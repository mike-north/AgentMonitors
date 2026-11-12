/**
 * Platform process-table reader: the one place that knows how to read identity
 * evidence for live processes on each supported platform (008 §5).
 *
 * Identity evidence is the triple `(pid, pgid, startTime)`. A pid (or process
 * group id) alone is not identity — the OS recycles it once the original holder
 * is gone — but a pid paired with the start time the platform recorded for it
 * names exactly one process for that process's whole life. Comparing two
 * readings of the same machine's table, `startTime` is treated as an opaque
 * token: only equality matters, so its unit and format are per-platform.
 *
 * Platform detail stays behind this module and uses only what the platform
 * ships plus Node — no native dependencies, and on macOS no third-party tools:
 *
 * - **Linux:** `/proc/<pid>/stat` — `pgrp` (field 5) and `starttime`
 *   (field 22, clock ticks since boot). No external binary is executed. A
 *   process that exits mid-read is left out; any other read error makes the
 *   reading unsupported rather than incomplete.
 * - **macOS:** the system `/bin/ps -A -o pid=,pgid=,lstart=` under `LC_ALL=C`.
 *   `lstart` has one-second resolution, which is enough for equality matching:
 *   a recycled pid would need the pid space to wrap within the same second.
 * - **Anything else (including Windows):** reported as unsupported. Callers
 *   must then rely on a live child handle or abstain (008 §5, §6.1).
 *
 * This module only reads; it never signals anything.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Identity evidence for one live process as the platform reports it.
 *
 * `startTime` is opaque and platform-specific (Linux: clock ticks since boot;
 * macOS: the `ps` `lstart` text). Two records describe the same process iff
 * all three fields are equal.
 *
 * @public
 */
export interface ProcessIdentityRecord {
  readonly pid: number;
  /** The process group the process belonged to when the table was read. */
  readonly pgid: number;
  readonly startTime: string;
}

/**
 * One reading of the platform process table, or why it could not be read.
 * An unsupported or failed reading is never treated as "no processes": callers
 * must treat it as missing evidence and abstain rather than signal.
 *
 * @public
 */
export type ProcessTableReading =
  | {
      readonly supported: true;
      readonly processes: readonly ProcessIdentityRecord[];
    }
  | { readonly supported: false; readonly reason: string };

/**
 * Reads the current process table. Injectable so identity verification can be
 * unit-tested against fabricated tables (recycled pids, missing processes,
 * unreadable platforms) without depending on real OS state.
 *
 * @public
 */
export type ProcessTableReader = () => Promise<ProcessTableReading>;

/** Upper bound on one `ps` invocation; a wedged reader must not wedge cleanup. */
const PS_TIMEOUT_MS = 5_000;
/** `ps -A` output for a busy machine is a few hundred KiB at most. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Parse `ps -A -o pid=,pgid=,lstart=` output (macOS/BSD, `LC_ALL=C`).
 *
 * Each line is `<pid> <pgid> <lstart>` where `lstart` is a fixed-format date
 * such as `Wed Nov 11 10:00:00 2026`. Lines that do not match are skipped
 * rather than guessed at.
 *
 * @internal
 */
export function parsePsIdentityOutput(output: string): ProcessIdentityRecord[] {
  const records: ProcessIdentityRecord[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (match === null) continue;
    const [, pidText, pgidText, startTime] = match;
    if (pidText === undefined || pgidText === undefined) continue;
    if (startTime === undefined) continue;
    records.push({
      pid: Number(pidText),
      pgid: Number(pgidText),
      startTime,
    });
  }
  return records;
}

/**
 * Parse the contents of a Linux `/proc/<pid>/stat` file.
 *
 * The command name (field 2) is parenthesized and may itself contain spaces
 * or parentheses, so fields are counted from after the **last** `)`. Returns
 * `undefined` for content that does not have the expected shape.
 *
 * @see https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
 * @internal
 */
export function parseProcStat(
  content: string,
): ProcessIdentityRecord | undefined {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open <= 0 || close < open) return undefined;
  const pid = Number(content.slice(0, open).trim());
  // After ") ": field 3 (state) is index 0, so field N is index N - 3.
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgidText = rest[5 - 3];
  const startTime = rest[22 - 3];
  if (pgidText === undefined || startTime === undefined) return undefined;
  const pgid = Number(pgidText);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (!Number.isInteger(pgid) || !/^\d+$/.test(startTime)) return undefined;
  return { pid, pgid, startTime };
}

/**
 * The filesystem calls the Linux reader makes. Injectable so error handling
 * (descriptor exhaustion, permission errors) can be unit-tested without a real
 * `/proc`.
 *
 * @internal
 */
export interface ProcFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const nodeProcFs: ProcFs = { readdir, readFile };

/**
 * Most `/proc/<pid>/stat` files read at once. Opening every entry together can
 * exhaust file descriptors on a busy machine; a bounded pool keeps the read
 * fast without that.
 */
const PROC_READ_CONCURRENCY = 32;

/**
 * Errors meaning the process exited between listing `/proc` and reading its
 * `stat` file. Only these may drop a process from a reading; any other error
 * means the reading is incomplete.
 */
const EXITED_ERROR_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ESRCH']);

/**
 * Read identity evidence from Linux `/proc`.
 *
 * A process that exits mid-read (ENOENT/ESRCH) is simply not part of the
 * reading. Any other failure (EMFILE, EACCES, …) makes the whole reading
 * `supported: false`: silently dropping a live process would let a caller
 * mistake a missing member for an exited one.
 *
 * @internal
 */
export async function readLinuxProcessTable(
  fs: ProcFs = nodeProcFs,
): Promise<ProcessTableReading> {
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch (error) {
    return {
      supported: false,
      reason: `could not list /proc (${errorMessage(error)})`,
    };
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry));
  const processes: ProcessIdentityRecord[] = [];
  let failure: string | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < pids.length) {
      const pid = pids[next++];
      if (pid === undefined) return;
      const path = `/proc/${pid}/stat`;
      try {
        const record = parseProcStat(await fs.readFile(path, 'utf8'));
        if (record !== undefined) processes.push(record);
      } catch (error) {
        if (isExitedError(error)) continue;
        failure ??= `could not read ${path} (${errorMessage(error)})`;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PROC_READ_CONCURRENCY, pids.length) },
      worker,
    ),
  );
  if (failure !== undefined) return { supported: false, reason: failure };
  return { supported: true, processes };
}

function isExitedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const { code } = error;
  return typeof code === 'string' && EXITED_ERROR_CODES.has(code);
}

function readDarwinProcessTable(): Promise<ProcessTableReading> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-A', '-o', 'pid=,pgid=,lstart='],
      {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) {
          resolve({
            supported: false,
            reason: `reading the process table with /bin/ps failed (${error.message})`,
          });
          return;
        }
        resolve({ supported: true, processes: parsePsIdentityOutput(stdout) });
      },
    );
  });
}

/**
 * Read identity evidence for every visible process on this machine.
 *
 * Returns `supported: false` (never an empty table) when the platform is not
 * supported or the read fails, so a caller can never mistake missing evidence
 * for "the target is gone".
 *
 * @public
 */
export function readProcessTable(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessTableReading> {
  if (platform === 'linux') return readLinuxProcessTable();
  if (platform === 'darwin') return readDarwinProcessTable();
  return Promise.resolve({
    supported: false,
    reason: `process identity evidence is not available on platform "${platform}"`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
