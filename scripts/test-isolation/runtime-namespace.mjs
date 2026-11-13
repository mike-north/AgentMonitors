/**
 * Read-only reporting for the user's shared fixed runtime namespace. The adapter
 * is the attributable fatal check for Node test accesses and preloaded children.
 * Daemons and other worktrees use the same namespace, so endpoint differences
 * cannot identify our writes and never fail the run. Reports retain direction
 * and both endpoint identities. Data/config/state/cache keep their strict guard.
 * Entries may disappear or be replaced between native reads; those races are
 * observations too, never authority to fail the suite or combine identities.
 */
import { inspection } from './native-inspection.mjs';
import { legacyRuntimeName, runtimeNamespaces } from './runtime-paths.mjs';

/** @param {unknown} error @returns {boolean} */
function isSnapshotRace(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'EINVAL'].includes(String(error.code)),
  );
}

/**
 * Dependent directory/symlink reads must belong to the lstat identity. A second
 * identity read detects replacements that succeed without a native error.
 * @param {string} file @param {Record<string, object>} result
 * @param {string[]} observationErrors
 */
function captureEntry(file, result, observationErrors) {
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
  let target;
  let names = [];
  if (stat.isDirectory() || stat.isSymbolicLink()) {
    try {
      if (stat.isSymbolicLink()) target = inspection.fs.readlinkSync(file);
      else names = inspection.fs.readdirSync(file).sort();
      const current = inspection.fs.lstatSync(file, { bigint: true });
      if (
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        (current.mode & 0o170000n) !== (stat.mode & 0o170000n)
      ) {
        observationErrors.push(`${file}: entry replaced during snapshot`);
        return;
      }
    } catch (error) {
      if (!isSnapshotRace(error)) throw error;
      observationErrors.push(`${file}: ${String(error)}`);
      return;
    }
  }
  result[file] = {
    type,
    device: String(stat.dev),
    inode: String(stat.ino),
    target,
    mode: String(stat.mode),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
  };
  // Runtime entries are identities, not authority to traverse symlink targets.
  if (stat.isDirectory()) {
    for (const name of names) {
      captureEntry(inspection.path.join(file, name), result, observationErrors);
    }
  }
}

/**
 * Keep race diagnostics alongside the endpoint inventory, including at startup.
 * @param {import('./runtime-paths.mjs').RuntimeNamespace[]} namespaces
 * @param {string[]} [observationErrors] @returns {Record<string, object>} @internal
 */
export function snapshotRuntimeNamespaces(namespaces, observationErrors = []) {
  const result = {};
  for (const namespace of namespaces) {
    captureEntry(namespace.directory, result, observationErrors);
    let names;
    try {
      names = inspection.fs.readdirSync(namespace.base);
    } catch (error) {
      if (isSnapshotRace(error)) {
        observationErrors.push(`${namespace.base}: ${String(error)}`);
        continue;
      }
      throw error;
    }
    for (const name of names.filter(legacyRuntimeName).sort()) {
      captureEntry(
        inspection.path.join(namespace.base, name),
        result,
        observationErrors,
      );
    }
  }
  return result;
}

/**
 * Identity excludes mutable metadata and retains explicit absence in JSON reports.
 * @param {object | undefined} entry
 */
function identity(entry) {
  return entry
    ? {
        type: entry.type,
        device: entry.device,
        inode: entry.inode,
        target: entry.target ?? null,
      }
    : null;
}

/**
 * Describe endpoint differences without attributing them to any process.
 * @param {Record<string,object>} before @param {Record<string,object>} after
 * @returns {{path: string, direction: 'added'|'removed'|'replaced', before: object|null, after: object|null}[]} @internal
 */
export function runtimeNetChanges(before, after) {
  const changes = [];
  for (const file of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const first = identity(before[file]);
    const last = identity(after[file]);
    if (JSON.stringify(first) !== JSON.stringify(last)) {
      changes.push({
        path: file,
        direction:
          first === null ? 'added' : last === null ? 'removed' : 'replaced',
        before: first,
        after: last,
      });
    }
  }
  return changes;
}

/**
 * Watchers provide best-effort names of mid-run activity; final native snapshots
 * describe net changes. Neither endpoint differences nor watcher errors attribute
 * writes to tests; both remain visible diagnostics. Watchers do not keep Node alive.
 * @returns {{namespaces: import('./runtime-paths.mjs').RuntimeNamespace[], finish: () => void, close: () => void}} @internal
 */
export function observeRuntimeNamespace() {
  const namespaces = runtimeNamespaces();
  const errors = [];
  const before = snapshotRuntimeNamespaces(namespaces, errors);
  const events = new Set();
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
      const after = snapshotRuntimeNamespaces(namespaces, errors);
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
      if (changes.length || events.size || metadata.length || errors.length) {
        console.warn(
          `Runtime namespace churn: ${JSON.stringify({ entriesSeen: [...events].sort(), metadataChanged: metadata, observationErrors: errors, netChanges: changes })}`,
        );
      }
    },
  };
}
