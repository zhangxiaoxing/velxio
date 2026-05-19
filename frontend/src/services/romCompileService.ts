/**
 * Frontend wrapper for POST /api/compile-rom — compiles a chip-program file
 * (8080 ASM, Intel HEX, raw .bin) into base64 ROM bytes that get stored on
 * a custom-chip component's `romBytes` property. The chip's emulator then
 * reads those bytes at chip_setup via vx_rom_size / vx_rom_read.
 */

export type RomTarget = '8080' | 'z80' | '8086' | '4004';
export type RomFormat = 'asm' | 'hex' | 'bin' | 'c';

export interface RomCompileResult {
  success: boolean;
  rom_base64: string | null;
  byte_size: number;
  stderr: string;
  error: string | null;
}

const BASE = '/api/compile-rom';

export async function compileRom(
  source: string,
  target: RomTarget,
  format: RomFormat,
): Promise<RomCompileResult> {
  const res = await fetch(`${BASE}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ source, target, format }),
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      success: false,
      rom_base64: null,
      byte_size: 0,
      stderr: '',
      error: `HTTP ${res.status}: ${text}`,
    };
  }
  return (await res.json()) as RomCompileResult;
}

/** Classify a filename as a chip-program file (vs an Arduino sketch).
 *
 * `.c` is intentionally NOT in the always-list — Arduino sketches use .c
 * too. The toolbar disambiguates by checking whether a custom-chip on
 * the canvas has `programFile === activeFile.name`. If yes, .c is a chip
 * program (SDCC route); if no, it's an Arduino sketch (arduino-cli route).
 */
export function isChipProgramFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.s') ||
    lower.endsWith('.asm') ||
    lower.endsWith('.hex') ||
    lower.endsWith('.bin')
  );
}

/** Pick a sensible compile format from the filename extension. */
export function formatForFile(name: string): RomFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.hex')) return 'hex';
  if (lower.endsWith('.bin')) return 'bin';
  if (lower.endsWith('.c') || lower.endsWith('.cpp')) return 'c';
  return 'asm';
}

/** Pick the right target CPU from the chip's chip.json programTargets,
 *  falling back to 8080 (the only one wired up today). */
export function targetForChip(chipJsonStr: string): RomTarget {
  try {
    const obj = JSON.parse(chipJsonStr);
    if (Array.isArray(obj.programTargets) && obj.programTargets.length > 0) {
      const t = String(obj.programTargets[0]).toLowerCase();
      if (t === '8080' || t === 'z80' || t === '8086' || t === '4004') return t;
    }
  } catch { /* ignore */ }
  return '8080';
}
