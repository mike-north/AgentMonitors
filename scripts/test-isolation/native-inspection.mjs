/**
 * Trusted read-only IO for the host observer. Capture once before the adapter
 * patches built-ins, including across Vitest's per-file module cache resets.
 * Tests use guarded APIs; only inventory/observation code uses these references.
 */
import fs from 'node:fs';
import path from 'node:path';

const key = Symbol.for('agentmonitors.testInspectionNative');
if (!fs[key]) {
  let depth = 0;
  // Native read implementations can call other patched built-ins internally.
  // This capability brackets only these read-only primitives, never a test
  // callback; finally restores checking even when inspection fails.
  const readonly = (original) =>
    function (...args) {
      depth++;
      try {
        return Reflect.apply(original, this, args);
      } finally {
        depth--;
      }
    };
  Object.defineProperty(fs, key, {
    value: Object.freeze({
      active: () => depth > 0,
      fs: Object.freeze(
        Object.fromEntries(
          [
            'lstatSync',
            'readFileSync',
            'readdirSync',
            'readlinkSync',
            'realpathSync',
            'watch',
          ].map((name) => [name, readonly(fs[name])]),
        ),
      ),
      path: Object.freeze(
        Object.fromEntries(
          ['join', 'resolve', 'normalize', 'dirname', 'basename'].map(
            (name) => [name, readonly(path[name])],
          ),
        ),
      ),
      uid: process.getuid?.() ?? 0,
      separator: path.sep,
    }),
  });
}
/** Original read-only primitives are an observer capability, never cleanup authority. @internal */
export const inspection = fs[key];
