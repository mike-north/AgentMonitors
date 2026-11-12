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
 * A process forked after the SIGTERM step is still ours: it is in the group the
 * command started, and the group's id cannot have been reused while a member
 * existed. The late-fork test drives that shape through a TERM trap that starts
 * a worker and exits; the hand-off test drives it through a TERM-ignoring
 * member that forks during the grace period and exits a second later, which
 * only the grace-period membership readings can see. Both require the SIGKILL
 * follow-up to remove the late process (008 §3.1).
 *
 * Continuity can still be lost in two ways, and the follow-up then abstains:
 * the group empties and its id is reused, or, after the leader has exited, a
 * member forks and exits within one reading interval while no other confirmed
 * member is alive (008 §3.1's stated exception). The first needs the pid space
 * to wrap; the second is real but timing-dependent. Both abstentions are
 * pinned against fabricated process tables in
 * `libs/core/src/process/process-identity.test.ts`.
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

    // Regression (#479): the worker forks after the SIGTERM step recorded the
    // group's members, then the leader exits. It is a real member of the
    // command's group and must not outlive the hard bound (008 §3.1), so the
    // follow-up must SIGKILL it rather than abstain as if the group id had
    // been reused.
    it('SIGKILLs a descendant the command forks from its TERM trap after the SIGTERM step', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-479-late-fork-'));
      const leaderPidFile = join(dir, 'leader.pid');
      const workerPidFile = join(dir, 'worker.pid');
      const worker = join(dir, 'worker.sh');
      const leader = join(dir, 'leader.sh');
      // The worker ignores SIGTERM so only a SIGKILL could remove it.
      writeFileSync(
        worker,
        `trap '' TERM\necho $$ > '${workerPidFile}'\nexec sleep 30\n`,
      );
      // The leader starts the worker only once SIGTERM arrives, then exits.
      writeFileSync(
        leader,
        [
          `echo $$ > '${leaderPidFile}'`,
          `trap 'sh "${worker}" & exit 0' TERM`,
          'sleep 30 &',
          'wait $!',
          '',
        ].join('\n'),
      );

      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      let leaderPid: number | undefined;
      let workerPid: number | undefined;
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
          await pollUntil(() => readPid(workerPidFile) !== undefined, 3_000),
        ).toBe(true);
        workerPid = readPid(workerPidFile);
        expect(workerPid).toBeDefined();

        const dead = await pollUntil(
          () => !isProcessAlive(workerPid ?? 0),
          KILL_STEP_DEADLINE_MS,
        );
        expect(dead).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGKILL');
        expect(stderrText(stderrSpy)).not.toContain('alone instead of sending');
      } finally {
        vi.restoreAllMocks();
        killAll([workerPid ?? readPid(workerPidFile), leaderPid]);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    // Regression (#479): a non-leader member that ignores SIGTERM forks a
    // child during the grace period and then exits. Neither the SIGTERM read
    // nor the read at the leader's exit saw the child, and by the SIGKILL step
    // its parent was gone, so the step found only an unconfirmed process and
    // abstained, leaving the child alive past the hard bound (008 §3.1). The
    // readings taken during the grace period see parent and child together and
    // confirm the child through the parent.
    it('SIGKILLs a process a TERM-ignoring member hands off to during the grace period', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-479-relay-'));
      const leaderPidFile = join(dir, 'leader.pid');
      const memberPidFile = join(dir, 'member.pid');
      const heirPidFile = join(dir, 'heir.pid');
      const member = join(dir, 'member.sh');
      // Timeline, with `timeout: 1s`: the SIGTERM step and the leader's exit
      // happen at about 1 s. The member forks its heir at about 1.5 s, well
      // after both of those reads, then outlives the fork by 1 s (several
      // grace-period readings) and exits about 3.5 s before the SIGKILL step.
      writeFileSync(
        member,
        [
          `trap '' TERM`,
          `echo $$ > '${memberPidFile}'`,
          'sleep 1.5',
          'sleep 30 &',
          `echo $! > '${heirPidFile}'`,
          'sleep 1',
          'exit 0',
          '',
        ].join('\n'),
      );

      const killSpy = vi.spyOn(process, 'kill');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      let leaderPid: number | undefined;
      let memberPid: number | undefined;
      let heirPid: number | undefined;
      try {
        const result = await source.observe(
          {
            command: [
              'sh',
              '-c',
              `echo $$ > '${leaderPidFile}'; sh '${member}' & wait`,
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
        expect(
          await pollUntil(() => readPid(heirPidFile) !== undefined, 3_000),
        ).toBe(true);
        heirPid = readPid(heirPidFile);
        expect(heirPid).toBeDefined();

        const dead = await pollUntil(
          () => !isProcessAlive(heirPid ?? 0),
          KILL_STEP_DEADLINE_MS,
        );
        expect(dead).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(-(leaderPid ?? 0), 'SIGKILL');
        expect(stderrText(stderrSpy)).not.toContain('alone instead of sending');
      } finally {
        vi.restoreAllMocks();
        killAll([
          heirPid ?? readPid(heirPidFile),
          memberPid ?? readPid(memberPidFile),
          leaderPid,
        ]);
        rmSync(dir, { recursive: true, force: true });
      }
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
