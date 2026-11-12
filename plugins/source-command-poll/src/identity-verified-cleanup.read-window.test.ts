/**
 * Integration test: the `command-poll` SIGTERM step still bounds the command's
 * process group when the command exits on its own while the step's
 * process-table read is in flight (008 §3.1, §5.1; issue #479).
 *
 * The real source runs a real `sh` command, and real signals are delivered.
 * The one seam is the process-table reader the SIGTERM step uses: it takes a
 * real snapshot when the read starts, then holds the result until the
 * command's leader has been reaped. That makes the race deterministic: the
 * leader is always reaped mid-read, wherever its natural exit falls inside the
 * read window. Every other read (the one taken at the leader's exit and the
 * SIGKILL step's) is the real, unmodified reader.
 *
 * Every process a test starts is killed in a `finally` that runs on failure too.
 *
 * @see https://man7.org/linux/man-pages/man2/kill.2.html
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Core from '@agentmonitors/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import source from './index.js';

/** How long a held read may wait for the leader to exit before giving up. */
const HOLD_LIMIT_MS = 10_000;

vi.mock('@agentmonitors/core', async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  const sendVerifiedSignal: typeof actual.sendVerifiedSignal = (
    target,
    signal,
    options,
  ) => {
    if (target.kind !== 'spawned-process-group' || signal !== 'SIGTERM') {
      return actual.sendVerifiedSignal(target, signal, options);
    }
    const { leader } = target;
    const heldUntilLeaderReaped: Core.ProcessTableReader = async () => {
      const snapshot = await actual.readProcessTable();
      const deadline = Date.now() + HOLD_LIMIT_MS;
      while (actual.isChildUnreaped(leader) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return snapshot;
    };
    return actual.sendVerifiedSignal(target, signal, {
      ...options,
      readProcessTable: heldUntilLeaderReaped,
    });
  };
  return { ...actual, sendVerifiedSignal };
});

const NOW = new Date('2026-06-12T00:00:00.000Z');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function pollUntil(
  predicate: () => boolean,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function killAll(pids: (number | undefined)[]): void {
  for (const pid of pids) {
    if (pid === undefined) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

describe.skipIf(process.platform === 'win32')(
  'source-command-poll: SIGTERM step when the command exits during the verification read (008 §5.1, issue #479)',
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Regression (#479): the SIGTERM step checked the leader only
    // after its read completed, so a command that finished during the read
    // made the step abstain, and its background member outlived the bound.
    // The held read makes the exit land mid-read wherever it falls; the exit
    // points leave margin for the timeout timer to fire first even under load.
    it.each(['1.1', '1.5'])(
      'signals the group and leaves nothing alive when the command exits at %ss, mid-read',
      async (exitAfter) => {
        const dir = mkdtempSync(join(tmpdir(), 'am-479-read-window-'));
        const leaderPidFile = join(dir, 'leader.pid');
        const memberPidFile = join(dir, 'member.pid');
        const killSpy = vi.spyOn(process, 'kill');
        const stderrSpy = vi.spyOn(process.stderr, 'write');
        let leaderPid: number | undefined;
        let memberPid: number | undefined;
        try {
          const result = await source.observe(
            {
              command: [
                'sh',
                '-c',
                `echo $$ > '${leaderPidFile}'; sleep 30 & echo $! > '${memberPidFile}'; sleep ${exitAfter}`,
              ],
              timeout: '1s',
            },
            { now: NOW },
          );
          const payload = result.observations[0]?.payload as { error: string };
          expect(payload.error).toMatch(/timed out/i);

          leaderPid = readPid(leaderPidFile);
          memberPid = readPid(memberPidFile);
          expect(leaderPid).toBeDefined();
          expect(memberPid).toBeDefined();

          const dead = await pollUntil(
            () => !isProcessAlive(memberPid ?? 0),
            3_000,
          );
          expect(dead).toBe(true);
          expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGTERM');
          const stderr = stderrSpy.mock.calls
            .map((call) => String(call[0]))
            .join('');
          expect(stderr).not.toContain('alone instead of sending');
        } finally {
          vi.restoreAllMocks();
          killAll([memberPid ?? readPid(memberPidFile), leaderPid]);
          rmSync(dir, { recursive: true, force: true });
        }
      },
      20_000,
    );
  },
);
