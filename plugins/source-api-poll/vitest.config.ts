import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite that discovers zero test files MUST fail rather than report a
    // false green (issue #288) — see scripts/vitest-pass-with-no-tests.test.ts.
    passWithNoTests: false,
  },
});
