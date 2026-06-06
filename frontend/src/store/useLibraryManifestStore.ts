import { create } from 'zustand';

/**
 * Library manifest for the currently-loaded example/project (P2.3).
 *
 * The declared library set is sent to the backend compiler as the resolution
 * SCOPE: ESP-IDF then merges only these libraries (plus the core), so a sketch
 * picks the declared lib and never an unrelated one from the shared dir.
 *
 * `null` = no manifest -> legacy scan-all (unchanged behaviour). Set by
 * `loadExample` to the example's declared `libraries` (or null for core-only
 * examples). Switching between examples updates it; loading a non-example
 * workspace leaves the previous value, but that only degrades to scan-all via
 * the backend's graceful fallback — never an incorrect build.
 */
interface LibraryManifestState {
  libraries: string[] | null;
  setLibraries: (libs: string[] | null | undefined) => void;
}

export const useLibraryManifestStore = create<LibraryManifestState>((set) => ({
  libraries: null,
  setLibraries: (libs) => set({ libraries: libs && libs.length ? libs : null }),
}));
