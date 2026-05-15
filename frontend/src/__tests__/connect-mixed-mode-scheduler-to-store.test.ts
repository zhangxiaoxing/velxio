/**
 * @vitest-environment jsdom
 *
 * Phase 1c step 1 — tests for the feature-flagged WASM-driven
 * connector.  Uses a fake store + fake scheduler so the test runs in
 * Vitest without booting either Zustand or the WASM worker.
 *
 * jsdom env is required for the `isMixedModeEnabled` tests that touch
 * `window.localStorage` and `window.location`.  The connector tests
 * themselves only need the Promise microtask queue.
 *
 * Covered:
 *   - initial solve fires on subscribe
 *   - solve re-fires on components / wires / boards change
 *   - solves coalesce when one is already in flight
 *   - solve errors are logged but don't break the subscriber
 *   - unsubscribe stops future solves
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  connectMixedModeSchedulerToStoreFor,
  isMixedModeEnabled,
  type SimulatorStoreLike,
} from '../simulation/spice/connectMixedModeSchedulerToStore';

function makeStore(initial: {
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>;
  boards: Array<{ id: string; boardKind: string; pinStates?: Record<string, unknown> }>;
}): {
  store: SimulatorStoreLike;
  set(next: Partial<typeof initial>): void;
} {
  let state = initial;
  const listeners: Array<(state: unknown, prev: unknown) => void> = [];
  return {
    store: {
      getState: () => state,
      subscribe(listener) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    set(next) {
      const prev = state;
      state = { ...state, ...next };
      for (const l of listeners) l(state, prev);
    },
  };
}

function makeScheduler(opts: { loadCircuit?: () => Promise<void>; resolveDc?: () => Promise<void> } = {}) {
  const calls = { loadCircuit: 0, resolveDc: 0 };
  return {
    calls,
    scheduler: {
      async loadCircuit(_netlist: string, _pinNetMap: Map<string, string>): Promise<void> {
        calls.loadCircuit++;
        if (opts.loadCircuit) await opts.loadCircuit();
      },
      async resolveDc(): Promise<void> {
        calls.resolveDc++;
        if (opts.resolveDc) await opts.resolveDc();
      },
    },
  };
}

const emptySnapshot = {
  components: [],
  wires: [],
  boards: [
    { id: 'uno', boardKind: 'arduino-uno', pinStates: { '5V': { type: 'digital', v: 5 } } },
  ],
};

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe('connectMixedModeSchedulerToStore', () => {
  it('runs an initial solve as soon as it subscribes', async () => {
    const { store } = makeStore(emptySnapshot);
    const { scheduler, calls } = makeScheduler();
    connectMixedModeSchedulerToStoreFor(store, scheduler, () => ({}));
    // Solve is async — yield to the microtask queue.
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.loadCircuit).toBe(1);
    expect(calls.resolveDc).toBe(1);
  });

  it('re-solves when components change', async () => {
    const ctrl = makeStore(emptySnapshot);
    const { scheduler, calls } = makeScheduler();
    connectMixedModeSchedulerToStoreFor(ctrl.store, scheduler, () => ({}));
    await new Promise((r) => setTimeout(r, 5));

    ctrl.set({ components: [{ id: 'r1', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.loadCircuit).toBe(2);
    expect(calls.resolveDc).toBe(2);
  });

  it('re-solves when wires change', async () => {
    const ctrl = makeStore(emptySnapshot);
    const { scheduler, calls } = makeScheduler();
    connectMixedModeSchedulerToStoreFor(ctrl.store, scheduler, () => ({}));
    await new Promise((r) => setTimeout(r, 5));

    ctrl.set({
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '5V' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.loadCircuit).toBe(2);
  });

  it('does NOT re-solve when state changes but components/wires/boards are unchanged', async () => {
    const ctrl = makeStore(emptySnapshot);
    const { scheduler, calls } = makeScheduler();
    connectMixedModeSchedulerToStoreFor(ctrl.store, scheduler, () => ({}));
    await new Promise((r) => setTimeout(r, 5));

    // Synthetic listener-only event — re-emit the same arrays.
    ctrl.set({});
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.loadCircuit).toBe(1); // still 1 — no re-solve
  });

  it('coalesces solves when one is already in flight', async () => {
    let releaseFirst!: () => void;
    const blocker = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { scheduler, calls } = makeScheduler({
      // First loadCircuit blocks until releaseFirst is called.
      loadCircuit: () => {
        return calls.loadCircuit === 1 ? blocker : Promise.resolve();
      },
    });
    const ctrl = makeStore(emptySnapshot);
    connectMixedModeSchedulerToStoreFor(ctrl.store, scheduler, () => ({}));

    // First solve is now in-flight (waiting on the blocker).
    // Fire a series of store changes — they should coalesce into ONE
    // follow-up solve, not N.
    ctrl.set({ components: [{ id: 'a', metadataId: 'resistor', properties: {} }] });
    ctrl.set({ components: [{ id: 'b', metadataId: 'resistor', properties: {} }] });
    ctrl.set({ components: [{ id: 'c', metadataId: 'resistor', properties: {} }] });

    releaseFirst();
    // Let the first solve finish + coalesced follow-up run.
    await new Promise((r) => setTimeout(r, 20));

    // 1 initial + 1 coalesced follow-up = 2 total, NOT 1+3.
    expect(calls.loadCircuit).toBe(2);
    expect(calls.resolveDc).toBe(2);
  });

  it('logs but does not throw when a solve errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { scheduler } = makeScheduler({
      loadCircuit: () => Promise.reject(new Error('boom')),
    });
    const { store } = makeStore(emptySnapshot);
    // Should not throw.
    connectMixedModeSchedulerToStoreFor(store, scheduler, () => ({}));
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledWith('[mixed-mode] solve failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('unsubscribe stops future re-solves', async () => {
    const ctrl = makeStore(emptySnapshot);
    const { scheduler, calls } = makeScheduler();
    const cancel = connectMixedModeSchedulerToStoreFor(ctrl.store, scheduler, () => ({}));
    await new Promise((r) => setTimeout(r, 5));
    cancel();
    ctrl.set({ components: [{ id: 'r1', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.loadCircuit).toBe(1); // only the initial solve
  });
});

describe('isMixedModeEnabled feature flag', () => {
  it('returns false by default', () => {
    expect(isMixedModeEnabled()).toBe(false);
  });

  it('returns true when localStorage has velxio.mixedmode=on', () => {
    window.localStorage.setItem('velxio.mixedmode', 'on');
    expect(isMixedModeEnabled()).toBe(true);
  });

  it('returns false for any value other than "on"', () => {
    window.localStorage.setItem('velxio.mixedmode', 'true');
    expect(isMixedModeEnabled()).toBe(false);
    window.localStorage.setItem('velxio.mixedmode', '1');
    expect(isMixedModeEnabled()).toBe(false);
  });
});
