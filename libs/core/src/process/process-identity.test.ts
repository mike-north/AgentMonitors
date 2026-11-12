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
import { EventEmitter } from 'node:events';
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
  readLinuxProcessTable,
  readProcessTable,
  type ProcFileHandle,
  type ProcFs,
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

/**
 * A fake leader that can be reaped the way Node reaps a real child: `exitCode`
 * is set and `exit` is emitted in the same synchronous step.
 */
class ReapableChild extends EventEmitter implements ChildProcessHandle {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
  constructor(readonly pid: number) {
    super();
  }
  reap(): void {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

/**
 * A process table whose content the test changes over time, recording when
 * each read starts. `hold` makes reads wait until the test releases them, to
 * simulate a slow read during which the leader is reaped.
 */
function liveTable(initial: ProcessIdentityRecord[]) {
  let current = initial;
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const reads: ProcessIdentityRecord[][] = [];
  return {
    set(next: ProcessIdentityRecord[]) {
      current = next;
    },
    hold() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      gate = undefined;
    },
    reads,
    read: async (): Promise<ProcessTableReading> => {
      // The snapshot is taken when the read starts, as `ps` or `/proc` would.
      const snapshot = current;
      reads.push(snapshot);
      if (gate !== undefined) await gate;
      return { supported: true, processes: snapshot };
    },
  };
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

describe('sendVerifiedSignal: process group continuity across the leader exiting', () => {
  const leaderRecord = { pid: 100, pgid: 100, startTime: T1 };
  const sibling = { pid: 101, pgid: 100, startTime: T1 };

  // Regression (#479): the SIGTERM step read the table first and
  // checked the leader afterwards, so a command that exited on its own during
  // the read made the step abstain, and its surviving group member was never
  // bounded.
  it('the SIGTERM step still signals when the leader exits during its own read', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([leaderRecord, sibling]);
    t.hold();
    const pending = sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));
    // The leader exits on its own while the read is in flight.
    leader.reap();
    t.set([sibling]);
    t.release();
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'sent', evidence: 'recorded-identity' });
    expect(h.delivered).toEqual(['SIGTERM']);
    expect(h.abstentions).toEqual([]);
    expect(group.verifiedMembers).toEqual(
      expect.arrayContaining([leaderRecord, sibling]),
    );
  });

  it('needs no signal when a read started before the leader exited shows an empty group', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([{ pid: 5, pgid: 5, startTime: T1 }]);
    t.hold();
    const pending = sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));
    leader.reap();
    t.release();
    expect((await pending).status).toBe('not-needed');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions).toEqual([]);
  });

  it('abstains when the leader exits during an unreadable read: there is no evidence to act on', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    // The leader's exit starts a second read, so release every pending one.
    const releases: (() => void)[] = [];
    const slowUnsupported = async (): Promise<ProcessTableReading> => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { supported: false, reason: 'the reader failed' };
    };
    const pending = sendVerifiedSignal(
      group,
      'SIGTERM',
      h.options(slowUnsupported),
    );
    leader.reap();
    for (const release of releases) release();
    expect((await pending).status).toBe('abstained');
    expect(h.delivered).toEqual([]);
    expect(h.abstentions[0]?.reason).toMatch(/exited while the process table/);
  });

  // Regression (#479): a process forked after the SIGTERM step
  // (e.g. by the command's TERM trap just before it exits) is a member of our
  // group, but was absent from the SIGTERM read, so the SIGKILL follow-up
  // abstained and left it running past the hard bound (008 §3.1).
  it('confirms a process forked after the SIGTERM step through the read taken as the leader is reaped', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([leaderRecord, sibling]);
    await sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));

    // The trap forks a worker into the group, then the leader exits; the
    // sibling died on SIGTERM.
    const worker = { pid: 102, pgid: 100, startTime: T2 };
    t.set([leaderRecord, worker]);
    leader.reap();
    t.set([worker]);

    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(t.read),
    );
    expect(outcome).toEqual({ status: 'sent', evidence: 'recorded-identity' });
    expect(h.delivered).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.abstentions).toEqual([]);
    expect(group.verifiedMembers).toContainEqual(worker);
  });

  it('the read at the leader’s exit starts synchronously, before anything else can run', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([leaderRecord]);
    await sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));
    const before = t.reads.length;
    leader.reap();
    expect(t.reads.length).toBe(before + 1);
  });

  it('a later step confirms the group through a member recorded by any earlier read', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([leaderRecord, sibling]);
    await sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));
    leader.reap();
    // Only the sibling recorded at SIGTERM remains, plus a newer process
    // that it forked after the leader's exit read.
    const grandchild = { pid: 103, pgid: 100, startTime: T2 };
    t.set([sibling, grandchild]);
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(t.read),
    );
    expect(outcome.status).toBe('sent');
    // Continuity through the sibling confirms the grandchild as well.
    expect(group.verifiedMembers).toContainEqual(grandchild);
  });

  it('still abstains when continuity is lost: every confirmed member is gone and a stranger holds the id', async () => {
    const h = harness();
    const leader = new ReapableChild(100);
    const group = spawnedProcessGroup(leader);
    const t = liveTable([leaderRecord, sibling]);
    await sendVerifiedSignal(group, 'SIGTERM', h.options(t.read));
    leader.reap();
    // The group emptied after the exit read, and the id was reused.
    const stranger = { pid: 100, pgid: 100, startTime: T2 };
    t.set([stranger]);
    const outcome = await sendVerifiedSignal(
      group,
      'SIGKILL',
      h.options(t.read),
    );
    expect(outcome.status).toBe('abstained');
    expect(h.delivered).toEqual(['SIGTERM']);
    expect(h.abstentions[0]).toMatchObject({ observed: [stranger] });
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

describe('readLinuxProcessTable error handling', () => {
  const stat = (pid: number, pgid: number) =>
    `${String(pid)} (sh) S 1 ${String(pgid)} ${String(pgid)} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0`;

  function errnoError(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
    error.code = code;
    return error;
  }

  /** An open handle over `content`, serving at most `readSize` bytes per read. */
  function fakeHandle(content: string, readSize: number): ProcFileHandle {
    const bytes = new TextEncoder().encode(content);
    return {
      read: (buffer, position) => {
        const n = Math.min(buffer.length, readSize, bytes.length - position);
        buffer.set(bytes.subarray(position, position + n));
        return Promise.resolve(Math.max(n, 0));
      },
      close: () => Promise.resolve(),
    };
  }

  function fakeProc(
    pids: number[],
    failures: Record<number, string> = {},
    readSize = 4096,
  ): ProcFs & { maxInFlight: number; openHandles: number } {
    let inFlight = 0;
    const fs = {
      maxInFlight: 0,
      openHandles: 0,
      readdir: () =>
        Promise.resolve(['self', 'net', ...pids.map((p) => String(p))]),
      open: async (path: string) => {
        inFlight++;
        fs.openHandles++;
        fs.maxInFlight = Math.max(fs.maxInFlight, inFlight);
        const release = (): void => {
          inFlight--;
          fs.openHandles--;
        };
        await new Promise((r) => setTimeout(r, 1));
        const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
        const code = failures[pid];
        if (code !== undefined) {
          release();
          throw errnoError(code);
        }
        const handle = fakeHandle(stat(pid, 100), readSize);
        return {
          read: handle.read,
          close: async () => {
            await handle.close();
            release();
          },
        };
      },
    };
    return fs;
  }

  it('leaves out a process that exited mid-read (ENOENT / ESRCH)', async () => {
    const reading = await readLinuxProcessTable(
      fakeProc([100, 101, 102], { 101: 'ENOENT', 102: 'ESRCH' }),
    );
    expect(reading).toEqual({
      supported: true,
      processes: [{ pid: 100, pgid: 100, startTime: '5000' }],
    });
  });

  // Regression (#479): any read error used to drop the process
  // silently, so descriptor exhaustion could make a live group look empty.
  it.each(['EMFILE', 'ENFILE', 'EACCES', 'EIO'])(
    'reports the reading as unsupported on %s instead of dropping the process',
    async (code) => {
      const reading = await readLinuxProcessTable(
        fakeProc([100, 101, 102], { 101: code }),
      );
      expect(reading.supported).toBe(false);
      if (reading.supported) return;
      expect(reading.reason).toContain('/proc/101/stat');
      expect(reading.reason).toContain(code);
    },
  );

  it('bounds how many stat files are open at once', async () => {
    const pids = Array.from({ length: 500 }, (_, i) => i + 1);
    const fs = fakeProc(pids);
    const reading = await readLinuxProcessTable(fs);
    expect(reading.supported && reading.processes.length).toBe(500);
    expect(fs.maxInFlight).toBeGreaterThan(1);
    expect(fs.maxInFlight).toBeLessThanOrEqual(32);
  });

  // A stat line longer than the first read must be read to EOF, not truncated
  // (a truncated line would lose the start-time field and drop the process).
  it('reads a stat line longer than a single read to EOF', async () => {
    const fs = fakeProc([100, 101], {}, 7);
    const reading = await readLinuxProcessTable(fs);
    expect(reading).toEqual({
      supported: true,
      processes: [
        { pid: 100, pgid: 100, startTime: '5000' },
        { pid: 101, pgid: 100, startTime: '5000' },
      ],
    });
    expect(fs.openHandles).toBe(0);
  });

  it('reads a stat line longer than the reader chunk across several reads', async () => {
    const longComm = 'x'.repeat(5000);
    const content = `100 (${longComm}) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0`;
    const reading = await readLinuxProcessTable({
      readdir: () => Promise.resolve(['100']),
      open: () => Promise.resolve(fakeHandle(content, Infinity)),
    });
    expect(reading).toEqual({
      supported: true,
      processes: [{ pid: 100, pgid: 100, startTime: '5000' }],
    });
  });

  it('closes the handle and reports unsupported when a read fails mid-file', async () => {
    let closed = false;
    const reading = await readLinuxProcessTable({
      readdir: () => Promise.resolve(['100']),
      open: () =>
        Promise.resolve({
          read: () => Promise.reject(errnoError('EIO')),
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
    });
    expect(reading.supported).toBe(false);
    expect(closed).toBe(true);
  });

  it('reports an unlistable /proc as unsupported', async () => {
    const reading = await readLinuxProcessTable({
      readdir: () => Promise.reject(errnoError('EACCES')),
      open: () => Promise.reject(errnoError('ENOENT')),
    });
    expect(reading.supported).toBe(false);
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
