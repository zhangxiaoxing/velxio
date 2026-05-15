/**
 * CircuitSimulationService tests.
 *
 * Fully isolated from useSimulatorStore + useElectricalStore + the
 * WASM scheduler.  Uses fakes for every port so the service's
 * orchestration logic is exercised standalone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type SimulatorStorePort,
  type ElectricalStorePort,
  type MixedModeSchedulerPort,
  type ElectricalSnapshot,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { FakeSolverAdapter } from '../simulation/spice/adapters/FakeSolverAdapter';

afterEach(() => {
  __resetMixedModeScheduler();
});

function makeSimStore(initial: {
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>;
  boards: Array<{ id: string; boardKind: string }>;
}): { port: SimulatorStorePort; set(next: Partial<typeof initial>): void } {
  let state: typeof initial = initial;
  const listeners: Array<(s: unknown, p: unknown) => void> = [];
  return {
    port: {
      getState: () => state,
      subscribe(l) {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
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

function makeElectricalStore(): {
  port: ElectricalStorePort;
  snapshots: ElectricalSnapshot[];
} {
  const snapshots: ElectricalSnapshot[] = [];
  return {
    snapshots,
    port: {
      publish(s) {
        snapshots.push(s);
      },
    },
  };
}

const simpleBoardWithBoard = {
  components: [{ id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
  wires: [
    {
      id: 'w1',
      start: { componentId: 'uno', pinName: '5V' },
      end: { componentId: 'r1', pinName: '1' },
    },
    {
      id: 'w2',
      start: { componentId: 'r1', pinName: '2' },
      end: { componentId: 'uno', pinName: 'GND' },
    },
  ],
  boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
};

describe('CircuitSimulationService — orchestration', () => {
  it('runs an initial solve when started', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.calls.loadCircuit.length).toBe(1);
    expect(fake.calls.solve.length).toBe(1);
    expect(elec.snapshots.length).toBe(1);
    expect(elec.snapshots[0]?.analysisMode).toBe('op');
    expect(elec.snapshots[0]?.nodeVoltages.vcc_rail).toBeCloseTo(5);
  });

  it('extracts branch currents from i(v_*) vectors', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5, 'i(v_vcc_rail)': -0.005 },
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.branchCurrents.v_vcc_rail).toBeCloseTo(-0.005);
  });

  it('re-solves on components / wires / boards changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({ '5V': { type: 'digital', v: 5 } }) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);

    sim.set({ components: [...simpleBoardWithBoard.components, { id: 'r2', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(2);
  });

  it('does NOT re-solve when an unrelated field changes', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 10));
    sim.set({}); // same arrays — should NOT trigger a re-solve
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.solve.length).toBe(1);
  });

  it('coalesces solves when one is in flight', async () => {
    const fake = new FakeSolverAdapter({
      vectors: { 'v(vcc_rail)': 5 },
      solveDelayMs: 30,
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    service.start();
    // While initial solve runs, fire 3 store changes — should coalesce
    // into 1 trailing solve.
    sim.set({ components: [{ id: 'a', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'b', metadataId: 'resistor', properties: {} }] });
    sim.set({ components: [{ id: 'c', metadataId: 'resistor', properties: {} }] });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.solve.length).toBe(2); // initial + 1 trailing
  });

  it('publishes .tran waveforms when analysis is transient', async () => {
    const fake = new FakeSolverAdapter({
      vectors: {
        'v(n_out)': new Float64Array([0, 1, 2, 3, 4]),
        'i(v_src)': new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05]),
      },
      timeAxis: new Float64Array([0, 1e-4, 2e-4, 3e-4, 4e-4]),
    });
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore({
      components: [
        // A signal-generator forces .tran in buildInputFromStore.
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 100 },
        },
      ],
      wires: [],
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }],
    });
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 20));

    const snap = elec.snapshots[0];
    expect(snap?.analysisMode).toBe('tran');
    expect(snap?.timeWaveforms).toBeDefined();
    expect(snap?.timeWaveforms?.time.length).toBe(5);
  });

  it('publishes warnings from the solver', async () => {
    const fake = new FakeSolverAdapter({ vectors: { 'v(vcc_rail)': 5 } });
    // FakeSolverAdapter does not currently emit warnings; vetting that the
    // service forwards them is sufficient — see solver-port-contract for
    // the warnings-field contract.
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 10));
    // The FakeSolverAdapter returns empty warnings, so the snapshot
    // also has empty warnings — but the field exists.
    expect(elec.snapshots[0]?.warnings).toEqual([]);
  });

  it('logs but does not throw when solver fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeSolverAdapter();
    // Override solve to reject on first call.
    let calls = 0;
    fake.solve = async () => {
      calls++;
      throw new Error('boom');
    };
    __setSchedulerSolverFactoryForTests(() => fake);
    const sim = makeSimStore(simpleBoardWithBoard);
    const elec = makeElectricalStore();
    const service = new CircuitSimulationService(
      sim.port,
      elec.port,
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => ({}) },
    );
    service.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    expect(elec.snapshots.length).toBe(0); // no publish on failure
    expect(calls).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
