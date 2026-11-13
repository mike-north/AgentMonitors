/**
 * Net-only observer of the user's shared fixed runtime namespace. The adapter is
 * the primary check for test accesses, including transient accesses. Other
 * worktrees/daemons may churn this directory, so endpoint metadata and observed
 * transient entries are diagnostics; only added, removed, or replaced entries
 * fail this diff. Data/config/state snapshots retain their separate strict rule.
 */
import { inspection } from './native-inspection.mjs';
import { legacyRuntimeName, runtimeNamespaces } from './runtime-paths.mjs';

/** @param {string} file @param {Record<string, object>} result */
function captureEntry(file, result) {
  let stat;
  try {
    stat = inspection.fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return;
    }
    throw error;
  }
  const type = stat.isDirectory()
    ? 'directory'
    : stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? 'file'
        : stat.isSocket()
          ? 'socket'
          : 'other';
  result[file] = {
    type,
    device: String(stat.dev),
    inode: String(stat.ino),
    target: stat.isSymbolicLink()
      ? inspection.fs.readlinkSync(file)
      : undefined,
    mode: String(stat.mode),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
  };
  // Runtime entries are identities, not authority to traverse symlink targets.
  if (stat.isDirectory()) {
    for (const name of inspection.fs.readdirSync(file).sort()) {
      captureEntry(inspection.path.join(file, name), result);
    }
  }
}

/** @param {import('./runtime-paths.mjs').RuntimeNamespace[]} namespaces @returns {Record<string, object>} @internal */
export function snapshotRuntimeNamespaces(namespaces) {
  const result = {};
  for (const namespace of namespaces) {
    captureEntry(namespace.directory, result);
    let names;
    try {
      names = inspection.fs.readdirSync(namespace.base);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    for (const name of names.filter(legacyRuntimeName).sort()) {
      captureEntry(inspection.path.join(namespace.base, name), result);
    }
  }
  return result;
}

/** Only directory-entry identity participates in the runtime failure decision. @param {object | undefined} entry */
function identity(entry) {
  if (!entry) {
    return undefined;
  }
  return JSON.stringify({
    type: entry.type,
    device: entry.device,
    inode: entry.inode,
    target: entry.target,
  });
}

/** @param {Record<string,object>} before @param {Record<string,object>} after @returns {string[]} @internal */
export function runtimeNetChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((file) => identity(before[file]) !== identity(after[file]));
}

/**
 * Watchers provide best-effort names of mid-run activity; final native snapshots
 * are authoritative for net changes. Observation errors are visible diagnostics,
 * never permission to suppress a net difference. Watchers do not keep Node alive.
 * @returns {{namespaces: import('./runtime-paths.mjs').RuntimeNamespace[], finish: () => void, close: () => void}} @internal
 */
export function observeRuntimeNamespace() {
  const namespaces = runtimeNamespaces();
  const before = snapshotRuntimeNamespaces(namespaces);
  const events = new Set();
  const errors = [];
  const watchers = new Map();
  const attach = (directory, recursive, onEvent) => {
    if (watchers.has(directory)) {
      return;
    }
    try {
      const watcher = inspection.fs.watch(
        directory,
        { persistent: false, recursive },
        onEvent,
      );
      watcher.on('error', (error) =>
        errors.push(`${directory}: ${error.message}`),
      );
      watchers.set(directory, watcher);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        errors.push(`${directory}: ${String(error)}`);
      }
    }
  };
  for (const namespace of namespaces) {
    // Non-recursive native watchers report short-lived direct entries promptly;
    // attach to discovered lock subdirectories instead of relying on a delayed
    // recursive FSEvents batch on macOS.
    const watchDirectory = (directory) =>
      attach(directory, false, (event, name) => {
        const file = name
          ? inspection.path.join(directory, String(name))
          : directory;
        events.add(`${event}: ${file}`);
        if (name) {
          try {
            if (inspection.fs.lstatSync(file).isDirectory()) {
              watchDirectory(file);
            }
          } catch (error) {
            if (
              !(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
              )
            ) {
              errors.push(`${file}: ${String(error)}`);
            }
          }
        }
      });
    watchDirectory(namespace.directory);
    for (const [file, entry] of Object.entries(before)) {
      if (
        entry.type === 'directory' &&
        file.startsWith(namespace.directory + inspection.separator)
      ) {
        watchDirectory(file);
      }
    }
    attach(namespace.base, false, (event, name) => {
      const value = String(name ?? '');
      if (
        value === inspection.path.basename(namespace.directory) ||
        legacyRuntimeName(value)
      ) {
        events.add(`${event}: ${inspection.path.join(namespace.base, value)}`);
        watchDirectory(namespace.directory);
      }
    });
  }
  const close = () => {
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };
  return {
    namespaces,
    close,
    finish() {
      const after = snapshotRuntimeNamespaces(namespaces);
      const changes = runtimeNetChanges(before, after);
      const metadata = Object.keys(before)
        .filter(
          (file) =>
            after[file] &&
            JSON.stringify(before[file]) !== JSON.stringify(after[file]),
        )
        .sort()
        .map((file) => ({
          path: file,
          beforeMtime: before[file].mtime,
          afterMtime: after[file].mtime,
          beforeMode: before[file].mode,
          afterMode: after[file].mode,
        }));
      if (events.size || metadata.length || errors.length) {
        console.warn(
          `Runtime namespace churn: ${JSON.stringify({ entriesSeen: [...events].sort(), metadataChanged: metadata, observationErrors: errors, netChanges: changes })}`,
        );
      }
      if (changes.length) {
        throw new Error(`Runtime namespace net change:\n${changes.join('\n')}`);
      }
    },
  };
}
