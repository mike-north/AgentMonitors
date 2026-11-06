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
  if (manager === 'pnpm') return /^pnpm\.(?:cjs|mjs|js)$/i.test(name);
  // Corepack's npm.js proxy is valid only in its named package layout, not
  // merely because an arbitrary invoking JavaScript file is named npm.js.
  const isCorepackNpm =
    name === 'npm.js' &&
    path.basename(path.dirname(candidate)) === 'dist' &&
    path.basename(path.dirname(path.dirname(candidate))) === 'corepack';
  return /^npm-cli\.(?:cjs|mjs|js)$/i.test(name) || isCorepackNpm;
}

/**
 * Return a Node-executable launcher, or undefined when no supported installation
 * is present. Prefer the invoking manager, then Node's official layout, then
 * PATH symlinks and npm/Corepack-style adjacent installations. Never interpret
 * shell wrapper contents or substitute another manager for the requested one.
 * @internal
 */
export function packageManagerEntry(manager) {
  // Installed pnpm launchers use the same module extensions as direct invocations.
  // Corepack shims point at named dist proxies rather than standalone manager bins.
  const relatives =
    manager === 'npm'
      ? ['npm/bin/npm-cli.js', 'corepack/dist/npm.js']
      : [
          ...['cjs', 'js', 'mjs'].map(
            (extension) => `pnpm/bin/pnpm.${extension}`,
          ),
          'corepack/dist/pnpm.js',
        ];
  const invoked = process.env.npm_execpath;
  if (invoked && isEntry(invoked, manager) && existsSync(invoked))
    return invoked;
  const nodeDir = path.dirname(process.execPath);
  const candidates = relatives.map((relative) =>
    path.join(
      nodeDir,
      process.platform === 'win32' ? 'node_modules' : '../lib/node_modules',
      relative,
    ),
  );
  // Only Windows treats Path as PATH; POSIX variables with other casing are unrelated.
  const pathKey =
    process.platform === 'win32'
      ? Object.keys(process.env).find((key) => key.toLowerCase() === 'path')
      : 'PATH';
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
          ...relatives.map((relative) =>
            path.join(path.dirname(target), 'node_modules', relative),
          ),
        );
      }
    }
    candidates.push(
      ...relatives.map((relative) => path.join(dir, 'node_modules', relative)),
      ...relatives.map((relative) =>
        path.join(dir, '../lib/node_modules', relative),
      ),
    );
  }
  return candidates.find((candidate) => existsSync(candidate));
}
