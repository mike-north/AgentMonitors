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
  noExternal: [/^(?!better-sqlite3|bindings|file-uri-to-path)/],
  external: ['better-sqlite3', 'bindings', 'file-uri-to-path'],
});
