/**
 * PinManager - Manages Arduino pin states and notifies listeners
 *
 * Maps AVR PORT registers to Arduino pin numbers.
 *
 * Arduino Uno / Nano (ATmega328P):
 * - PORTB (0x25) → Digital pins 8-13
 * - PORTC (0x28) → Analog pins A0-A5 (14-19)
 * - PORTD (0x2B) → Digital pins 0-7
 *
 * Arduino Mega 2560 (ATmega2560): uses explicit per-bit pin maps
 * for non-linear port ↔ Arduino-pin relationships.
 *
 * Also supports:
 * - Analog voltage injection (for potentiometers, sensors)
 * - PWM duty cycle tracking (for servos, RGB LEDs, buzzers)
 */

export type PinState = boolean;
export type PinChangeCallback = (pin: number, state: PinState) => void;
export type AnalogCallback = (pin: number, voltage: number) => void;
export type PwmCallback = (pin: number, dutyCycle: number) => void;

export class PinManager {
  private listeners: Map<number, Set<PinChangeCallback>> = new Map();
  private pwmListeners: Map<number, Set<PwmCallback>> = new Map();
  private analogListeners: Map<number, Set<AnalogCallback>> = new Map();
  private pinStates: Map<number, boolean> = new Map();
  private pwmValues: Map<number, number> = new Map();
  // Pins the MCU has driven (digitalWrite / PWM / port-listener fire).
  // Consumed by collectPinStates.ts to emit a SPICE V-source only for
  // real outputs — leaving INPUT pins floating so external sensors
  // (NTC + divider on A0, photoresistor, etc.) don't get clamped to
  // the MCU's idle V-source.
  private outputPins: Set<number> = new Set();

  // ── Digital pin API ──────────────────────────────────────────────────────

  /**
   * Register callback for digital pin state changes.
   * Returns unsubscribe function.
   */
  onPinChange(arduinoPin: number, callback: PinChangeCallback): () => void {
    if (!this.listeners.has(arduinoPin)) {
      this.listeners.set(arduinoPin, new Set());
    }
    this.listeners.get(arduinoPin)!.add(callback);
    return () => {
      this.listeners.get(arduinoPin)?.delete(callback);
    };
  }

  /**
   * Update port register and notify digital pin listeners.
   *
   * @param portName  Human-readable port name for log output (e.g. 'PORTB').
   * @param newValue  New 8-bit port value.
   * @param oldValue  Previous 8-bit port value (default 0).
   * @param pinMap    Optional per-bit Arduino pin numbers (length 8).
   *                  Use -1 for bits that are not exposed as Arduino pins.
   *                  When omitted the legacy Uno/Nano fixed offsets are used:
   *                  PORTB→8, PORTC→14, PORTD→0.
   * @param ddrMask   Optional DDR register value (8 bits). When provided,
   *                  a pin is added to `outputPins` only if its DDR bit is
   *                  1 (the AVR is actively driving it as OUTPUT). Without
   *                  this guard, the PORTx write that activates INPUT_PULLUP
   *                  (DDR=0, PORT=1) falsely marks the pin as MCU output
   *                  and emits an ideal V-source on the SPICE side, fighting
   *                  the real external circuit (button, sensor, pull-down).
   */
  updatePort(
    portName: string,
    newValue: number,
    oldValue: number = 0,
    pinMap?: number[],
    ddrMask?: number,
  ) {
    const legacyOffsets: Record<string, number> = { PORTB: 8, PORTC: 14, PORTD: 0 };

    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      const oldState = (oldValue & mask) !== 0;
      const newState = (newValue & mask) !== 0;

      if (oldState !== newState) {
        const arduinoPin = pinMap ? pinMap[bit] : (legacyOffsets[portName] ?? 0) + bit;
        if (arduinoPin < 0) continue; // unmapped bit

        this.pinStates.set(arduinoPin, newState);
        // Only mark as MCU-output if DDR bit is set (or DDR unknown → legacy).
        if (ddrMask === undefined || (ddrMask & mask) !== 0) {
          this.outputPins.add(arduinoPin);
        }

        const callbacks = this.listeners.get(arduinoPin);
        if (callbacks) {
          callbacks.forEach((cb) => cb(arduinoPin, newState));
        }
      }
    }
  }

  getPinState(arduinoPin: number): boolean {
    return this.pinStates.get(arduinoPin) || false;
  }

  /**
   * Set a single pin state and notify listeners.
   * Alias for triggerPinChange — used by ESP32-C3, RISC-V, and RP2040 simulators.
   *
   * `source` distinguishes MCU GPIO writes (mark pin as output for SPICE)
   * from external actors like buttons or sensor parts (don't mark).
   */
  setPinState(pin: number, state: boolean, source: 'mcu' | 'external' = 'external'): void {
    this.triggerPinChange(pin, state, source);
  }

  /**
   * Directly fire pin change callbacks for a specific pin.
   * Used by RP2040Simulator which has individual GPIO listeners instead of PORT registers.
   */
  triggerPinChange(pin: number, state: boolean, source: 'mcu' | 'external' = 'external'): void {
    const current = this.pinStates.get(pin);
    if (current === state) {
      if (source === 'mcu') this.outputPins.add(pin);
      return;
    }
    this.pinStates.set(pin, state);
    if (source === 'mcu') this.outputPins.add(pin);
    const callbacks = this.listeners.get(pin);
    if (callbacks) {
      callbacks.forEach((cb) => cb(pin, state));
    }
  }

  /** Pins the MCU has actively driven this session. */
  getOutputPins(): ReadonlySet<number> {
    return this.outputPins;
  }

  /**
   * Clear cached pin states + output-pin classifications.  Called by
   * stopBoard / resetBoard so the next Run starts without stale output
   * classifications from a previous session forcing premature V-source
   * emission.  Also keeps the test fixtures' fresh-triggerPinChange path
   * (the original reason this helper exists) working.
   */
  resetPinStates(): void {
    this.pinStates.clear();
    this.outputPins.clear();
  }

  // ── PWM duty cycle API ───────────────────────────────────────────────────

  /**
   * Register callback for PWM duty cycle changes on a pin.
   * dutyCycle is 0.0–1.0.
   */
  onPwmChange(pin: number, callback: PwmCallback): () => void {
    if (!this.pwmListeners.has(pin)) {
      this.pwmListeners.set(pin, new Set());
    }
    this.pwmListeners.get(pin)!.add(callback);
    return () => {
      this.pwmListeners.get(pin)?.delete(callback);
    };
  }

  /**
   * Called by AVRSimulator each frame when an OCR register changes.
   */
  updatePwm(pin: number, dutyCycle: number): void {
    this.pwmValues.set(pin, dutyCycle);
    if (dutyCycle > 0) this.outputPins.add(pin);
    const callbacks = this.pwmListeners.get(pin);
    if (callbacks) {
      callbacks.forEach((cb) => cb(pin, dutyCycle));
    }
  }

  /**
   * Broadcast PWM duty to ALL registered PWM listeners.
   * Used when the LEDC channel→GPIO mapping is unknown (gpio=-1).
   * Components filter by duty range (e.g., servo accepts 0.01-0.20).
   */
  broadcastPwm(dutyCycle: number): void {
    this.pwmListeners.forEach((callbacks, pin) => {
      this.pwmValues.set(pin, dutyCycle);
      callbacks.forEach((cb) => cb(pin, dutyCycle));
    });
  }

  /**
   * Count of distinct GPIO pins that currently have at least one PWM
   * listener registered.  Used by the ledc_update router so it can
   * skip a gpio=-1 broadcast when multiple consumers exist — sending
   * the same duty to two servos would corrupt the second one
   * (`servo blinks between two positions` symptom). With a single
   * consumer the broadcast is unambiguous and useful.
   */
  pwmListenerPinCount(): number {
    let n = 0;
    this.pwmListeners.forEach((cbs) => {
      if (cbs.size > 0) n++;
    });
    return n;
  }

  getPwmValue(pin: number): number {
    return this.pwmValues.get(pin) ?? 0;
  }

  // ── Analog voltage API ───────────────────────────────────────────────────

  /**
   * Register callback when external code sets an analog voltage on a pin.
   */
  onAnalogChange(pin: number, callback: AnalogCallback): () => void {
    if (!this.analogListeners.has(pin)) {
      this.analogListeners.set(pin, new Set());
    }
    this.analogListeners.get(pin)!.add(callback);
    return () => {
      this.analogListeners.get(pin)?.delete(callback);
    };
  }

  /**
   * Inject a simulated analog voltage (0–5V) on an Arduino pin.
   * Notifies any registered analog listeners.
   */
  setAnalogVoltage(arduinoPin: number, voltage: number): void {
    const callbacks = this.analogListeners.get(arduinoPin);
    if (callbacks) {
      callbacks.forEach((cb) => cb(arduinoPin, voltage));
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  getListenersCount(): number {
    let count = 0;
    this.listeners.forEach((set) => (count += set.size));
    return count;
  }

  clearAllListeners() {
    this.listeners.clear();
    this.pwmListeners.clear();
    this.analogListeners.clear();
    this.outputPins.clear();
  }
}
