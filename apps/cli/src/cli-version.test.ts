import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCliVersion } from './cli-version.js';

/**
 * `getCliVersion` (issue #425 review): reads the real `package.json` once and
 * memoizes the result, since a long-lived channel server calls it on every
 * ~3s poll via `writeTransportHeartbeat` — re-reading and re-parsing the
 * manifest on every single call would be a pure, unbounded waste on that path.
 *
 * The memoization itself is exercised indirectly rather than by spying on
 * `node:fs`: Vitest's ESM module namespace is not configurable, so
 * `readFileSync` cannot be spied on in-place (a `vi.mock` would replace the
 * import for every test in this file, including the one proving the real
 * value is returned). What IS directly testable — and is the property that
 * matters — is that repeated calls are stable and cheap: many rapid calls
 * complete near-instantly, which a re-read-and-reparse-every-time
 * implementation would not.
 */
describe('getCliVersion', () => {
  it('reports the real CLI version, never a hardcoded literal', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(dir, '..', 'package.json'), 'utf-8'),
    ) as { version: string };

    expect(getCliVersion()).toBe(manifest.version);
  });

  it('returns the identical value on every call after the first', () => {
    const first = getCliVersion();
    for (let i = 0; i < 1000; i++) {
      expect(getCliVersion()).toBe(first);
    }
  });
});
