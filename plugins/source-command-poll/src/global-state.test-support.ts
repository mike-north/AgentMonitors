/** Timeout-safe teardown for tests that instrument process-wide state. */
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Snapshot before each case and restore from a framework hook. A timed-out
 * awaited observation need not unwind its own finally before the next case.
 * @internal
 */
export function restoreProcessGlobalsAfterEach(): void {
  let environment: NodeJS.ProcessEnv;
  beforeEach(() => {
    environment = { ...process.env };
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in environment)) Reflect.deleteProperty(process.env, key);
    }
    Object.assign(process.env, environment);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
