import { useLibraryManifestStore } from '../store/useLibraryManifestStore';

/**
 * Apply a saved project's declared library manifest (the compile scope) to the
 * manifest store on load, so the editor, toolbar, Library Manager and
 * velxio.json all reflect it. `null`/empty -> no scope (legacy scan-all).
 *
 * Lives in its own util so both the OSS and the pro-overlay ProjectByIdPage
 * (the one actually routed on velxio.dev) restore the manifest identically.
 */
export function applyProjectManifest(librariesJson: string | undefined | null): void {
  try {
    const parsed = JSON.parse(librariesJson || '[]');
    const libs = Array.isArray(parsed) && parsed.length ? (parsed as string[]) : null;
    useLibraryManifestStore.getState().setLibraries(libs);
  } catch {
    useLibraryManifestStore.getState().setLibraries(null);
  }
}
