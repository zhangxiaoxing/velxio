import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { verifyCircuit, type VerificationResult } from '../../simulation/verify/circuitVerifier';
import { buildInputFromStore } from '../../simulation/spice/storeAdapter';
import { BOARD_PIN_GROUPS } from '../../simulation/spice/boardPinGroups';
import { CircuitVerificationModal } from '../simulator/CircuitVerificationModal';
import type { PinSourceState } from '../../simulation/spice/types';
import type { BoardKind, LanguageMode } from '../../types/board';
import { BOARD_KIND_FQBN, BOARD_KIND_LABELS, BOARD_SUPPORTS_MICROPYTHON, isPiBoardKind } from '../../types/board';
import { compileCode } from '../../services/compilation';
import {
  compileRom,
  isChipProgramFile,
  formatForFile,
  targetForChip,
} from '../../services/romCompileService';
import { reportRunEvent } from '../../services/metricsService';
import { useProjectStore } from '../../store/useProjectStore';
import { LibraryManagerModal } from '../simulator/LibraryManagerModal';
import { InstallLibrariesModal } from '../simulator/InstallLibrariesModal';
import { parseCompileResult } from '../../utils/compilationLogger';
import type { CompilationLog } from '../../utils/compilationLogger';
import { exportToWokwiZip } from '../../utils/wokwiZip';
import { importProjectFile, PROJECT_FILE_ACCEPT } from '../../utils/importProject';
import { readFirmwareFile } from '../../utils/firmwareLoader';
import {
  trackCompileCode,
  trackRunSimulation,
  trackStopSimulation,
  trackResetSimulation,
  trackOpenLibraryManager,
} from '../../utils/analytics';
import './EditorToolbar.css';

interface EditorToolbarProps {
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  compileLogs: CompilationLog[];
  setCompileLogs: (logs: CompilationLog[] | ((prev: CompilationLog[]) => CompilationLog[])) => void;
  /**
   * Optional element rendered between the left action group and the right
   * action group. The editor passes <FileTabs /> here so the tabs share the
   * same row as the toolbar — keeping every action icon pinned and visible
   * regardless of how narrow the editor pane gets.
   */
  centerSlot?: React.ReactNode;
  /**
   * Optional extra elements rendered after the built-in right-group buttons
   * (Libraries / Import-Export / Output Console). Used by private overlays
   * to add deployment-specific actions without forking the toolbar.
   */
  rightSlot?: React.ReactNode;
}

const BOARD_PILL_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  'raspberry-pi-4': '⬛',
  'raspberry-pi-5': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

const BOARD_PILL_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': '#ef9a9a',
  'raspberry-pi-4': '#ef9a9a',
  'raspberry-pi-5': '#ef9a9a',
  esp32: '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

export const EditorToolbar = ({
  consoleOpen,
  setConsoleOpen,
  compileLogs: _compileLogs,
  setCompileLogs,
  centerSlot,
  rightSlot,
}: EditorToolbarProps) => {
  const { t } = useTranslation();
  const { files, codeChangedSinceLastCompile, markCompiled } = useEditorStore();
  const {
    boards,
    activeBoardId,
    compileBoardProgram,
    loadMicroPythonProgram,
    setBoardLanguageMode,
    updateBoard,
    startBoard,
    stopBoard,
    resetBoard,
    // legacy compat
    startSimulation,
    stopSimulation,
    resetSimulation,
    running,
    compiledHex,
  } = useSimulatorStore();

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const currentProject = useProjectStore((s) => s.currentProject);

  // Board-less mode: digital / analog SPICE-only circuits. The Run / Stop
  // buttons toggle the SPICE solver's `paused` flag — pausing freezes every
  // LED at its current brightness so the user can inspect the state, and
  // resuming flushes the most recent switch toggle through the engine.
  const electricalPaused = useElectricalStore((s) => s.paused);
  const setElectricalPaused = useElectricalStore((s) => s.setPaused);
  const isBoardless = boards.length === 0;
  const digitalRunning = isBoardless && !electricalPaused;

  // Circuit-verification modal state. When `pendingRun` is non-null we've
  // already paid the cost of solving + analysing — the user can either
  // bail out or proceed by running `pendingRun()`.
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const pendingRunRef = useRef<(() => void) | null>(null);

  // Helper: report a Run event to the backend for analytics. Resolves the
  // FQBN from the board kind so the backend can group by family/fqbn.
  const reportRun = useCallback(
    (boardKind: BoardKind | undefined) => {
      const fqbn = boardKind ? BOARD_KIND_FQBN[boardKind] : null;
      void reportRunEvent({
        project_id: currentProject?.id ?? null,
        board_fqbn: fqbn ?? null,
      });
    },
    [currentProject],
  );
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [libManagerOpen, setLibManagerOpen] = useState(false);
  const [pendingLibraries, setPendingLibraries] = useState<string[]>([]);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const firmwareInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [missingLibHint, setMissingLibHint] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreMenuOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [moreMenuOpen]);

  // Compile All / Run All — runs sequentially, logs to console (no dialog)
  const [compileAllRunning, setCompileAllRunning] = useState(false);

  const addLog = useCallback(
    (log: CompilationLog) => {
      setCompileLogs((prev: CompilationLog[]) => [...prev, log]);
    },
    [setCompileLogs],
  );

  const handleCompile = async () => {
    setCompiling(true);
    setMessage(null);
    setConsoleOpen(true);
    // Wipe the previous build's output before we append anything new.
    // Issue #209: lingering logs from prior compiles made it impossible
    // to tell the latest errors / warnings apart from stale ones.
    setCompileLogs([]);
    trackCompileCode();

    // ── Chip-program path ───────────────────────────────────────────────
    // If the editor's active file is a chip-program file we don't compile
    // Arduino code — we assemble/compile it into ROM bytes via
    // /api/compile-rom and stash the result on every custom-chip component
    // that points at this filename through its `programFile` property. The
    // chip's emulator then reads the bytes on chip_setup via vx_rom_size /
    // vx_rom_read.
    //
    // A file is "chip program" when EITHER its extension is unambiguous
    // (.s/.asm/.hex/.bin) OR some custom-chip on the canvas has
    // programFile === activeFile.name. The latter lets .c files route to
    // SDCC instead of arduino-cli when wired to a CPU chip.
    const activeFile = files.find((f) => f.id === useEditorStore.getState().activeFileId);
    const componentsForCompile = useSimulatorStore.getState().components;
    const chipsBoundToFile = activeFile
      ? componentsForCompile.filter((c) => {
          if (c.metadataId !== 'custom-chip') return false;
          const prog = String((c.properties as any)?.programFile ?? '').trim();
          return prog === activeFile.name;
        })
      : [];

    if (activeFile && (isChipProgramFile(activeFile.name) || chipsBoundToFile.length > 0)) {
      try {
        const chips = chipsBoundToFile.length > 0
          ? chipsBoundToFile
          : componentsForCompile.filter((c) => {
              if (c.metadataId !== 'custom-chip') return false;
              const prog = String((c.properties as any)?.programFile ?? '').trim();
              return prog === '' || prog === activeFile.name;
            });
        if (chips.length === 0) {
          addLog({
            timestamp: new Date(),
            type: 'error',
            message: `No custom-chip on the canvas references ${activeFile.name}. Drop an "i8080 CPU" chip, or set its programFile property.`,
          });
          setMessage({ type: 'error', text: 'No matching custom-chip on canvas' });
          setCompiling(false);
          return;
        }
        // Resolve target from the first matching chip's chip.json.
        const firstChipJson = String((chips[0].properties as any)?.chipJson ?? '{}');
        const target = targetForChip(firstChipJson);
        const fmt = formatForFile(activeFile.name);
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: `Assembling ${activeFile.name} (target=${target}, format=${fmt}) for ${chips.length} chip(s)...`,
        });
        const result = await compileRom(activeFile.content, target, fmt);
        if (!result.success || !result.rom_base64) {
          addLog({
            timestamp: new Date(),
            type: 'error',
            message: result.error || 'ROM compile failed',
          });
          if (result.stderr) {
            addLog({ timestamp: new Date(), type: 'error', message: result.stderr });
          }
          setMessage({ type: 'error', text: result.error || 'ROM compile failed' });
          setCompiling(false);
          return;
        }
        // Inject into every matching chip's romBytes property.
        const updateComponent = useSimulatorStore.getState().updateComponent;
        for (const chip of chips) {
          updateComponent(chip.id, {
            properties: {
              ...(chip.properties as Record<string, unknown>),
              romBytes: result.rom_base64,
              programFile: activeFile.name,
            },
          });
        }
        addLog({
          timestamp: new Date(),
          type: 'success',
          message: `ROM compiled: ${result.byte_size} bytes injected into ${chips.length} chip(s).`,
        });
        setMessage({
          type: 'success',
          text: `ROM ready (${result.byte_size} B). Hit Run.`,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        addLog({ timestamp: new Date(), type: 'error', message: errMsg });
        setMessage({ type: 'error', text: errMsg });
      } finally {
        setCompiling(false);
      }
      return;
    }
    // ── End chip-program path ───────────────────────────────────────────

    const kind = activeBoard?.boardKind;

    // Raspberry Pi 3B doesn't need arduino-cli compilation
    if (isPiBoardKind(kind)) {
      addLog({
        timestamp: new Date(),
        type: 'info',
        message: 'Raspberry Pi 3B: no compilation needed — run Python scripts directly.',
      });
      setMessage({ type: 'success', text: 'Ready (no compilation needed)' });
      setCompiling(false);
      return;
    }

    // MicroPython mode — no backend compilation needed
    if (activeBoard?.languageMode === 'micropython' && activeBoardId) {
      addLog({
        timestamp: new Date(),
        type: 'info',
        message: 'MicroPython: loading firmware and user files...',
      });
      try {
        const groupFiles = useEditorStore.getState().getGroupFiles(activeBoard.activeFileGroupId);
        const pyFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
        await loadMicroPythonProgram(activeBoardId, pyFiles);
        addLog({
          timestamp: new Date(),
          type: 'success',
          message: 'MicroPython firmware loaded successfully',
        });
        setMessage({ type: 'success', text: 'MicroPython ready' });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Failed to load MicroPython';
        addLog({ timestamp: new Date(), type: 'error', message: errMsg });
        setMessage({ type: 'error', text: errMsg });
      } finally {
        setCompiling(false);
      }
      return;
    }

    const fqbn = kind ? BOARD_KIND_FQBN[kind] : null;
    const boardLabel = kind ? BOARD_KIND_LABELS[kind] : 'Unknown';

    if (!fqbn) {
      addLog({ timestamp: new Date(), type: 'error', message: `No FQBN for board kind: ${kind}` });
      setMessage({ type: 'error', text: 'Unknown board' });
      setCompiling(false);
      return;
    }

    addLog({
      timestamp: new Date(),
      type: 'info',
      message: `Starting compilation for ${boardLabel} (${fqbn})...`,
    });

    try {
      const groupFiles = activeBoard?.activeFileGroupId
        ? useEditorStore.getState().getGroupFiles(activeBoard.activeFileGroupId)
        : files;
      const sketchFiles = (groupFiles.length > 0 ? groupFiles : files).map((f) => ({
        name: f.name,
        content: f.content,
      }));

      // Stream live cmake + ninja output into the compilation console as
      // it arrives, instead of waiting for the whole build to finish.
      // Each poll the backend returns the cumulative stdout buffer; we
      // append only the delta since the previous call as 'info' lines.
      let lastStreamedLen = 0;
      const result = await compileCode(
        sketchFiles,
        fqbn,
        currentProject?.id ?? null,
        ({ stdout }) => {
          if (stdout.length <= lastStreamedLen) return;
          const delta = stdout.slice(lastStreamedLen);
          lastStreamedLen = stdout.length;
          const newLines = delta.split('\n').filter((s) => s.trim());
          if (!newLines.length) return;
          const now = new Date();
          setCompileLogs((prev: CompilationLog[]) => [
            ...prev,
            ...newLines.map((line) => ({
              timestamp: now,
              type: 'info' as const,
              message: line,
            })),
          ]);
        },
        // Per-board ESP32 build options + SPIFFS uploads. Undefined for AVR
        // / RP2040 boards (ignored on those paths by the backend).
        {
          boardOptions: activeBoard?.boardOptions,
          spiffsFiles: activeBoard?.spiffsFiles,
        },
      );

      // After the build settles, append the structured analysis on top of
      // the live stream — parseCompileResult highlights FAILED blocks and
      // tags compiler errors with type='error', which the console uses for
      // colour + the auto-switch-to-errors filter.
      const resultLogs = parseCompileResult(result, boardLabel);
      setCompileLogs((prev: CompilationLog[]) => [...prev, ...resultLogs]);

      if (result.success) {
        const program = result.hex_content ?? result.binary_content ?? null;
        if (program && activeBoardId) {
          compileBoardProgram(activeBoardId, program);
          if (result.has_wifi !== undefined) {
            updateBoard(activeBoardId, { hasWifi: result.has_wifi });
          }
        }
        setMessage({ type: 'success', text: 'Compiled successfully' });
        markCompiled();
        setMissingLibHint(false);
      } else {
        const errText = result.error || result.stderr || 'Compile failed';
        setMessage({ type: 'error', text: errText });
        // Issue #208: drop the previous successful program from this
        // board so a subsequent Run cannot silently execute stale code
        // that doesn't match the editor any more. The Run button gates
        // on `!compiledProgram` and will refuse + force a re-compile.
        if (activeBoardId) {
          updateBoard(activeBoardId, { compiledProgram: null });
        }
        // Detect missing library errors — common patterns:
        // "No such file or directory" for #include, "fatal error: XXX.h"
        const looksLikeMissingLib =
          /No such file or directory|fatal error:.*\.h|library not found/i.test(errText);
        setMissingLibHint(looksLikeMissingLib);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Compile failed';
      addLog({ timestamp: new Date(), type: 'error', message: errMsg });
      setMessage({ type: 'error', text: errMsg });
    } finally {
      setCompiling(false);
    }
  };

  // Track whether we should auto-run after compilation completes
  const autoRunAfterCompile = useRef(false);

  /**
   * Pre-flight safety check: solves the current circuit and flags shorts,
   * LED over-current and resistor over-power. Returns the result. When the
   * solver fails to converge (degenerate netlist, no power source, …) we
   * silently report a clean result so the user isn't blocked on circuits
   * that aren't physically meaningful yet.
   */
  const runVerification = useCallback(async (): Promise<VerificationResult | null> => {
    try {
      const sim = useSimulatorStore.getState();
      // Skip if the circuit hasn't got anything analysable on it yet.
      const hasSource = sim.components.some(
        (c) => c.metadataId.startsWith('signal-generator') || c.metadataId.startsWith('battery'),
      );
      if (!hasSource && sim.boards.length === 0) return null;

      const snap = {
        components: sim.components.map((c) => ({
          id: c.id,
          metadataId: c.metadataId,
          properties: c.properties,
        })),
        wires: sim.wires,
        boards: sim.boards.map((b) => {
          // Realistic pre-flight: simulate the WORST CASE — every digital
          // pin connected to a load is forced HIGH at the board's vcc.
          // This is what we want because the user's sketch WILL eventually
          // do `digitalWrite(pin, HIGH)` (otherwise why is the LED wired?).
          // Testing idle state would never flag a missing series resistor
          // because the LED draws zero current when its pin is LOW.
          //
          // Caveat: pins wired only to inputs (e.g. a pull-up resistor +
          // button) get over-driven here too. The verifier rules are
          // already tolerant — a properly-spec'd pull-up sees minimal
          // current and doesn't trip overcurrent / overpower. A circuit
          // that would actually fault under HIGH is flagged correctly.
          const pinStates: Record<string, PinSourceState> = {};
          const group = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
          const wiredPinNames = new Set<string>();
          for (const w of sim.wires) {
            if (w.start.componentId === b.id) wiredPinNames.add(w.start.pinName);
            if (w.end.componentId === b.id) wiredPinNames.add(w.end.pinName);
          }
          for (const pinName of wiredPinNames) {
            // Skip GND / power-rail pin names — they belong to the rail
            // groups and don't need to be re-asserted as digital sources.
            if (group.gnd.includes(pinName)) continue;
            if (group.vcc_pins.includes(pinName)) continue;
            const arduinoPin = Number.parseInt(pinName, 10);
            // Skip pins we can't identify as a digital GPIO (e.g.
            // 'AREF', 'RESET', 'TX', 'RX' on some boards). Those are
            // either rail-ish or non-driven by the sketch.
            if (Number.isNaN(arduinoPin)) continue;
            pinStates[pinName] = { type: 'digital', v: group.vcc };
          }
          return { id: b.id, boardKind: b.boardKind, pinStates };
        }),
      };
      const input = buildInputFromStore(snap);
      return await verifyCircuit(input);
    } catch (err) {
      console.warn('[verifyCircuit] failed', err);
      return null;
    }
  }, []);

  /**
   * Returns true if the caller should proceed inline. If the verifier finds
   * errors we stash a resume callback in `pendingRunRef` and pop the
   * verification modal; the resume callback re-enters `handleRun` with
   * `skipVerify = true` so we don't loop. Warnings-only results don't
   * block — they surface inline via `setMessage` and the run continues.
   */
  const checkOrBlock = useCallback(
    async (resume: () => void): Promise<boolean> => {
      const result = await runVerification();
      if (!result) return true;
      if (result.errors.length === 0 && result.warnings.length === 0) return true;
      if (result.errors.length === 0) {
        // Warnings only — non-blocking. Surface inline and continue.
        const summary = result.warnings
          .slice(0, 3)
          .map((w) => w.message)
          .join(' • ');
        const more = result.warnings.length > 3 ? ` (+${result.warnings.length - 3} more)` : '';
        setMessage({
          type: 'error',
          text: `${result.warnings.length} circuit warning${result.warnings.length === 1 ? '' : 's'}: ${summary}${more}`,
        });
        return true;
      }
      // Errors → block until the user explicitly chooses Run Anyway.
      pendingRunRef.current = resume;
      setVerification(result);
      return false;
    },
    [runVerification],
  );

  const handleRun = async (skipVerify = false) => {
    console.log('[handleRun] click', { activeBoardId, running, codeChangedSinceLastCompile });

    // Pre-flight: solve the circuit and check for shorts / overcurrent /
    // overpower. If anything trips we hand control to the modal, which
    // resumes by calling `handleRun(true)` for "Run anyway".
    if (!skipVerify) {
      const ok = await checkOrBlock(() => handleRun(true));
      if (!ok) return;
    }

    // Board-less circuits (SPICE-only digital / analog gallery) have no MCU
    // to start. Resuming the electrical solver replays any switch toggles
    // captured while paused so the canvas catches up instantly.
    if (isBoardless) {
      setElectricalPaused(false);
      setMessage(null);
      return;
    }

    if (activeBoardId) {
      const board = boards.find((b) => b.id === activeBoardId);
      console.log('[handleRun] active board', {
        id: board?.id,
        kind: board?.boardKind,
        hasCompiledProgram: !!board?.compiledProgram,
        compiledProgramLen: board?.compiledProgram?.length ?? 0,
      });

      // MicroPython mode: stop any running session first, then reload firmware + start
      if (board?.languageMode === 'micropython') {
        trackRunSimulation(board.boardKind);
        reportRun(board.boardKind);

        // Always stop the current session so the new run gets a clean QEMU boot.
        // This also prevents the double start_esp32 that occurs when the bridge
        // is already connected and startBoard() is called again.
        if (board.running) {
          stopBoard(activeBoardId);
          // Give the WebSocket a moment to close cleanly before reconnecting.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        setCompiling(true);
        setMessage(null);
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: 'MicroPython: loading firmware and user files...',
        });
        try {
          const groupFiles = useEditorStore.getState().getGroupFiles(board.activeFileGroupId);
          const pyFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
          await loadMicroPythonProgram(activeBoardId, pyFiles);
          addLog({
            timestamp: new Date(),
            type: 'success',
            message: 'MicroPython firmware loaded',
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Failed to load MicroPython';
          addLog({ timestamp: new Date(), type: 'error', message: errMsg });
          setMessage({ type: 'error', text: errMsg });
          setCompiling(false);
          return;
        }
        setCompiling(false);
        startBoard(activeBoardId);
        setMessage(null);
        return;
      }

      const isQemuBoard =
        board?.boardKind && isPiBoardKind(board.boardKind) ||
        board?.boardKind === 'esp32' ||
        board?.boardKind === 'esp32-s3' ||
        board?.boardKind === 'esp32-cam' ||
        board?.boardKind === 'esp32-c3' ||
        board?.boardKind === 'esp32-devkit-c-v4' ||
        board?.boardKind === 'wemos-lolin32-lite' ||
        board?.boardKind === 'xiao-esp32-s3' ||
        board?.boardKind === 'arduino-nano-esp32' ||
        board?.boardKind === 'xiao-esp32-c3' ||
        board?.boardKind === 'aitewinrobot-esp32c3-supermini';

      // QEMU boards: auto-compile if no firmware available yet
      if (isQemuBoard) {
        console.log('[handleRun] QEMU path');
        if (!board?.compiledProgram || codeChangedSinceLastCompile) {
          console.log('[handleRun] auto-compile + run');
          autoRunAfterCompile.current = true;
          await handleCompile();
          const updatedBoard = useSimulatorStore
            .getState()
            .boards.find((b) => b.id === activeBoardId);
          console.log('[handleRun] after compile', {
            hasCompiledProgram: !!updatedBoard?.compiledProgram,
            compiledProgramLen: updatedBoard?.compiledProgram?.length ?? 0,
            autoRunFlag: autoRunAfterCompile.current,
          });
          if (autoRunAfterCompile.current) {
            autoRunAfterCompile.current = false;
            if (updatedBoard?.compiledProgram) {
              trackRunSimulation(updatedBoard.boardKind);
              reportRun(updatedBoard.boardKind);
              console.log('[handleRun] → startBoard', activeBoardId);
              startBoard(activeBoardId);
              setMessage(null);
            } else {
              // handleCompile returned without producing a firmware/program.
              // Most common causes: arduino-cli unreachable, ESP-IDF compile
              // error in the user's sketch, MicroPython firmware download
              // failed, or the bridge rejected the load. handleCompile has
              // already addLog'd the underlying error — surface a top-level
              // toast too so the user knows their Run click didn't silently
              // succeed.
              const isMicropython = updatedBoard?.languageMode === 'micropython';
              const errText = isMicropython
                ? 'MicroPython firmware did not load. Click "Load MicroPython" to retry, or check the console for the underlying error.'
                : 'Compilation produced no firmware. Check the output console for the underlying error.';
              console.warn('[handleRun] compile finished but no compiledProgram — not starting');
              setMessage({ type: 'error', text: errText });
              addLog({ timestamp: new Date(), type: 'error', message: errText });
            }
          }
          return;
        }
        trackRunSimulation(board?.boardKind);
        reportRun(board?.boardKind);
        console.log('[handleRun] → startBoard (already compiled)', activeBoardId);
        startBoard(activeBoardId);
        setMessage(null);
        return;
      }

      // Auto-compile if no program or code changed since last compile
      if (!board?.compiledProgram || codeChangedSinceLastCompile) {
        autoRunAfterCompile.current = true;
        await handleCompile();
        // After compile, check if it succeeded and run
        const updatedBoard = useSimulatorStore
          .getState()
          .boards.find((b) => b.id === activeBoardId);
        if (autoRunAfterCompile.current && updatedBoard?.compiledProgram) {
          autoRunAfterCompile.current = false;
          trackRunSimulation(updatedBoard.boardKind);
          reportRun(updatedBoard.boardKind);
          startBoard(activeBoardId);
          setMessage(null);
        } else {
          autoRunAfterCompile.current = false;
        }
        return;
      }

      trackRunSimulation(board?.boardKind);
      reportRun(board?.boardKind);
      startBoard(activeBoardId);
      setMessage(null);
      return;
    }

    // Legacy fallback
    if (!compiledHex || codeChangedSinceLastCompile) {
      autoRunAfterCompile.current = true;
      await handleCompile();
      const hex = useSimulatorStore.getState().compiledHex;
      if (autoRunAfterCompile.current && hex) {
        autoRunAfterCompile.current = false;
        trackRunSimulation();
        reportRun(undefined);
        startSimulation();
        setMessage(null);
      } else {
        autoRunAfterCompile.current = false;
      }
    } else {
      trackRunSimulation();
      reportRun(undefined);
      startSimulation();
      setMessage(null);
    }
  };

  const handleStop = () => {
    trackStopSimulation();
    if (isBoardless) {
      // Freeze the SPICE solver — every LED stays at its current brightness
      // and switch clicks stop re-triggering ngspice until the user hits Run.
      setElectricalPaused(true);
      setMessage(null);
      return;
    }
    if (activeBoardId) stopBoard(activeBoardId);
    else stopSimulation();
    setMessage(null);
  };

  const handleReset = () => {
    trackResetSimulation();
    if (activeBoardId) resetBoard(activeBoardId);
    else resetSimulation();
    setMessage(null);
  };

  /**
   * Compile every board on the canvas sequentially. Progress + per-board
   * results stream to the existing compilation console — no separate dialog.
   * Returns the count of boards that ended up with a runnable program (so
   * Run All can use it to decide whether to proceed to start them).
   */
  const compileAllBoards = async (): Promise<{ ok: number; failed: number }> => {
    const boardsList = useSimulatorStore.getState().boards;
    if (boardsList.length === 0) return { ok: 0, failed: 0 };

    setCompileAllRunning(true);
    setConsoleOpen(true);
    addLog({
      timestamp: new Date(),
      type: 'info',
      message: `Compiling all ${boardsList.length} board${boardsList.length === 1 ? '' : 's'}...`,
    });

    let ok = 0;
    let failed = 0;

    for (const board of boardsList) {
      const label = BOARD_KIND_LABELS[board.boardKind] ?? board.boardKind;

      if (isPiBoardKind(board.boardKind)) {
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: `${label}: skipped (no compilation needed)`,
        });
        ok++;
        continue;
      }

      const fqbn = BOARD_KIND_FQBN[board.boardKind];
      if (!fqbn) {
        addLog({
          timestamp: new Date(),
          type: 'error',
          message: `${label}: no FQBN configured`,
        });
        failed++;
        continue;
      }

      addLog({ timestamp: new Date(), type: 'info', message: `${label}: compiling...` });

      try {
        const groupFiles = useEditorStore.getState().getGroupFiles(board.activeFileGroupId);
        const sketchFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));

        // Stream live cmake + ninja output per-board (Compile-All flow).
        let lastStreamedLen = 0;
        const result = await compileCode(
          sketchFiles,
          fqbn,
          currentProject?.id ?? null,
          ({ stdout }) => {
            if (stdout.length <= lastStreamedLen) return;
            const delta = stdout.slice(lastStreamedLen);
            lastStreamedLen = stdout.length;
            const newLines = delta.split('\n').filter((s) => s.trim());
            if (!newLines.length) return;
            const now = new Date();
            setCompileLogs((prev: CompilationLog[]) => [
              ...prev,
              ...newLines.map((line) => ({
                timestamp: now,
                type: 'info' as const,
                message: `${label}: ${line}`,
              })),
            ]);
          },
          { boardOptions: board.boardOptions, spiffsFiles: board.spiffsFiles },
        );

        const resultLogs = parseCompileResult(result, label);
        setCompileLogs((prev: CompilationLog[]) => [...prev, ...resultLogs]);

        if (result.success) {
          const program = result.hex_content ?? result.binary_content ?? null;
          if (program) {
            compileBoardProgram(board.id, program);
            if (result.has_wifi !== undefined) {
              updateBoard(board.id, { hasWifi: result.has_wifi });
            }
          }
          ok++;
        } else {
          failed++;
        }
      } catch (err) {
        addLog({
          timestamp: new Date(),
          type: 'error',
          message: `${label}: ${err instanceof Error ? err.message : String(err)}`,
        });
        failed++;
      }
    }

    addLog({
      timestamp: new Date(),
      type: ok > 0 && failed === 0 ? 'success' : failed > 0 ? 'error' : 'info',
      message: `Done — ${ok} succeeded, ${failed} failed`,
    });
    if (ok > 0 && failed === 0) markCompiled();
    setCompileAllRunning(false);
    return { ok, failed };
  };

  const handleCompileAll = () => {
    trackCompileCode();
    void compileAllBoards();
  };

  /** Run All = compile all (if needed) + start every board, mirroring single Run. */
  const handleRunAll = async () => {
    const boardsList = useSimulatorStore.getState().boards;
    if (boardsList.length === 0) return;

    // Compile if anything is missing a program or code changed since last compile
    const needsCompile =
      codeChangedSinceLastCompile ||
      boardsList.some(
        (b) =>
          !isPiBoardKind(b.boardKind) &&
          b.languageMode !== 'micropython' &&
          !b.compiledProgram,
      );

    if (needsCompile) {
      const { failed } = await compileAllBoards();
      if (failed > 0) return; // Don't start anything if any board failed
    }

    // Refresh list after compile (compiledProgram may have changed)
    const refreshed = useSimulatorStore.getState().boards;
    for (const board of refreshed) {
      if (board.running) continue;
      const isQemu =
        isPiBoardKind(board.boardKind) ||
        board.boardKind === 'esp32' ||
        board.boardKind === 'esp32-s3';
      if (isQemu || board.compiledProgram || board.languageMode === 'micropython') {
        trackRunSimulation(board.boardKind);
        reportRun(board.boardKind);
        startBoard(board.id);
      }
    }
  };

  const handleExport = async () => {
    try {
      const {
        components,
        wires,
        boardPosition,
        boardType: legacyBoardType,
      } = useSimulatorStore.getState();
      const projectName =
        files.find((f) => f.name.endsWith('.ino'))?.name.replace('.ino', '') || 'velxio-project';
      await exportToWokwiZip(files, components, wires, legacyBoardType, projectName, boardPosition);
    } catch (err) {
      setMessage({ type: 'error', text: 'Export failed.' });
    }
  };

  // Phase 3 D3.2 — Schematic screenshot. Pro-tier-gated by the backend.
  // Same UX pattern as BOM export: everyone can click; 402 redirects to
  // /pricing. The server-side headless chromium renders the canvas and
  // returns a PNG, which we trigger a download for.
  const handleExportScreenshot = async () => {
    const projectId = currentProject?.id;
    if (!projectId) {
      setMessage({ type: 'error', text: 'Save the project before exporting an image.' });
      return;
    }
    setMessage({ type: 'info', text: 'Rendering screenshot — may take 5-10 seconds…' });
    try {
      const resp = await fetch(`/api/pro/projects/${projectId}/screenshot.png`, {
        credentials: 'include',
      });
      if (resp.status === 402) {
        // Fire the in-place upgrade modal instead of bouncing to /pricing —
        // keeps the user in the editor with full context. The pro overlay's
        // UpgradeGate listens for this event and opens UpgradePromptModal.
        window.dispatchEvent(new CustomEvent('velxio-pro-upgrade-prompt', {
          detail: { componentName: 'Schematic screenshot export' },
        }));
        return;
      }
      if (resp.status === 401) {
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (resp.status === 422) {
        setMessage({ type: 'error', text: 'Add at least one component to export an image.' });
        return;
      }
      if (!resp.ok) {
        setMessage({ type: 'error', text: 'Screenshot export failed.' });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = resp.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"]+)"?/.exec(cd);
      a.download = m ? m[1] : `velxio-${projectId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage({ type: 'success', text: 'Screenshot downloaded.' });
    } catch {
      setMessage({ type: 'error', text: 'Screenshot export failed.' });
    }
  };

  // Phase 3 D3.1 — BOM export. Pro-tier-gated by the backend (402 if not pro).
  // We let everyone click; the 402 response feeds the upgrade prompt below
  // so free/maker users hit the funnel naturally instead of an obviously-
  // locked button (which they'd just dismiss).
  const handleExportBom = async () => {
    const projectId = currentProject?.id;
    if (!projectId) {
      setMessage({ type: 'error', text: 'Save the project before exporting a BOM.' });
      return;
    }
    try {
      const resp = await fetch(`/api/pro/projects/${projectId}/bom.csv`, {
        credentials: 'include',
      });
      if (resp.status === 402) {
        // Fire the in-place upgrade modal instead of bouncing to /pricing —
        // keeps the user in the editor with full context. The pro overlay's
        // UpgradeGate listens for this event and opens UpgradePromptModal.
        window.dispatchEvent(new CustomEvent('velxio-pro-upgrade-prompt', {
          detail: { componentName: 'BOM export' },
        }));
        return;
      }
      if (resp.status === 401) {
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!resp.ok) {
        setMessage({ type: 'error', text: 'BOM export failed.' });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Filename comes from Content-Disposition; pick a fallback.
      const cd = resp.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"]+)"?/.exec(cd);
      a.download = m ? m[1] : `bom-${projectId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setMessage({ type: 'error', text: 'BOM export failed.' });
    }
  };

  const handleFirmwareUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (firmwareInputRef.current) firmwareInputRef.current.value = '';
    if (!file) return;

    setConsoleOpen(true);
    addLog({ timestamp: new Date(), type: 'info', message: `Loading firmware: ${file.name}...` });

    try {
      const boardKind = activeBoard?.boardKind;
      if (!boardKind) {
        setMessage({ type: 'error', text: 'No board selected' });
        return;
      }

      const result = await readFirmwareFile(file, boardKind);

      // Architecture mismatch warning for ELF files
      if (result.elfInfo?.suggestedBoard && result.elfInfo.suggestedBoard !== boardKind) {
        const detected = result.elfInfo.architectureName;
        const current = activeBoard ? BOARD_KIND_LABELS[activeBoard.boardKind] : boardKind;
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: `Note: Detected ${detected} architecture, but current board is ${current}. Loading anyway.`,
        });
      }

      if (activeBoardId) {
        compileBoardProgram(activeBoardId, result.program);
        markCompiled();
        addLog({ timestamp: new Date(), type: 'info', message: result.message });
        setMessage({ type: 'success', text: `Firmware loaded: ${file.name}` });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to load firmware';
      addLog({ timestamp: new Date(), type: 'error', message: errMsg });
      setMessage({ type: 'error', text: errMsg });
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!importInputRef.current) return;
    importInputRef.current.value = '';
    if (!file) return;
    try {
      const result = await importProjectFile(file);
      if (result.kind === 'vlx') {
        // importVlxFile already wrote into the stores.
        setMessage({ type: 'success', text: `Imported ${file.name}` });
        return;
      }
      // .zip path: apply the parsed payload to the stores ourselves, then
      // surface any missing libraries via the existing install modal.
      const { loadFiles } = useEditorStore.getState();
      const { setComponents, setWires, setBoardType, setBoardPosition, stopSimulation } =
        useSimulatorStore.getState();
      stopSimulation();
      if (result.boardType) setBoardType(result.boardType);
      setBoardPosition(result.boardPosition);
      setComponents(result.components);
      setWires(result.wires);
      if (result.files.length > 0) loadFiles(result.files);
      setMessage({ type: 'success', text: `Imported ${file.name}` });
      if (result.libraries.length > 0) {
        setPendingLibraries(result.libraries);
        setInstallModalOpen(true);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Import failed.' });
    }
  };

  return (
    <>
      <div className="editor-toolbar-wrapper" style={{ position: 'relative' }}>
        <div className="editor-toolbar" ref={toolbarRef}>
          {/* MicroPython language selector — only when active board supports it.
              The board context pill that used to live here was removed: it
              duplicated the BoardSelector dropdown elsewhere in the toolbar. */}
          {activeBoard && BOARD_SUPPORTS_MICROPYTHON.has(activeBoard.boardKind) && (
            <select
              className="tb-lang-select"
              value={activeBoard.languageMode ?? 'arduino'}
              onChange={(e) => {
                if (activeBoardId)
                  setBoardLanguageMode(activeBoardId, e.target.value as LanguageMode);
              }}
              title={t('editor.toolbar.languageMode')}
              style={{
                background: '#2d2d2d',
                color: '#ccc',
                border: '1px solid #444',
                borderRadius: 4,
                padding: '2px 4px',
                fontSize: 11,
                cursor: 'pointer',
                outline: 'none',
                marginRight: 4,
              }}
            >
              <option value="arduino">Arduino C++</option>
              <option value="micropython">MicroPython</option>
            </select>
          )}

          <div className="toolbar-group">
            {/* Compile */}
            <button
              onClick={handleCompile}
              disabled={compiling || !activeBoard}
              className="tb-btn tb-btn-compile"
              title={
                !activeBoard
                  ? t('editor.toolbar.compile.addBoard')
                  : compiling
                    ? t('editor.toolbar.compile.loading')
                    : activeBoard?.languageMode === 'micropython'
                      ? t('editor.toolbar.compile.loadMicropython')
                      : t('editor.toolbar.compile.compile')
              }
            >
              {compiling ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="spin"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
              )}
            </button>

            <div className="tb-divider" />

            {/* Run */}
            <button
              onClick={handleRun}
              disabled={
                isBoardless
                  ? digitalRunning
                  : running || compiling || !activeBoard
              }
              className="tb-btn tb-btn-run"
              title={
                isBoardless
                  ? digitalRunning
                    ? 'Digital simulation running'
                    : 'Resume digital simulation'
                  : !activeBoard
                    ? t('editor.toolbar.run.addBoard')
                    : activeBoard?.languageMode === 'micropython'
                      ? t('editor.toolbar.run.runMicropython')
                      : t('editor.toolbar.run.run')
              }
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </button>

            {/* Stop */}
            <button
              onClick={handleStop}
              disabled={isBoardless ? !digitalRunning : !running}
              className="tb-btn tb-btn-stop"
              title={isBoardless ? 'Freeze digital simulation' : t('editor.toolbar.stop')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </button>

            {/* Reset */}
            <button
              onClick={handleReset}
              disabled={!compiledHex && !activeBoard?.compiledProgram}
              className="tb-btn tb-btn-reset"
              title={t('editor.toolbar.reset')}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>

            {boards.length > 1 && (
              <>
                <div className="tb-divider" />

                {/* Compile All */}
                <button
                  onClick={handleCompileAll}
                  disabled={compileAllRunning}
                  className="tb-btn tb-btn-compile-all"
                  title={t('editor.toolbar.compileAll')}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    <path d="M6 20h4M14 4l4 4" strokeDasharray="2 2" />
                  </svg>
                </button>

                {/* Run All */}
                <button
                  onClick={handleRunAll}
                  disabled={running}
                  className="tb-btn tb-btn-run-all"
                  title={t('editor.toolbar.runAll')}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="3,3 11,12 3,21" />
                    <polygon points="13,3 21,12 13,21" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Center slot — file tabs share the row so action icons stay pinned. */}
          {centerSlot && <div className="toolbar-center-slot">{centerSlot}</div>}

          <div className="toolbar-group toolbar-group-right">
            {/* Hidden file input for project import. Accepts both .vlx
                (Velxio native) and .zip (Wokwi bundle); the dispatcher in
                utils/importProject.ts picks the right loader by extension. */}
            <input
              ref={importInputRef}
              type="file"
              accept={PROJECT_FILE_ACCEPT}
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            {/* Hidden file input for firmware upload */}
            <input
              ref={firmwareInputRef}
              type="file"
              accept=".hex,.bin,.elf,.ihex"
              style={{ display: 'none' }}
              onChange={handleFirmwareUpload}
            />

            {/* Library Manager — always visible with label */}
            <button
              onClick={() => {
                trackOpenLibraryManager();
                setLibManagerOpen(true);
              }}
              className="tb-btn-libraries"
              title={t('editor.toolbar.libraries.title')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                <path d="m3.3 7 8.7 5 8.7-5" />
                <path d="M12 22V12" />
              </svg>
              <span className="tb-libraries-label">{t('editor.toolbar.libraries.label')}</span>
            </button>

            {/* Import zip — inline by default; container query at narrow
                widths swaps this for the corresponding overflow-menu item. */}
            <button
              onClick={() => importInputRef.current?.click()}
              className="tb-btn tb-btn-import-inline"
              title={t('editor.toolbar.import')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              onClick={() => handleExport()}
              className="tb-btn tb-btn-export-inline"
              title={t('editor.toolbar.export')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            {/* Overflow "More" menu — collects the secondary actions
                (BOM, Schematic image, Upload firmware) so the toolbar no
                longer overflows on narrow widths.  The two Pro items show
                a small "PRO" pill in the menu so users know they're
                premium BEFORE clicking, instead of being surprised by an
                upgrade prompt. */}
            <div className="tb-overflow-wrap" ref={moreMenuRef}>
              <button
                onClick={() => setMoreMenuOpen((v) => !v)}
                className={`tb-btn tb-btn-overflow${moreMenuOpen ? ' tb-btn-overflow-active' : ''}`}
                title={t('editor.toolbar.more', 'More')}
                aria-haspopup="true"
                aria-expanded={moreMenuOpen}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              {moreMenuOpen && (
                <div className="tb-overflow-menu" role="menu">
                  {/* Responsive items — hidden by default, shown via
                      container query when the toolbar is too narrow to
                      keep their inline twins.  Keeps mobile users from
                      losing access to Import / Export entirely. */}
                  <button
                    className="tb-overflow-item tb-overflow-import"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      importInputRef.current?.click();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.importLabel', 'Import project')}</span>
                  </button>
                  <button
                    className="tb-overflow-item tb-overflow-export"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleExport();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.exportLabel', 'Export project (.zip)')}</span>
                  </button>
                  <button
                    className="tb-overflow-item"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleExportBom();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                      <line x1="9" y1="4" x2="9" y2="20" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.exportBomLabel', 'Bill of Materials (CSV)')}</span>
                    <span className="tb-overflow-pro">PRO</span>
                  </button>
                  <button
                    className="tb-overflow-item"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleExportScreenshot();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.exportScreenshotLabel', 'Schematic image (PNG)')}</span>
                    <span className="tb-overflow-pro">PRO</span>
                  </button>
                  <button
                    className="tb-overflow-item"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      firmwareInputRef.current?.click();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                      <line x1="12" y1="15" x2="12" y2="22" />
                      <polyline points="8 18 12 22 16 18" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.uploadFirmwareLabel', 'Upload firmware')}</span>
                  </button>
                  {/* Sync to GitHub — Pro feature.  Fires a window event the
                      pro overlay listens for; if no overlay is loaded (OSS
                      build) the click is a silent no-op which is fine —
                      OSS users can't have linked repos anyway. */}
                  <button
                    className="tb-overflow-item"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      window.dispatchEvent(new CustomEvent('velxio-pro-github-sync-prompt', {
                        detail: { projectId: currentProject?.id ?? null },
                      }));
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.72-4.04-1.61-4.04-1.61-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.72.08-.72 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.62-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.01 2.05.14 3.01.4 2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22 0 1.6-.02 2.89-.02 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span className="tb-overflow-label">{t('editor.toolbar.githubSyncLabel', 'Sync to GitHub')}</span>
                    <span className="tb-overflow-pro">PRO</span>
                  </button>
                </div>
              )}
            </div>

            <div className="tb-divider" />

            {/* Output Console toggle */}
            <button
              onClick={() => setConsoleOpen((v) => !v)}
              className={`tb-btn tb-btn-output${consoleOpen ? ' tb-btn-output-active' : ''}`}
              title={t('editor.toolbar.toggleConsole')}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
            {rightSlot}
          </div>
        </div>
      </div>

      {/* Error detail bar */}
      {message?.type === 'error' && message.text.length > 40 && !consoleOpen && (
        <div className="toolbar-error-detail">{message.text}</div>
      )}

      {/* Missing library hint */}
      {missingLibHint && (
        <div className="tb-lib-hint">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{t('editor.toolbar.libHint.message')}</span>
          <button
            className="tb-lib-hint-btn"
            onClick={() => {
              trackOpenLibraryManager();
              setLibManagerOpen(true);
              setMissingLibHint(false);
            }}
          >
            {t('editor.toolbar.libHint.cta')}
          </button>
          <button
            className="tb-lib-hint-close"
            onClick={() => setMissingLibHint(false)}
            title={t('editor.toolbar.libHint.dismiss')}
          >
            &times;
          </button>
        </div>
      )}

      <LibraryManagerModal isOpen={libManagerOpen} onClose={() => setLibManagerOpen(false)} />
      <InstallLibrariesModal
        isOpen={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        libraries={pendingLibraries}
      />
      {verification && (
        <CircuitVerificationModal
          result={verification}
          onCancel={() => {
            pendingRunRef.current = null;
            setVerification(null);
          }}
          onRunAnyway={() => {
            const resume = pendingRunRef.current;
            pendingRunRef.current = null;
            setVerification(null);
            resume?.();
          }}
        />
      )}
    </>
  );
};
