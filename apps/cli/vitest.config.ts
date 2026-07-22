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
    //
    // `cli.docker.test.ts` is excluded for a related but distinct reason
    // (PR #453 CI hang, issue #425): it drives a Docker container through a
    // SYNCHRONOUS `execFileSync` — apt-get, a global npm install, a full pnpm
    // install, and seven package builds — which blocks its vitest worker
    // thread outright (vitest cannot preempt synchronous code). It only runs
    // in CI (self-skipping via `describe.skipIf` when no Docker daemon is
    // reachable), so it silently never competed for CPU locally. Once this
    // PR added several more real-daemon integration tests to the same
    // parallel pool (`doctor delivery-transport health`, the `channel serve`
    // MCP-subprocess regression, etc.), the combined CPU pressure on CI's
    // constrained runners was severe enough to blow the 30-minute job
    // timeout — invisible locally the whole time because the Docker test
    // never even runs here. It now runs alone, serially, in
    // `vitest.serial.config.ts`.
    exclude: [
      ...configDefaults.exclude,
      '**/concurrent-spawn.test.ts',
      '**/detached-spawn.test.ts',
      '**/daemon-detach.integration.test.ts',
      '**/verify.integration.test.ts',
      '**/cli.docker.test.ts',
      // Spawns a real `channel serve` subprocess and waits for it to exit on
      // its own, so it belongs with the other process-spawning suites.
      '**/channel-shutdown.integration.test.ts',
      '**/transport-health.integration.test.ts',
    ],
  },
});
