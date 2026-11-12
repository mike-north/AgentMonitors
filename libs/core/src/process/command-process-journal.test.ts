/** Crash durability and missing-evidence cases are independent of the host process table. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import { readProcessTable } from './process-table.js';
import {
  readBootIdentity,
  readCommandMarks,
  readCommandTerminal,
} from './command-process-marks.js';

vi.mock('./process-table.js', () => ({ readProcessTable: vi.fn() }));
vi.mock('./command-process-marks.js', () => ({
  COMMAND_LIFE_ENV: 'AGENTMONITORS_COMMAND_LIFE',
  readBootIdentity: vi.fn(),
  readCommandMarks: vi.fn(),
  readCommandTerminal: vi.fn(),
}));
const directories: string[] = [];
const journals: CommandProcessJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A durable previous life with a dead owner, without requiring any real victim process. */
async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-journal-'));
  directories.push(dir);
  const db = path.join(dir, 'inbox.db');
  vi.mocked(readBootIdentity).mockResolvedValue('boot');
  vi.mocked(readCommandTerminal).mockResolvedValue('terminated');
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [{ pid: process.pid, pgid: process.pid, startTime: 'owner' }],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map(),
  });
  const journal = await CommandProcessJournal.open(db, dir);
  journals.push(journal);
  const token = (await journal.environment()).AGENTMONITORS_COMMAND_LIFE;
  journal.spawned(4242);
  const sql = new Database(`${db}.commands.sqlite`);
  sql
    .prepare('UPDATE command_lives SET owner = ?')
    .run(JSON.stringify({ pid: 99, pgid: 99, startTime: 'dead-owner' }));
  sql.close();
  const next = await CommandProcessJournal.open(db, dir);
  journals.push(next);
  return { journal: next, token, db };
}

it('finds marked descendants even when a crash prevented recording the spawned PID', async () => {
  const f = await fixture();
  const victim = { pid: 4243, pgid: 4243, startTime: 'descendant' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [victim],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[victim.pid, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).toHaveBeenCalledExactlyOnceWith(victim.pid, 'SIGKILL');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: victim.pid,
      status: 'reaped',
      evidence: expect.objectContaining({ startTime: 'descendant' }),
    }),
  );
});

it('abstains if a discovered process loses its mark before the signal-time gate', async () => {
  const f = await fixture();
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [{ pid: 4242, pgid: 4242, startTime: 'victim' }],
  });
  vi.mocked(readCommandMarks)
    .mockResolvedValueOnce({
      supported: true,
      marks: new Map([[4242, f.token]]),
    })
    .mockResolvedValue({ supported: true, marks: new Map() });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      status: 'abstained',
      reason: expect.stringMatching(/mark/),
    }),
  );
});

it('abstains when a marked PID changes start time between discovery and signal', async () => {
  const f = await fixture();
  vi.mocked(readProcessTable)
    .mockResolvedValueOnce({
      supported: true,
      processes: [{ pid: 4242, pgid: 4242, startTime: 'old' }],
    })
    .mockResolvedValue({
      supported: true,
      processes: [{ pid: 4242, pgid: 4242, startTime: 'new' }],
    });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[4242, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect((await f.journal.sweep()).outcomes).toContainEqual(
    expect.objectContaining({
      status: 'abstained',
      reason: expect.stringMatching(/reused/),
    }),
  );
  expect(kill).not.toHaveBeenCalled();
});

it('records incomplete discovery instead of treating an unreadable table as an empty sweep', async () => {
  const f = await fixture();
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: false,
    reason: 'table unavailable',
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await f.journal.sweep()).toEqual(
    expect.objectContaining({
      status: 'incomplete',
      outcomes: expect.arrayContaining([
        expect.objectContaining({
          status: 'abstained',
          reason: expect.stringMatching(/unavailable/),
        }),
      ]),
    }),
  );
  expect(kill).not.toHaveBeenCalled();
});

it('leaves positively live owners and their marked work alone', async () => {
  const f = await fixture();
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [
      { pid: 99, pgid: 99, startTime: 'dead-owner' },
      { pid: 4242, pgid: 4242, startTime: 'work' },
    ],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[4242, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect((await f.journal.sweep()).outcomes).toContainEqual(
    expect.objectContaining({ status: 'owner-alive' }),
  );
  expect(kill).not.toHaveBeenCalled();
});

it('also reaps an unmarked descendant whose original group is confirmed by a marked member', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const child = { pid: 4243, pgid: 4242, startTime: 'child' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [parent, child],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[4242, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
});

it('discovers a final marked fork made while the first snapshot was being reaped', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const late = { pid: 4243, pgid: 4243, startTime: 'late' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes:
      kill.mock.calls.length === 0
        ? [parent]
        : kill.mock.calls.length === 1
          ? [late]
          : [],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledWith(late.pid, 'SIGKILL');
});

it('records malformed durable owner identity as an abstention instead of throwing out of startup', async () => {
  const f = await fixture();
  const sql = new Database(`${f.db}.commands.sqlite`);
  sql
    .prepare('UPDATE command_lives SET owner = ? WHERE life = ?')
    .run('not-json', f.token);
  sql.close();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect((await f.journal.sweep()).outcomes).toContainEqual(
    expect.objectContaining({
      status: 'abstained',
      reason: expect.stringMatching(/Invalid/),
    }),
  );
  expect(kill).not.toHaveBeenCalled();
});

it('never treats a live daemon owner with an inherited old mark as a group cleanup anchor', async () => {
  const f = await fixture();
  const owner = { pid: process.pid, pgid: process.pid, startTime: 'owner' };
  const peer = { pid: 4243, pgid: process.pid, startTime: 'peer' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [owner, peer],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[owner.pid, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
});

it('records each still-discovered PID when bounded discovery cannot reach a quiet snapshot', async () => {
  const f = await fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: [
      {
        pid: 4242 + kill.mock.calls.length,
        pgid: 4242 + kill.mock.calls.length,
        startTime: 'fork',
      },
    ],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const result = await f.journal.sweep();
  expect(result.status).toBe('incomplete');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      status: 'abstained',
      pid: 4250,
      reason: expect.stringMatching(/discovery/),
    }),
  );
});

for (const terminal of ['running', 'unavailable'] as const) {
  it(`does not claim a reap when a delivered signal has ${terminal} termination evidence`, async () => {
    const f = await fixture();
    const victim = { pid: 4242, pgid: 4242, startTime: 'victim' };
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [victim],
    });
    vi.mocked(readCommandMarks).mockResolvedValue({
      supported: true,
      marks: new Map([[victim.pid, f.token]]),
    });
    vi.mocked(readCommandTerminal).mockResolvedValue(terminal);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = await f.journal.sweep();
    expect(kill).toHaveBeenCalledExactlyOnceWith(victim.pid, 'SIGKILL');
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({
        pid: victim.pid,
        status: 'failed',
        reason: expect.stringMatching(/termination.*confirmed/),
      }),
    );
    expect(result.outcomes.some((o) => o.status === 'reaped')).toBe(false);
  });
}

it('does not transfer a recycled marked PID onto an unrelated group from an older snapshot', async () => {
  const f = await fixture();
  const old = { pid: 4242, pgid: 5000, startTime: 'unrelated-old' };
  const unrelated = { pid: 4243, pgid: 5000, startTime: 'unrelated-member' };
  const replacement = { pid: 4242, pgid: 4242, startTime: 'our-new' };
  vi.mocked(readProcessTable)
    .mockResolvedValueOnce({ supported: true, processes: [old, unrelated] })
    .mockResolvedValue({
      supported: true,
      processes: [replacement, unrelated],
    });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[4242, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: 4242,
      status: 'abstained',
      reason: expect.stringMatching(/reused|changed/),
    }),
  );
});

it('reaps old marked work even when the old owner PID was reused by the current daemon', async () => {
  const f = await fixture();
  const sql = new Database(`${f.db}.commands.sqlite`);
  sql.prepare('UPDATE command_lives SET owner = ? WHERE life = ?').run(
    JSON.stringify({
      pid: process.pid,
      pgid: process.pid,
      startTime: 'old-owner',
    }),
    f.token,
  );
  sql.close();
  const current = { pid: process.pid, pgid: process.pid, startTime: 'owner' };
  const work = { pid: 4242, pgid: 4242, startTime: 'old-work' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [current, work],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[work.pid, f.token]]),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledExactlyOnceWith(work.pid, 'SIGKILL');
});

it('checks process identity after the final mark read, not before it', async () => {
  const f = await fixture();
  const before = { pid: 4242, pgid: 4242, startTime: 'before' };
  const after = { pid: 4242, pgid: 4242, startTime: 'reused' };
  let current = before;
  let markReads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: [current],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async () => {
    markReads++;
    if (markReads === 2) current = after;
    return {
      supported: true,
      marks: markReads <= 2 ? new Map([[before.pid, f.token]]) : new Map(),
    };
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: before.pid,
      status: 'abstained',
      reason: expect.stringMatching(/reused/),
    }),
  );
});

it('records an empty first startup without boot, process-table or environment scans', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-empty-journal-'));
  directories.push(dir);
  vi.mocked(readBootIdentity).mockReset().mockResolvedValue('boot');
  vi.mocked(readProcessTable)
    .mockReset()
    .mockResolvedValue({ supported: true, processes: [] });
  vi.mocked(readCommandMarks)
    .mockReset()
    .mockResolvedValue({ supported: true, marks: new Map() });
  const journal = await CommandProcessJournal.open(
    path.join(dir, 'inbox.db'),
    dir,
  );
  journals.push(journal);
  expect(await journal.sweep()).toMatchObject({
    status: 'complete',
    outcomes: [],
  });
  expect(readBootIdentity).not.toHaveBeenCalled();
  expect(readProcessTable).not.toHaveBeenCalled();
  expect(readCommandMarks).not.toHaveBeenCalled();
});
