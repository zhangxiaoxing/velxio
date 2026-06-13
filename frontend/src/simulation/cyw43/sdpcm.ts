/**
 * sdpcm
 *
 * SDPCM (Serial Data Protocol over CMC) frame encoder / decoder.
 * SDPCM is Broadcom's framing layer that wraps every payload exchanged
 * with the CYW43439 over F2 (the radio frame channel). Frame layout
 * (12-byte SDPCM header + per-channel sub-header + payload):
 *
 *   uint16  size                  // total bytes including this header
 *   uint16  size_complement       // = ~size & 0xffff
 *   uint8   sequence              // per-direction 8-bit counter
 *   uint8   channel               // 0=control, 1=event, 2=data, 3=glom
 *   uint8   next_length           // hint of next frame size, 0 if unknown
 *   uint8   header_length         // offset of payload from start of frame
 *   uint8   flow_ctl              // backpressure
 *   uint8   credit                // FIFO credit advertised back to host
 *   uint16  reserved
 *
 * The CDC (Cypress Data Channel) sub-header sits inside channel-0 frames
 * for IOCTLs:
 *
 *   uint32  cmd                   // WLC_*
 *   uint16  outlen                // bytes the host wants the chip to return
 *   uint16  inlen                 // bytes the host is sending
 *   uint32  flags                 // request-id in upper 16 bits
 *   uint32  status                // BCME_OK on success
 *
 * Public layout names follow picowi (MIT) and pico-sdk (BSD-3) for
 * cross-referencing; struct contents re-derived from the spec.
 */

import { SdpcmChannel } from './constants';

export const SDPCM_HEADER_LEN = 12;
export const CDC_HEADER_LEN = 16;

export interface SdpcmFrame {
  channel: number;
  sequence: number;
  payload: Uint8Array;
}

/** Build an SDPCM frame for a given channel. */
export function encodeSdpcm(opts: SdpcmFrame): Uint8Array {
  const size = SDPCM_HEADER_LEN + opts.payload.length;
  // gSPI / F2 is word-oriented: the real CYW43439 always drives frames padded
  // up to a 4-byte boundary, and the host reads that word-aligned length. The
  // emulator's F2 read path byte-swaps every 32-bit word (encodeFrameWords);
  // if the buffer length is NOT a multiple of 4 the final partial word gets
  // mangled by the host's symmetric swap, corrupting the last 1-3 bytes of the
  // frame. That goes unnoticed for DHCP/ARP (UDP checksum 0, trailing pad) but
  // silently drops DNS/TCP replies (real checksum -> lwIP discards). Pad the
  // backing buffer to a word boundary; the `size` field stays the true length
  // so the driver still parses exactly the real frame and ignores the pad.
  const total = (size + 3) & ~3;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, size, true);
  dv.setUint16(2, ~size & 0xffff, true);
  buf[4] = opts.sequence & 0xff;
  buf[5] = opts.channel & 0xff;
  buf[6] = 0; // next_length
  buf[7] = SDPCM_HEADER_LEN; // header_length
  buf[8] = 0; // flow_ctl
  buf[9] = 0; // credit
  // bytes 10..11 reserved
  buf.set(opts.payload, SDPCM_HEADER_LEN);
  return buf;
}

/** Parse an SDPCM frame; returns null if the frame is malformed. */
export function decodeSdpcm(buf: Uint8Array): SdpcmFrame | null {
  if (buf.length < SDPCM_HEADER_LEN) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = dv.getUint16(0, true);
  const sizeComplement = dv.getUint16(2, true);
  if (((~size) & 0xffff) !== sizeComplement) return null;
  if (size > buf.length) return null;
  const channel = buf[5];
  const headerLength = buf[7];
  if (headerLength > size) return null;
  const sequence = buf[4];
  const payload = buf.slice(headerLength, size);
  return { channel, sequence, payload };
}

// ── CDC (control-channel IOCTL framing) ───────────────────────────

export interface CdcFrame {
  cmd: number;
  outlen: number;
  inlen: number;
  flags: number;
  status: number;
  payload: Uint8Array;
}

export function encodeCdc(frame: CdcFrame): Uint8Array {
  const buf = new Uint8Array(CDC_HEADER_LEN + frame.payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, frame.cmd >>> 0, true);
  dv.setUint16(4, frame.outlen & 0xffff, true);
  dv.setUint16(6, frame.inlen & 0xffff, true);
  dv.setUint32(8, frame.flags >>> 0, true);
  dv.setUint32(12, frame.status >>> 0, true);
  buf.set(frame.payload, CDC_HEADER_LEN);
  return buf;
}

export function decodeCdc(buf: Uint8Array): CdcFrame | null {
  if (buf.length < CDC_HEADER_LEN) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    cmd: dv.getUint32(0, true),
    outlen: dv.getUint16(4, true),
    inlen: dv.getUint16(6, true),
    flags: dv.getUint32(8, true),
    status: dv.getUint32(12, true),
    payload: buf.slice(CDC_HEADER_LEN),
  };
}

/** Build a complete control-channel IOCTL request (sdpcm + cdc + payload). */
export function encodeIoctlRequest(
  sequence: number,
  cmd: number,
  flags: number,
  outlen: number,
  payload: Uint8Array,
): Uint8Array {
  const cdc = encodeCdc({
    cmd,
    outlen,
    inlen: payload.length,
    flags,
    status: 0,
    payload,
  });
  return encodeSdpcm({
    channel: SdpcmChannel.CONTROL,
    sequence,
    payload: cdc,
  });
}

/** Build a complete async event SDPCM frame (channel 1). */
export function encodeEventFrame(
  sequence: number,
  eventType: number,
  status: number,
  reason: number,
  payload: Uint8Array = new Uint8Array(0),
  srcMac: Uint8Array = new Uint8Array([0, 0, 0, 0, 0, 0]),
  flags = 0,
): Uint8Array {
  // Event SDPCM payload layout used by Broadcom firmware:
  //   BDC_HDR (4 bytes)            flags, priority, interface, data_offset
  //   ETHER_HDR (14 bytes)         dest+src+ethertype
  //   BCMETH_HDR (10 bytes)        Broadcom OUI tag
  //   EVENT_HDR (48 bytes)         event_type, status, …
  //   <payload>
  // The driver reads the BDC header at the SDPCM header_length, then takes the
  // ethernet payload at bdc + 4 + (data_offset<<2). Without the BDC it reads
  // the broadcast-MAC byte as data_offset and the payload points out of bounds.
  const ETHERTYPE_BRCM = 0x886c;
  const BDC_LEN = 4;
  const ETH_LEN = 14;
  const BCMETH_LEN = 10;
  const EVENT_LEN = 48;
  const total = BDC_LEN + ETH_LEN + BCMETH_LEN + EVENT_LEN + payload.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  // BDC header: data_offset = 0 (ethernet immediately follows), interface 0.
  // buf[0..3] stay zero.
  const eth = BDC_LEN;
  // Ethernet header: dst = broadcast, src = chip MAC, ethertype = BRCM
  for (let i = 0; i < 6; i++) buf[eth + i] = 0xff;
  buf.set(srcMac, eth + 6);
  dv.setUint16(eth + 12, ETHERTYPE_BRCM, false);

  // Broadcom Ethernet header (subtype/len/ver/oui/usr_subtype)
  let off = eth + ETH_LEN;
  dv.setUint16(off + 0, 0, false);
  dv.setUint16(off + 2, total - BDC_LEN - ETH_LEN, false);
  buf[off + 4] = 0x02; // ver
  buf[off + 5] = 0x00; // oui[0]
  buf[off + 6] = 0x10; // oui[1]
  buf[off + 7] = 0x18; // oui[2]
  dv.setUint16(off + 8, 1, false); // usr_subtype = event packet

  // EVENT_HDR (big-endian — Broadcom firmware writes this BE)
  off += BCMETH_LEN;
  dv.setUint16(off + 0, 1, false); // ver
  dv.setUint16(off + 2, flags & 0xffff, false); // flags (bit 0 = link up for WLC_E_LINK)
  dv.setUint32(off + 4, eventType >>> 0, false);
  dv.setUint32(off + 8, status >>> 0, false);
  dv.setUint32(off + 12, reason >>> 0, false);
  dv.setUint32(off + 16, 0, false); // auth_type
  dv.setUint32(off + 20, payload.length >>> 0, false);
  // bytes 24..29 = src MAC, 30..45 = ifname, 46 = ifidx, 47 = bsscfgidx
  buf.set(srcMac, off + 24);

  // Event-specific payload
  buf.set(payload, off + EVENT_LEN);

  return encodeSdpcm({
    channel: SdpcmChannel.EVENT,
    sequence,
    payload: buf,
  });
}

/** Decode an event payload — returns the flags / event_type / status / reason. */
export function decodeEventBody(payload: Uint8Array): {
  flags: number;
  eventType: number;
  status: number;
  reason: number;
  datalen: number;
  data: Uint8Array;
} | null {
  const BDC_LEN = 4;
  const ETH_LEN = 14;
  const BCMETH_LEN = 10;
  const EVENT_LEN = 48;
  if (payload.length < BDC_LEN + ETH_LEN + BCMETH_LEN + EVENT_LEN) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const off = BDC_LEN + ETH_LEN + BCMETH_LEN;
  const flags = dv.getUint16(off + 2, false);
  const eventType = dv.getUint32(off + 4, false);
  const status = dv.getUint32(off + 8, false);
  const reason = dv.getUint32(off + 12, false);
  const datalen = dv.getUint32(off + 20, false);
  const data = payload.slice(off + EVENT_LEN, off + EVENT_LEN + datalen);
  return { flags, eventType, status, reason, datalen, data };
}
