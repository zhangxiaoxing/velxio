/**
 * Phase 1c step 1 — feature-flagged WASM-driven connector for the
 * MixedModeScheduler.
 *
 * Runs alongside `wireElectricalSolver` (legacy 200-ms-poll, batch
 * eecircuit-engine) and `connectLegacySolverToMixedMode` (the Phase
 * 1b bridge that republishes legacy voltages into the scheduler).
 *
 * When the flag is on:
 *   1. Subscribe to useSimulatorStore for components / wires / board
 *      changes
 *   2. On change: build the SPICE netlist via the existing storeAdapter
 *      + NetlistBuilder
 *   3. `scheduler.loadCircuit(netlist, pinNetMap)` — pumps it into the
 *      vendored ngspice-WASM via NgSpiceInteractive
 *   4. `scheduler.resolveDc()` — runs the DC op and publishes voltages
 *      for every (component, pin) in pinNetMap
 *
 * SpiceResolvedPinResolver subscribers now have TWO sources feeding
 * their voltage cache: the legacy bridge AND the WASM path.  Whichever
 * publishes last wins — that's by design while we A/B test which path
 * gives better results.  When confidence is established, the legacy
 * bridge will be retired and only the WASM connector remains.
 *
 * Lifecycle:
 *   Mount from EditorPage when `isMixedModeEnabled()` is true.  Returns
 *   an unsubscribe handle for cleanup on unmount.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildInputFromStore } from './storeAdapter';
import { buildNetlist } from './NetlistBuilder';
import { getMixedModeScheduler } from './MixedModeScheduler';
import { collectPinStates } from './subscribeToStore';

/** Stripped-down store shape so this module can be unit-tested without Zustand. */
export interface SimulatorStoreLike {
  getState(): {
    components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
    wires: Array<{
      id: string;
      start: { componentId: string; pinName: string };
      end: { componentId: string; pinName: string };
    }>;
    boards: Array<{
      id: string;
      boardKind: string;
      pinStates?: Record<string, unknown>;
    }>;
  };
  subscribe(listener: (state: unknown, prev: unknown) => void): () => void;
}

interface SchedulerLike {
  loadCircuit(netlist: string, pinNetMap: Map<string, string>): Promise<void>;
  resolveDc(): Promise<void>;
}

/**
 * True when the feature flag is set.  Two opt-in mechanisms:
 *   - URL query `?mixedmode=on` — useful for one-off sharing of test links
 *   - localStorage `velxio.mixedmode = 'on'` — sticky across reloads
 *
 * Reading both lets us flip a single user's session via the URL without
 * touching DevTools, while still supporting a permanent opt-in.
 */
export function isMixedModeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('mixedmode') === 'on') return true;
    return window.localStorage.getItem('velxio.mixedmode') === 'on';
  } catch {
    return false;
  }
}

/**
 * Default entry point — uses the live useSimulatorStore + singleton
 * scheduler.  Returns an unsubscribe handle.
 */
export function connectMixedModeSchedulerToStore(): () => void {
  return connectMixedModeSchedulerToStoreFor(
    useSimulatorStore as unknown as SimulatorStoreLike,
    getMixedModeScheduler(),
    /* pinStateCollector */ (boardId, boardKind, wires) =>
      collectPinStates(
        boardId,
        // The collector expects BoardKind; we narrow via string at call
        // time.  In practice every board id in the live store maps to a
        // valid BoardKind; if not, collectPinStates returns {}.
        boardKind as Parameters<typeof collectPinStates>[1],
        wires as Parameters<typeof collectPinStates>[2],
      ),
  );
}

/**
 * Lower-level form for tests — accepts the store, scheduler, and pin-state
 * collector explicitly so neither Zustand nor PinManager need to boot.
 */
export function connectMixedModeSchedulerToStoreFor(
  store: SimulatorStoreLike,
  scheduler: SchedulerLike,
  collectBoardPinStates: (
    boardId: string,
    boardKind: string,
    wires: Array<{ start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }>,
  ) => Record<string, unknown>,
): () => void {
  let inFlight = false;
  let pending = false;

  const solve = async (): Promise<void> => {
    if (inFlight) {
      // Coalesce: keep one solve in flight, mark pending for after.
      pending = true;
      return;
    }
    inFlight = true;
    try {
      const state = store.getState();
      const snap = {
        components: state.components,
        wires: state.wires,
        boards: state.boards.map((b) => ({
          id: b.id,
          // The store's BoardKind is narrower than `string` but the
          // adapter widens at call time; cast through `unknown` to
          // satisfy buildInputFromStore.
          boardKind: b.boardKind,
          pinStates: collectBoardPinStates(b.id, b.boardKind, state.wires) as never,
        })),
      };
      const input = buildInputFromStore(snap as Parameters<typeof buildInputFromStore>[0]);
      const { netlist, pinNetMap } = buildNetlist(input);
      await scheduler.loadCircuit(netlist, pinNetMap);
      await scheduler.resolveDc();
    } catch (err) {
      // Don't propagate — the legacy solver is still running. Log so
      // dev tools / Sentry can surface convergence problems without
      // breaking the existing app.
      // eslint-disable-next-line no-console
      console.warn('[mixed-mode] solve failed:', err);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        // Re-fire the solve. Don't await — let it run asynchronously so
        // the caller's subscriber callback isn't blocked.
        void solve();
      }
    }
  };

  const unsubscribe = store.subscribe((next, prev) => {
    const n = next as ReturnType<typeof store.getState>;
    const p = prev as ReturnType<typeof store.getState>;
    if (n.components !== p.components || n.wires !== p.wires || n.boards !== p.boards) {
      void solve();
    }
  });

  void solve(); // kick off initial solve
  return unsubscribe;
}
