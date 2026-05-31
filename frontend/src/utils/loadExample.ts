/**
 * Shared utility to load an example project into the editor and simulator stores.
 * Used by both ExamplesPage (gallery click) and ExampleLoaderPage (direct URL).
 */

import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';
import { isPiBoardKind } from '../types/board';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { useProjectStore } from '../store/useProjectStore';
import { useVfsStore } from '../store/useVfsStore';
import { isBoardComponent } from './boardPinMapping';
import { getInstalledLibraries, installLibrary } from '../services/libraryService';
import { trackOpenExample } from './analytics';
import { stripBrandPrefix } from './exampleToBuildNetlistInput';

export interface LibraryInstallProgress {
  total: number;
  done: number;
  current: string;
}

/**
 * Install any missing Arduino libraries required by an example.
 * Calls onProgress for UI updates; silently continues on failure.
 */
export async function ensureLibraries(
  libs: string[],
  onProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  if (libs.length === 0) return;
  try {
    const installed = await getInstalledLibraries();
    const installedNames = new Set(
      installed.map((l) => (l.library?.name ?? l.name ?? '').toLowerCase()),
    );
    const missing = libs.filter((l) => !installedNames.has(l.toLowerCase()));
    if (missing.length === 0) return;

    onProgress?.({ total: missing.length, done: 0, current: missing[0] });
    for (let i = 0; i < missing.length; i++) {
      onProgress?.({ total: missing.length, done: i, current: missing[i] });
      await installLibrary(missing[i]);
    }
    onProgress?.(null);
  } catch {
    onProgress?.(null);
  }
}

/**
 * Load an example project into the editor + simulator stores.
 * Does NOT navigate — the caller is responsible for navigation.
 */
export async function loadExample(
  example: ExampleProject,
  onLibraryProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  trackOpenExample(example.title);

  // CRITICAL — clear currentProject FIRST, before touching any other store.
  //
  // Otherwise: user has a saved project open (currentProject = { id, slug, …}),
  // navigates to /examples, clicks an example. We mutate the simulator +
  // editor stores below; the auto-save hook is still subscribed and still
  // thinks the active project is the user's saved one. It debounces a
  // PUT /api/projects/<old-id> with the example's components/wires/files
  // and OVERWRITES the user's saved project with the example contents.
  //
  // The auto-save hook is subscribed to useProjectStore and resets its
  // baseline (projectId=null, lastSavedHash=null) whenever currentProject?.id
  // changes. Clearing here BEFORE the mutations below guarantees the hook
  // sees null as projectId during every subsequent simulator/editor change,
  // so no PUT goes out.
  useProjectStore.getState().clearCurrentProject();

  // Loading a new example always starts unpaused — otherwise the canvas
  // would open with every LED frozen at the previous example's state.
  useElectricalStore.getState().setPaused(false);

  // Auto-install required libraries
  if (example.libraries && example.libraries.length > 0) {
    await ensureLibraries(example.libraries, onLibraryProgress);
  }

  const {
    setComponents,
    setWires,
    setBoardLanguageMode,
    boards,
    addBoard,
    removeBoard,
    setActiveBoardId,
    recalculateAllWirePositions,
  } = useSimulatorStore.getState();

  if (example.boards && example.boards.length > 0) {
    // ── Multi-board loading ───────────────────────────────────────────────
    const currentIds = boards.map((b) => b.id);
    currentIds.forEach((id) => removeBoard(id));

    example.boards.forEach((eb) => {
      addBoard(eb.boardKind as BoardKind, eb.x, eb.y);
    });

    // Match addBoard's deterministic ID rule (useSimulatorStore.addBoard):
    //   1st board of a kind  → id = boardKind
    //   2nd board of a kind  → id = `${boardKind}-2`
    //   Nth board of a kind  → id = `${boardKind}-N`
    // This is what wires reference, so the loader must compute the same IDs
    // when loading per-board code/vfs.
    const kindCount = new Map<string, number>();
    const boardIds: string[] = example.boards.map((eb) => {
      const n = (kindCount.get(eb.boardKind) ?? 0) + 1;
      kindCount.set(eb.boardKind, n);
      return n === 1 ? eb.boardKind : `${eb.boardKind}-${n}`;
    });

    const { boards: newBoards } = useSimulatorStore.getState();
    example.boards.forEach((eb, idx) => {
      const boardId = boardIds[idx];
      const board = newBoards.find((b) => b.id === boardId);
      if (!board) return;

      if (eb.code) {
        // Arduino-style boards (AVR, RP2040, ESP32, …) all need the `.ino`
        // extension so arduino-cli auto-includes <Arduino.h>. Only the Pi 3B
        // uses a different toolchain (Python via VFS or g++ for `.cpp`).
        const filename = isPiBoardKind(eb.boardKind) ? 'main.cpp' : 'sketch.ino';
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles([{ name: filename, content: eb.code }]);
      }

      if (eb.vfsFiles && isPiBoardKind(eb.boardKind)) {
        const vfsState = useVfsStore.getState();
        const tree = vfsState.getTree(boardId);
        for (const [nodeId, node] of Object.entries(tree)) {
          if (node.type === 'file' && eb.vfsFiles[node.name] !== undefined) {
            vfsState.setContent(boardId, nodeId, eb.vfsFiles[node.name]);
          }
        }
      }
    });

    const firstArduinoIdx = example.boards.findIndex(
      (eb) =>
        !isPiBoardKind(eb.boardKind) &&
        eb.boardKind !== 'esp32' &&
        eb.boardKind !== 'esp32-s3' &&
        eb.boardKind !== 'esp32-c3',
    );
    if (firstArduinoIdx !== -1) {
      setActiveBoardId(boardIds[firstArduinoIdx]);
    }

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('raspberry') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: stripBrandPrefix(comp.type),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: { componentId: wire.start.componentId, pinName: wire.start.pinName, x: 0, y: 0 },
        end: { componentId: wire.end.componentId, pinName: wire.end.pinName, x: 0, y: 0 },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  } else {
    // ── Single-board loading ─────────────────────────────────────────────
    // Tear the canvas down to nothing first, then (unless the example is
    // board-less) add exactly one fresh board of the target kind.
    //
    // Analog-only and digital-only SPICE examples are board-less — they open
    // with just the circuit (boards are optional: 0, 1, or many at any time).
    //
    // Rebuilding from scratch — rather than reusing and retyping a leftover
    // board from a previous (possibly multi-board) example — is what keeps
    // this prolijo: a single-board example always ends with exactly one
    // board whose id matches its kind. The old reuse path left a stale id
    // (e.g. "stm32-bluepill" on what was now an Arduino Uno) and any extra
    // boards as residue. This mirrors the multi-board path above; the
    // setComponents/setWires calls below replace components and wires
    // wholesale.
    const filter = (example as { boardFilter?: string }).boardFilter;
    const isBoardless = filter === 'analog' || filter === 'digital';

    boards.forEach((b) => removeBoard(b.id));

    if (!isBoardless) {
      const targetBoard = example.boardType || 'arduino-uno';
      const newId = addBoard(
        targetBoard as BoardKind,
        DEFAULT_BOARD_POSITION.x,
        DEFAULT_BOARD_POSITION.y,
      );
      setActiveBoardId(newId);
    }

    // ── MicroPython + multi-file payloads ────────────────────────────────
    // When the example specifies languageMode='micropython' or ships a
    // files[] array, we go through setBoardLanguageMode + loadFiles instead
    // of the legacy setCode() path so the editor opens the right file
    // (main.py) with the right language mode.
    const liveBoardId = useSimulatorStore.getState().activeBoardId;
    const liveBoard = useSimulatorStore
      .getState()
      .boards.find((b) => b.id === liveBoardId);

    if (example.languageMode === 'micropython' && liveBoard) {
      setBoardLanguageMode(liveBoard.id, 'micropython');
    }

    if (example.files && example.files.length > 0 && liveBoard) {
      // Re-resolve the file group ID — setBoardLanguageMode replaces it.
      const updatedBoard = useSimulatorStore
        .getState()
        .boards.find((b) => b.id === liveBoard.id);
      const groupId = updatedBoard?.activeFileGroupId ?? liveBoard.activeFileGroupId;
      const editorStore = useEditorStore.getState();
      editorStore.setActiveGroup(groupId);
      editorStore.loadFiles(example.files);
    } else if (liveBoard) {
      // Single-file Arduino-style example. We must use `loadFiles` (not the
      // legacy `setCode`) and explicitly switch the editor store to the
      // board's file group: in board-less → board transitions the editor's
      // `activeFileId` still points at an orphan ID from the deleted
      // group, so `setCode` would silently no-op and the editor would
      // appear blank. (Regression test: load-example-transitions.test.ts.)
      const editorStore = useEditorStore.getState();
      editorStore.setActiveGroup(liveBoard.activeFileGroupId);
      const filename = isPiBoardKind(liveBoard.boardKind) ? 'main.cpp' : 'sketch.ino';
      editorStore.loadFiles([{ name: filename, content: example.code }]);
    } else {
      // Truly board-less: write the placeholder code to whatever the editor
      // currently shows (boardless examples ship a `void setup()/loop()`
      // stub — content barely matters since the user won't compile it).
      useEditorStore.getState().setCode(example.code);
    }

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: stripBrandPrefix(comp.type),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    // After possibly removing every board, re-read activeBoardId.
    const liveActiveBoardId = useSimulatorStore.getState().activeBoardId;
    // For analog (board-less) examples we leave any 'arduino-uno' references
    // in wires untouched — there shouldn't be any, but if there are we'd
    // rather emit a dangling endpoint than silently graft them onto a board
    // that no longer exists.
    const remapBoardId = (id: string) =>
      isBoardComponent(id) && liveActiveBoardId ? liveActiveBoardId : id;

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: {
          componentId: remapBoardId(wire.start.componentId),
          pinName: wire.start.pinName,
          x: 0,
          y: 0,
        },
        end: {
          componentId: remapBoardId(wire.end.componentId),
          pinName: wire.end.pinName,
          x: 0,
          y: 0,
        },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  }
}
