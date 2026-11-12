/**
 * Integration tests: the `command-poll` timeout escalation only signals a
 * process group it can positively identify as the one it started
 * (008 §5, issue #479; escalation contract 003 §11.2/§11.7).
 *
 * These drive the real source end to end — a real `sh` command times out, the
 * real escalation timers fire, and real signals are (or are not) delivered. The
 * only observation hooks are spies on `process.kill` and `process.stderr.write`,
 * both left calling through to the real implementations.
 *
 * Simulating identifier recycling: a test cannot make the OS hand a specific
 * process-group id to unrelated work. What the verifier sees after a recycle is
 * a group whose leader is gone and whose current members include none of the
 * processes it recorded when it last confirmed the group. The recycling test
 * produces exactly that view: the command's leader starts a stand-in process
 * only AFTER the timeout's SIGTERM step has recorded the group's members, then
 * exits. When the SIGKILL follow-up runs, the recorded pgid is occupied solely
 * by a process the verifier never confirmed — indistinguishable, to it, from a
 * reused id — so it must withhold the signal and report the abstention.
 *
 * Every process a test starts is killed in a `finally` that runs on failure too.
 *
 * @see https://man7.org/linux/man-pages/man2/kill.2.html
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#trap
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import source from './index.js';

const NOW = new Date('2026-06-12T00:00:00.000Z');
/** Escalation grace from 003 §11.2, plus slack for the verification read. */
const KILL_STEP_DEADLINE_MS = 1_000 + 5_000 + 3_000;

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
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
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

/** Kill every pid in `pids` that is still alive; used only for test cleanup. */
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

function stderrText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

describe.skipIf(process.platform === 'win32')(
  'source-command-poll: identity-verified timeout escalation (008 §5, issue #479)',
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('withholds SIGKILL from a recorded process group it can no longer identify, and reports the abstention', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-479-recycled-'));
      const leaderPidFile = join(dir, 'leader.pid');
      const standInPidFile = join(dir, 'stand-in.pid');
      const standIn = join(dir, 'stand-in.sh');
      const leader = join(dir, 'leader.sh');
      // The stand-in ignores SIGTERM so only a SIGKILL could remove it; its
      // survival is the proof that no SIGKILL reached the recorded group.
      writeFileSync(
        standIn,
        `trap '' TERM\necho $$ > '${standInPidFile}'\nexec sleep 30\n`,
      );
      // The leader starts the stand-in only once the SIGTERM step has run (and
      // recorded the group's members), then exits.
      writeFileSync(
        leader,
        [
          `echo $$ > '${leaderPidFile}'`,
          `trap 'sh "${standIn}" & exit 0' TERM`,
          'sleep 30 &',
          'wait $!',
          '',
        ].join('\n'),
      );

      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      let leaderPid: number | undefined;
      let standInPid: number | undefined;
      try {
        const result = await source.observe(
          { command: ['sh', leader], timeout: '1s' },
          { now: NOW },
        );
        // The timeout itself is reported exactly as before (003 §11.5).
        const payload = result.observations[0]?.payload as { error: string };
        expect(payload.error).toMatch(/timed out/i);

        leaderPid = readPid(leaderPidFile);
        expect(leaderPid).toBeDefined();
        expect(
          await pollUntil(() => readPid(standInPidFile) !== undefined, 3_000),
        ).toBe(true);
        standInPid = readPid(standInPidFile);

        // Wait for the SIGKILL follow-up to run and abstain.
        const abstained = await pollUntil(
          () =>
            stderrText(stderrSpy).includes(
              `Left process group ${String(leaderPid)} alone instead of sending SIGKILL`,
            ),
          KILL_STEP_DEADLINE_MS,
        );
        expect(abstained).toBe(true);

        // The abstention names why and what it saw, without claiming certainty.
        const warning = stderrText(stderrSpy);
        expect(warning).toContain('command-poll timeout escalation');
        expect(warning).toMatch(
          /may be ours, but its identity could not be confirmed/,
        );
        expect(warning).toContain(`pid ${String(standInPid)}`);

        // No SIGKILL was sent to the group, and the stand-in survived.
        expect(killSpy).not.toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGKILL');
        expect(standInPid).toBeDefined();
        expect(isProcessAlive(standInPid ?? 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        killAll([standInPid ?? readPid(standInPidFile), leaderPid]);
        rmSync(dir, { recursive: true, force: true });
      }
      expect(isProcessAlive(standInPid ?? 0)).toBe(false);
    }, 20_000);

    it('still SIGKILLs a confirmed group after its leader exits: TERM → KILL escalation reaches a TERM-ignoring descendant', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-479-escalation-'));
      const leaderPidFile = join(dir, 'leader.pid');
      const descendantPidFile = join(dir, 'descendant.pid');
      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      let leaderPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        // The descendant exists from the start, so the SIGTERM step records it
        // as a member; the leader dies on SIGTERM, the descendant ignores it.
        const result = await source.observe(
          {
            command: [
              'sh',
              '-c',
              `echo $$ > '${leaderPidFile}'; (trap '' TERM; exec sleep 30) & echo $! > '${descendantPidFile}'; wait`,
            ],
            timeout: '1s',
          },
          { now: NOW },
        );
        const payload = result.observations[0]?.payload as { error: string };
        expect(payload.error).toMatch(/timed out/i);

        leaderPid = readPid(leaderPidFile);
        descendantPid = readPid(descendantPidFile);
        expect(leaderPid).toBeDefined();
        expect(descendantPid).toBeDefined();

        const dead = await pollUntil(
          () => !isProcessAlive(descendantPid ?? 0),
          KILL_STEP_DEADLINE_MS,
        );
        expect(dead).toBe(true);
        // Both escalation steps addressed the whole group.
        expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGKILL');
        expect(stderrText(stderrSpy)).not.toContain('alone instead of sending');
      } finally {
        vi.restoreAllMocks();
        killAll([descendantPid ?? readPid(descendantPidFile), leaderPid]);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it('a timed-out command whose whole group exits on SIGTERM needs no SIGKILL and reports nothing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-479-clean-'));
      const leaderPidFile = join(dir, 'leader.pid');
      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      let leaderPid: number | undefined;
      try {
        await source.observe(
          {
            command: [
              'sh',
              '-c',
              `echo $$ > '${leaderPidFile}'; sleep 30 & wait`,
            ],
            timeout: '1s',
          },
          { now: NOW },
        );
        leaderPid = readPid(leaderPidFile);
        expect(leaderPid).toBeDefined();
        // Let the SIGKILL follow-up's verification run.
        await new Promise((r) => setTimeout(r, 5_000 + 1_500));
        expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGTERM');
        expect(killSpy).not.toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGKILL');
        expect(stderrText(stderrSpy)).not.toContain('alone instead of sending');
      } finally {
        vi.restoreAllMocks();
        killAll([leaderPid]);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
