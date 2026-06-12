/**
 * picow-cyw43-boot-harness.investigate.test.ts
 *
 * INVESTIGATION HARNESS (not a CI test — run explicitly).
 *
 * Boots the REAL Pico W MicroPython firmware on rp2040js, attaches the
 * production Cyw43Emulator to the PIO TX FIFOs exactly the way
 * RP2040Simulator.installCyw43PioHooks() does, injects a WiFi-bringup
 * snippet via the raw REPL, and captures the gSPI command trace so we can
 * see EXACTLY where the real cyw43 driver diverges from the emulator
 * (i.e. where it stalls).
 *
 * Run:
 *   npx vitest run src/__tests__/picow-cyw43-boot-harness.investigate.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Simulator, USBCDC, ConsoleLogger, LogLevel } from 'rp2040js';
import { Cyw43Emulator } from '../simulation/cyw43/Cyw43Emulator';
import { PioBusSniffer, formatCmd, type Cyw43Cmd } from '../simulation/cyw43/PioBusSniffer';
import { bootromB1 } from '../simulation/rp2040-bootrom';

const FW_PATH =
  '/home/dave/velxio-prod/velxio/frontend/public/firmware/micropython-rp2040w.uf2';

const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const FLASH_START = 0x10000000;

function loadUF2(uf2: Uint8Array, flash: Uint8Array): number {
  const view = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  let blocks = 0;
  for (let off = 0; off + 512 <= uf2.length; off += 512) {
    if (view.getUint32(off, true) !== UF2_MAGIC0) continue;
    if (view.getUint32(off + 4, true) !== UF2_MAGIC1) continue;
    const addr = view.getUint32(off + 12, true);
    const payload = uf2.subarray(off + 32, off + 32 + 256);
    const o = addr - FLASH_START;
    if (o >= 0 && o + 256 <= flash.length) { flash.set(payload, o); blocks++; }
  }
  return blocks;
}

// The WiFi bringup snippet. Prints between each step so the serial log
// pinpoints how far MicroPython gets before the cyw43 driver stalls.
const INJECT_CODE = [
  'import network, time',
  'print("STEP_IMPORT_OK")',
  'w=network.WLAN(network.STA_IF)',
  'print("STEP_WLAN_OBJ_OK")',
  'try:',
  '    w.active(True)',
  'except Exception as e:',
  '    print("ACTIVE_EXC " + repr(e))',
  // Give the background driver task time to finish wifi_on (CLM load + IOCTLs).
  'for i in range(40):',
  '    print("ACT", i, "active=" + str(w.active()) + " status=" + str(w.status()))',
  '    if w.active():',
  '        break',
  '    time.sleep_ms(150)',
  'try:',
  '    w.connect("Velxio-GUEST", "")',
  '    print("STEP_CONNECT_CALLED status=" + str(w.status()))',
  'except Exception as e:',
  '    print("CONNECT_EXC " + repr(e))',
  'for i in range(20):',
  '    print("POLL", i, "status", w.status(), "conn", w.isconnected())',
  '    if w.isconnected():',
  '        break',
  '    time.sleep_ms(200)',
  'print("HARNESS_DONE")',
].join('\n');

// Skipped in the normal gate (boots a real firmware for ~60s). Run with:
//   CYW43_HARNESS=1 npx vitest run src/__tests__/picow-cyw43-boot-harness.investigate.test.ts
describe.skipIf(!process.env.CYW43_HARNESS)('Pico W cyw43 boot harness (investigation)', () => {
  it('captures the gSPI trace up to the stall', async () => {
    const result = await new Promise<{
      serial: string;
      trace: string[];
      reachedImport: boolean;
      reachedActive: boolean;
      lastCmds: string[];
      pollSummary: Array<[string, number]>;
    }>((resolve) => {
      const sim = new Simulator();
      sim.rp2040.loadBootrom(bootromB1);
      // Custom non-throwing logger: capture CPU faults (e.g. unaligned reads)
      // with the PC so we can locate corruption WITHOUT aborting the run.
      void LogLevel; void ConsoleLogger;
      let faultCount = 0;
      const faultLog: string[] = [];
      sim.rp2040.logger = {
        debug() {}, info() {}, warn() {},
        error: (_comp: string, msg: string) => {
          faultCount++;
          if (faultLog.length < 25) {
            const pc = ((sim.rp2040 as any).core?.PC ?? 0) >>> 0;
            faultLog.push(`PC=0x${pc.toString(16)} ${msg}`);
          }
        },
      } as any;

      const fwBlocks = loadUF2(new Uint8Array(readFileSync(FW_PATH)), sim.rp2040.flash);
      let usbConnected = false;

      // ── attach production Cyw43Emulator the way RP2040Simulator does ──
      const chip = new Cyw43Emulator();
      const initInbound = chip.debugInboundCount();
      let statusReadsWithPkt = 0;
      let statusReads = 0;
      const sniffer = new PioBusSniffer();
      sniffer.setModeProvider(() => chip.isBigEndian());
      let pushCount = 0;
      void pushCount;
      const rxQueue: number[] = [];
      const rawWords: number[] = [];
      const trace: string[] = [];
      const f2Log: string[] = []; // F2/IOCTL transfers, NOT subject to the ring
      const postF2: string[] = []; // verbatim trace from the first F2 write onward
      let f2Seen = false;
      let restartsAtClm = -1; // restartCount at the moment clm_load goes out
      const funcHist = [0, 0, 0, 0]; // count of decoded gSPI functions F0..F3
      const cmdCounts = new Map<string, number>();
      let ledOn = false;
      chip.onLed((e) => { ledOn = e.on; trace.push(`** LED ${e.on ? 'ON' : 'OFF'} **`); });
      chip.onConnect((e) => trace.push(`** WIFI CONNECT ssid=${e.ssid} **`));

      const key = (c: Cyw43Cmd) =>
        `${c.write ? 'WR' : 'RD'} F${c.function} 0x${c.address.toString(16)} len=${c.length}`;

      function queueReply(reply: Uint8Array) {
        for (let i = 0; i + 4 <= reply.length; i += 4) {
          rxQueue.push(
            ((reply[i + 3] << 24) | (reply[i + 2] << 16) | (reply[i + 1] << 8) | reply[i]) >>> 0,
          );
        }
        if (reply.length % 4 !== 0) {
          const tail = reply.subarray(reply.length - (reply.length % 4));
          let w = 0;
          for (let i = 0; i < tail.length; i++) w |= tail[i] << (i * 8);
          rxQueue.push(w >>> 0);
        }
      }
      function feedWord(word: number, sm: any) {
        for (const ev of sniffer.feedWord(word)) {
          if (ev.kind === 'header') {
            const k = key(ev.cmd);
            cmdCounts.set(k, (cmdCounts.get(k) ?? 0) + 1);
            if (f2Seen && postF2.length < 400) postF2.push(`HDR ${formatCmd(ev.cmd)}`);
          } else if (ev.kind === 'payload') {
            // Histogram of decoded functions + capture EVERY F2 transfer.
            funcHist[ev.cmd.function & 3]++;
            // Track SPI_STATUS reads and whether a frame was queued at the time.
            if (!ev.cmd.write && ev.cmd.function === 0 && ev.cmd.address === 0x08) {
              statusReads++;
              if (chip.debugInboundCount() > 0) statusReadsWithPkt++;
            }
            if (ev.cmd.function === 2 && f2Log.length < 60) {
              const head = Array.from(ev.payload.slice(0, 32))
                .map((b) => b.toString(16).padStart(2, '0')).join(' ');
              f2Log.push(`${ev.cmd.write ? 'WR' : 'RD'} F2 a=0x${ev.cmd.address.toString(16)} len=${ev.payload.length || ev.readBytes}` +
                (ev.cmd.write ? `\n     bytes: ${head}` : ''));
            }
            if (ev.cmd.function === 2 && ev.cmd.write && !f2Seen) { f2Seen = true; restartsAtClm = restartCount; }
            // Once clm_load (first F2 write) goes out, capture EVERYTHING verbatim
            // (no ring) so we can see exactly where the driver stalls afterward.
            if (f2Seen && postF2.length < 400) {
              postF2.push(`${formatCmd(ev.cmd)} rx=${ev.readBytes}` +
                (ev.cmd.write && ev.payload.length > 0 && ev.payload.length < 8
                  ? ` =0x${((ev.payload[0] | (ev.payload[1] << 8) | (ev.payload[2] << 16) | (ev.payload[3] << 24)) >>> 0).toString(16)}`
                  : ''));
            }
            // Skip the ~3500 firmware-block writes (len>=64) AND the backplane
            // window-address writes (0x1000a/b/c) that bracket each block —
            // keep the trace on the handshake + post-download SR/power loop.
            const a = ev.cmd.address;
            const isNoise = (ev.cmd.write && ev.payload.length >= 64) ||
              (ev.cmd.write && (a === 0x1000a || a === 0x1000b || a === 0x1000c));
            if (!isNoise) {
              trace.push(`-> ${formatCmd(ev.cmd)} rxBytes=${ev.readBytes}`);
              if (ev.cmd.write && ev.payload.length > 0) {
                const v = (ev.payload[0] | (ev.payload[1] << 8) | (ev.payload[2] << 16) | (ev.payload[3] << 24)) >>> 0;
                trace.push(`   WR data u32=0x${v.toString(16).padStart(8, '0')} (${ev.payload.length}B)`);
              }
            }
            if (trace.length > 6000) trace.splice(0, trace.length - 4000); // ring
            const reply = chip.onCommand(ev.cmd, ev.payload, ev.readBytes);
            if (reply && reply.length > 0) {
              queueReply(reply);
              if (trace.length < 4000) {
                const hex = Array.from(reply.slice(0, 8))
                  .map((b) => b.toString(16).padStart(2, '0')).join(' ');
                trace.push(`<- (${reply.length}B) ${hex}${reply.length > 8 ? ' ...' : ''}`);
              }
              if (f2Seen && postF2.length < 400) {
                const hex = Array.from(reply.slice(0, 16))
                  .map((b) => b.toString(16).padStart(2, '0')).join(' ');
                postF2.push(`   <- (${reply.length}B) ${hex}${reply.length > 16 ? ' ...' : ''}`);
              }
            }
          }
        }
      }

      let rxPulled = 0;
      let restartCount = 0;
      let txPulls = 0;
      let smSteps = 0;
      for (const pio of (sim.rp2040 as any).pio) {
        for (const sm of pio.machines) {
          const tx = sm.txFIFO;
          if (!tx) continue;
          // Make the TX FIFO NON-DROPPING by swapping its fixed 4-deep backing
          // for an unbounded queue. rp2040js's FIFO.push silently drops when
          // `used === length` (the DMA outruns the PIO drain on large bursts).
          // Real hardware paces the DMA with DREQ so it never drops; the dropped
          // words corrupt the 260-word F2 IOCTL writes (clm_load, ioctls), which
          // is why no F2 payload ever frames. An unbounded queue retains every
          // word so the PIO drains the complete stream — keeping the sniffer
          // (hooked on push) and the driver's view identical (no phantom reads).
          // Head-pointer queue: pull() is O(1) amortized (NO Array.shift, which is
          // O(n) and turned the whole thing O(n^2) — the firmware download stalled).
          const q: number[] = [];
          let head = 0;
          Object.defineProperty(tx, 'full', { get: () => false, configurable: true });
          Object.defineProperty(tx, 'empty', { get: () => head >= q.length, configurable: true });
          Object.defineProperty(tx, 'itemCount', { get: () => q.length - head, configurable: true });
          tx.peek = () => (head < q.length ? q[head] : 0);
          tx.reset = () => { q.length = 0; head = 0; };
          tx.push = (v: number) => {
            pushCount++;
            rawWords.push(v >>> 0);
            if (rawWords.length > 600) rawWords.splice(0, rawWords.length - 400); // ring
            feedWord(v, sm);
            q.push(v >>> 0);
          };
          tx.pull = () => {
            txPulls++;
            if (head >= q.length) return 0;
            const v = q[head++];
            if (head > 8192 && head * 2 > q.length) { q.splice(0, head); head = 0; } // compact
            return v;
          };
          // Reset the sniffer at each transfer boundary: cyw43_spi_transfer
          // calls pio_sm_restart before pushing the count words, so this keeps
          // framing deterministic even after the firmware-stream fast-path.
          if (typeof sm.restart === 'function') {
            const origRestart = sm.restart.bind(sm);
            sm.restart = () => { restartCount++; sniffer.reset(); return origRestart(); };
          }
          const rx = sm.rxFIFO;
          if (rx) {
            const origPull = rx.pull.bind(rx);
            // Serve the chip's response on-demand: when the driver's DMA pulls,
            // hand back the next queued response word (bypasses the async
            // PIO/FIFO timing that otherwise lags/loses the data).
            rx.pull = () => {
              const v = rxQueue.length > 0 ? (rxQueue.shift() as number) : origPull();
              rxPulled++;
              return v;
            };
          }
        }
        // Crank the PIO step-rate. rp2040js runs the PIO on its own setTimeout
        // loop at only 1000 steps/tick (pio.run) while the CPU's execute() burns
        // 1,000,000 instructions/tick — so a CPU tick (~hundreds of ms wall)
        // starves the PIO, which only gets 1000 steps between ticks. With a
        // non-dropping FIFO the PIO must bit-bang every firmware word, making the
        // ~224KB download take 1000x too long. The gSPI PIO runs near the system
        // clock (clkdiv ~1-2), so let it do up to 1M steps/tick, breaking early
        // once all TX FIFOs are drained to avoid spinning when idle.
        if (typeof pio.run === 'function') {
          pio.run = () => {
            for (let i = 0; i < 1_000_000 && !pio.stopped; i++) {
              pio.step();
              if (i >= 2000 && (i & 1023) === 0) {
                let pending = false;
                for (const m of pio.machines) {
                  if (m.txFIFO && !m.txFIFO.empty) { pending = true; break; }
                }
                if (!pending) break;
              }
            }
            if (!pio.stopped) pio.runTimer = setTimeout(() => pio.run(), 0);
          };
        }
      }

      // Drive the WL_HOST_WAKE line (GPIO24 on Pico W). The driver's
      // poll_device gates ALL bus access on this pin being high until it has
      // received its first packet (cyw43_ll.c had_successful_packet). Without
      // it, the first IOCTL (clm_load) is sent but the driver then polls
      // forever getting -1 and never reads the response. Active-high.
      let hostWakeHigh = false;
      chip.onHostWake((active: boolean) => {
        hostWakeHigh = active;
        try { (sim.rp2040 as any).gpio[24].setInputValue(active); } catch { /* noop */ }
      });
      void hostWakeHigh;

      // ── raw REPL injection (mirrors test_micropython_pico.mjs) ──
      const cdc = new USBCDC(sim.rp2040.usbCtrl);
      let serial = '';
      let buf = '';
      let state: 'idle' | 'prompt' | 'raw' | 'done' = 'idle';
      let reachedImport = false;
      let reachedActive = false;

      cdc.onDeviceConnected = () => {
        usbConnected = true;
        cdc.sendSerialByte('\r'.charCodeAt(0));
        cdc.sendSerialByte('\n'.charCodeAt(0));
      };

      function sendCode() {
        const bytes = Array.from(new TextEncoder().encode(INJECT_CODE));
        let off = 0;
        const chunk = () => {
          if (off >= bytes.length) {
            setTimeout(() => { cdc.sendSerialByte(0x04); state = 'done'; }, 200);
            return;
          }
          for (const b of bytes.slice(off, off + 64)) cdc.sendSerialByte(b);
          off += 64;
          setTimeout(chunk, 120);
        };
        chunk();
      }

      cdc.onSerialData = (bytes: Uint8Array) => {
        for (const b of bytes) { const ch = String.fromCharCode(b); serial += ch; buf += ch; }
        if (state === 'idle' && buf.includes('>>>')) {
          state = 'prompt'; buf = '';
          setTimeout(() => cdc.sendSerialByte(0x01), 150); // Ctrl+A raw REPL
        }
        if (state === 'prompt' && buf.includes('raw REPL')) {
          state = 'raw'; buf = '';
          setTimeout(sendCode, 150);
        }
        if (serial.includes('STEP_IMPORT_OK')) reachedImport = true;
        if (serial.includes('STEP_ACTIVE')) reachedActive = true;
        if (serial.length > 60000) serial = serial.slice(-20000);
        if (serial.includes('HARNESS_DONE') || serial.includes('Traceback')) {
          setTimeout(finish, 300); // let the last line flush
        }
      };

      let finished = false;
      // Sample the CPU PC between sim ticks to find busy-wait loops (the driver
      // blocks in active(True) with no bus activity, so a PC histogram localizes
      // the stuck loop — DMA wait, TXSTALL wait, or a delay).
      const pcHist = new Map<number, number>();
      const pcSampler = setInterval(() => {
        const pc = ((sim.rp2040 as any).core?.PC ?? 0) >>> 0;
        pcHist.set(pc, (pcHist.get(pc) ?? 0) + 1);
      }, 20);
      const deadline = setTimeout(finish, 70_000);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(pcSampler);
        // Snapshot the PIO/SM state BEFORE stopping — this is the deadlock state.
        let pioState = '';
        try {
          let pi = 0;
          for (const pio of (sim.rp2040 as any).pio) {
            pioState += `PIO${pi} stopped=${pio.stopped} fdebug=0x${(pio.fdebug >>> 0).toString(16)} txStall=0x${(pio.txStall >>> 0).toString(16)}\n`;
            let si = 0;
            for (const sm of pio.machines) {
              const tx = sm.txFIFO;
              pioState += `  SM${si} en=${sm.enabled} waiting=${sm.waiting} waitType=${sm.waitType} ` +
                `pc=${sm.pc ?? '?'} txDepth=${tx ? tx.itemCount : '?'} rxDepth=${sm.rxFIFO ? sm.rxFIFO.itemCount : '?'}\n`;
              si++;
            }
            pi++;
          }
        } catch (e) { pioState = `pioState err: ${String(e)}`; }
        try { sim.stop(); } catch { /* noop */ }
        const polls = [...cmdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        const report =
          `fwBlocks=${fwBlocks} usbConnected=${usbConnected} ` +
          `state=${state} serialLen=${serial.length} traceLen=${trace.length} ` +
          `reachedImport=${reachedImport} reachedActive=${reachedActive} ledOn=${ledOn}\n\n` +
          '===== SERIAL OUTPUT (tail 2500) =====\n' + serial.slice(-2500) + '\n\n' +
          '===== TOP COMMAND COUNTS (poll loops) =====\n' +
          polls.map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`).join('\n') + '\n\n' +
          `===== FUNCTION HISTOGRAM F0..F3 = ${funcHist.join(',')} =====\n` +
          `===== initInbound=${initInbound} statusReads=${statusReads} statusReadsWithPkt=${statusReadsWithPkt} finalInbound=${chip.debugInboundCount()} restarts=${restartCount} =====\n` +
          `===== pushCount=${pushCount} txPulls=${txPulls} smSteps=${smSteps} =====\n` +
          `===== IOCTL ${chip.debugIoctlStats()} =====\n` +
          '===== IOCTL SEQUENCE =====\n' + chip.debugIoctlLog().map((s, i) => `  ${i}: ${s}`).join('\n') + '\n' +
          `===== restartsAtClm=${restartsAtClm} restartsFinal=${restartCount} rxPulled=${rxPulled} =====\n` +
          `===== CPU FAULTS faultCount=${faultCount} =====\n` + faultLog.join('\n') + '\n' +
          '===== HOT PCs (busy-wait localization) =====\n' +
          [...pcHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
            .map(([pc, n]) => `  ${String(n).padStart(6)}  PC=0x${pc.toString(16)}`).join('\n') + '\n\n' +
          '===== PIO/SM STATE AT DEADLINE (deadlock) =====\n' + pioState + '\n' +
          '===== F2/IOCTL TRANSFERS (total seen, non-ring) =====\n' +
          `count=${f2Log.length}\n` + f2Log.join('\n') + '\n\n' +
          '===== POST-CLM_LOAD (verbatim from first F2 write) =====\n' + postF2.join('\n') + '\n\n' +
          '===== TRACE TAIL (post-firmware) =====\n' + trace.slice(-120).join('\n') + '\n\n' +
          '===== LAST RAW TX WORDS (hex) — the end of the run =====\n' +
          rawWords.slice(-70).map((w) => w.toString(16).padStart(8, '0')).join(' ') + '\n';
        try { writeFileSync('/tmp/cyw43-trace.txt', report); } catch { /* noop */ }
        resolve({
          serial,
          trace,
          reachedImport,
          reachedActive,
          lastCmds: trace.slice(-60),
          pollSummary: polls,
        });
      }

      sim.rp2040.core.PC = 0x10000000;
      sim.execute();
    });

    // ── report ──
    console.log('\n===== SERIAL OUTPUT (tail) =====\n' + result.serial.slice(-1500));
    console.log('\n===== TOP COMMAND COUNTS (poll loops) =====');
    for (const [k, n] of result.pollSummary) console.log(`  ${n.toString().padStart(6)}  ${k}`);
    console.log('\n===== LAST 60 TRACE LINES =====\n' + result.lastCmds.join('\n'));
    console.log('\n===== reachedImport=' + result.reachedImport + ' reachedActive=' + result.reachedActive + ' =====');

    expect(result.trace.length).toBeGreaterThan(0);
  }, 90_000);
});
