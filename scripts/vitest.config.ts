import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['**/*.test.ts'],
    // Files launch nested Vitest/package-manager processes. One outer file at
    // a time avoids multiplying those pools and starving bounded facility checks.
    fileParallelism: false,
  },
});
