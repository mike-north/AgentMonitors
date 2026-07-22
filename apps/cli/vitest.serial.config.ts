import { defineConfig } from 'vitest/config';

/**
 * Serial vitest configuration for daemon-spawn integration tests.
 *
 * These tests spawn real daemon child processes that must bind a Unix socket.
 * Running them inside the default parallel vitest run (nx run-many --target=test
 * with up to 3 concurrent projects + vitest file-parallelism) starves the child
 * processes of CPU, causing intermittent bind timeouts.
 *
 * This config runs the daemon-spawn files alone in a single fork, sequentially,
 * after the parallel suite finishes (see .github/workflows/ci.yml and the
 * root test:serial script). `verify.integration` is here too: each `verify`
 * case boots and supervises its own isolated daemon.
 *
 * `cli.docker.test.ts` is here for a related reason (PR #453 CI hang, issue
 * #425): it drives a Docker container through a SYNCHRONOUS `execFileSync`
 * that blocks its worker thread outright — vitest cannot preempt synchronous
 * code, so `testTimeout` alone cannot bound it. Running it in the parallel
 * pool alongside this PR's new real-daemon integration tests starved both of
 * CPU on CI's constrained runners badly enough to exceed the 30-minute job
 * timeout; the file self-skips without a reachable Docker daemon, so this was
 * entirely invisible locally. It is bounded instead by its own `execFileSync`
 * `timeout` option (Node kills the child directly) plus the generous
 * `testTimeout` below, which only needs to exceed that bound.
 */
export default defineConfig({
  test: {
    include: [
      'src/concurrent-spawn.test.ts',
      'src/detached-spawn.test.ts',
      'src/commands/daemon-detach.integration.test.ts',
      'src/commands/verify.integration.test.ts',
      'src/commands/cli.docker.test.ts',
      'src/channel-shutdown.integration.test.ts',
      'src/commands/transport-health.integration.test.ts',
    ],
    // No file-level parallelism — each file must complete before the next
    // starts so the daemon processes are never competing for CPU.
    fileParallelism: false,
    pool: 'forks',
    // maxWorkers: 1 + isolate: false is the Vitest 4 equivalent of the
    // removed poolOptions.forks.singleFork: true.
    maxWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    retry: 2,
    passWithNoTests: false,
  },
});
