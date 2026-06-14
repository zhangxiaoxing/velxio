/**
 * picow-gateway-e2e.investigate.test.ts  (gated: CYW43_GATEWAY_E2E=1)
 *
 * End-to-end proof of the Pico W IoT gateway INBOUND path: a real
 * RP2040Simulator runs a MicroPython HTTP *server*, and a browser-style
 * HTTP request to /api/gateway/<clientId>/ is proxied by the backend INTO
 * the chip over the WebSocket bridge, returning the served page.
 *
 * Requires a backend with the inbound proxy + VELXIO_PICOW_NET=1 running;
 * point at it with VELXIO_E2E_API_BASE (default http://127.0.0.1:8011/api).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebSocket as NodeWS } from 'ws';

const FW_PATH = '/home/dave/velxio-prod/velxio/frontend/public/firmware/micropython-rp2040w.uf2';
const WASM_PATH = '/home/dave/velxio-prod/velxio/frontend/node_modules/littlefs/dist/littlefs.wasm';

vi.mock('../simulation/MicroPythonLoader', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFirmware: async () => new Uint8Array(readFileSync(FW_PATH)) };
});
vi.mock('littlefs', async (orig) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await orig()) as any;
  const create = actual.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...actual, default: (cfg: any = {}) => create({ ...cfg, wasmBinary: new Uint8Array(readFileSync(WASM_PATH)) }) };
});

const SERVER_PY = [
  'import network, socket, time',
  'w = network.WLAN(network.STA_IF)',
  'w.active(True)',
  'w.connect("Velxio-GUEST", "")',
  'for i in range(80):',
  '    if w.isconnected(): break',
  '    time.sleep_ms(150)',
  'ip = w.ifconfig()[0]',
  'print("PYIP", ip)',
  's = socket.socket()',
  's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  's.bind(("0.0.0.0", 80))',
  's.listen(1)',
  'print("LISTEN", ip)',
  'n = 0',
  // Blocking server with NO per-client try/except (like the relay example):
  // if the gateway ever forwarded an oversized request or RST a stale
  // connection, recv()/the next accept() would raise ECONNRESET and kill
  // this loop, so a second request would never be served.
  'while True:',
  '    cl, addr = s.accept()',
  '    cl.recv(512)',
  '    n += 1',
  '    print("REQ", n)',
  '    cl.send(b"HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n<html><body>VELXIO-PICO-OK</body></html>")',
  '    cl.close()',
].join('\n');

const API_BASE = process.env.VELXIO_E2E_API_BASE || 'http://127.0.0.1:8011/api';

describe.skipIf(!process.env.CYW43_GATEWAY_E2E)('Pico W IoT gateway inbound', () => {
  it('serves the chip web page through /api/gateway', async () => {
    const { RP2040Simulator } = await import('../simulation/RP2040Simulator');
    const { PinManager } = await import('../simulation/PinManager');
    const { Cyw43Bridge } = await import('../simulation/cyw43/Cyw43Bridge');

    // Stable per-tab session id so bridge.clientId matches the WS registration.
    const ss = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (ss.has(k) ? ss.get(k) : null),
      setItem: (k: string, v: string) => { ss.set(k, v); },
      removeItem: (k: string) => { ss.delete(k); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = NodeWS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { __VELXIO_API_BASE__: API_BASE };

    const sim = new RP2040Simulator(new PinManager());
    let serial = '';
    sim.onSerialData = (ch: string) => { serial += ch; if (serial.length > 80000) serial = serial.slice(-40000); };

    const bridge = new Cyw43Bridge('gw-board');
    sim.attachCyw43(bridge);
    bridge.wifiEnabled = true;
    const pktlog: string[] = [];
    const desc = (b: Uint8Array) => {
      if (b.length < 14) return 'short';
      const et = (b[12] << 8) | b[13];
      const src = Array.from(b.subarray(6, 12)).map((x) => x.toString(16).padStart(2, '0')).join('');
      if (et === 0x0806) return `ARP op${b[21]} src=${src}`;
      if (et !== 0x0800) return 'eth0x' + et.toString(16);
      const proto = b[23], l4 = 14 + (b[14] & 0xf) * 4;
      if (proto === 6) return `TCP ${(b[l4] << 8) | b[l4 + 1]}->${(b[l4 + 2] << 8) | b[l4 + 3]} fl${b[l4 + 13].toString(16)} src=${src}`;
      if (proto === 17) return `UDP ${(b[l4] << 8) | b[l4 + 1]}->${(b[l4 + 2] << 8) | b[l4 + 3]}`;
      return 'ip-proto' + proto;
    };
    const origSend = bridge.sendPacket.bind(bridge);
    bridge.sendPacket = (e: Uint8Array) => { if (pktlog.length < 120) pktlog.push('OUT ' + desc(e)); return origSend(e); };
    const innerIn = bridge.onPacketIn!;
    bridge.onPacketIn = (p) => { if (pktlog.length < 120) pktlog.push('IN  ' + desc(p.ether)); return innerIn(p); };
    bridge.connect();
    const clientId = bridge.clientId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;

    await sim.loadMicroPython([{ name: 'main.py', content: SERVER_PY }]);

    // 1. Run until the chip's HTTP server is listening.
    const upDeadline = Date.now() + 90_000;
    while (Date.now() < upDeadline && !serial.includes('LISTEN')) {
      const n = serial.includes('PYIP') ? 1 : 16;
      for (let i = 0; i < n; i++) sim.runFrameForTime(n === 1 ? 10 : 50);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(serial).toMatch(/LISTEN 10\.13\.37\.42/);

    // 2. Fire TWO sequential gateway requests, the first carrying a large
    //    header (simulating a real browser's cookies/User-Agent). The chip's
    //    non-resilient blocking server must serve BOTH (proving the gateway
    //    forwards a lean request and never RSTs the chip on cleanup).
    const gwUrl = `${API_BASE}/gateway/${encodeURIComponent(clientId)}/`;
    const bigHeader = { 'X-Browser-Junk': 'a'.repeat(4096) };
    const doFetch = async (path: string, headers?: Record<string, string>) => {
      let r: { status: number; body: string } | null = null;
      let e: unknown = null;
      const p = fetch(gwUrl + path, headers ? { headers } : undefined)
        .then(async (resp) => { r = { status: resp.status, body: await resp.text() }; })
        .catch((x) => { e = x; });
      const dl = Date.now() + 25_000;
      while (Date.now() < dl && r === null && e === null) {
        sim.runFrameForTime(10);
        await new Promise((res) => setTimeout(res, 0));
      }
      await p;
      return { r, e };
    };

    const first = await doFetch('', bigHeader);   // page load (browser-sized)
    const second = await doFetch('on');           // the toggle

    try { bridge.disconnect(); } catch { /* noop */ }
    try { sim.stop(); } catch { /* noop */ }

    console.log('\n===== GATEWAY E2E =====\nclientId=' + clientId +
      '\nserial=' + serial.split('\n').filter((l) => /^(PYIP|LISTEN|REQ|SRV|Traceback|OSError)/.test(l)).join(' | ') +
      '\nfirst=' + JSON.stringify(first.r) + '\nsecond=' + JSON.stringify(second.r));

    expect(first.e).toBeNull();
    expect(first.r?.status).toBe(200);
    expect(first.r?.body).toContain('VELXIO-PICO-OK');
    // The blocking server survived the first request and served the second.
    expect(second.r?.status).toBe(200);
    expect(serial).toContain('REQ 2');
    expect(serial).not.toMatch(/Traceback|ECONNRESET/);
  }, 140_000);
});
