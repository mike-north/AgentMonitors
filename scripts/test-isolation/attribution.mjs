/**
 * Read-only attribution for the installation-diff guard. Isolation of HOME/XDG/
 * TMPDIR is the first line of protection; the diff is a second line, not a write
 * tracer. A test writing a file already held by a qualifying foreign process
 * cannot be distinguished from that process's writes and is not caught here.
 *
 * Only regular-file changes with stable file identity and the same pre-run,
 * non-descendant holder at both snapshots may be reported without failure.
 * Descriptor device/inode must match the snapshot too: a stale open descriptor
 * may retain a replaced file's pathname on macOS. Creation/removal, replacement,
 * directories outside the shared runtime namespace, and unknown inspection stay
 * strict. Runtime accesses are checked by the adapter; its shared namespace has
 * a separate net-only observer so unrelated transient activity is diagnostic.
 * ps start times have second precision: the entire reported birth second must
 * precede the run. This deliberately refuses ambiguous, very recent peers.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** @typedef {{pid: number, parent: number, start: number, command: string}} ProcessIdentity */
/** @typedef {{pid: number, device: string, inode: string}} OpenFileIdentity */
/** @typedef {{processes: Map<number, ProcessIdentity>, files: Map<string, OpenFileIdentity[]>} | {reason: string}} Inspection */

/**
 * Bound each native reader independently. No inspection path sends signals to
 * inspected processes; SIGKILL applies only to our own timed-out reader handle.
 * @param {string} command @param {string[]} args @returns {string}
 */
function readTool(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    throw new Error(
      `${command}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

/**
 * Capture the whole visible process/open-file table instead of passing thousands
 * of installation paths through ARG_MAX. Missing, partial, or malformed readers
 * grant no exception. Only absolute named files are relevant to this guard.
 * @returns {Inspection} @internal
 */
export function inspectOpenFiles() {
  try {
    const table = readTool('ps', ['-axo', 'pid=,ppid=,lstart=,args=']);
    /** @type {Map<number, ProcessIdentity>} */
    const processes = new Map();
    for (const line of table.trim().split('\n')) {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/,
      );
      if (!match) throw new Error('unreadable ps process identity');
      const start = Date.parse(`${match[3]} UTC`);
      if (!Number.isFinite(start)) throw new Error('unreadable ps start time');
      const pid = Number(match[1]);
      processes.set(pid, {
        pid,
        parent: Number(match[2]),
        start,
        command: match[4],
      });
    }
    if (!processes.has(process.pid))
      throw new Error('coordinator missing from ps');
    const output = readTool('lsof', ['-nP', '-FpnDit']);
    /** @type {Map<string, OpenFileIdentity[]>} */
    const files = new Map();
    let pid;
    /** @type {{type?: string, device?: string, inode?: string, name?: string} | undefined} */
    let descriptor;
    /**
     * A pathname alone can name an unlinked predecessor on macOS. Retain the
     * descriptor's own device/inode, not a fresh stat of whatever has that name.
     */
    function finishDescriptor() {
      if (descriptor?.type !== 'REG' || !descriptor.name?.startsWith('/'))
        return;
      if (pid === undefined || !descriptor.device || !descriptor.inode) {
        throw new Error('unreadable lsof file identity');
      }
      const device = BigInt(descriptor.device).toString();
      const inode = BigInt(descriptor.inode).toString();
      const records = files.get(descriptor.name) ?? [];
      records.push({ pid, device, inode });
      files.set(descriptor.name, records);
    }
    for (const line of output.split('\n')) {
      if (/^p\d+$/.test(line)) {
        finishDescriptor();
        pid = Number(line.slice(1));
        descriptor = undefined;
      } else if (line.startsWith('f')) {
        finishDescriptor();
        descriptor = {};
      } else if (line) {
        if (!descriptor) throw new Error('unreadable lsof record');
        if (line.startsWith('t')) descriptor.type = line.slice(1);
        else if (line.startsWith('D')) descriptor.device = line.slice(1);
        else if (line.startsWith('i')) descriptor.inode = line.slice(1);
        else if (line.startsWith('n')) descriptor.name = line.slice(1);
        else throw new Error('unreadable lsof field');
      }
    }
    finishDescriptor();
    return { processes, files };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Missing lineage is uncertainty, not evidence of independence. Walking through
 * PID 0/1 establishes an outside root; finding the coordinator rejects it.
 * @param {number} pid @param {Map<number, ProcessIdentity>} table @param {number} coordinator
 */
function outsideRun(pid, table, coordinator) {
  const visited = new Set();
  while (pid !== 0) {
    if (pid === coordinator || visited.has(pid)) return false;
    visited.add(pid);
    const row = table.get(pid);
    if (!row) return false;
    if (pid === 1) return true;
    pid = row.parent;
  }
  return true;
}

/** @param {string} file @returns {string} */
function canonical(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Classify only observed diffs. Holding an unrelated file never exempts a tree.
 * Stable device/inode plus regular-file type prevents an open deleted/replaced
 * file from authorizing a new directory entry with the same name.
 * @param {Record<string, string>} before @param {Record<string, string>} after
 * @param {Inspection} first @param {Inspection} last
 * @param {number} startedAt @param {number} coordinator
 * @returns {{strict: string[], foreign: (ProcessIdentity & {files: string[]})[]}} @internal
 */
export function classifyPathChanges(
  before,
  after,
  first,
  last,
  startedAt,
  coordinator,
) {
  const strict = [];
  /** @type {Map<number, ProcessIdentity & {files: string[]}>} */
  const foreign = new Map();
  for (const file of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    if (before[file] === after[file]) continue;
    let holder;
    if (
      before[file] &&
      after[file] &&
      before[file] !== 'absent' &&
      after[file] !== 'absent' &&
      !('reason' in first) &&
      !('reason' in last)
    ) {
      const a = JSON.parse(before[file]);
      const b = JSON.parse(after[file]);
      if (
        typeof a.device === 'string' &&
        typeof a.inode === 'string' &&
        a.type === 'file' &&
        b.type === 'file' &&
        a.device === b.device &&
        a.inode === b.inode
      ) {
        const name = canonical(file);
        for (const opened of first.files.get(name) ??
          first.files.get(file) ??
          []) {
          const pid = opened.pid;
          const old = first.processes.get(pid);
          const current = last.processes.get(pid);
          if (
            opened.device === a.device &&
            opened.inode === a.inode &&
            old &&
            current &&
            old.start === current.start &&
            old.command === current.command &&
            old.start + 1_000 <= startedAt &&
            (last.files.get(name) ?? last.files.get(file) ?? []).some(
              (entry) =>
                entry.pid === pid &&
                entry.device === b.device &&
                entry.inode === b.inode,
            ) &&
            outsideRun(pid, first.processes, coordinator) &&
            outsideRun(pid, last.processes, coordinator)
          ) {
            holder = old;
            break;
          }
        }
      }
    }
    if (!holder) strict.push(file);
    else {
      const record = foreign.get(holder.pid) ?? { ...holder, files: [] };
      record.files.push(file);
      foreign.set(holder.pid, record);
    }
  }
  return {
    strict,
    foreign: [...foreign.values()].sort((a, b) => a.pid - b.pid),
  };
}

/**
 * Foreign-write diagnostics are emitted even when another diff fails the run.
 * The JSON record is also the exact exclusion receipt for full-byte comparisons.
 * @param {Record<string, string>} before @param {Record<string, string>} after
 * @param {Inspection} first @param {Inspection} last @param {number} startedAt
 * @internal
 */
export function assertAttributedPathsUnchanged(
  before,
  after,
  first,
  last,
  startedAt,
) {
  const result = classifyPathChanges(
    before,
    after,
    first,
    last,
    startedAt,
    process.pid,
  );
  for (const record of result.foreign) {
    console.warn(
      `Foreign process writes: PID ${record.pid} ${JSON.stringify(record)}`,
    );
  }
  if (result.strict.length) {
    const unknown = [first, last]
      .filter((read) => 'reason' in read)
      .map((read) => read.reason);
    throw new Error(
      `Real user paths changed during tests:\n${result.strict.join('\n')}${unknown.length ? `\nProcess inspection unavailable: ${unknown.join('; ')}` : ''}`,
    );
  }
}
