/** Crash durability and missing-evidence cases are independent of the host process table. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
// Resolve the host native binding before selecting a simulated platform.
const nativeBinding = new Database(':memory:');
nativeBinding.close();
// These injected-reader cases exercise the sequential /proc path independently
// of the host. macOS batched signal gates have their own marker-reader suite.
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
});
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
  vi.mocked(readCommandTerminal).mockImplementation(async (record) =>
    record.pid === 99 ? 'running' : 'terminated',
  );
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
  return { journal: next, admission: journal, token, db };
}

it('sweeps 12,001 gone hints within the detached readiness budget', async () => {
  const f = await fixture();
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    // A long daemon life must not turn empty restart accounting into one
    // FULL-sync rewrite of an ever-growing receipt for every completed command.
    sql.transaction(() => {
      const insert = sql.prepare(
        'INSERT OR IGNORE INTO command_pids VALUES(?,?)',
      );
      for (let pid = 1; pid <= 12_001; pid++) insert.run(f.token, pid);
    })();
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const started = performance.now();
    const result = await f.journal.sweep();
    const elapsedMs = performance.now() - started;
    console.info(`12,001 gone hints: ${elapsedMs.toFixed(1)} ms`);
    expect(result.status).toBe('complete');
    expect(result.outcomes).toHaveLength(12_001);
    expect(result.outcomes.every((outcome) => outcome.status === 'gone')).toBe(
      true,
    );
    expect(kill).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    expect(
      JSON.parse(
        sql
          .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
          .pluck()
          .get(),
      ),
    ).toEqual(result);
    expect(elapsedMs).toBeLessThan(2_000);
  } finally {
    sql.close();
  }
}, 60_000);

it('retires empty group hints during repeated admissions while preserving possible survivors', async () => {
  const f = await fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const survivor = { pid: 4243, pgid: 4242, startTime: 'unmarked' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [survivor],
  });
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    // The current life remains admitted throughout; completed empty groups
    // must not accumulate until a daemon restart, while this group stays suspect.
    for (let cycle = 0; cycle < 100; cycle++) {
      await f.admission.environment();
      const pid = 5000 + cycle;
      f.admission.spawned(pid);
      f.admission.exited(pid);
    }
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: false,
      reason: 'unavailable',
    });
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
      { life: f.token },
    ]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

it('retains PID-only occupancy during admission and abstains after restart', async () => {
  const f = await fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  // The direct child has exited and its group is empty, but a different
  // incarnation occupies its PID. Admission cannot erase that suspicion.
  f.admission.exited(4242);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [{ pid: 4242, pgid: 7000, startTime: 'unmarked-reuse' }],
  });
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    f.journal.close();
    journals.splice(journals.indexOf(f.journal), 1);
    const restarted = CommandProcessJournal.open(f.db, path.dirname(f.db));
    journals.push(restarted);
    const result = await restarted.sweep();
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({
        life: f.token,
        pid: 4242,
        status: 'abstained',
        reason: expect.stringMatching(/group continuity is unconfirmed/),
      }),
    );
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
      { life: f.token },
    ]);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    expect(
      JSON.parse(
        sql
          .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
          .pluck()
          .get(),
      ),
    ).toEqual(result);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

it.each(['verified', 'boot', 'mark', 'start-time'] as const)(
  'accounts for a marked late fork when its parent vanishes before signalling (%s)',
  async (gate) => {
    const f = await fixture();
    const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
    const child = { pid: 4243, pgid: 4242, startTime: 'late-child' };
    let reads = 0;
    let present = true;
    const sql = new Database(`${f.db}.commands.sqlite`);
    // The parent survives anchor confirmation but exits naturally before the
    // signal-time table. Its child was absent from the discovery snapshot.
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes: !present ? [] : ++reads <= 2 ? [parent] : [child],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => {
      const childGate =
        reads >= 5 && pids.length === 1 && pids[0] === child.pid;
      if (childGate && gate === 'start-time')
        vi.mocked(readProcessTable).mockResolvedValue({
          supported: true,
          processes: [{ ...child, startTime: 'recycled' }],
        });
      return {
        supported: true,
        marks: new Map(
          pids
            .filter(
              (pid) =>
                !(childGate && gate === 'mark') &&
                (pid === parent.pid || pid === child.pid),
            )
            .map((pid) => [pid, f.token]),
        ),
      };
    });
    // Boot is queried before the mark, so change it on the child's next
    // signal-time read while preserving the sweep's original boot identity.
    vi.mocked(readBootIdentity).mockImplementation(async () =>
      gate === 'boot' && reads >= 5 ? 'changed-boot' : 'boot',
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
      return true;
    });
    try {
      const first = await f.journal.sweep();
      expect(first.outcomes).toContainEqual(
        expect.objectContaining({ pid: parent.pid, status: 'gone' }),
      );
      expect(first.outcomes).toContainEqual(
        expect.objectContaining({
          pid: child.pid,
          status: gate === 'verified' ? 'reaped' : 'abstained',
        }),
      );
      expect(kill.mock.calls).toEqual(
        gate === 'verified' ? [[child.pid, 'SIGKILL']] : [],
      );
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
        { pid: parent.pgid },
      ]);
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(first);
      present = false;
      vi.mocked(readProcessTable).mockResolvedValue({
        supported: true,
        processes: [],
      });
      vi.mocked(readCommandMarks).mockResolvedValue({
        supported: true,
        marks: new Map(),
      });
      vi.mocked(readBootIdentity).mockResolvedValue('boot');
      const empty = await f.journal.sweep();
      expect(empty.status).toBe('complete');
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(empty);
    } finally {
      sql.close();
    }
  },
);

it.each(['discovery', 'anchor', 'signal'] as const)(
  'retains vanished-target suspicion alone when its PID is reused after %s',
  async (phase) => {
    const f = await fixture();
    const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
    const reused = { pid: 4242, pgid: 9000, startTime: 'unrelated' };
    const vanishAt = { discovery: 1, anchor: 2, signal: 3 }[phase];
    let reads = 0;
    // No child, failed signal, unreadable mark or abstention can independently
    // retain this life. Only the vanished target protects the occupied hint.
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes:
        ++reads < vanishAt ? [parent] : reads === vanishAt ? [] : [reused],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks:
        reads < vanishAt && pids.includes(parent.pid)
          ? new Map([[parent.pid, f.token]])
          : new Map(),
    }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const sql = new Database(`${f.db}.commands.sqlite`);
    try {
      const result = await f.journal.sweep();
      expect(result.outcomes).toEqual([
        expect.objectContaining({ pid: parent.pid, status: 'gone' }),
      ]);
      expect(reads).toBe(vanishAt + 1);
      expect(kill).not.toHaveBeenCalled();
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
        { pid: parent.pid },
      ]);
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(result);
      vi.mocked(readProcessTable).mockResolvedValue({
        supported: true,
        processes: [],
      });
      vi.mocked(readCommandMarks).mockResolvedValue({
        supported: true,
        marks: new Map(),
      });
      await f.journal.sweep();
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    } finally {
      sql.close();
    }
  },
);

it.each(['discovery', 'anchor'] as const)(
  'rediscovers a marked late fork after its parent vanishes during %s',
  async (phase) => {
    const f = await fixture();
    const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
    const child = { pid: 4243, pgid: 4242, startTime: 'late-child' };
    const vanishAt = phase === 'discovery' ? 1 : 2;
    let reads = 0;
    // Linux enumerates /proc before reading individual stat files. A fork
    // after enumeration and ENOENT for the parent yields an empty first read.
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes:
        ++reads < vanishAt ? [parent] : reads === vanishAt ? [] : [child],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(pids.map((pid) => [pid, f.token])),
    }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const sql = new Database(`${f.db}.commands.sqlite`);
    try {
      const result = await f.journal.sweep();
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: parent.pid, status: 'gone' }),
      );
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: child.pid, status: 'reaped' }),
      );
      expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGKILL');
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
        { pid: parent.pgid },
      ]);
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(result);
      vi.mocked(readProcessTable).mockResolvedValue({
        supported: true,
        processes: [],
      });
      vi.mocked(readCommandMarks).mockResolvedValue({
        supported: true,
        marks: new Map(),
      });
      await f.journal.sweep();
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    } finally {
      sql.close();
    }
  },
);

it.each(['group-member', 'delivery-ESRCH'] as const)(
  'retains vanished-target suspicion alone after %s',
  async (phase) => {
    const f = await fixture();
    const anchor = { pid: 4242, pgid: 4242, startTime: 'anchor' };
    const member = { pid: 4243, pgid: 4242, startTime: 'member' };
    const target = phase === 'group-member' ? member : anchor;
    const reused = { ...target, pgid: 9000, startTime: 'unrelated' };
    const sql = new Database(`${f.db}.commands.sqlite`);
    if (phase === 'group-member') {
      // Visit the unmarked group member before its marked anchor. Both exit
      // without a signal, so no independent reap or abstention masks retention.
      sql.prepare('UPDATE command_pids SET pid = ?').run(member.pid);
    }
    let reads = 0;
    const before = phase === 'group-member' ? [anchor, member] : [anchor];
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes:
        ++reads <= (phase === 'group-member' ? 2 : 3)
          ? before
          : phase === 'group-member' && reads <= 4
            ? []
            : [reused],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks:
        reads <= 3 && pids.includes(anchor.pid)
          ? new Map([[anchor.pid, f.token]])
          : new Map(),
    }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (phase === 'group-member')
        throw new Error('A vanished group member must not be signalled');
      throw Object.assign(new Error('target exited'), { code: 'ESRCH' });
    });
    try {
      const result = await f.journal.sweep();
      expect(
        result.outcomes.every((outcome) => outcome.status === 'gone'),
      ).toBe(true);
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: target.pid, status: 'gone' }),
      );
      expect(kill.mock.calls).toEqual(
        phase === 'group-member' ? [] : [[target.pid, 'SIGKILL']],
      );
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
      expect(
        sql
          .prepare('SELECT pid FROM command_pids WHERE pid = ?')
          .all(target.pid),
      ).toEqual([{ pid: target.pid }]);
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(result);
      vi.mocked(readProcessTable).mockResolvedValue({
        supported: true,
        processes: [],
      });
      vi.mocked(readCommandMarks).mockResolvedValue({
        supported: true,
        marks: new Map(),
      });
      await f.journal.sweep();
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    } finally {
      sql.close();
    }
  },
);

it('preserves an unrecorded anchor group when the anchor vanishes during confirmation', async () => {
  const f = await fixture();
  const anchor = { pid: 4242, pgid: 4242, startTime: 'anchor' };
  const survivor = { pid: 4243, pgid: 4242, startTime: 'unmarked' };
  const sql = new Database(`${f.db}.commands.sqlite`);
  sql.prepare('DELETE FROM command_pids').run();
  let reads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: ++reads === 1 ? [anchor] : reads === 2 ? [] : [survivor],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async () => ({
    supported: true,
    marks: reads === 1 ? new Map([[anchor.pid, f.token]]) : new Map(),
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const result = await f.journal.sweep();
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ pid: survivor.pid, status: 'abstained' }),
    );
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
      { life: f.token },
    ]);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: anchor.pgid },
    ]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

it('bounds rediscovery of a continuously vanishing marked lineage to eight passes', async () => {
  const f = await fixture();
  let reads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => {
    const index = reads++;
    const pid = 4242 + Math.floor(index / 2);
    return {
      supported: true,
      processes: index % 2 === 0 ? [{ pid, pgid: pid, startTime: 'fork' }] : [],
    };
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(reads).toBe(17);
  expect(result.status).toBe('incomplete');
  expect(
    result.outcomes.filter((outcome) => outcome.status === 'gone'),
  ).toHaveLength(8);
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: 4250,
      status: 'abstained',
      reason: expect.stringMatching(/Bounded discovery/),
    }),
  );
  expect(kill).not.toHaveBeenCalled();
});

it('keeps a hint refreshed while admission reads an earlier empty process snapshot', async () => {
  const f = await fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    // Spawn/exit bookkeeping can run while the async table read is in flight.
    // Even the same numeric hint may now describe work newer than that snapshot.
    vi.mocked(readProcessTable).mockImplementation(async () => {
      f.admission.spawned(4242);
      return { supported: true, processes: [] };
    });
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

it('bounds empty hints even when unrelated bookkeeping arrives during every admission read', async () => {
  const f = await fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    // Continuous unrelated work cannot invalidate emptiness evidence for every
    // older hint. Only a refreshed hint must outlive the earlier snapshot.
    for (let cycle = 0; cycle < 100; cycle++) {
      const pid = 5000 + cycle;
      vi.mocked(readProcessTable).mockImplementation(async () => {
        f.admission.spawned(pid);
        return { supported: true, processes: [] };
      });
      await f.admission.environment();
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
        { pid },
      ]);
    }
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    await f.admission.environment();
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

it('persists a newly discovered marked group before signalling and accounts for its survivor after reopen', async () => {
  const f = await fixture();
  const anchor = { pid: 4242, pgid: 7000, startTime: 'detached-anchor' };
  const child = { pid: 4243, pgid: 7000, startTime: 'unmarked-child' };
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    // Interrupted spawn recording leaves only the nonce. A discovered detached
    // group needs its own suspicion before cleanup removes its last marked anchor.
    sql.prepare('DELETE FROM command_pids').run();
    let signals = 0;
    let present = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toContainEqual({
        pid: anchor.pgid,
      });
      signals++;
      return true;
    });
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes: signals === 0 ? [anchor] : present ? [child] : [],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: pids.includes(anchor.pid)
        ? new Map([[anchor.pid, f.token]])
        : new Map(),
    }));
    const first = await f.journal.sweep();
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ pid: anchor.pid, status: 'reaped' }),
    );
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ pid: child.pid, status: 'abstained' }),
    );
    f.journal.close();
    journals.splice(journals.indexOf(f.journal), 1);
    const reopened = CommandProcessJournal.open(f.db, path.dirname(f.db));
    journals.push(reopened);
    const second = await reopened.sweep();
    expect(second.outcomes).toContainEqual(
      expect.objectContaining({
        pid: child.pid,
        status: 'abstained',
        reason: expect.stringMatching(/group continuity is unconfirmed/),
      }),
    );
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
      { life: f.token },
    ]);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: anchor.pgid },
    ]);
    expect(kill).toHaveBeenCalledExactlyOnceWith(anchor.pid, 'SIGKILL');
    present = false;
    await reopened.sweep();
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
  } finally {
    sql.close();
  }
});

it.each(['pid', 'reason'] as const)(
  'records a distinct unreadable ownership %s boundary while cleaning late forks',
  async (boundary) => {
    const f = await fixture();
    const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
    const late = { pid: 4243, pgid: 4242, startTime: 'late' };
    const unknown = { pid: 4244, pgid: 7000, startTime: 'unknown' };
    const other = { pid: 4245, pgid: 8000, startTime: 'other' };
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes:
        kill.mock.calls.length === 0
          ? [parent, unknown]
          : [late, unknown, ...(boundary === 'pid' ? [other] : [])],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(
        pids
          .filter((pid) => pid === parent.pid || pid === late.pid)
          .map((pid) => [pid, f.token]),
      ),
      unreadable: pids.filter(
        (pid) => pid === unknown.pid || pid === other.pid,
      ),
      unreadableReason:
        boundary === 'reason' && kill.mock.calls.length > 0
          ? 'uncertainty B'
          : 'uncertainty A',
    }));
    const result = await f.journal.sweep();
    expect(kill.mock.calls).toEqual([
      [parent.pid, 'SIGKILL'],
      [late.pid, 'SIGKILL'],
    ]);
    expect(result.status).toBe('incomplete');
    expect(
      result.outcomes
        .filter((outcome) => outcome.status === 'abstained')
        .map((outcome) => [outcome.pid, outcome.reason]),
    ).toEqual(
      boundary === 'pid'
        ? [
            [unknown.pid, 'uncertainty A'],
            [other.pid, 'uncertainty A'],
          ]
        : [
            [unknown.pid, 'uncertainty A'],
            [unknown.pid, 'uncertainty B'],
          ],
    );
    const sql = new Database(`${f.db}.commands.sqlite`);
    try {
      expect(
        JSON.parse(
          sql
            .prepare(
              'SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1',
            )
            .pluck()
            .get(),
        ),
      ).toEqual(result);
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
        { life: f.token },
      ]);
    } finally {
      sql.close();
    }
  },
);

it('retains group suspicion after a direct exit without authorizing an unmarked survivor signal', async () => {
  const f = await fixture();
  // A reaped direct child can leave environment-cleared work in its original
  // group. Its numeric identifier remains suspicion, never signal authority.
  f.admission.exited(4242);
  const child = { pid: 4243, pgid: 4242, startTime: 'unmarked-child' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [child],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map(),
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: child.pid,
      life: f.token,
      status: 'abstained',
      reason: expect.stringMatching(/group continuity is unconfirmed/),
    }),
  );
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    expect(sql.prepare('SELECT life FROM command_lives').all()).toContainEqual({
      life: f.token,
    });
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toContainEqual({
      pid: 4242,
    });
  } finally {
    sql.close();
  }
});

it('reaps a positively marked late fork despite unrelated unreadable ownership', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const late = { pid: 4243, pgid: 4242, startTime: 'late' };
  const unreadable = { pid: 4244, pgid: 7000, startTime: 'unrelated' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length === 0 ? [parent] : [late, unreadable],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids
        .filter((pid) => pid === parent.pid || pid === late.pid)
        .map((pid) => [pid, f.token]),
    ),
    unreadable: pids.includes(unreadable.pid) ? [unreadable.pid] : [],
  }));
  const result = await f.journal.sweep();
  expect(kill.mock.calls).toEqual([
    [parent.pid, 'SIGKILL'],
    [late.pid, 'SIGKILL'],
  ]);
  expect(result.status).toBe('incomplete');
  expect(result.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pid: parent.pid, status: 'reaped' }),
      expect.objectContaining({ pid: late.pid, status: 'reaped' }),
      expect.objectContaining({ pid: unreadable.pid, status: 'abstained' }),
    ]),
  );
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    expect(sql.prepare('SELECT life FROM command_lives').all()).toContainEqual({
      life: f.token,
    });
  } finally {
    sql.close();
  }
});

it('records unchanged unreadable ownership once while continuing late-fork cleanup', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const late = { pid: 4243, pgid: 4242, startTime: 'late' };
  const unreadable = { pid: 4244, pgid: 7000, startTime: 'unrelated' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  // Each successful cleanup forces another discovery snapshot. The unchanged
  // obstacle remains incomplete evidence, but represents only one uncertainty.
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length === 0 ? [parent] : [late, unreadable],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids
        .filter((pid) => pid === parent.pid || pid === late.pid)
        .map((pid) => [pid, f.token]),
    ),
    unreadable: pids.includes(unreadable.pid) ? [unreadable.pid] : [],
  }));
  const result = await f.journal.sweep();
  expect(kill.mock.calls).toEqual([
    [parent.pid, 'SIGKILL'],
    [late.pid, 'SIGKILL'],
  ]);
  expect(result.status).toBe('incomplete');
  expect(
    result.outcomes.filter(
      (outcome) =>
        outcome.pid === unreadable.pid && outcome.status === 'abstained',
    ),
  ).toHaveLength(1);
});

it('retains a reaped parent group across 100 journal reopens until its unmarked survivor is gone', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const child = { pid: 4243, pgid: 4242, startTime: 'unmarked-child' };
  let present = true;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  // The unmarked child first appears after the marked parent is confirmed
  // terminal. No persisted numeric hint can grant authority over that child.
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length === 0 ? [parent] : present ? [child] : [],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: pids.includes(parent.pid)
      ? new Map([[parent.pid, f.token]])
      : new Map(),
  }));
  const first = await f.journal.sweep();
  expect(first.outcomes).toContainEqual(
    expect.objectContaining({ pid: parent.pid, status: 'reaped' }),
  );
  f.journal.close();
  journals.splice(journals.indexOf(f.journal), 1);
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    for (let cycle = 0; cycle < 100; cycle++) {
      const reopened = CommandProcessJournal.open(f.db, path.dirname(f.db));
      try {
        const result = await reopened.sweep();
        expect(result.outcomes).toContainEqual(
          expect.objectContaining({
            life: f.token,
            pid: child.pid,
            status: 'abstained',
            reason: expect.stringMatching(/group continuity is unconfirmed/),
          }),
        );
        expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
          { life: f.token },
        ]);
        expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
          { pid: parent.pid },
        ]);
        expect(sql.prepare('SELECT id FROM restart_sweeps').all()).toHaveLength(
          Math.min(20, cycle + 2),
        );
        expect(kill).toHaveBeenCalledExactlyOnceWith(parent.pid, 'SIGKILL');
      } finally {
        reopened.close();
      }
    }
    present = false;
    const reopened = CommandProcessJournal.open(f.db, path.dirname(f.db));
    try {
      await reopened.sweep();
      expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([]);
      expect(kill).toHaveBeenCalledExactlyOnceWith(parent.pid, 'SIGKILL');
    } finally {
      reopened.close();
    }
  } finally {
    sql.close();
  }
});

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

it('identifies unrelated unreadable marks without attributing a readable detached escape', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const escape = { pid: 4243, pgid: 7000, startTime: 'escape' };
  const unreadable = { pid: 4244, pgid: 8000, startTime: 'unreadable' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [parent, escape, unreadable],
  });
  let checkedPendingReceipt = false;
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => {
    if (pids.length === 1 && pids[0] === parent.pid) {
      const sql = new Database(`${f.db}.commands.sqlite`);
      try {
        const row = sql
          .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
          .get();
        if (
          typeof row !== 'object' ||
          row === null ||
          !('result' in row) ||
          typeof row.result !== 'string'
        )
          throw new Error('Missing durable running receipt');
        expect(JSON.parse(row.result).outcomes).toContainEqual(
          expect.objectContaining({ pid: unreadable.pid, status: 'abstained' }),
        );
        checkedPendingReceipt = true;
      } finally {
        sql.close();
      }
    }
    return {
      supported: true,
      marks: pids.includes(parent.pid)
        ? new Map([[parent.pid, f.token]])
        : new Map(),
      unreadable: pids.includes(unreadable.pid) ? [unreadable.pid] : [],
    };
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(result.status).toBe('incomplete');
  expect(checkedPendingReceipt).toBe(true);
  expect(kill).toHaveBeenCalledExactlyOnceWith(parent.pid, 'SIGKILL');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: parent.pid,
      status: 'reaped',
    }),
  );
  const abstentions = result.outcomes.filter(
    (outcome) => outcome.status === 'abstained',
  );
  expect(abstentions.length).toBeGreaterThan(0);
  expect(abstentions.every((outcome) => outcome.pid === unreadable.pid)).toBe(
    true,
  );
  expect(result.outcomes.some((outcome) => outcome.pid === escape.pid)).toBe(
    false,
  );
});

it('does not reclassify a confirmed reap as unreadable discovery in a later snapshot', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [parent],
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks:
      kill.mock.calls.length === 0 && pids.includes(parent.pid)
        ? new Map([[parent.pid, f.token]])
        : new Map(),
    unreadable:
      kill.mock.calls.length > 0 && pids.includes(parent.pid)
        ? [parent.pid]
        : [],
  }));
  const result = await f.journal.sweep();
  expect(result.status).toBe('complete');
  expect(result.outcomes).toEqual([
    expect.objectContaining({ pid: parent.pid, status: 'reaped' }),
  ]);
  expect(kill).toHaveBeenCalledExactlyOnceWith(parent.pid, 'SIGKILL');
});

it('still records unreadable discovery when a reaped PID has a different incarnation', async () => {
  const f = await fixture();
  const parent = { pid: 4242, pgid: 4242, startTime: 'parent' };
  const replacement = { ...parent, startTime: 'replacement' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: [kill.mock.calls.length === 0 ? parent : replacement],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks:
      kill.mock.calls.length === 0 && pids.includes(parent.pid)
        ? new Map([[parent.pid, f.token]])
        : new Map(),
    unreadable:
      kill.mock.calls.length > 0 && pids.includes(parent.pid)
        ? [parent.pid]
        : [],
  }));
  const result = await f.journal.sweep();
  expect(result.status).toBe('incomplete');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: replacement.pid,
      status: 'abstained',
      reason:
        'Same-user ownership mark could not be read; command attribution is unknown',
    }),
  );
  expect(kill).toHaveBeenCalledExactlyOnceWith(parent.pid, 'SIGKILL');
});

it('reconciles a zombie owner and does not protect it as a live group anchor', async () => {
  const f = await fixture();
  const owner = { pid: 99, pgid: 99, startTime: 'dead-owner' };
  const child = { pid: 4242, pgid: 99, startTime: 'survivor' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [owner, child],
  });
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[owner.pid, f.token]]),
  });
  vi.mocked(readCommandTerminal).mockResolvedValue('terminated');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(result.outcomes.some((o) => o.status === 'owner-alive')).toBe(false);
  expect(kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({ pid: child.pid, status: 'reaped' }),
  );
});

it('withholds cleanup when the matching owner terminal state is unavailable', async () => {
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
  vi.mocked(readCommandTerminal).mockResolvedValue('unavailable');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: 99,
      status: 'abstained',
      reason: expect.stringMatching(/terminal state/),
    }),
  );
  expect(result.outcomes.some((o) => o.status === 'owner-alive')).toBe(false);
});

it('does not repeat discovery when every candidate lacks readable ownership', async () => {
  const f = await fixture();
  const pids = Array.from({ length: 100 }, (_, i) => 4242 + i);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: pids.map((pid) => ({ pid, pgid: pid, startTime: 'unproven' })),
  });
  vi.mocked(readCommandMarks)
    .mockClear()
    .mockResolvedValue({ supported: true, marks: new Map(), unreadable: pids });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.status).toBe('incomplete');
  for (const pid of pids)
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ pid, status: 'abstained' }),
    );
  expect(readCommandMarks).toHaveBeenCalledTimes(1);
  expect(result.outcomes).toHaveLength(pids.length);
});
