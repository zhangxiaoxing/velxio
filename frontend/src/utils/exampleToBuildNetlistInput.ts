/**
 * exampleToBuildNetlistInput — single source of truth for converting
 * an `ExampleProject` into the `BuildNetlistInput` the SPICE engine
 * consumes.
 *
 * Used by:
 *   • `loadExample.ts` (production load path)
 *   • smoke tests (`__tests__/examples-*-live.test.ts`)
 *   • any future tool that wants to inspect example netlists
 *     without going through the simulator store
 *
 * If the prefix rules or filtering ever change (e.g. add a new
 * `mfgX-` namespace), update ONLY this file — every consumer picks
 * the new behaviour automatically.
 */
import type { BuildNetlistInput, AnalysisMode } from '../simulation/spice/types';
import type { ExampleProject } from '../data/examples';

/**
 * Strip the brand prefix from a wokwi-elements / velxio-elements
 * component tag.  Matches the regex used historically inside
 * `loadExample.ts`.
 *
 * Examples:
 *   wokwi-led            → led
 *   wokwi-bjt-2n2222     → bjt-2n2222
 *   velxio-74hc595       → 74hc595
 *   resistor             → resistor (no prefix, untouched)
 */
export function stripBrandPrefix(componentType: string): string {
  return componentType.replace(/^(wokwi|velxio)-/, '');
}

/**
 * Whether a component is a board / MCU (excluded from the SPICE
 * component list — boards are stamped as voltage sources at the pin
 * level, not as full components).
 */
export function isBoardComponentType(componentType: string): boolean {
  const t = componentType.toLowerCase();
  return (
    t.includes('arduino') ||
    t.includes('pico') ||
    t.includes('raspberry') ||
    t.includes('esp32')
  );
}

/**
 * Convert an `ExampleProject` into a `BuildNetlistInput` ready for
 * `NetlistBuilder.buildNetlist`.  Boards are filtered out of the
 * component list (they don't get SPICE cards — only V-sources via
 * pin states), and component types lose their brand prefix.
 *
 * Boards[] is empty by default — for smoke tests we don't need to
 * stamp MCU pin voltages.  Callers that DO need them (e.g. live
 * tests of multi-board setups) pass `opts.boards` explicitly.
 */
export function exampleToBuildNetlistInput(
  example: ExampleProject,
  opts: {
    analysis?: AnalysisMode;
    boards?: BuildNetlistInput['boards'];
  } = {},
): BuildNetlistInput {
  const components = example.components
    .filter((c) => !isBoardComponentType(c.type))
    .map((c) => ({
      id: c.id,
      metadataId: stripBrandPrefix(c.type),
      properties: c.properties ?? {},
    }));

  const wires = example.wires.map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
  }));

  return {
    components,
    wires,
    boards: opts.boards ?? [],
    analysis: opts.analysis ?? { kind: 'op' },
  };
}
