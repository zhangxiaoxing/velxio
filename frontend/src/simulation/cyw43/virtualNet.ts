/**
 * virtualNet.ts
 *
 * A tiny self-contained network for the CYW43 emulator. The real chip just
 * bridges Ethernet frames to/from the air; for a fully local emulation (no
 * backend) the virtual AP also has to answer the handful of L2/L3 exchanges a
 * freshly-joined STA needs before its `network.WLAN` reports a usable link:
 *
 *   - DHCP (DISCOVER -> OFFER, REQUEST -> ACK) so lwIP gets an IP and the link
 *     advances CYW43_LINK_NOIP -> CYW43_LINK_UP (isconnected() == True).
 *   - ARP (who-has the gateway -> is-at) so the stack can resolve the router.
 *
 * Everything is built by hand (Ethernet + IPv4 + UDP + DHCP/BOOTP, or ARP) with
 * a correct IPv4 header checksum; the UDP checksum is left 0 (legal, and what
 * most embedded DHCP servers emit). All addresses are link-local to the virtual
 * AP and never leave the browser.
 */

export interface VirtualNetConfig {
  serverIp: readonly [number, number, number, number]; // AP / DHCP server / gateway
  clientIp: readonly [number, number, number, number]; // address leased to the STA
  netmask: readonly [number, number, number, number];
  dnsIp: readonly [number, number, number, number];
  apMac: Uint8Array; // 6 bytes — the virtual AP's MAC
  leaseSecs: number;
}

// Aligned with the backend picow_net stack (consts.py): same subnet, gateway
// and gateway MAC. That way DHCP/ARP can be answered LOCALLY (so Wi-Fi always
// associates, even with no backend) while DNS/TCP/UDP — addressed to this same
// gateway 10.13.37.1 — are forwarded to the backend NAT for real internet. The
// backend NATs by the chip's source IP, so the addresses must match.
export const DEFAULT_VNET: VirtualNetConfig = {
  serverIp: [10, 13, 37, 1],
  clientIp: [10, 13, 37, 42],
  netmask: [255, 255, 255, 0],
  dnsIp: [10, 13, 37, 1],
  apMac: new Uint8Array([0x02, 0x42, 0xda, 0x42, 0xff, 0xff]), // backend GATEWAY_MAC
  leaseSecs: 86400,
};

const ETH_IPV4 = 0x0800;
const ETH_ARP = 0x0806;
const IP_PROTO_UDP = 17;

function ip16(sum: number): number {
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

/** Build an Ethernet+IPv4+UDP frame carrying `udpPayload` (server -> client). */
function buildUdp(
  cfg: VirtualNetConfig,
  dstMac: Uint8Array,
  srcPort: number,
  dstPort: number,
  udpPayload: Uint8Array,
): Uint8Array {
  const ETH = 14;
  const IP = 20;
  const UDP = 8;
  const total = ETH + IP + UDP + udpPayload.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // Ethernet
  buf.set(dstMac.subarray(0, 6), 0);
  buf.set(cfg.apMac.subarray(0, 6), 6);
  dv.setUint16(12, ETH_IPV4, false);

  // IPv4
  let o = ETH;
  buf[o] = 0x45; // version 4, IHL 5
  buf[o + 1] = 0; // DSCP/ECN
  dv.setUint16(o + 2, IP + UDP + udpPayload.length, false); // total length
  dv.setUint16(o + 4, 0, false); // id
  dv.setUint16(o + 6, 0, false); // flags/frag
  buf[o + 8] = 64; // TTL
  buf[o + 9] = IP_PROTO_UDP;
  dv.setUint16(o + 10, 0, false); // checksum (filled below)
  buf.set(cfg.serverIp, o + 12);
  buf.set(dstMac === BROADCAST_MAC ? [255, 255, 255, 255] : cfg.clientIp, o + 16);
  // IPv4 header checksum
  let sum = 0;
  for (let i = 0; i < IP; i += 2) sum += dv.getUint16(o + i, false);
  dv.setUint16(o + 10, ip16(sum), false);

  // UDP (checksum 0 = not computed, legal for IPv4)
  o += IP;
  dv.setUint16(o + 0, srcPort, false);
  dv.setUint16(o + 2, dstPort, false);
  dv.setUint16(o + 4, UDP + udpPayload.length, false);
  dv.setUint16(o + 6, 0, false);
  buf.set(udpPayload, o + UDP);
  return buf;
}

const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const DHCP_MAGIC = [0x63, 0x82, 0x53, 0x63];

interface DhcpReq {
  xid: Uint8Array;       // 4 bytes
  chaddr: Uint8Array;    // 6 bytes (client MAC)
  msgType: number;       // 1 = DISCOVER, 3 = REQUEST
  broadcast: boolean;    // client wants the reply broadcast
}

/** Parse a DHCP request out of an Ethernet frame; null if it isn't one. */
function parseDhcp(ether: Uint8Array): DhcpReq | null {
  if (ether.length < 14 + 20 + 8 + 240) return null;
  const dv = new DataView(ether.buffer, ether.byteOffset, ether.byteLength);
  if (dv.getUint16(12, false) !== ETH_IPV4) return null;
  const ihl = (ether[14] & 0x0f) * 4;
  if (ether[14 + 9] !== IP_PROTO_UDP) return null;
  const udp = 14 + ihl;
  const dstPort = dv.getUint16(udp + 2, false);
  if (dstPort !== 67) return null; // DHCP server port
  const dhcp = udp + 8;
  if (ether[dhcp] !== 1) return null; // BOOTREQUEST
  const flags = dv.getUint16(dhcp + 10, false);
  const xid = ether.slice(dhcp + 4, dhcp + 8);
  const chaddr = ether.slice(dhcp + 28, dhcp + 34);
  // Verify + skip the magic cookie, then walk options for type 53 (msg type).
  const optStart = dhcp + 236;
  if (
    ether[optStart] !== DHCP_MAGIC[0] || ether[optStart + 1] !== DHCP_MAGIC[1] ||
    ether[optStart + 2] !== DHCP_MAGIC[2] || ether[optStart + 3] !== DHCP_MAGIC[3]
  ) return null;
  let msgType = 0;
  let i = optStart + 4;
  while (i < ether.length) {
    const opt = ether[i];
    if (opt === 0xff) break; // end
    if (opt === 0x00) { i++; continue; } // pad
    const len = ether[i + 1];
    if (opt === 53 && len >= 1) msgType = ether[i + 2];
    i += 2 + len;
  }
  if (msgType !== 1 && msgType !== 3) return null; // only DISCOVER / REQUEST
  return { xid, chaddr, msgType, broadcast: (flags & 0x8000) !== 0 };
}

/** Build the DHCP OFFER/ACK reply Ethernet frame for a parsed request. */
function buildDhcpReply(cfg: VirtualNetConfig, req: DhcpReq): Uint8Array {
  // BOOTP fixed area (236) + magic (4) + options.
  const replyType = req.msgType === 1 ? 2 : 5; // DISCOVER->OFFER, REQUEST->ACK
  const fixed = new Uint8Array(236);
  const dv = new DataView(fixed.buffer);
  fixed[0] = 2; // BOOTREPLY
  fixed[1] = 1; // htype ethernet
  fixed[2] = 6; // hlen
  fixed.set(req.xid, 4);
  dv.setUint16(10, req.broadcast ? 0x8000 : 0, false); // flags
  fixed.set(cfg.clientIp, 16); // yiaddr (leased address)
  fixed.set(cfg.serverIp, 20); // siaddr (server)
  fixed.set(req.chaddr.subarray(0, 6), 28); // chaddr

  const opts: number[] = [...DHCP_MAGIC];
  opts.push(53, 1, replyType);                       // DHCP message type
  opts.push(54, 4, ...cfg.serverIp);                 // server identifier
  opts.push(51, 4, ...le32be(cfg.leaseSecs));        // lease time
  opts.push(1, 4, ...cfg.netmask);                   // subnet mask
  opts.push(3, 4, ...cfg.serverIp);                  // router (gateway)
  opts.push(6, 4, ...cfg.dnsIp);                     // DNS server
  opts.push(0xff);                                   // end
  while (opts.length < 60) opts.push(0);             // pad to a sane minimum

  const dhcp = new Uint8Array(fixed.length + opts.length);
  dhcp.set(fixed, 0);
  dhcp.set(opts, fixed.length);

  const dstMac = req.broadcast ? BROADCAST_MAC : req.chaddr;
  return buildUdp(cfg, dstMac, 67, 68, dhcp);
}

function le32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** Parse an ARP request for the gateway; build the is-at reply, else null. */
function buildArpReply(cfg: VirtualNetConfig, ether: Uint8Array): Uint8Array | null {
  if (ether.length < 14 + 28) return null;
  const dv = new DataView(ether.buffer, ether.byteOffset, ether.byteLength);
  if (dv.getUint16(12, false) !== ETH_ARP) return null;
  const a = 14;
  if (dv.getUint16(a + 0, false) !== 1) return null;       // htype ethernet
  if (dv.getUint16(a + 2, false) !== ETH_IPV4) return null; // ptype IPv4
  if (dv.getUint16(a + 6, false) !== 1) return null;        // opcode request
  const targetIp = ether.slice(a + 24, a + 28);
  // Only answer for the gateway/server address.
  if (!ipEq(targetIp, cfg.serverIp)) return null;
  const senderMac = ether.slice(a + 8, a + 14);
  const senderIp = ether.slice(a + 14, a + 18);

  const out = new Uint8Array(14 + 28);
  const odv = new DataView(out.buffer);
  out.set(senderMac, 0);            // dst = requester
  out.set(cfg.apMac.subarray(0, 6), 6); // src = AP
  odv.setUint16(12, ETH_ARP, false);
  odv.setUint16(a + 0, 1, false);   // htype
  odv.setUint16(a + 2, ETH_IPV4, false);
  out[a + 4] = 6; out[a + 5] = 4;
  odv.setUint16(a + 6, 2, false);   // opcode reply
  out.set(cfg.apMac.subarray(0, 6), a + 8); // sender HW = AP
  out.set(cfg.serverIp, a + 14);            // sender IP = gateway
  out.set(senderMac, a + 18);               // target HW = requester
  out.set(senderIp, a + 24);                // target IP = requester
  return out;
}

function ipEq(a: Uint8Array, b: readonly number[]): boolean {
  return a.length >= 4 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Given an Ethernet frame the STA transmitted, return the AP's reply frame to
 * inject back (DHCP OFFER/ACK or ARP is-at), or null if no reply is warranted.
 */
export function virtualNetReply(cfg: VirtualNetConfig, ether: Uint8Array): Uint8Array | null {
  const dhcpReq = parseDhcp(ether);
  if (dhcpReq) return buildDhcpReply(cfg, dhcpReq);
  return buildArpReply(cfg, ether);
}
