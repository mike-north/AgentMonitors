import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Exclude daemon-spawn tests from the default parallel run.  They spawn
    // real child processes that bind Unix sockets; under nx run-many (up to
    // 3 concurrent projects) the children are CPU-starved and can't bind
    // within any reasonable timeout.  They run in isolation via the
    // test:serial script (vitest.serial.config.ts).
    exclude: [
      ...configDefaults.exclude,
      '**/concurrent-spawn.test.ts',
      '**/detached-spawn.test.ts',
    ],
  },
});
