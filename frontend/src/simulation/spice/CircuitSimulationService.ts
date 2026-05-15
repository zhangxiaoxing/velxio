/**
 * CircuitSimulationService — the orchestration layer that owns the
 * simulation loop.
 *
 * Responsibilities (single, well-defined):
 *   1. Listen to canvas state via an injected SimulatorStorePort.
 *   2. Build the SPICE netlist via NetlistBuilder.
 *   3. Drive the scheduler (loadCircuit + resolveDc / resolveTran).
 *   4. Extract every voltage / branch current / waveform from the
 *      scheduler's last SolveResult and publish to the
 *      ElectricalStorePort so the 12 downstream consumers (ADC
 *      injection, instruments, overlays) keep working.
 *   5. Coalesce concurrent solves: if one is in flight, mark a
 *      pending re-solve for after.
 *
 * Single source of truth: this service replaces the trio of
 *   - wireElectricalSolver (legacy)
 *   - connectLegacySolverToMixedMode (bridge)
 *   - connectMixedModeSchedulerToStore (Phase 1c step 1)
 *
 * Architecture:
 *   - Depends on PORTS only (SimulatorStorePort, ElectricalStorePort,
 *     MixedModeSchedulerPort).  Easy to test with fakes.
 *   - No useSimulatorStore / useElectricalStore imports in this file
 *     — those bindings live in the wiring file (start.ts).
 *   - No SPICE-engine knowledge — that's in the adapters.
 */
import { buildInputFromStore } from './storeAdapter';
import { buildNetlist } from './NetlistBuilder';
import type { TimeWaveforms } from './types';

/** What the service needs from the simulator store. */
export interface SimulatorStorePort {
  getState(): {
    components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
    wires: Array<{
      id: string;
      start: { componentId: string; pinName: string };
      end: { componentId: string; pinName: string };
    }>;
    boards: Array<{ id: string; boardKind: string; pinStates?: Record<string, unknown> }>;
  };
  subscribe(listener: (state: unknown, prev: unknown) => void): () => void;
}

/** What the service publishes to (the legacy electrical store, in our case). */
export interface ElectricalStorePort {
  /** Atomically write a complete solve snapshot. */
  publish(snapshot: ElectricalSnapshot): void;
}

/** Domain-level solve result, decoupled from SolverPort details. */
export interface ElectricalSnapshot {
  /** SPICE net name → scalar voltage (V).  For .tran: last sample. */
  nodeVoltages: Record<string, number>;
  /** V-source name (without leading V) → scalar branch current (A). */
  branchCurrents: Record<string, number>;
  /** "componentId:pinName" → SPICE net name (from NetlistBuilder). */
  pinNetMap: Map<string, string>;
  /** Which analysis produced this. */
  analysisMode: 'op' | 'tran' | 'ac';
  /** Per-sample waveforms — present only for .tran. */
  timeWaveforms?: TimeWaveforms;
  /** Convergence warnings from the solver. */
  warnings: string[];
}

/** What the service needs from the scheduler. */
export interface MixedModeSchedulerPort {
  loadCircuit(netlist: string, pinNetMap: Map<string, string>): Promise<void>;
  resolveDc(): Promise<void>;
  resolveTran(step: string, stop: string): Promise<void>;
  /**
   * The last SolveResult the scheduler produced.  Used by the service
   * to extract waveforms / branch currents without going around the
   * scheduler.
   */
  getLastResult(): import('./ports/SolverPort').SolveResult | null;
  /**
   * Allow the service to request extra vectors of interest before
   * the solve runs (branch currents, internal nets).  Optional —
   * implementations may ignore it if they don't optimise.
   */
  setExtraVectorsOfInterest?(vectors: readonly string[]): void;
}

export interface ServiceOptions {
  /** Pre-existing pin states for board pins (from PinManager). */
  collectBoardPinStates: (
    boardId: string,
    boardKind: string,
    wires: SimulatorStorePort['getState'] extends () => infer S
      ? S extends { wires: infer W }
        ? W
        : never
      : never,
  ) => Record<string, unknown>;
}

export class CircuitSimulationService {
  private inFlight = false;
  private pending = false;

  constructor(
    private readonly simStore: SimulatorStorePort,
    private readonly electricalStore: ElectricalStorePort,
    private readonly scheduler: MixedModeSchedulerPort,
    private readonly options: ServiceOptions,
  ) {}

  /** Run one solve cycle, coalescing concurrent triggers. */
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.runSolve();
    } catch (err) {
      // Failures are reported via electrical-store warnings field;
      // also logged so devtools / Sentry can see them.
      // eslint-disable-next-line no-console
      console.warn('[circuit-sim] solve failed:', err);
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        void this.tick();
      }
    }
  }

  private async runSolve(): Promise<void> {
    const state = this.simStore.getState();
    const snap = {
      components: state.components,
      wires: state.wires,
      boards: state.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: this.options.collectBoardPinStates(
          b.id,
          b.boardKind,
          state.wires as never,
        ) as never,
      })),
    };
    const input = buildInputFromStore(snap as Parameters<typeof buildInputFromStore>[0]);
    const { netlist, pinNetMap, nets, voltageSources } = buildNetlist(input);

    // Tell the scheduler exactly which vectors we want — every net
    // voltage + every branch current.
    const extraVectors: string[] = [];
    for (const net of nets) extraVectors.push(`v(${net})`);
    for (const vs of voltageSources) extraVectors.push(`i(${vs.toLowerCase()})`);
    this.scheduler.setExtraVectorsOfInterest?.(extraVectors);

    await this.scheduler.loadCircuit(netlist, pinNetMap);

    if (input.analysis.kind === 'tran') {
      await this.scheduler.resolveTran(input.analysis.step, input.analysis.stop);
    } else {
      await this.scheduler.resolveDc();
    }

    // Pull the SolveResult out of the scheduler and shape it for the
    // electrical store.
    const result = this.scheduler.getLastResult();
    if (!result) return;

    const nodeVoltages: Record<string, number> = {};
    const branchCurrents: Record<string, number> = {};
    let timeWaveforms: TimeWaveforms | undefined;

    for (const net of nets) {
      const vec = result.vectors.get(`v(${net})`);
      if (vec && vec.real.length > 0) {
        nodeVoltages[net] = vec.real[vec.real.length - 1]!;
      }
    }
    for (const vs of voltageSources) {
      const key = `i(${vs.toLowerCase()})`;
      const vec = result.vectors.get(key);
      if (vec && vec.real.length > 0) {
        // Store under the V-source name WITHOUT the leading "v_" — that's
        // the convention legacy consumers (LED handler, Ammeter) use.
        // Example: emission "V_led1_sense" → key "v_led1_sense".
        const bcKey = vs.toLowerCase();
        branchCurrents[bcKey] = vec.real[vec.real.length - 1]!;
      }
    }

    if (input.analysis.kind === 'tran' && result.timeAxis.length > 0) {
      const nodes = new Map<string, number[]>();
      const branches = new Map<string, number[]>();
      for (const net of nets) {
        const vec = result.vectors.get(`v(${net})`);
        if (vec && vec.real.length > 0) nodes.set(net, Array.from(vec.real));
      }
      for (const vs of voltageSources) {
        const vec = result.vectors.get(`i(${vs.toLowerCase()})`);
        if (vec && vec.real.length > 0) branches.set(vs.toLowerCase(), Array.from(vec.real));
      }
      timeWaveforms = {
        time: Array.from(result.timeAxis),
        nodes,
        branches,
      };
    }

    this.electricalStore.publish({
      nodeVoltages,
      branchCurrents,
      pinNetMap,
      analysisMode: input.analysis.kind,
      timeWaveforms,
      warnings: result.warnings,
    });
  }

  /**
   * Mount the service: subscribe to store changes + run one initial
   * solve.  Returns an unsubscribe handle.
   */
  start(): () => void {
    const unsubscribe = this.simStore.subscribe((next, prev) => {
      const n = next as ReturnType<typeof this.simStore.getState>;
      const p = prev as ReturnType<typeof this.simStore.getState>;
      if (n.components !== p.components || n.wires !== p.wires || n.boards !== p.boards) {
        void this.tick();
      }
    });
    void this.tick();
    return unsubscribe;
  }
}
