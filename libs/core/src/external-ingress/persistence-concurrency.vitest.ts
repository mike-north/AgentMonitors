import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/external-ingress/persistence-concurrency.child.ts'],
    pool: 'threads',
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
