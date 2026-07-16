import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // A suite that discovers zero test files MUST fail rather than report a
    // false green (issue #288) — see scripts/vitest-pass-with-no-tests.test.ts.
    passWithNoTests: false,
    // Exclude daemon-spawn tests from the default parallel run.  They spawn
    // real child processes that bind Unix sockets; under nx run-many (up to
    // 3 concurrent projects) the children are CPU-starved and can't bind
    // within any reasonable timeout.  They run in isolation via the
    // test:serial script (vitest.serial.config.ts).  `verify.integration`
    // boots a supervised isolated daemon per case, so it belongs here too.
    exclude: [
      ...configDefaults.exclude,
      '**/concurrent-spawn.test.ts',
      '**/detached-spawn.test.ts',
      '**/verify.integration.test.ts',
    ],
  },
});
