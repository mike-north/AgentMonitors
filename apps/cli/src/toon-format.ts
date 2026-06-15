/**
 * TOON output format helper.
 *
 * Wraps `@toon-format/toon` `encode`/`decode` for the CLI's structured-output
 * commands. All durable storage (SQLite, hook-state files, IPC wire) stays JSON;
 * TOON is a *terminal* rendering transform applied at the CLI output edge.
 *
 * @see https://toonformat.dev/
 * @see https://github.com/toon-format/toon
 */
import { encode, decode } from '@toon-format/toon';

/**
 * Render an arbitrary JSON-serialisable value as a TOON string for terminal
 * output. This is the only place in the CLI that calls `encode()`; all callers
 * should import and use this helper rather than the library directly so the
 * transform stays easy to find and audit.
 *
 * The input is first normalised through `JSON.parse(JSON.stringify(value))` to
 * strip any non-serialisable properties (e.g. `undefined` values, class
 * instances) before encoding, matching the semantics of `JSON.stringify`.
 */
export function renderToon(value: unknown): string {
  // Normalise to a plain JSON value first — same guarantee as JSON.stringify.
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown;
  return encode(jsonValue);
}

/**
 * Decode a TOON string back to its JSON value. Exported for use in tests to
 * assert round-trip safety (TOON output must decode to the same value that
 * `--format json` would produce).
 */
export { decode as decodeToon };
