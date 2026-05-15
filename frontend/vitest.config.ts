import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration — split out from `vite.config.ts` (Phase 1d-tests J).
 *
 * `vite.config.ts` no longer owns the `test:` block; vitest auto-loads
 * this file and CI workflows can reference it directly.  Defaults below
 * tune for the velxio test suite:
 *
 *   - 30 s test timeout: smoke tests iterating 200+ examples need
 *     headroom; per-test individual asserts are still fast.
 *   - `forks` pool with `singleFork: false` so each test file runs in
 *     its own Node worker.  The NgSpiceNodeAdapter is a process-wide
 *     singleton (emscripten module can't reinitialise); without per-file
 *     isolation, state leaks between tests sharing the same worker.
 *   - Coverage excludes the WASM bundle (large binary, irrelevant lcov)
 *     and the test files themselves.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    coverage: {
      provider: 'v8',
      include: [
        'src/simulation/**/*.ts',
        'src/utils/exampleTo*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        'src/simulation/spice/wasm/**',
      ],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
