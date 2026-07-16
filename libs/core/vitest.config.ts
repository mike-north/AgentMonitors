import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite that discovers zero test files MUST fail rather than report a
    // false green (issue #288) — an accidentally emptied, renamed-away-from,
    // or excluded test suite is exactly the failure this guards against.
    // vitest 4 already defaults to false; set explicitly for the same reason
    // apps/cli/vitest.serial.config.ts does — see scripts/vitest-pass-with-no-tests.test.ts.
    passWithNoTests: false,
  },
});
