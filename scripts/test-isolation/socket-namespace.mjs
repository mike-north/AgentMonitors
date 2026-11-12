/**
 * Test-only relocation of the production socket fallback's fixed OS namespace.
 * It cannot follow HOME or TMPDIR in production (002 §10.3); source tests and
 * built-CLI children therefore intercept only those exact path joins. All
 * socket hashing, liveness probes, ownership checks and real IPC still run.
 */
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

// The built-in module survives Vitest's per-file module cache resets. Mark it
// there so successive setup files do not stack wrappers around every path join.
const installed = Symbol.for('agentmonitors.testSocketNamespace');

/** Install before product imports; the current case selects the owned root. @internal */
export function installSocketNamespace() {
  if (path[installed]) return;
  const join = path.join;
  path.join = (...parts) => {
    if (
      parts[0] === '/tmp' &&
      /^agentmonitors-(?:\d+|[a-f0-9]{16}\.sock)$/.test(parts[1] ?? '')
    ) {
      const root = process.env.AGENTMONITORS_TEST_SOCKET_ROOT;
      if (!root)
        throw new Error('Socket fallback requires an owned test namespace');
      return join(root, ...parts.slice(1));
    }
    return join(...parts);
  };
  Object.defineProperty(path, installed, { value: true });
  // Keep named ESM imports and CommonJS/default imports on the same boundary.
  syncBuiltinESMExports();
}
