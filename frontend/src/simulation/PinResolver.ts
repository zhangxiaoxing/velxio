/**
 * PinResolver — abstraction over "what's driving this component pin?".
 *
 * Background
 * ----------
 * Until Phase 0 of the mixed-mode simulator project, every component
 * handler in simulation/parts/*Parts.ts wired its own subscription to
 * `pinManager.onPinChange(arduinoPin, callback)` after resolving the
 * arduinoPin via the `getArduinoPinHelper(componentPinName)` callback
 * passed into `attachEvents`. That couples handlers tightly to the
 * digital event flow and makes it impossible to swap in a SPICE-resolved
 * voltage check without rewriting every handler.
 *
 * This module introduces `PinResolver`: a small interface that hides the
 * "how do I know what state this pin is in?" question behind two methods,
 * `getCurrentState()` and `onChange()`. Handlers ask the resolver for the
 * current state and subscribe for changes; they never touch PinManager
 * directly.
 *
 * Phase 0 ships the DEFAULT IMPLEMENTATION, which is functionally
 * identical to the legacy path — it just routes through PinResolver
 * instead of being inlined in each handler. Zero behavior change.
 *
 * Phase 1 will add a SPICE-resolved implementation that watches
 * `nodeVoltages[net]` and threshold-converts to digital states. That
 * landing point is why the abstraction exists.
 *
 * See ../../project/sim-mixedmode/phase-00-pin-resolver.md
 *     ../../project/sim-mixedmode/phase-01-mixed-mode-coupling.md
 *     (in the velxio-prod repo)
 */

import type { Wire } from '../types/wire';
import type { Component } from '../types/components';
import type { BoardInstance } from '../types/board';

/** Default Vcc when an owner board can't be identified. Matches Arduino Uno. */
const DEFAULT_VCC = 5;

/** Logic state of a pin from the perspective of the digital event flow. */
export type PinState = 'HIGH' | 'LOW' | 'FLOATING' | 'CONFLICT';

/**
 * Resolves "what is this component pin doing?" for one specific pin.
 *
 * - `getCurrentState()` returns the live state synchronously.
 * - `getCurrentVoltage()` returns the live voltage in volts (or null if
 *   unknown — e.g. SPICE hasn't solved yet). For the Phase 0 default
 *   impl this is synthesised as `state==='HIGH' ? vcc : 0`.
 * - `onChange(cb)` subscribes to state transitions. Returns an
 *   unsubscribe function. The callback fires whenever the state
 *   changes — NOT on every internal pin event (e.g. PWM duty bumps
 *   don't fire as long as the digital state stays HIGH).
 *
 * Implementations must be cheap to construct and cheap to query.
 * One PinResolver per (componentId, pinName) is created per
 * `attachEvents` call.
 */
export interface PinResolver {
  getCurrentState(): PinState;
  getCurrentVoltage(): number | null;
  onChange(cb: (state: PinState, voltage: number) => void): () => void;
}

/**
 * Internal context that the default PinResolver needs to do its work.
 * Passed once from DynamicComponent at attachEvents time so the resolver
 * doesn't have to reach into Zustand stores itself (keeps it testable).
 */
export interface PinResolverContext {
  /** All components currently on the canvas — used by the wire-trace logic. */
  components: Component[];
  /** All boards on the canvas. */
  boards: BoardInstance[];
  /** All wires on the canvas. */
  wires: Wire[];
  /** The board that's emitting events for this component (Arduino Uno etc.). */
  ownerBoard: BoardInstance | null;
  /**
   * Vcc of the owner board in volts (e.g. 5 for Arduino Uno, 3.3 for ESP32).
   * Used to synthesise a voltage value for the Phase 0 default impl —
   * `HIGH → vcc`, `LOW → 0`. Phase 1+ reads real voltages from SPICE
   * instead.
   */
  ownerBoardVcc: number;
  /** Subscribe to a single Arduino pin's digital changes. Returns unsubscribe. */
  subscribeArduinoPin: (
    pin: number,
    cb: (pin: number, state: boolean) => void,
  ) => () => void;
  /**
   * Read the current digital state of an Arduino pin, synchronously. Used
   * by `getCurrentState()` so the resolver doesn't have to wait for the
   * first event after subscription to report a sensible initial state.
   * Return `null` if the pin's state isn't tracked (e.g. board hasn't
   * booted yet).
   */
  readArduinoPin: (pin: number) => boolean | null;
}

/**
 * Pure pin-tracing logic — walks wires through 2-terminal passives (and
 * a few "transparent" actives like BJTs as part of the 2026-05-15
 * shortcut) until it finds either a board pin or a dead end.  This is
 * the same trace that lived inline in `getArduinoPin` inside
 * DynamicComponent.tsx, extracted here so the default PinResolver impl
 * can call it without duplicating logic.
 *
 * Returns:
 *  - >= 0  → Arduino pin number controlling this component pin
 *  - -1    → wired to GND (handled by caller as "always LOW")
 *  - null  → no board reached (might be wired to another component that
 *            we don't trace through, or unwired entirely)
 *
 * Phase 1 will replace this with SPICE-net lookup via pinNetMap. The
 * `[C, B]` BJT shortcut here goes away when Phase 5 deletes the
 * legacy direct-event path.
 */
export type PinTracer = (
  componentId: string,
  componentPinName: string,
) => number | null;

/**
 * Build the default PinResolver for one (component, pin) pair.
 *
 * `tracePin` is provided by the caller (DynamicComponent) — it
 * encapsulates the wire-graph walk because that logic depends on
 * runtime board metadata DynamicComponent already has loaded.  Keeps
 * this module dependency-free of the board/wire stores and easy to
 * unit test.
 */
export function createDefaultPinResolver(
  componentId: string,
  componentPinName: string,
  ctx: PinResolverContext,
  tracePin: PinTracer,
): PinResolver {
  // Resolve once at construction. The trace result is stable while the
  // wire topology is unchanged; if a wire is added/removed,
  // DynamicComponent's effect re-runs and we rebuild from scratch.
  const arduinoPin = tracePin(componentId, componentPinName);

  // Local mirror of the current state. Initialised on first subscription
  // (or first synchronous read) from the PinManager.
  let cached: PinState = 'FLOATING';
  let cachedVoltage: number | null = null;
  let initialised = false;

  // Board VCC for voltage synthesis. Caller looks it up from
  // boardPinGroups; we just use whatever they give us (default 5V).
  const vcc = ctx.ownerBoardVcc ?? DEFAULT_VCC;

  function refresh(): void {
    if (arduinoPin === null) {
      cached = 'FLOATING';
      cachedVoltage = null;
      return;
    }
    if (arduinoPin === -1) {
      // Tied to GND.
      cached = 'LOW';
      cachedVoltage = 0;
      return;
    }
    const live = ctx.readArduinoPin(arduinoPin);
    if (live === null) {
      cached = 'FLOATING';
      cachedVoltage = null;
      return;
    }
    cached = live ? 'HIGH' : 'LOW';
    cachedVoltage = live ? vcc : 0;
  }

  return {
    getCurrentState(): PinState {
      if (!initialised) {
        refresh();
        initialised = true;
      }
      return cached;
    },
    getCurrentVoltage(): number | null {
      if (!initialised) {
        refresh();
        initialised = true;
      }
      return cachedVoltage;
    },
    onChange(cb): () => void {
      if (arduinoPin === null) {
        // Unwired or wired to something we don't trace through. No
        // events will ever fire — return a no-op unsubscribe.
        return () => {};
      }
      if (arduinoPin === -1) {
        // Tied to GND. Emit one initial event so subscribers can mirror
        // state immediately, then no further changes.
        queueMicrotask(() => cb('LOW', 0));
        return () => {};
      }
      return ctx.subscribeArduinoPin(arduinoPin, (_pin, state) => {
        cached = state ? 'HIGH' : 'LOW';
        cachedVoltage = state ? vcc : 0;
        cb(cached, cachedVoltage);
      });
    },
  };
}
