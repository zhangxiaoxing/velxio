/**
 * picow-bridge-e2e.investigate.test.ts  (gated: CYW43_BRIDGE_E2E=1)
 * Real RP2040Simulator + Cyw43Bridge over a real WebSocket to the RUNNING
 * backend picow_net -> real internet. main.py auto-runs from a real LittleFS.
 * Logs every chip<->backend packet so a DNS/TCP hang is diagnosable.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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

const MAIN_PY = [
  'import network, socket, time',
  'w = network.WLAN(network.STA_IF)',
  'w.active(True)',
  'w.connect("Velxio-GUEST", "")',
  'for i in range(80):',
  '    if w.isconnected(): break',
  '    time.sleep_ms(150)',
  'print("PYIP", w.ifconfig())',
  'try:',
  '    ai = socket.getaddrinfo("example.com", 80)[0][-1]',
  '    print("PYDNS", ai)',
  '    s = socket.socket(); s.connect(ai)',
  '    s.send(b"GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n")',
  '    print("PYHTTP", s.recv(16)); s.close()',
  'except Exception as e:',
  '    print("PYNETERR", repr(e))',
  'print("PYDONE")',
].join('\n');

function pktDesc(b: Uint8Array): string {
  if (b.length < 14) return 'short';
  const et = (b[12] << 8) | b[13];
  if (et === 0x0806) return 'ARP';
  if (et !== 0x0800) return 'eth0x' + et.toString(16);
  const proto = b[23], ihl = (b[14] & 0xf) * 4, l4 = 14 + ihl;
  if (proto === 1) return 'ICMP';
  if (proto === 17) return `UDP ${(b[l4] << 8) | b[l4 + 1]}->${(b[l4 + 2] << 8) | b[l4 + 3]}`;
  if (proto === 6) { const fl = b[l4 + 13]; return `TCP ${(b[l4] << 8) | b[l4 + 1]}->${(b[l4 + 2] << 8) | b[l4 + 3]} fl${fl.toString(16)}`; }
  return 'ip-proto' + proto;
}

describe.skipIf(!process.env.CYW43_BRIDGE_E2E)('Pico W bridge e2e', () => {
  it('connects via bridge and fetches example.com', async () => {
    const { RP2040Simulator } = await import('../simulation/RP2040Simulator');
    const { PinManager } = await import('../simulation/PinManager');
    const { Cyw43Bridge } = await import('../simulation/cyw43/Cyw43Bridge');

    const sim = new RP2040Simulator(new PinManager());
    let serial = '';
    const pktlog: string[] = [];
    sim.onSerialData = (ch: string) => { serial += ch; if (serial.length > 80000) serial = serial.slice(-40000); };

    const bridge = new Cyw43Bridge('e2e-board');
    // window only around connect() (computes the WS URL); removed before the
    // sim runs so it doesn't accidentally take any browser code path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = NodeWS;
    // Point at a running backend with picow_net enabled (VELXIO_PICOW_NET=1).
    // Default = the OSS dev backend (uvicorn --port 8001); override with
    // VELXIO_E2E_API_BASE (e.g. the in-container backend exposed on another port).
    const apiBase = process.env.VELXIO_E2E_API_BASE || 'http://127.0.0.1:8001/api';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { __VELXIO_API_BASE__: apiBase };
    sim.attachCyw43(bridge);
    bridge.wifiEnabled = true;
    // wrap send + onPacketIn for logging (after attach set onPacketIn).
    const origSend = bridge.sendPacket.bind(bridge);
    bridge.sendPacket = (e: Uint8Array) => {
      if (pktlog.length < 200) pktlog.push('OUT ' + pktDesc(e));
      return origSend(e);
    };
    const innerIn = bridge.onPacketIn!;
    bridge.onPacketIn = (p) => {
      if (pktlog.length < 200) pktlog.push('IN  ' + pktDesc(p.ether));
      return innerIn(p);
    };
    bridge.connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;

    await sim.loadMicroPython([{ name: 'main.py', content: MAIN_PY }]);
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      // Big chunks during the bring-up; once Wi-Fi is up and the sketch is
      // doing DNS/TCP, yield to the WS far more often so the bridge round-trips
      // (real-time) keep up with lwIP's emulated DNS/connect timers.
      const n = serial.includes('PYIP') ? 1 : 16;
      for (let i = 0; i < n; i++) sim.runFrameForTime(n === 1 ? 10 : 50);
      if (serial.includes('PYDONE')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    try { bridge.disconnect(); } catch { /* noop */ }
    try { sim.stop(); } catch { /* noop */ }
    writeFileSync('/tmp/bridge-e2e-serial.txt', serial + '\n\n=== PKTLOG ===\n' + pktlog.join('\n'));
    console.log('\n===== E2E =====\n' +
      serial.split('\n').filter((l) => l.startsWith('PY')).join('\n') +
      '\n--- packets ---\n' + pktlog.slice(0, 40).join('\n'));

    expect(serial).toMatch(/PYIP .*10\.13\.37\.42/);
    expect(serial).toContain('PYHTTP');
  }, 170_000);
});
