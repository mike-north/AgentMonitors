import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  platform: 'node',
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  noExternal: [/(.*)/],
  external: ['better-sqlite3'],
});
