import { testIsolation } from '../../scripts/test-isolation/config.mjs';
import { defineConfig } from 'vitest/config';

// Run the live install in a single fork after the daemon-spawn tests so
// the container and daemon processes do not compete for CPU.
export default defineConfig({
  test: {
    ...testIsolation,
    include: ['src/commands/cli.docker.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    retry: 0,
    passWithNoTests: false,
  },
});
