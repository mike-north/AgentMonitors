import { defineConfig } from 'vitest/config';

/**
 * Serial vitest configuration for daemon-spawn integration tests.
 *
 * These tests spawn real daemon child processes that must bind a Unix socket.
 * Running them inside the default parallel vitest run (nx run-many --target=test
 * with up to 3 concurrent projects + vitest file-parallelism) starves the child
 * processes of CPU, causing intermittent bind timeouts.
 *
 * This config runs the two spawn files alone in a single fork, sequentially,
 * after the parallel suite finishes (see .github/workflows/ci.yml and the
 * root test:serial script).
 */
export default defineConfig({
  test: {
    include: ['src/concurrent-spawn.test.ts', 'src/detached-spawn.test.ts'],
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
