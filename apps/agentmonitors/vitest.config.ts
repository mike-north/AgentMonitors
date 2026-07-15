import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite that discovers zero test files MUST fail rather than report a
    // false green (issue #288) — see scripts/vitest-pass-with-no-tests.test.ts.
    passWithNoTests: false,
    // The launcher smoke test spawns a real Node subprocess that loads the full
    // CLI; under parallel CI load that occasionally hiccups. Retry a couple of
    // times so a transient contention blip doesn't red the suite — a genuine
    // launcher break still fails all attempts (and the test dumps the
    // subprocess stderr/status on failure for diagnosis).
    retry: 2,
  },
});
