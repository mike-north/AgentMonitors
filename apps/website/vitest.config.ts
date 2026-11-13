import { defineConfig } from 'vitest/config';
import { testIsolation } from '../../scripts/test-isolation/config.mjs';

/** Website unit tests share the workspace's default filesystem boundary. */
export default defineConfig({
  test: {
    ...testIsolation,
    passWithNoTests: false,
  },
});
