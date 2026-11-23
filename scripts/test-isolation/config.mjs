/** Shared, opt-out-free boundary used by every maintained Vitest entry point. */
import { fileURLToPath, URL } from 'node:url';

/** Absolute paths also work when a subprocess fixture inherits a package config. @internal */
export const testIsolation = {
  globalSetup: [fileURLToPath(new URL('./global-setup.mjs', import.meta.url))],
  setupFiles: [fileURLToPath(new URL('./setup.mjs', import.meta.url))],
};
