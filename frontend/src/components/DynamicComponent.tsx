/**
 * Dynamic Component Renderer
 *
 * Generic component that renders any wokwi-element web component dynamically.
 * Replaces individual React wrapper components (LED.tsx, Resistor.tsx, etc.)
 *
 * Features:
 * - Creates web component from metadata
 * - Syncs React props to web component properties
 * - Extracts pinInfo from DOM for wire connections
 * - Handles component lifecycle
 */

import React, { useRef, useEffect, useCallback } from 'react';
import type { ComponentMetadata } from '../types/component-metadata';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { PartSimulationRegistry } from '../simulation/parts';
import { isBoardComponent, boardPinToNumber } from '../utils/boardPinMapping';
import { createDefaultPinResolver, type PinResolver } from '../simulation/PinResolver';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';

// Side-effect imports: register every web component we'll create at runtime.
// `@wokwi/elements` covers the upstream catalog; `../velxio-elements` adds
// the velxio-local elements (e.g. <velxio-capacitor-electrolytic>,
// <velxio-instr-voltmeter>) that don't exist upstream.
import '@wokwi/elements';
import '../velxio-elements';

interface DynamicComponentProps {
  id: string;
  metadata: ComponentMetadata;
  properties: Record<string, any>;
  x?: number;
  y?: number;
  isSelected?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinInfoReady?: (pinInfo: any[]) => void;
}

export const DynamicComponent: React.FC<DynamicComponentProps> = ({
  id,
  metadata,
  properties,
  x = 0,
  y = 0,
  isSelected = false,
  onMouseDown,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  onPinInfoReady,
}) => {
  const elementRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const handleComponentEvent = useSimulatorStore((s) => s.handleComponentEvent);
  const running = useSimulatorStore((s) => s.running);
  const simulator = useSimulatorStore((s) => s.simulator);
  // Board-less SPICE circuits (digital / analog gallery) have no MCU to
  // run, so `running` is always false — but interactive parts like
  // slide-switches and pushbuttons should still show a pointer cursor
  // and let the user click them. We treat board-less + un-paused as
  // "interactive" so the cursor + dialog gating mirror the MCU mode.
  const boardCount = useSimulatorStore((s) => s.boards.length);
  const electricalPaused = useElectricalStore((s) => s.paused);
  const interactionRunning = running || (boardCount === 0 && !electricalPaused);
  // hexEpoch increments each time a new hex is loaded, triggering a fresh
  // attachEvents call (and re-registration of I2C devices on the new bus).
  // We intentionally do NOT depend on `running` so that I2C displays and
  // other protocol parts (SSD1306, DS1307 …) are NOT torn down and
  // re-created on every stop/play cycle — which previously caused the
  // display to flash blank and lose its frame buffer.
  const hexEpoch = useSimulatorStore((s) => s.hexEpoch);

  // Track wires connected to this component so attachEvents re-runs when
  // wires are added or removed (e.g. disconnecting an LED cathode from GND).
  const wireFingerprint = useSimulatorStore((s) => {
    const myWires = s.wires.filter((w) => w.start.componentId === id || w.end.componentId === id);
    return myWires.map((w) => w.id).join(',');
  });

  // Check if component is interactive (has simulation logic with attachEvents)
  const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);
  const isInteractive = logic?.attachEvents !== undefined;

  /**
   * Sync React properties to Web Component
   */
  useEffect(() => {
    if (!elementRef.current) return;

    Object.entries(properties).forEach(([key, value]) => {
      try {
        (elementRef.current as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set property ${key} on ${metadata.tagName}:`, error);
      }
    });
  }, [properties, metadata.tagName]);

  /**
   * Extract pinInfo from web component after it initializes
   */
  useEffect(() => {
    if (!elementRef.current || !onPinInfoReady) return;

    // Wait for web component to fully initialize
    const checkPinInfo = () => {
      try {
        const pinInfo = (elementRef.current as any)?.pinInfo;
        if (pinInfo && Array.isArray(pinInfo) && pinInfo.length > 0) {
          onPinInfoReady(pinInfo);
          return true;
        }
      } catch {
        // Element not ready yet
      }
      return false;
    };

    // Try immediately
    if (checkPinInfo()) return;

    // Otherwise poll every 100ms for up to 2 seconds
    const interval = setInterval(() => {
      if (checkPinInfo()) {
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
    }, 2000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onPinInfoReady]);

  /**
   * Handle mouse events
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (onMouseDown) {
        e.stopPropagation();
        onMouseDown(e);
      }
    },
    [onMouseDown],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onDoubleClick) {
        e.stopPropagation();
        onDoubleClick(e);
      }
    },
    [onDoubleClick],
  );

  /**
   * Mount web component (only once)
   */
  useEffect(() => {
    if (!containerRef.current) return;

    // Prevent double-mount in React StrictMode
    if (mountedRef.current) {
      return;
    }

    const element = document.createElement(metadata.tagName);
    element.id = id;

    // Set initial properties
    Object.entries(properties).forEach(([key, value]) => {
      try {
        (element as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set initial property ${key}:`, error);
      }
    });

    containerRef.current.appendChild(element);
    elementRef.current = element;
    mountedRef.current = true;

    return () => {
      if (containerRef.current && element.parentNode === containerRef.current) {
        containerRef.current.removeChild(element);
      }
      elementRef.current = null;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.tagName, id]); // Only re-create if tagName or id changes

  /**
   * Attach component-specific DOM events (like button presses)
   */
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const onButtonPress = (e: Event) => handleComponentEvent(id, 'button-press', e);
    const onButtonRelease = (e: Event) => handleComponentEvent(id, 'button-release', e);

    el.addEventListener('button-press', onButtonPress);
    el.addEventListener('button-release', onButtonRelease);

    const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);

    let cleanupSimulationEvents: (() => void) | undefined;
    if (logic && logic.attachEvents) {
      // Board-less circuits (analog/digital SPICE examples) have no MCU
      // simulator, but input parts (switches, buttons, DIP switches) still
      // need their `change`/`button-press` events to fire `emitPropertyChange`
      // so the SPICE solver re-runs. Every part already guards its
      // `simulator.setPinState` / `pinManager.onPinChange` calls behind a
      // null pin lookup (`getArduinoPin` returns null when there's no board),
      // so the stub below is enough — it satisfies the type signature without
      // doing anything when called.
      const stubSimulator =
        simulator ??
        ({
          setPinState: () => {},
          isRunning: () => false,
          pinManager: {
            onPinChange: () => () => {},
            triggerPinChange: () => {},
          } as any,
        } as any);
      // Helper to find Arduino pin connected to a component pin.
      // Traces through electrically-transparent passive components so that a
      // circuit like  LED-cathode → resistor → GND  returns -1 (GND) instead
      // of null.
      //
      // NOTE: diodes / transistors / op-amps are NOT traced through — they
      // have polarity / Vf / non-linear behaviour that the digital layer
      // cannot interpret as "same pin".
      const getArduinoPin = (componentPinName: string): number | null => {
        const state = useSimulatorStore.getState();

        // Map metadataId → [pinA, pinB] for 2-terminal passives.
        // Tracing "through" means: if the caller arrived on pinA, continue
        // from pinB (and vice-versa).
        const PASSIVE_PIN_PAIRS: Record<string, [string, string]> = {
          resistor: ['1', '2'],
          'resistor-us': ['1', '2'],
          capacitor: ['1', '2'],
          'capacitor-electrolytic': ['+', '−'],
          inductor: ['1', '2'],
          'analog-resistor': ['A', 'B'],
          'analog-capacitor': ['A', 'B'],
          'analog-inductor': ['A', 'B'],
          // NTC and photoresistor breakouts are 3-pin active modules (VCC/GND
          // + analog output); not traceable as 2-terminal passives. Their
          // analog output is already an ADC-readable pin on its own.
          //
          // BJTs are 3-pin actives, but the canonical "Arduino digital pin
          // controls a load via transistor" pattern is fundamental enough
          // that we treat them as a [collector, base] shortcut.  Tracing
          // FROM the collector side continues through the base — i.e. the
          // Arduino pin driving the base is reported as the controller of
          // the collector. That makes 7-segment multiplex circuits with
          // BJT digit drivers actually work in the simulator, since
          // getArduinoPinHelper('COM.1') can resolve through the transistor.
          // For NPN, Arduino HIGH at base → transistor on → collector pulled
          // to emitter (typically GND) — and "HIGH = digit enabled" in our
          // 7-segment driver matches this when COM is common-cathode wired
          // through the transistor to GND.
          'bjt-2n2222': ['C', 'B'],
          'bjt-bc547': ['C', 'B'],
          'bjt-2n3055': ['C', 'B'],
          'bjt-2n3906': ['C', 'B'],
          'bjt-bc557': ['C', 'B'],
        };
        // Preset variants of the generic passives share their parent's tag
        // and pin layout — so resistor-220, cap-1u, ind-10m, etc. trace the
        // same way as their canonical sibling above. The list mirrors the
        // PASSIVE_PRESETS map in spice/componentToSpice.ts.
        const PRESET_TO_BASE: Record<string, string> = {
          'resistor-220': 'resistor',
          'resistor-330': 'resistor',
          'resistor-470': 'resistor',
          'resistor-1k': 'resistor',
          'resistor-2k2': 'resistor',
          'resistor-4k7': 'resistor',
          'resistor-10k': 'resistor',
          'resistor-22k': 'resistor',
          'resistor-47k': 'resistor',
          'resistor-100k': 'resistor',
          'resistor-1m': 'resistor',
          'cap-10p': 'capacitor',
          'cap-22p': 'capacitor',
          'cap-100p': 'capacitor',
          'cap-1n': 'capacitor',
          'cap-10n': 'capacitor',
          'cap-100n': 'capacitor',
          'cap-1u': 'capacitor',
          'cap-elec-1u': 'capacitor-electrolytic',
          'cap-elec-10u': 'capacitor-electrolytic',
          'cap-elec-47u': 'capacitor-electrolytic',
          'cap-elec-100u': 'capacitor-electrolytic',
          'cap-elec-470u': 'capacitor-electrolytic',
          'cap-elec-1000u': 'capacitor-electrolytic',
          'ind-100u': 'inductor',
          'ind-1m': 'inductor',
          'ind-10m': 'inductor',
        };
        for (const [preset, base] of Object.entries(PRESET_TO_BASE)) {
          PASSIVE_PIN_PAIRS[preset] = PASSIVE_PIN_PAIRS[base];
        }

        // Depth-limited BFS: trace from (fromId, fromPin) through wires,
        // traversing through passive components to reach a board pin.
        const trace = (fromId: string, fromPin: string, depth: number): number | null => {
          if (depth > 6) return null;

          const wires = state.wires.filter(
            (w) =>
              (w.start.componentId === fromId && w.start.pinName === fromPin) ||
              (w.end.componentId === fromId && w.end.pinName === fromPin),
          );

          for (const w of wires) {
            const selfEp =
              w.start.componentId === fromId && w.start.pinName === fromPin ? w.start : w.end;
            const otherEp = selfEp === w.start ? w.end : w.start;

            if (isBoardComponent(otherEp.componentId)) {
              // Direct board connection
              const boardKind =
                state.boards.find((b) => b.id === otherEp.componentId)?.boardKind ??
                otherEp.componentId;
              const pin = boardPinToNumber(boardKind, otherEp.pinName);
              if (pin !== null) return pin;
            } else {
              // Intermediate passive component — traverse through it
              const comp = state.components.find((c) => c.id === otherEp.componentId);
              const pair = comp && PASSIVE_PIN_PAIRS[comp.metadataId];
              if (pair) {
                const [p1, p2] = pair;
                const otherPin = otherEp.pinName === p1 ? p2 : p1;
                const result = trace(otherEp.componentId, otherPin, depth + 1);
                if (result !== null) return result;
              }
            }
          }
          return null;
        };

        return trace(id, componentPinName, 0);
      };

      // PinResolver factory — Phase 0 of the mixed-mode simulator project
      // (see project/sim-mixedmode/ in the velxio-prod repo). For now it
      // wraps getArduinoPin + pinManager.onPinChange — zero behavioral
      // change vs the legacy path. Phase 1+ will swap in a SPICE-resolved
      // implementation that watches node voltages and threshold-converts
      // to logic states.
      const simState = useSimulatorStore.getState();
      const ownerBoard =
        simState.boards.find((b) => b.id === simState.activeBoardId) ?? null;
      const ownerBoardVcc =
        (ownerBoard && BOARD_PIN_GROUPS[ownerBoard.boardKind as keyof typeof BOARD_PIN_GROUPS]?.vcc) ?? 5;
      const getPinResolver = (componentPinName: string): PinResolver | null => {
        const state = useSimulatorStore.getState();
        const pinManager = (stubSimulator as {
          pinManager?: {
            onPinChange?: (pin: number, cb: (pin: number, state: boolean) => void) => () => void;
            getPinState?: (pin: number) => boolean | null;
          };
        }).pinManager;
        return createDefaultPinResolver(
          id,
          componentPinName,
          {
            components: state.components,
            boards: state.boards,
            wires: state.wires,
            ownerBoard,
            ownerBoardVcc,
            subscribeArduinoPin: (pin, cb) => {
              if (!pinManager?.onPinChange) return () => {};
              return pinManager.onPinChange(pin, cb);
            },
            readArduinoPin: (pin) => {
              if (!pinManager?.getPinState) return null;
              try {
                return pinManager.getPinState(pin);
              } catch {
                return null;
              }
            },
          },
          getArduinoPin,
        );
      };

      cleanupSimulationEvents = logic.attachEvents(
        el,
        stubSimulator,
        getArduinoPin,
        id,
        getPinResolver,
      );
    }

    return () => {
      if (cleanupSimulationEvents) cleanupSimulationEvents();

      el.removeEventListener('button-press', onButtonPress);
      el.removeEventListener('button-release', onButtonRelease);
    };
  }, [id, handleComponentEvent, metadata.id, simulator, hexEpoch, wireFingerprint]);

  // The wrapper uses `onMouseDownCapture` (not `onMouseDown`) so it sees
  // the mousedown BEFORE the inner wokwi-element. Interactive wokwi parts
  // (pushbutton, slide-switch, potentiometer …) call stopPropagation in
  // their own bubble-phase handlers, which used to prevent any drag from
  // starting once the simulator was running. Capture phase fires first
  // and lets the canvas's drag-threshold logic distinguish click vs drag
  // at mouseup time — so the user can rearrange interactive components
  // while simulation is live.
  return (
    <div
      className="dynamic-component-wrapper"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: interactionRunning && isInteractive ? 'pointer' : 'move',
        border: isSelected ? '2px dashed #007acc' : '2px solid transparent',
        borderRadius: '4px',
        padding: '4px',
        userSelect: 'none',
        zIndex: isSelected ? 5 : 1,
        pointerEvents: 'auto',
        transform: properties.rotation ? `rotate(${properties.rotation}deg)` : undefined,
        transformOrigin: 'center center',
      }}
      onMouseDownCapture={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-component-id={id}
      data-component-type={metadata.id}
    >
      {/* Container for web component */}
      <div ref={containerRef} className="web-component-container" />

      {/* Component label */}
      <div
        className="component-label"
        style={{
          fontSize: '11px',
          textAlign: 'center',
          marginTop: '4px',
          color: '#666',
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
        }}
      >
        {properties.pin !== undefined ? `Pin ${properties.pin}` : metadata.name}
        {properties.protocol && (
          <span
            style={{
              fontSize: '9px',
              padding: '1px 4px',
              borderRadius: '3px',
              backgroundColor: properties.protocol === 'spi' ? '#e67e22' : '#3498db',
              color: '#fff',
              fontWeight: 600,
              textTransform: 'uppercase',
              lineHeight: '1.2',
            }}
          >
            {String(properties.protocol)}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Helper function to create a component instance from metadata
 */
export function createComponentFromMetadata(
  metadata: ComponentMetadata,
  x: number,
  y: number,
): {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, any>;
} {
  return {
    id: `${metadata.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    metadataId: metadata.id,
    x,
    y,
    properties: { ...metadata.defaultValues },
  };
}
