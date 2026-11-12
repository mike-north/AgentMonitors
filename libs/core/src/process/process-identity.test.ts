/**
 * Unit tests for identity-verified cleanup signals (008 §5, issue #479).
 *
 * Every case runs the real verification logic against a fabricated process
 * table and a fake child handle, so recycled ids, missing processes and
 * unreadable platforms can be asserted deterministically. No real process is
 * ever signalled here: delivery goes through a recording `deliver` callback.
 * The real kill paths are covered by the integration tests in
 * `plugins/source-command-poll` and `apps/cli`.
 *
 * @see https://man7.org/linux/man-pages/man2/kill.2.html (negative pid = group)
 * @see https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeSignalAbstention,
  sendVerifiedSignal,
  spawnedProcessGroup,
  type ChildProcessHandle,
  type SignalAbstention,
} from './process-identity.js';
import {
  parseProcStat,
  parsePsIdentityOutput,
  readProcessTable,
  type ProcessIdentityRecord,
  type ProcessTableReading,
} from './process-table.js';

const T1 = 'Wed Nov 11 10:00:00 2026';
const T2 = 'Wed Nov 11 10:05:00 2026';

function fakeChild(
  pid: number,
  state: 'running' | 'reaped',
): ChildProcessHandle & { kill: ReturnType<typeof vi.fn> } {
  return {
    pid,
    exitCode: state === 'reaped' ? 0 : null,
    signalCode: null,
    kill: vi.fn(() => true),
  };
}

function table(...processes: ProcessIdentityRecord[]) {
  return (): Promise<ProcessTableReading> =>
    Promise.resolve({ supported: true, processes });
}

const unsupportedTable = (): Promise<ProcessTableReading> =>
  Promise.resolve({ supported: false, reason: 'no table on this platform' });

function harness() {
  const delivered: NodeJS.Signals[] = [];
  const abstentions: SignalAbstention[] = [];
  return {
    delivered,
    abstentions,
    options: (readProcessTable: () => Promise<ProcessTableReading>) => ({
      action: 'test cleanup',
      readProcessTable,
      deliver: (signal: NodeJS.Signals) => {
        delivered.push(signal);
      },
      reportAbstention: (a: SignalAbstention) => {
        abstentions.push(a);
      },
    }),
  };
}

describe('sendVerifiedSignal: spawned process (live handle)', () => {
  it('signals through the handle while the child is unreaped', async () => {
    const child = fakeChild(4242, 'running');
    const outcome = await sendVerifiedSignal(
      { kind: 'spawned-process', handle: child },
      'SIGTERM',
      { action: 'test', reportAbstention: vi.fn() },
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'live-child-handle' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('never signals once the child is reaped — the pid may now be anyone', async () => {
    const child = fakeChild(4242, 'reaped');
    const report = vi.fn();
    const outcome = await sendVerifiedSignal(
      { kind: 'spawned-process', handle: child },
      'SIGKILL',
      { action: 'test', reportAbstention: report },
    );
    expect(outcome.status).toBe('not-needed');
    expect(child.kill).not.toHaveBeenCalled();
    // Our process is known to be gone; nothing is suspected, so no warning.
    expect(report).not.toHaveBeenCalled();
  });
});

describe('sendVerifiedSignal: process group', () => {
  it('confirms by the live leader handle and records the members it saw', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'running'));
    const members = [
      { pid: 100, pgid: 100, startTime: T1 },
      { pid: 101, pgid: 100, startTime: T1 },
    ];
    const outcome = await sendVerifiedSignal(
      group,
      'SIGTERM',
      h.options(table(...members, { pid: 7, pgid: 7, startTime: T1 })),
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'live-child-handle' });
    expect(h.delivered).toEqual(['SIGTERM']);
    expect(group.verifiedMembers).toEqual(members);
  });

  it('after the leader is reaped, confirms through a surviving known member', async () => {
    const h = harness();
    const leader = fakeChild(100, 'running');
    const group = spawnedProcessGroup(leader);
    const descendant = { pid: 101, pgid: 100, startTime: T1 };
    await sendVerifiedSignal(
      group,
      'SIGTERM',
      h.options(table({ pid: 100, pgid: 100, startTime: T1 }, descendant)),
    );
    const reaped = fakeChild(100, 'reaped');
    const later = { ...group, leader: reaped };

    const outcome = await sendVerifiedSignal(
      later,
      'SIGKILL',
      h.options(table(descendant)),
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'recorded-identity' });
    expect(h.delivered).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.abstentions).toEqual([]);
  });

  it('withholds the signal when the recorded pgid is now held by unrelated processes (recycled id)', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'reaped'));
    group.verifiedMembers = [
      { pid: 100, pgid: 100, startTime: T1 },
      { pid: 101, pgid: 100, startTime: T1 },
    ];
    // Same group id, but a process with a different start time: the group was
    // emptied and the id handed to new work.
    const stranger = { pid: 100, pgid: 100, startTime: T2 };
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(table(stranger)),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions).toHaveLength(1);
    expect(h.abstentions[0]).toMatchObject({
      signal: 'SIGKILL',
      target: { kind: 'process-group', id: 100 },
      observed: [stranger],
    });
    expect(h.abstentions[0]?.reason).toMatch(/may have been reused/);
  });

  it('reports nothing to do when the group has no members left', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'reaped'));
    group.verifiedMembers = [{ pid: 100, pgid: 100, startTime: T1 }];
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(table({ pid: 5, pgid: 5, startTime: T1 })),
    );
    expect(outcome.status).toBe('not-needed');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions).toEqual([]);
  });

  it('abstains when the leader is reaped and the platform table is unreadable', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'reaped'));
    group.verifiedMembers = [{ pid: 101, pgid: 100, startTime: T1 }];
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(unsupportedTable),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions[0]?.reason).toMatch(/no table on this platform/);
  });

  it('abstains when the leader is reaped and no earlier confirmation recorded members', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'reaped'));
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(table({ pid: 101, pgid: 100, startTime: T1 })),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual([]);
  });

  it('still signals by the live leader handle when the table cannot be read', async () => {
    const h = harness();
    const group = spawnedProcessGroup(fakeChild(100, 'running'));
    const outcome = await sendVerifiedSignal(
      group,
      'SIGTERM',
      h.options(unsupportedTable),
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'live-child-handle' });
    expect(group.verifiedMembers).toEqual([]);
  });

  it('refuses to track a group for a child that never got a pid', () => {
    expect(() =>
      spawnedProcessGroup({
        pid: undefined,
        exitCode: null,
        signalCode: null,
        kill: () => false,
      }),
    ).toThrow(/no pid/);
  });
});

describe('sendVerifiedSignal: recorded process (no handle)', () => {
  const record = { pid: 4242, pgid: 4242, startTime: T1 };

  it('signals when pid and start time both match', async () => {
    const h = harness();
    const outcome = await sendVerifiedSignal(
      { kind: 'recorded-process', record },
      'SIGTERM',
      h.options(table({ ...record, pgid: 9 })),
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'recorded-identity' });
    expect(h.delivered).toEqual(['SIGTERM']);
  });

  it('withholds the signal for a recycled pid (same pid, different start time)', async () => {
    const h = harness();
    const devServer = { pid: 4242, pgid: 4242, startTime: T2 };
    const outcome = await sendVerifiedSignal(
      { kind: 'recorded-process', record },
      'SIGTERM',
      h.options(table(devServer)),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions[0]).toMatchObject({
      target: { kind: 'process', id: 4242 },
      observed: [devServer],
    });
  });

  it('reports nothing to do for a missing process', async () => {
    const h = harness();
    const outcome = await sendVerifiedSignal(
      { kind: 'recorded-process', record },
      'SIGTERM',
      h.options(table()),
    );
    expect(outcome.status).toBe('not-needed');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions).toEqual([]);
  });

  it('abstains when the platform table is unreadable', async () => {
    const h = harness();
    const outcome = await sendVerifiedSignal(
      { kind: 'recorded-process', record },
      'SIGTERM',
      h.options(unsupportedTable),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual([]);
  });
});

describe('describeSignalAbstention (008 §6.1 calibrated wording)', () => {
  it('names the target, states uncertainty, and says nothing was signalled', () => {
    const text = describeSignalAbstention({
      action: 'command-poll timeout escalation for "sh -c poll.sh"',
      signal: 'SIGKILL',
      target: { kind: 'process-group', id: 4242 },
      reason: 'the group id may have been reused',
      observed: [{ pid: 4243, pgid: 4242, startTime: T2 }],
    });
    expect(text).toContain('process group 4242');
    expect(text).toContain('SIGKILL');
    expect(text).toMatch(
      /may be ours, but its identity could not be confirmed/,
    );
    expect(text).toContain(`pid 4243 (started ${T2})`);
    expect(text).toContain('Nothing was signalled');
    // An abstention must never be phrased as a certainty.
    expect(text).not.toMatch(/\bis ours\b|\bkilled\b/);
  });
});

describe('process-table parsing', () => {
  it('parses macOS ps pid/pgid/lstart lines', () => {
    const output = [
      '    1     1 Tue Nov 10 18:42:25 2026    ',
      '  363   360 Tue Nov 10 18:48:54 2026',
      'garbage line',
      '',
    ].join('\n');
    expect(parsePsIdentityOutput(output)).toEqual([
      { pid: 1, pgid: 1, startTime: 'Tue Nov 10 18:42:25 2026' },
      { pid: 363, pgid: 360, startTime: 'Tue Nov 10 18:48:54 2026' },
    ]);
  });

  it('parses Linux /proc/<pid>/stat, counting fields after the last ")"', () => {
    // comm contains spaces and parentheses, which a naive split gets wrong.
    const stat =
      '4242 (we ird) (name) S 1 4200 4200 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 18446744073709551615';
    expect(parseProcStat(stat)).toEqual({
      pid: 4242,
      pgid: 4200,
      startTime: '987654',
    });
  });

  it('rejects malformed /proc stat content', () => {
    expect(parseProcStat('')).toBeUndefined();
    expect(parseProcStat('4242 (sh) S 1')).toBeUndefined();
    expect(
      parseProcStat(
        'x (sh) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20',
      ),
    ).toBeUndefined();
  });

  it('reports an unsupported platform instead of an empty table', async () => {
    await expect(readProcessTable('win32')).resolves.toMatchObject({
      supported: false,
    });
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reads this process with its own group from the real table',
    async () => {
      const reading = await readProcessTable();
      expect(reading.supported).toBe(true);
      if (!reading.supported) return;
      const self = reading.processes.find((p) => p.pid === process.pid);
      expect(self).toBeDefined();
      expect(self?.startTime.length).toBeGreaterThan(0);
      // A second reading reports the same identity for the same process.
      const again = await readProcessTable();
      const selfAgain = again.supported
        ? again.processes.find((p) => p.pid === process.pid)
        : undefined;
      expect(selfAgain).toEqual(self);
    },
  );
});
