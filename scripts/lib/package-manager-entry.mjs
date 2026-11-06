/**
 * Locate package-manager JavaScript entrypoints without executing command shims.
 * Manager identity matters: npm cannot replace pnpm's workspace-protocol rewrite.
 * PATH installations may be separate from Node; Windows .cmd files are locations
 * to inspect for adjacent package files, never programs to pass to a shell.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve filesystem identity before lexical joins can collapse symlink/.. traversal.
 * Native realpath follows OS lookup semantics; the JS realpath implementation can
 * normalize away that traversal. Unusable search entries must not hide later tools.
 * @param {string} candidate
 * @param {'file' | 'directory'} kind
 */
function physicalPath(candidate, kind) {
  try {
    const resolved = realpathSync.native(candidate);
    const stat = statSync(resolved);
    return (kind === 'directory' ? stat.isDirectory() : stat.isFile())
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

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
 * Return an absolute physical Node-executable launcher, or undefined when no
 * supported installation is present. Anchor identity at discovery time because
 * consumers choose their own subprocess cwd. Prefer the invoking manager, then Node's
 * official layout, then PATH symlinks and npm/Corepack-style adjacent installations.
 * Never interpret shell wrapper contents or substitute another manager for the
 * requested one.
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
  if (invoked && existsSync(invoked)) {
    const selected = physicalPath(invoked, 'file');
    if (selected && isEntry(selected, manager)) return selected;
  }
  const nodeDir = physicalPath(path.dirname(process.execPath), 'directory');
  const candidates = nodeDir
    ? relatives.map((relative) =>
        path.join(
          nodeDir,
          process.platform === 'win32' ? 'node_modules' : '../lib/node_modules',
          relative,
        ),
      )
    : [];
  // Only Windows treats Path as PATH; POSIX variables with other casing are unrelated.
  const pathKey =
    process.platform === 'win32'
      ? Object.keys(process.env).find((key) => key.toLowerCase() === 'path')
      : 'PATH';
  const searchPath = process.env[pathKey ?? 'PATH'];
  // Explicit POSIX empty components mean discovery-time cwd; unset PATH does not.
  for (const rawDir of searchPath === undefined
    ? []
    : searchPath.split(path.delimiter)) {
    if (rawDir === '' && process.platform === 'win32') continue;
    const dir = physicalPath(rawDir || process.cwd(), 'directory');
    if (!dir) continue;
    for (const suffix of process.platform === 'win32'
      ? ['', '.cmd', '.exe']
      : ['']) {
      const bin = path.join(dir, manager + suffix);
      if (existsSync(bin)) {
        const target = physicalPath(bin, 'file');
        if (!target) continue;
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
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const selected = physicalPath(candidate, 'file');
    // A nominal installation path can link to another manager's launcher.
    if (selected && isEntry(selected, manager)) return selected;
  }
  return undefined;
}
