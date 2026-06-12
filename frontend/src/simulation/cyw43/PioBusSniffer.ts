/**
 * pio_bus_sniffer
 *
 * Decodes the 32-bit gSPI command words that the cyw43 PIO program
 * shifts out on the Pico W's WL_DATA pin. The PIO program transmits
 * MSB-first in 16-bit halfwords and the driver swaps halfwords before
 * presenting them to the wire — see
 *   pico-sdk/src/rp2_common/pico_cyw43_driver/cyw43_bus_pio_spi.pio
 *
 * This is a **passive** observer. It accepts a stream of 32-bit words
 * coming out of the PIO TX FIFO and reassembles them into typed
 * commands the higher layer can act on.
 *
 * It deliberately does NOT touch the real CYW43 driver source — every
 * constant below is derived from the open spec or open driver code,
 * not from the closed firmware.
 */

export interface Cyw43Cmd {
  /** Raw 32-bit header as transmitted (after PIO halfword swap is undone). */
  rawHeader: number;
  /** 1 = host writing to chip, 0 = chip writing to host. */
  write: boolean;
  /** Address auto-increments inside the function space when set. */
  increment: boolean;
  /** 0 = F0/SPI bus regs, 1 = F1/backplane, 2 = F2/data. */
  function: 0 | 1 | 2 | 3;
  /** 17-bit address inside the chosen function. */
  address: number;
  /** Byte length following the header. 0–2048. */
  length: number;
}

/**
 * Decode a single 32-bit header word into a Cyw43Cmd. The argument is
 * the value already in **host byte order** — caller is responsible for
 * undoing the PIO halfword swap before passing it in.
 */
export function decodeHeader(hdr: number): Cyw43Cmd {
  // Cap to 32 bits — JS numbers are doubles, bitops are 32-bit signed.
  const h = hdr >>> 0;
  return {
    rawHeader: h,
    write: ((h >>> 31) & 1) === 1,
    increment: ((h >>> 30) & 1) === 1,
    function: ((h >>> 28) & 0b11) as 0 | 1 | 2 | 3,
    address: (h >>> 11) & 0x1ffff,
    length: h & 0x7ff,
  };
}

/**
 * Undo the PIO program's 16-bit halfword swap. The driver computes
 *   wire = ((host_word & 0xffff) << 16) | ((host_word >> 16) & 0xffff)
 * before pushing into the TX FIFO; this reverses it.
 */
export function swap16x2(word: number): number {
  const w = word >>> 0;
  return (((w & 0xffff) << 16) | ((w >>> 16) & 0xffff)) >>> 0;
}

/** Reverse the 4 bytes of a word (32-bit big-endian regime). */
export function bswap32be(word: number): number {
  const w = word >>> 0;
  return (((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24)) >>> 0;
}

/**
 * The driver shifts data as 32-bit words via PIO `out pins, 1` over
 * 32 cycles per word. This streamer accepts whole 32-bit words pulled
 * off the PIO TX FIFO and yields fully-decoded commands once the
 * trailing payload bytes are present.
 *
 * Usage:
 *
 *   const sniffer = new PioBusSniffer();
 *   for (const word of pioTxFifoStream) {
 *     for (const ev of sniffer.feedWord(word)) {
 *       handle(ev);
 *     }
 *   }
 */
export type SnifferEvent =
  | { kind: 'header'; cmd: Cyw43Cmd }
  | { kind: 'payload'; cmd: Cyw43Cmd; payload: Uint8Array; readBytes: number };

/**
 * Transfer-aware decoder for the real cyw43_bus_pio_spi protocol.
 *
 * Per cyw43_spi_transfer() (pico-sdk), every transfer pushes this exact
 * sequence of 32-bit words into the PIO TX FIFO:
 *
 *     [ tx_length*8 - 1 ]                 // OUT X,32 — bits to shift OUT
 *     [ (rx_length - tx_length)*8 - 1 ]   // OUT Y,32 — bits to shift IN (0 for write)
 *     [ command word ]                    // DMA, byte-swapped
 *     [ write_data... ]                   // DMA, only for writes (tx_length > 4)
 *
 * The first two words are PIO loop counters consumed by manual OUT X/Y
 * execs — they are NOT bus traffic. Read responses come back on the RX
 * FIFO, not TX, so a READ transfer puts only [count][count][cmd] on TX.
 *
 * The old decoder treated every first word as a command header, which
 * mis-decoded the count word (e.g. 31 -> "RD F0 0x3e0") and desynced the
 * whole stream, so the driver's bus-control writes never landed and
 * cyw43_ll_bus_init() failed with EPERM.
 *
 * NOTE on swaps: the count words arrive raw (pio_sm_put, no DMA bswap);
 * the command/data words arrive byte-swapped by the DMA, which combined
 * with the PIO halfword order is undone by swap16x2() (verified against a
 * real boot: the READ_TEST 0x14 header decodes correctly this way).
 */
type DecodeState = 'outCount' | 'inCount' | 'cmd' | 'writeData';

export class PioBusSniffer {
  private state: DecodeState = 'outCount';
  private outBytes = 0;
  private readBytes = 0;
  private wordsLeft = 0;
  private cmd: Cyw43Cmd | null = null;
  private writeBuf: number[] = [];

  /**
   * Word-order regime provider. Boot (16-bit-LE) commands+data are SWAP32'd by
   * the driver and recovered with swap16(); after SPI_BUS_CONTROL the chip is
   * 32-bit big-endian and the words arrive un-swapped. The emulator owns this
   * state (it sees the SPI_BUS_CONTROL write); we read it at decode time.
   */
  private bigEndian: () => boolean = () => false;
  setModeProvider(fn: () => boolean): void { this.bigEndian = fn; }

  /** Apply the regime-appropriate de-swap to a command/data word. */
  private deswap(raw: number): number {
    // Boot (16-bit-LE, driver SWAP32s the command) → swap16x2 recovers it.
    // 32-BE (after SPI_BUS_CONTROL) → the bus is big-endian, so the word is
    // byte-reversed → bswap32 recovers it.
    return this.bigEndian() ? bswap32be(raw) : swap16x2(raw);
  }

  /** Reset framing — call when the SM/transfer machinery is restarted. */
  reset(): void {
    this.state = 'outCount';
    this.cmd = null;
    this.writeBuf = [];
  }

  /** Debug hook (tests): fired with each count word's raw value + decode. */
  onCount: ((kind: 'out' | 'in', raw: number, bytes: number) => void) | null = null;

  /**
   * True while the in-flight transfer is a large non-F2 write — i.e. a firmware
   * download block (or any backplane bulk write the chip discards). The host
   * pushes ~224 KB of these; their data words carry no information the emulator
   * needs (firmware lands in chip SRAM we don't model), so a non-dropping FIFO
   * forces the PIO to bit-bang every one and the emulation crawls. The harness
   * uses this to drop those data words while keeping F2/SDPCM writes (IOCTLs)
   * and every command/count word intact. 36 bytes = count(0) + cmd(4) + a few
   * config words; firmware blocks are 64-byte payloads, well above it.
   */
  inDiscardableWriteData(): boolean {
    return this.state === 'writeData' && this.cmd?.function !== 2 && this.outBytes > 36;
  }

  *feedWord(rawWord: number): Generator<SnifferEvent> {
    const raw = rawWord >>> 0;

    switch (this.state) {
      case 'outCount': {
        // count1 = tx_length*8 - 1, with tx_length a multiple of 4 (cmd + data,
        // all 4-aligned) and tx_length <= 2048+4. Any word that doesn't fit that
        // is NOT a transfer start — it's a stray word (rp2040js pushes one extra
        // after a large write) or firmware-download data (which we discard). Skip
        // it and stay in outCount, so the framing self-heals at the next real
        // transfer. This also fast-paths the ~224 KB firmware stream: every data
        // word fails validation and is skipped until the post-download HT-clock
        // poll re-syncs us.
        const ob = (raw + 1) / 8;
        if (raw === 0 || ((raw + 1) & 31) !== 0 || ob > 2052) return;
        this.outBytes = ob;
        this.onCount?.('out', raw, this.outBytes);
        this.state = 'inCount';
        return;
      }
      case 'inCount': {
        // (rx_length - tx_length)*8 - 1  ->  bytes the chip drives back.
        // A write pushes literal 0 here (no read phase).
        this.readBytes = raw === 0 ? 0 : Math.round((raw + 1) / 8);
        this.onCount?.('in', raw, this.readBytes);
        // outBytes/4 words follow: word 0 = command, rest = write data.
        this.wordsLeft = Math.max(1, Math.round(this.outBytes / 4));
        this.writeBuf = [];
        this.cmd = null;
        this.state = 'cmd';
        return;
      }
      case 'cmd': {
        const cmd = decodeHeader(this.deswap(raw));
        this.cmd = cmd;
        this.wordsLeft -= 1;
        yield { kind: 'header', cmd };
        if (this.wordsLeft <= 0) {
          // Command-only transfer: a read, or a write with no data word.
          yield { kind: 'payload', cmd, payload: new Uint8Array(0), readBytes: this.readBytes };
          this.state = 'outCount';
        } else {
          this.state = 'writeData';
        }
        return;
      }
      case 'writeData': {
        const w = this.deswap(raw);
        // Write data is little-endian within the de-swapped word.
        for (let i = 0; i < 4; i++) this.writeBuf.push((w >>> (i * 8)) & 0xff);
        this.wordsLeft -= 1;
        if (this.wordsLeft <= 0) {
          const dataLen = Math.max(0, this.outBytes - 4);
          const payload = new Uint8Array(this.writeBuf.slice(0, dataLen));
          yield { kind: 'payload', cmd: this.cmd!, payload, readBytes: this.readBytes };
          this.state = 'outCount';
        }
        return;
      }
    }
  }
}

/** Pretty-print a command for debug logs. */
export function formatCmd(cmd: Cyw43Cmd): string {
  const dir = cmd.write ? 'WR' : 'RD';
  const fnName = ['F0', 'F1', 'F2', 'F3'][cmd.function];
  const inc = cmd.increment ? '+' : ' ';
  return `${dir} ${fnName}${inc} addr=0x${cmd.address.toString(16).padStart(5, '0')} len=${cmd.length}`;
}
