/**
 * Retro Intel/Zilog CPU examples.
 *
 * These projects place Velxio's bundled "i8080 mini-computer" custom chips
 * on the canvas pre-wired to Arduino Uno boards. Because custom chips are
 * shipped as C source (the WASM is compiled on demand by the backend), each
 * example arrives with sourceC + chipJson populated and wasmBase64 empty —
 * the user clicks the chip and hits "Compile" once to materialize the WASM.
 *
 * After that the project runs end-to-end: the i8080-repl example streams a
 * banner + uptime counter via UART to the Serial Monitor, and the
 * i8080-counter example uses two pushbuttons to drive an 8-LED counter.
 *
 * Sources for the chip programs live alongside the chip in
 * `frontend/src/components/customChips/examples/intel/`, with the original
 * 8080 assembly under `scripts/repl-rom.s` and `scripts/counter-rom.s`.
 */
import type { ExampleProject } from './examples';

// We re-import the chip sources here so the example payload is fully
// self-describing — no runtime lookup into chipExamples.ts. This keeps
// project saves/loads independent from the chip gallery.
import i8080ReplC      from '../components/customChips/examples/intel/i8080-repl.c?raw';
import i8080ReplJ      from '../components/customChips/examples/intel/i8080-repl.chip.json?raw';
import i8080CounterC   from '../components/customChips/examples/intel/i8080-counter.c?raw';
import i8080CounterJ   from '../components/customChips/examples/intel/i8080-counter.chip.json?raw';
import i8080CpuC       from '../components/customChips/examples/intel/i8080-cpu.c?raw';
import i8080CpuJ       from '../components/customChips/examples/intel/i8080-cpu.chip.json?raw';
import z80CpuC         from '../components/customChips/examples/intel/z80-cpu.c?raw';
import z80CpuJ         from '../components/customChips/examples/intel/z80-cpu.chip.json?raw';

const chaserZ80C = `/* LED chaser written in C, compiled to Z80 by SDCC.
 *
 * Demonstrates that you can program the Z80 chip in C (not just asm).
 * The backend runs:
 *     sdcc -mz80 --code-loc 0x100 --data-loc 0x8000 program.c
 * and feeds the resulting Intel HEX into the chip via vx_rom_read.
 *
 * The MMIO addresses (0xC000 LED, 0xC003 BTN, 0xC001 UART_DATA,
 * 0xC002 UART_STAT) match the z80-cpu chip's memory map.
 *
 * Behaviour: walks a single LED back and forth across the 8 outputs
 * (true Larson scanner, with direction reversal).
 */
#define LED_OUT   (*(volatile unsigned char __at(0xC000)))
#define BTN_IN    (*(volatile unsigned char __at(0xC003)))

static void delay(unsigned int loops) {
    while (loops--) {
        __asm
        nop
        nop
        nop
        nop
        __endasm;
    }
}

void main(void) {
    unsigned char bit = 0x01;
    char dir = 1;          /* +1 = walking left, -1 = walking right */
    while (1) {
        LED_OUT = bit;
        delay(5000);

        if (dir > 0) {
            bit <<= 1;
            if (bit == 0x80) dir = -1;
        } else {
            bit >>= 1;
            if (bit == 0x01) dir = 1;
        }
    }
}
`;

const chaserZ80CSketch = `// Z80 LED chaser — the program is written in C (chaser.c) and compiled to
// the Z80 by SDCC on the backend.
//
// Just click Run. Velxio does the rest automatically:
//   1. compiles the z80-cpu chip's C source to WASM,
//   2. compiles chaser.c to a Z80 ROM (sdcc -mz80) and loads it into the chip,
//   3. compiles this (empty) Arduino sketch and starts the simulation.
// A single LED then walks back and forth across the 8 outputs.
//
// Want to change the animation? Edit chaser.c and hit Run again.

void setup() {}
void loop() {}
`;

const larsonZ80Asm = `; Larson Scanner / Knight Rider in Z80 assembly.
;
; A single LED walks left across 8 LEDs forever. Uses JR/DJNZ/RLCA --
; Z80 instructions the 8080 emulator can't run. The pattern wraps from
; bit 7 back to bit 0 thanks to RLCA's circular rotation.

        ORG 0x0000

        LD   SP, 0xBFFF        ; stack at top of RAM
        LD   A, 0x01           ; A = bit pattern (start at LED0)

loop:
        LD   (0xC000), A       ; write to LED port
        PUSH AF
        CALL delay
        POP  AF
        RLCA                   ; rotate left (bit 7 -> bit 0)
        JR   loop

; -- delay: ~80 ms outer loop -------------------------------------------
delay:
        LD   C, 80
outer:
        LD   B, 0              ; 0 = 256 inner iterations
inner:
        DJNZ inner
        DEC  C
        JR   NZ, outer
        RET
`;

const larsonZ80Sketch = `// Z80 Larson Scanner -- Arduino Uno companion sketch.
//
// The Z80 chip on the canvas runs the larson.s program. This Arduino
// sketch just keeps Serial alive in case you wire UART later.
//
// Just click Run. Velxio automatically compiles the z80-cpu chip to WASM,
// assembles larson.s into a Z80 ROM, loads it into the chip, and starts the
// simulation. A single bit then walks across the 8 LEDs.
//
// To slow it down or speed it up: change the "LD C, 80" line in larson.s
// (higher number = slower), then hit Run again.

void setup() {}
void loop() {}
`;

const killbitsAsm = `; Kill the Bit -- Dean McDaniel, May 15, 1975. Public domain.
;
; The classic Altair 8800 front-panel reflex game adapted to Velxio.
; A single LED walks across the 8 LEDs; press the matching button at
; the right moment to "kill" the bit. Miss, and an extra bit lights up
; next pass. Get all bits out to win.
;
; This file is the ROM image for the programmable i8080-cpu chip. Click
; Compile to assemble it (calls /api/compile-rom on the backend), then
; click Run to start the 8080 emulator.

        ORG 0x0000

        LXI  SP, 0xBFFF      ; stack at top of RAM
        LXI  H, 0x0000       ; delay accumulator
        MVI  D, 0x80         ; D = bit pattern (start: LED7 lit)
        LXI  B, 0x0E00       ; delay step

beat:
        DAD  B               ; loop ~18 times per visible frame
        JNC  beat

        ; One tick: show pattern + sample buttons + advance bit.
        MOV  A, D
        STA  0xC000          ; LED port

        LDA  0xC003          ; button bitmap
        XRA  D               ; matching bits cancel
        RRC                  ; rotate right
        MOV  D, A

        JMP  beat
`;

const killbitsSketch = `// Kill the Bit -- Arduino Uno companion sketch.
//
// All the action happens in the i8080-cpu chip on the canvas. This sketch
// just keeps Serial alive in case you wire UART later. Watch the LEDs and
// press the matching button on each beat.
//
// Steps:
//   1. Open killbits.s in the editor.
//   2. Click Compile -- the backend assembles the 28-byte ROM and injects
//      it into the i8080-cpu chip's romBytes property.
//   3. Click Run. A single LED will start walking across the 8 outputs.
//   4. Press the button (BTN0..BTN7) below the lit LED to "kill" the bit.

void setup() {}
void loop() {}
`;

const replSketch = `// i8080 banner streamer
//
// The bundled i8080 chip on the canvas runs its own embedded ROM. All
// this Arduino sketch does is set up Serial and forward bytes back and
// forth: the chip's UART output arrives at the AVR's RX path, the sketch
// echoes each byte so the Serial Monitor displays it.
//
// Steps:
//   1. Double-click the chip, switch to the Editor tab, click Compile.
//      (The backend compiles the embedded 8080 emulator + ROM to WASM.)
//   2. Hit Save, then Run.
//   3. Open the Serial Monitor — you should see the banner followed by
//      "uptime ticks: 0xNN" lines incrementing every ~50 ms, all driven
//      by real Intel 8080 instructions running in WASM.

void setup() {
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    Serial.write(c);
  }
}
`;

const counterSketch = `// i8080 button counter
//
// The bundled i8080 chip on the canvas runs its own embedded ROM that
// increments a counter on every BTN_INC press and clears it on BTN_RST.
// The current value drives LED0..LED7 in binary.
//
// Steps:
//   1. Double-click the chip, switch to the Editor tab, click Compile.
//   2. Hit Save, then Run.
//   3. Click BTN_INC repeatedly to count up. Click BTN_RST to clear.
//      The 8 LEDs show the current count in binary.
//
// The Arduino sketch itself does nothing — the 8080 is the brain of
// this little board.

void setup() {
}

void loop() {
}
`;

export const retroIntelExamples: ExampleProject[] = [
  {
    id: 'i8080-banner-streamer',
    title: 'Intel 8080 Banner Streamer',
    description:
      'A clean-room Intel 8080 boots from a 328-byte embedded ROM, prints a banner, ' +
      'then prints "uptime ticks: 0xNN" every ~50 ms. Open the Serial Monitor to watch.',
    category: 'circuits',
    difficulty: 'advanced',
    boardType: 'arduino-uno',
    tags: ['retro', '8080', 'cpu', 'uart', 'wasm', 'custom-chip', 'serial'],
    code: replSketch,
    components: [
      {
        type: 'custom-chip',
        id: 'i8080',
        x: 480,
        y: 140,
        properties: {
          chipName: 'i8080 Mini-Computer (Banner)',
          sourceC: i8080ReplC,
          chipJson: i8080ReplJ,
          wasmBase64: '',
        },
      },
    ],
    wires: [
      // Chip TX → Arduino RX (D0) — visual only; the UART bridge routes
      // bytes through the simulator's USART regardless of wire topology.
      {
        id: 'i8080-tx',
        start: { componentId: 'i8080', pinName: 'TX' },
        end: { componentId: 'arduino-uno', pinName: '0' },
        color: '#7be38b',
      },
      {
        id: 'i8080-rx',
        start: { componentId: 'i8080', pinName: 'RX' },
        end: { componentId: 'arduino-uno', pinName: '1' },
        color: '#ffb648',
      },
      {
        id: 'i8080-vcc',
        start: { componentId: 'i8080', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'i8080-gnd',
        start: { componentId: 'i8080', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'i8080-button-counter',
    title: 'Intel 8080 Button Counter',
    description:
      'A self-contained Intel 8080 chip running a 34-byte ROM. Press the INC button to count up ' +
      'in binary on 8 LEDs, press the RST button to clear. The CPU, RAM, and program are all ' +
      'inside the single chip on the canvas.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardType: 'arduino-uno',
    tags: ['retro', '8080', 'cpu', 'leds', 'buttons', 'wasm', 'custom-chip'],
    code: counterSketch,
    components: [
      {
        type: 'custom-chip',
        id: 'i8080c',
        x: 380,
        y: 120,
        properties: {
          chipName: 'i8080 Button Counter',
          sourceC: i8080CounterC,
          chipJson: i8080CounterJ,
          wasmBase64: '',
        },
      },
      // 8 LEDs for the binary readout
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 700 + i * 50,
        y: 120,
        properties: { color: i < 4 ? 'red' : 'orange' },
      })),
      // 2 buttons
      {
        type: 'wokwi-pushbutton',
        id: 'btn-inc',
        x: 380,
        y: 420,
        properties: { color: 'green' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-rst',
        x: 540,
        y: 420,
        properties: { color: 'red' },
      },
    ],
    wires: [
      // LED data wires
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}`,
        start: { componentId: 'i8080c', pinName: `LED${i}` },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      // LED GNDs
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}-gnd`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      })),
      // Buttons
      {
        id: 'wire-btn-inc',
        start: { componentId: 'btn-inc', pinName: '1.l' },
        end: { componentId: 'i8080c', pinName: 'BTN_INC' },
        color: '#22c55e',
      },
      {
        id: 'wire-btn-rst',
        start: { componentId: 'btn-rst', pinName: '1.l' },
        end: { componentId: 'i8080c', pinName: 'BTN_RST' },
        color: '#ef4444',
      },
      {
        id: 'wire-btn-inc-pwr',
        start: { componentId: 'btn-inc', pinName: '2.r' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-btn-rst-pwr',
        start: { componentId: 'btn-rst', pinName: '2.r' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-i8080c-vcc',
        start: { componentId: 'i8080c', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-i8080c-gnd',
        start: { componentId: 'i8080c', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ── Kill-the-Bit (1975) — first example using the PROGRAMMABLE i8080-cpu chip ──
  {
    id: 'i8080-killbits',
    title: 'Kill the Bit (1975)',
    description:
      "Dean McDaniel's iconic 1975 Altair 8800 reflex game, running on a programmable Intel 8080 chip. " +
      'A single LED walks across 8 LEDs; press the matching button at the right moment to kill it. ' +
      'The ROM lives in killbits.s as a project file — click Compile to assemble it, then Run.',
    category: 'games',
    difficulty: 'advanced',
    boardType: 'arduino-uno',
    tags: ['retro', '8080', 'cpu', 'leds', 'buttons', 'game', 'altair', 'wasm', 'custom-chip', 'asm', 'programmable'],
    code: killbitsSketch,
    files: [
      { name: 'sketch.ino', content: killbitsSketch },
      { name: 'killbits.s', content: killbitsAsm },
    ],
    components: [
      {
        type: 'custom-chip',
        id: 'i8080cpu',
        x: 380,
        y: 120,
        properties: {
          chipName: 'i8080 CPU (programmable)',
          sourceC: i8080CpuC,
          chipJson: i8080CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'killbits.s',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 700 + i * 50,
        y: 120,
        properties: { color: i < 4 ? 'yellow' : 'orange' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-pushbutton',
        id: `btn-${i}`,
        x: 700 + i * 50,
        y: 380,
        properties: { color: 'green' },
      })),
    ],
    wires: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}`,
        start: { componentId: 'i8080cpu', pinName: `LED${i}` },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}-gnd`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-btn-${i}`,
        start: { componentId: `btn-${i}`, pinName: '1.l' },
        end: { componentId: 'i8080cpu', pinName: `BTN${i}` },
        color: '#22c55e',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-btn-${i}-pwr`,
        start: { componentId: `btn-${i}`, pinName: '2.r' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      })),
      {
        id: 'wire-cpu-vcc',
        start: { componentId: 'i8080cpu', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-cpu-gnd',
        start: { componentId: 'i8080cpu', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ── Z80 Larson Scanner — first example on the programmable z80-cpu ──
  {
    id: 'z80-larson-scanner',
    title: 'Z80 Larson Scanner',
    description:
      'A single LED walks left across 8 LEDs, Knight-Rider style. Z80 program lives in larson.s ' +
      '(JR + DJNZ + RLCA — instructions the 8080 emulator can\'t run). Click Compile, then Run.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardType: 'arduino-uno',
    tags: ['retro', 'z80', 'zilog', 'cpu', 'leds', 'larson', 'knight-rider', 'wasm', 'custom-chip', 'asm', 'programmable'],
    code: larsonZ80Sketch,
    files: [
      { name: 'sketch.ino', content: larsonZ80Sketch },
      { name: 'larson.s',   content: larsonZ80Asm },
    ],
    components: [
      {
        type: 'custom-chip',
        id: 'z80cpu',
        x: 380,
        y: 120,
        properties: {
          chipName: 'Z80 CPU (programmable)',
          sourceC: z80CpuC,
          chipJson: z80CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'larson.s',
          programTarget: 'z80',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 700 + i * 50,
        y: 120,
        properties: { color: i % 2 === 0 ? 'red' : 'orange' },
      })),
    ],
    wires: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}`,
        start: { componentId: 'z80cpu', pinName: `LED${i}` },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#ef4444',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}-gnd`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      })),
      {
        id: 'wire-z80-vcc',
        start: { componentId: 'z80cpu', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-z80-gnd',
        start: { componentId: 'z80cpu', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ── Z80 LED chaser in C (SDCC) ─────────────────────────────────────
  {
    id: 'z80-led-chaser-c',
    title: 'Z80 LED Chaser (C via SDCC)',
    description:
      'Same z80-cpu chip, but the program is written in C and compiled by SDCC at compile time. ' +
      'A single LED walks back and forth Larson-style. Requires sdcc installed on the backend.',
    category: 'circuits',
    difficulty: 'advanced',
    boardType: 'arduino-uno',
    tags: ['retro', 'z80', 'zilog', 'cpu', 'leds', 'larson', 'c', 'sdcc', 'wasm', 'custom-chip', 'programmable'],
    code: chaserZ80CSketch,
    files: [
      { name: 'sketch.ino', content: chaserZ80CSketch },
      { name: 'chaser.c',   content: chaserZ80C },
    ],
    components: [
      {
        type: 'custom-chip',
        id: 'z80cpu',
        x: 380,
        y: 120,
        properties: {
          chipName: 'Z80 CPU (programmable)',
          sourceC: z80CpuC,
          chipJson: z80CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'chaser.c',
          programTarget: 'z80',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 700 + i * 50,
        y: 120,
        properties: { color: 'red' },
      })),
    ],
    wires: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}`,
        start: { componentId: 'z80cpu', pinName: `LED${i}` },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-led-${i}-gnd`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      })),
      {
        id: 'wire-z80c-vcc',
        start: { componentId: 'z80cpu', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'wire-z80c-gnd',
        start: { componentId: 'z80cpu', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
];
