/**
 * Test-only host-path boundary. Production path resolution remains unchanged:
 * inherited overrides are cleared so its normal fallbacks resolve under the
 * owned HOME/XDG roots. Keep this inventory aligned with the CLI resolvers.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

// Node's native temp/home resolvers consult the original environment backing
// object. Tests that replace process.env with a plain object must not sever
// updates to that backing object for subsequent cases.
const nativeEnvironment = process.env;

// A file URL remains one NODE_OPTIONS token even in a checkout with spaces.
const socketPreload = `--import=${new URL('./socket-preload.mjs', import.meta.url).href}`;

/**
 * The environment inputs that may select storage, config, temp files, or a
 * running installation. Removing product overrides preserves tests of default
 * resolution instead of forcing every workspace onto one global database.
 * @param {string} root - Exclusively owned, short temporary directory.
 * @param {string} [toolRoot] - Run-owned tool caches, shared to avoid repeated
 * package-manager downloads without sharing application state between cases.
 * @returns {Record<string, string | undefined>} @internal
 */
export function isolatedEnvironment(root, toolRoot = root) {
  const options = process.env.NODE_OPTIONS ?? '';
  return {
    HOME: root,
    USERPROFILE: root,
    HOMEDRIVE: path.parse(root).root.replace(/[\\/]$/, ''),
    HOMEPATH: root.slice(path.parse(root).root.length - 1),
    APPDATA: path.join(root, 'c'),
    LOCALAPPDATA: path.join(root, 'l'),
    XDG_DATA_HOME: path.join(root, 'd'),
    XDG_CONFIG_HOME: path.join(root, 'c'),
    XDG_STATE_HOME: path.join(root, 's'),
    XDG_CACHE_HOME: path.join(root, 'k'),
    XDG_RUNTIME_DIR: path.join(root, 'r'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    COREPACK_HOME: path.join(toolRoot, 'p'),
    npm_config_cache: path.join(toolRoot, 'n'),
    AGENTMONITORS_TEST_SOCKET_ROOT: root,
    NODE_OPTIONS: options.includes(socketPreload)
      ? options
      : `${options} ${socketPreload}`.trim(),
    AGENTMONITORS_DB: undefined,
    AGENTMONITORS_SOCKET: undefined,
    CLAUDE_PROJECT_DIR: undefined,
  };
}

/**
 * Apply only the path boundary, retaining tool lookup and test-specific inputs.
 * Child processes inherit this environment unless a test constructs its own.
 * @param {Record<string, string | undefined>} env @internal
 */
export function applyEnvironment(env) {
  if (process.env !== nativeEnvironment) {
    const replacement = process.env;
    for (const key of Object.keys(nativeEnvironment)) {
      if (!(key in replacement)) Reflect.deleteProperty(nativeEnvironment, key);
    }
    for (const [key, value] of Object.entries(replacement)) {
      if (value !== undefined) nativeEnvironment[key] = value;
    }
    process.env = nativeEnvironment;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

/** @param {Record<string, string | undefined>} env @internal */
export function createEnvironmentDirectories(env) {
  for (const key of [
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'COREPACK_HOME',
    'npm_config_cache',
  ]) {
    const dir = env[key];
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Capture before replacing HOME/XDG. Include absent defaults: no installation
 * is required for a newly created directory to be a violation. The fixed
 * socket fallback deliberately does not follow TMPDIR (002 §10.3).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} @internal
 */
export function realUserPaths(env) {
  const home = homedir();
  const roots = [
    path.join(home, '.local/share/agentmonitors'),
    path.join(home, '.config/agentmonitors'),
    path.join(home, '.local/state/agentmonitors'),
    path.join(home, '.cache/agentmonitors'),
    path.join(home, 'Library/Application Support/agentmonitors'),
    path.join(home, 'Library/Preferences/agentmonitors'),
    path.join(home, 'Library/Caches/agentmonitors'),
    path.join(home, 'Library/Logs/agentmonitors'),
  ];
  for (const key of [
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    if (env[key]) roots.push(path.join(env[key], 'agentmonitors'));
  }
  for (const key of ['AGENTMONITORS_DB', 'AGENTMONITORS_SOCKET']) {
    if (env[key] && env[key] !== ':memory:') roots.push(path.resolve(env[key]));
  }
  if (process.platform !== 'win32') {
    // Production fallback joins are relocated in tests. The guard must use
    // an unrelocated spelling, including inside a preloaded child coordinator.
    roots.push(
      path.resolve('/tmp', `agentmonitors-${String(process.getuid?.() ?? 0)}`),
    );
  }
  return [...new Set(roots)].sort();
}

/**
 * Read-only installation snapshot. Hash small regular files as well as checking
 * metadata, so a same-size edit with a restored mtime cannot evade the guard.
 * Follow installation symlinks while recording their target. Directory identity
 * bounds traversal so links back to an ancestor cannot recurse forever.
 * @param {readonly string[]} roots
 * @returns {Record<string, string>} @internal
 */
export function snapshotPaths(roots) {
  /** @type {Record<string, string>} */
  const result = {};
  const directories = new Set();
  /** @param {string} file */
  function visit(file) {
    let stat;
    try {
      stat = lstatSync(file, { bigint: true });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR'].includes(String(error.code))
      ) {
        result[file] = 'absent';
        return;
      }
      throw error;
    }
    // File identity distinguishes an edit from replacing an existing directory
    // entry; an open old inode must never authorize its replacement.
    result[file] = JSON.stringify({
      type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: String(stat.mode),
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      hash:
        stat.isFile() && stat.size <= 1_048_576n
          ? createHash('sha256').update(readFileSync(file)).digest('hex')
          : undefined,
      target: stat.isSymbolicLink() ? readlinkSync(file) : undefined,
    });
    if (stat.isSymbolicLink()) {
      try {
        visit(realpathSync(file));
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
          )
        )
          throw error;
      }
    } else if (stat.isDirectory()) {
      const identity = realpathSync(file);
      if (directories.has(identity)) return;
      directories.add(identity);
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    }
  }
  for (const root of roots) visit(root);
  return result;
}
