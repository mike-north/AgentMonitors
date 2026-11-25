import { testIsolation } from '../../scripts/test-isolation/config.mjs';
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    ...testIsolation,
    // A suite that discovers zero test files MUST fail rather than report a
    // false green (issue #288) — see scripts/vitest-pass-with-no-tests.test.ts.
    passWithNoTests: false,
    // Exclude daemon-spawn tests from the default parallel run.  They spawn
    // real child processes that bind Unix sockets; under nx run-many (up to
    // 3 concurrent projects) the children are CPU-starved and can't bind
    // within any reasonable timeout.  They run in isolation via the
    // test:serial script (vitest.serial.config.ts).  `verify.integration`
    // boots a supervised isolated daemon per case, so it belongs here too.
    // The Docker install smoke runs alone in the uncached test:docker-smoke target.
    exclude: [
      ...configDefaults.exclude,
      '**/concurrent-spawn.test.ts',
      '**/input-limits.integration.test.ts',
      '**/detached-spawn.test.ts',
      '**/daemon-detach.integration.test.ts',
      '**/daemon-crash-recovery.integration.test.ts',
      '**/daemon-restart-sweep.integration.test.ts',
      '**/daemon-ingress-kill-fault.integration.test.ts',
      '**/daemon-retry-kill-fault.integration.test.ts',
      '**/verify.integration.test.ts',
      '**/cli.docker.test.ts',
      // Spawns a real `channel serve` subprocess and waits for it to exit on
      // its own, so it belongs with the other process-spawning suites.
      '**/channel-shutdown.integration.test.ts',
      '**/transport-health.integration.test.ts',
      '**/held-notify.integration.test.ts',
      // Real preset captures start multiple Node helpers before a short command
      // deadline; CPU contention must not turn fixture startup into a timeout.
      '**/pr-alerting-presets.test.ts',
      // Caller-exit timing is measured in a real subprocess without runner contention.
      '**/source-command-lifetime.test.ts',
      '**/daemon-reaper-lease.integration.test.ts',
    ],
  },
});
