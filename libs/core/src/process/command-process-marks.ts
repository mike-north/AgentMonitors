/**
 * Read inherited command ownership without exposing process environments. A random
 * daemon-life marker survives fork/exec and re-sessioning; erasing it while
 * detaching is the explicit containment escape. These are reliability marks,
 * not an authentication boundary against code running as the same OS user.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import {
  parseProcStat,
  readProcessTable,
  type ProcessIdentityRecord,
} from './process-table.js';

/** Environment key reserved for daemon command ownership. @public */
export const COMMAND_LIFE_ENV = 'AGENTMONITORS_COMMAND_LIFE';

/** A missing mark is distinct from an unreadable mark. @internal */
export type CommandMarks =
  | {
      readonly supported: true;
      readonly marks: ReadonlyMap<number, string>;
      readonly unreadable?: readonly number[];
    }
  | { readonly supported: false; readonly reason: string };

/** System utilities are bounded, own their direct child, and never log their output. */
function systemRead(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              `Ownership identity query failed (${String(error.code ?? 'unknown')})`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

/** Boot identity prevents Linux start ticks or old numeric identifiers crossing boots. @internal */
export async function readBootIdentity(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux')
      return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (process.platform === 'darwin')
      return (
        await systemRead('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      ).trim();
  } catch {
    /* Missing evidence always withholds cleanup, never guesses a boot. */
  }
  return undefined;
}

/** Read only the reserved marker; no environment values are returned or persisted. @internal */
export async function readCommandMarks(
  pids: readonly number[],
): Promise<CommandMarks> {
  const marks = new Map<number, string>();
  if (pids.length === 0) return { supported: true, marks };
  if (process.platform === 'darwin') {
    try {
      const output = await systemRead('/bin/ps', [
        'eww',
        '-A',
        '-o',
        'pid=,command=',
      ]);
      const wanted = new Set(pids);
      for (const line of output.split('\n')) {
        const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
        if (!wanted.has(pid)) continue;
        const mark =
          /(?:^|\s)AGENTMONITORS_COMMAND_LIFE=([a-f0-9-]{36})(?=\s|$)/.exec(
            line,
          )?.[1];
        if (mark !== undefined) marks.set(pid, mark);
      }
      return { supported: true, marks };
    } catch (error) {
      return {
        supported: false,
        reason:
          error instanceof Error ? error.message : 'Ownership query failed',
      };
    }
  }
  if (process.platform !== 'linux')
    return {
      supported: false,
      reason: 'Command ownership marks are unavailable on this platform',
    };
  const unreadable: number[] = [];
  // Bound filesystem work and descriptors independently of the host's process count.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, pids.length) }, async () => {
      while (next < pids.length) {
        const pid = pids[next++];
        if (pid === undefined) continue;
        try {
          const directory = `/proc/${String(pid)}`;
          if ((await stat(directory)).uid !== process.getuid?.()) continue;
          const entries = (
            await readFile(`${directory}/environ`, 'utf8')
          ).split('\0');
          const entry = entries.find((value) =>
            value.startsWith(`${COMMAND_LIFE_ENV}=`),
          );
          if (entry !== undefined)
            marks.set(pid, entry.slice(COMMAND_LIFE_ENV.length + 1));
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ESRCH')
          )
            continue;
          unreadable.push(pid);
        }
      }
    }),
  );
  return { supported: true, marks, unreadable };
}

/** Whether the recorded incarnation has demonstrably stopped executing. @internal */
export type CommandTerminalEvidence = 'terminated' | 'running' | 'unavailable';

/**
 * A delivered SIGKILL alone is not a reap receipt: an uninterruptible process
 * can retain a pending signal. Confirm absence, a changed incarnation, or a
 * terminal zombie/dead state without adding a grace period or more signals.
 * @internal
 */
export async function readCommandTerminal(
  record: ProcessIdentityRecord,
): Promise<CommandTerminalEvidence> {
  try {
    const reading = await readProcessTable();
    if (!reading.supported) return 'unavailable';
    const current = reading.processes.find((p) => p.pid === record.pid);
    if (current?.startTime !== record.startTime) return 'terminated';
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${String(record.pid)}/stat`, 'utf8');
      const identity = parseProcStat(stat);
      if (identity === undefined) return 'unavailable';
      if (identity.startTime !== record.startTime) return 'terminated';
      const state = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0];
      return /^[ZXx]$/.test(state ?? '') ? 'terminated' : 'running';
    }
    if (process.platform === 'darwin') {
      const output = await systemRead('/bin/ps', [
        '-p',
        String(record.pid),
        '-o',
        'stat=,lstart=',
      ]);
      const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(output);
      if (match?.[1] === undefined || match[2] === undefined)
        return 'unavailable';
      if (match[2] !== record.startTime) return 'terminated';
      return /^[ZXx]/.test(match[1]) ? 'terminated' : 'running';
    }
  } catch {
    // A process may have exited during its status read. Only a new identity
    // reading can turn that query failure into positive termination evidence.
    const fresh = await readProcessTable();
    if (
      fresh.supported &&
      !fresh.processes.some(
        (p) => p.pid === record.pid && p.startTime === record.startTime,
      )
    )
      return 'terminated';
  }
  return 'unavailable';
}
