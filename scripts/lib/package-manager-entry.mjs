/**
 * Locate package-manager JavaScript entrypoints without executing command shims.
 * Manager identity matters: npm cannot replace pnpm's workspace-protocol rewrite.
 * PATH installations may be separate from Node; Windows .cmd files are locations
 * to inspect for adjacent package files, never programs to pass to a shell.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Recognize only the requested manager's named JS launcher, including Corepack proxies. */
function isEntry(candidate, manager) {
  const name = path.basename(candidate);
  return manager === 'pnpm'
    ? /^pnpm\.(?:cjs|mjs|js)$/i.test(name)
    : /^npm-cli\.(?:cjs|mjs|js)$/i.test(name);
}

/**
 * Return a Node-executable launcher, or undefined when no supported installation
 * is present. Prefer the invoking manager, then Node's official layout, then
 * PATH symlinks and npm/Corepack-style adjacent installations. Never interpret
 * shell wrapper contents or substitute another manager for the requested one.
 * @internal
 */
export function packageManagerEntry(manager) {
  const relative =
    manager === 'npm' ? 'npm/bin/npm-cli.js' : 'pnpm/bin/pnpm.cjs';
  const invoked = process.env.npm_execpath;
  if (invoked && isEntry(invoked, manager) && existsSync(invoked))
    return invoked;
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(
      nodeDir,
      process.platform === 'win32' ? 'node_modules' : '../lib/node_modules',
      relative,
    ),
  ];
  // PATH is case-insensitive on Windows, where the environment may spell it Path.
  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === 'path',
  );
  for (const dir of (process.env[pathKey ?? 'PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)) {
    for (const suffix of process.platform === 'win32'
      ? ['', '.cmd', '.exe']
      : ['']) {
      const bin = path.join(dir, manager + suffix);
      if (existsSync(bin)) {
        const target = realpathSync(bin);
        if (isEntry(target, manager)) candidates.push(target);
        candidates.push(
          path.join(path.dirname(target), 'node_modules', relative),
        );
      }
    }
    candidates.push(path.join(dir, 'node_modules', relative));
    candidates.push(path.join(dir, '../lib/node_modules', relative));
  }
  return candidates.find((candidate) => existsSync(candidate));
}
