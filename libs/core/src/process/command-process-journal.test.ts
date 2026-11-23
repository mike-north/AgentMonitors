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
  readDarwinCommandTerminals: vi.fn(async () => new Map()),
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

// The readable companion represents the independent watchdog. Enumeration order
// must not let it lose its deadline before another member's uncertainty is known.
for (const obstacle of [
  'discovery-unreadable',
  'signal-unreadable',
  'identity',
  'unsupported',
  'table-unavailable',
  'watchdog-mark',
  'new-member',
  'group-change',
  'group-change-single-anchor',
  'verified',
] as const) {
  it(`preserves the group bound unless every member is verified (${obstacle})`, async () => {
    const f = await fixture();
    const command = { pid: 4242, pgid: 4242, startTime: 'command' };
    const watchdog = { pid: 4243, pgid: 4242, startTime: 'watchdog' };
    const otherBound = { pid: 5001, pgid: 5000, startTime: 'other-bound' };
    let markReads = 0;
    let tableReads = 0;
    const groupChange =
      obstacle === 'group-change' || obstacle === 'group-change-single-anchor';
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(readProcessTable).mockImplementation(async () => {
      tableReads++;
      if (obstacle === 'table-unavailable' && markReads > 1) {
        return {
          supported: false,
          reason: 'injected identity reader unavailable',
        };
      }
      return {
        supported: true,
        processes: [
          watchdog,
          obstacle === 'identity' && markReads > 1
            ? { ...command, startTime: 'replacement' }
            : groupChange && tableReads > 2
              ? { ...command, pgid: otherBound.pgid, startTime: 'replacement' }
              : command,
          ...(groupChange ? [otherBound] : []),
          ...(obstacle === 'new-member' && markReads > 1
            ? [{ pid: 4244, pgid: 4242, startTime: 'late' }]
            : []),
        ],
      };
    });
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => {
      markReads++;
      if (obstacle === 'unsupported' && markReads > 1) {
        return { supported: false, reason: 'injected reader unavailable' };
      }
      const unreadable =
        obstacle === 'discovery-unreadable' ||
        (obstacle === 'signal-unreadable' && markReads > 1);
      return {
        supported: true,
        watchdogs: new Set(
          [4243, 5001].filter(
            (pid) =>
              !(
                obstacle === 'watchdog-mark' &&
                markReads > 1 &&
                pid === watchdog.pid
              ),
          ),
        ),
        marks: new Map(
          pids
            .filter(
              (pid) =>
                (!unreadable || pid !== command.pid) &&
                !(
                  obstacle === 'group-change-single-anchor' &&
                  pid === command.pid
                ) &&
                !(
                  obstacle === 'watchdog-mark' &&
                  markReads > 1 &&
                  pid === watchdog.pid
                ),
            )
            .map((pid) => [pid, f.token]),
        ),
        ...(unreadable
          ? { unreadable: [command.pid] }
          : obstacle === 'watchdog-mark' && markReads > 1
            ? { unreadable: [watchdog.pid] }
            : {}),
      };
    });
    const result = await f.journal.sweep();
    if (obstacle === 'verified') {
      expect(kill.mock.calls).toEqual(
        expect.arrayContaining([
          [command.pid, 'SIGKILL'],
          [watchdog.pid, 'SIGKILL'],
        ]),
      );
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: watchdog.pid, status: 'reaped' }),
      );
    } else {
      expect(kill.mock.calls).toEqual([]);
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({
          pid: watchdog.pid,
          status: 'abstained',
          reason: expect.stringMatching(
            /group.*bound.*(unreadable|identity|unavailable)/i,
          ),
        }),
      );
    }
    if (groupChange) {
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({
          pid: otherBound.pid,
          status: 'abstained',
          reason: expect.stringMatching(/group.*bound.*identity/i),
        }),
      );
    }
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
    } finally {
      sql.close();
    }
  });
}

it('keeps a group veto when later discovery first finds its watchdog', async () => {
  const f = await fixture();
  const command = { pid: 4242, pgid: 4242, startTime: 'command' };
  const watchdog = { pid: 4243, pgid: 4242, startTime: 'watchdog' };
  const other = { pid: 5000, pgid: 5000, startTime: 'other-command' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes:
      kill.mock.calls.length === 0 ? [command, other] : [command, watchdog],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    watchdogs: new Set([4243]),
    marks: new Map(
      pids
        .filter((pid) => pid !== command.pid || kill.mock.calls.length > 0)
        .map((pid) => [pid, f.token]),
    ),
    ...(kill.mock.calls.length === 0 ? { unreadable: [command.pid] } : {}),
  }));
  const result = await f.journal.sweep();
  expect(kill.mock.calls).toEqual([[other.pid, 'SIGKILL']]);
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: watchdog.pid,
      status: 'abstained',
      reason: expect.stringMatching(/group.*bound.*unreadable/i),
    }),
  );
});

it('keeps a sole marked watchdog when the final table reveals another member', async () => {
  const f = await fixture();
  const watchdog = { pid: 4243, pgid: 4242, startTime: 'watchdog' };
  const late = { pid: 4244, pgid: 4242, startTime: 'late-command' };
  let reads = 0;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: ++reads <= 2 ? [watchdog] : [watchdog, late],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    watchdogs: new Set([4243]),
    marks: new Map(
      pids.filter((pid) => pid === watchdog.pid).map((pid) => [pid, f.token]),
    ),
    ...(pids.includes(late.pid) ? { unreadable: [late.pid] } : {}),
  }));
  const result = await f.journal.sweep();
  expect(kill.mock.calls).toEqual([]);
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: watchdog.pid,
      status: 'abstained',
      reason: expect.stringMatching(/group.*bound.*identity/i),
    }),
  );
});

it('keeps a sole marked watchdog when a reaped member PID is reused', async () => {
  const f = await fixture();
  const command = { pid: 4242, pgid: 4242, startTime: 'command' };
  const watchdog = { pid: 4243, pgid: 4242, startTime: 'watchdog' };
  let reads = 0;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: [
      ++reads < 4 ? command : { ...command, startTime: 'replacement' },
      watchdog,
    ],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    watchdogs: new Set([4243]),
    marks: new Map(
      pids.filter((pid) => pid === watchdog.pid).map((pid) => [pid, f.token]),
    ),
  }));
  const result = await f.journal.sweep();
  expect(kill.mock.calls).toEqual([[command.pid, 'SIGKILL']]);
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: watchdog.pid,
      status: 'abstained',
      reason: expect.stringMatching(/group.*bound.*identity/i),
    }),
  );
});

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

/** A final discovery is still durable attribution even without another confirmation pass. */
it('retains the ninth marked group across restart after eight disappearing generations', async () => {
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
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    const first = await f.journal.sweep();
    expect(reads).toBe(17);
    expect(first.status).toBe('incomplete');
    expect(first.outcomes).toContainEqual(
      expect.objectContaining({ pid: 4250, status: 'abstained' }),
    );
    expect(
      sql.prepare('SELECT pid FROM command_pids WHERE pid = 4250').all(),
    ).toEqual([{ pid: 4250 }]);
    // The last marked anchor exits before restart, leaving only its unmarked child.
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [{ pid: 4251, pgid: 4250, startTime: 'unmarked-survivor' }],
    });
    vi.mocked(readCommandMarks).mockResolvedValue({
      supported: true,
      marks: new Map(),
    });
    const reopened = CommandProcessJournal.open(f.db, path.dirname(f.db));
    journals.push(reopened);
    const second = await reopened.sweep();
    expect(second.outcomes).toContainEqual(
      expect.objectContaining({ pid: 4251, status: 'abstained' }),
    );
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
      { life: f.token },
    ]);
    expect(kill).not.toHaveBeenCalled();
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    await reopened.sweep();
    expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
  } finally {
    sql.close();
  }
});

/** Pre-spawn admission leaves a nonce even if SIGKILL prevents direct-PID bookkeeping. */
it.each(['child', 'empty', 'unavailable', 'unreadable'] as const)(
  'confirms nonce-only absence beyond a missed fork snapshot (%s)',
  async (next) => {
    const f = await fixture();
    const sql = new Database(`${f.db}.commands.sqlite`);
    sql.prepare('DELETE FROM command_pids').run();
    const child = { pid: 5000, pgid: 5000, startTime: 'late-marked-child' };
    let reads = 0;
    vi.mocked(readProcessTable).mockImplementation(async () => {
      reads++;
      if (reads > 1 && next === 'unavailable')
        return { supported: false, reason: 'injected confirmation failure' };
      return {
        supported: true,
        processes: reads === 1 || next === 'empty' ? [] : [child],
      };
    });
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(next === 'child' ? pids.map((pid) => [pid, f.token]) : []),
      ...(next === 'unreadable' && reads > 1
        ? { unreadable: [child.pid] }
        : {}),
    }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const result = await f.journal.sweep();
      expect(reads).toBeGreaterThanOrEqual(2);
      if (next === 'empty') {
        expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([]);
      } else {
        expect(sql.prepare('SELECT life FROM command_lives').all()).toEqual([
          { life: f.token },
        ]);
        expect(result.outcomes).toContainEqual(
          expect.objectContaining(
            next === 'unavailable'
              ? { status: 'abstained', reason: 'injected confirmation failure' }
              : {
                  pid: child.pid,
                  status: next === 'child' ? 'reaped' : 'abstained',
                },
          ),
        );
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
      }
      expect(kill.mock.calls).toEqual(
        next === 'child' ? [[child.pid, 'SIGKILL']] : [],
      );
    } finally {
      sql.close();
    }
  },
);

/** Unrelated unreadability cannot certify that a vanished group's attribution is finished. */
it('keeps disappearance hints when fresh ownership is unreadable', async () => {
  const f = await fixture();
  let reads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes:
      ++reads === 1 ? [] : [{ pid: 9000, pgid: 9000, startTime: 'unreadable' }],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(),
    unreadable: [...pids],
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    await f.journal.sweep();
    expect(reads).toBe(2);
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: 4242 },
    ]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

/** A nonce anywhere keeps existing suspicions while a new anchor is still unconfirmed. */
it('keeps disappearance hints while a marked child vanishes at confirmation', async () => {
  const f = await fixture();
  const child = { pid: 5000, pgid: 5000, startTime: 'marked' };
  const survivor = { pid: 5001, pgid: 5000, startTime: 'unmarked' };
  const sql = new Database(`${f.db}.commands.sqlite`);
  let reads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => {
    reads++;
    if (reads === 3)
      expect(
        sql.prepare('SELECT pid FROM command_pids WHERE pid = 4242').all(),
      ).toEqual([{ pid: 4242 }]);
    return {
      supported: true,
      processes:
        reads === 1 || reads === 3 ? [] : reads === 2 ? [child] : [survivor],
    };
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids.filter((pid) => pid === child.pid).map((pid) => [pid, f.token]),
    ),
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
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

/** Anchor disappearance must already be in the receipt before rediscovery can block or crash. */
it('commits anchor disappearance before awaiting rediscovery', async () => {
  const f = await fixture();
  const anchor = { pid: 4242, pgid: 4242, startTime: 'anchor' };
  const sql = new Database(`${f.db}.commands.sqlite`);
  let reads = 0;
  vi.mocked(readProcessTable).mockImplementation(async () => {
    reads++;
    if (reads === 3) {
      const saved = JSON.parse(
        sql
          .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
          .pluck()
          .get(),
      );
      expect(saved.outcomes).toContainEqual(
        expect.objectContaining({ pid: anchor.pid, status: 'gone' }),
      );
    }
    return { supported: true, processes: reads === 1 ? [anchor] : [] };
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    await f.journal.sweep();
    expect(reads).toBe(3);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    sql.close();
  }
});

/** A reap retains its group until a later startup, even if this sweep sees an empty table. */
it('keeps a reaped group hint without pending disappearance', async () => {
  const f = await fixture();
  const anchor = { pid: 4242, pgid: 4242, startTime: 'anchor' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length === 0 ? [anchor] : [],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const sql = new Database(`${f.db}.commands.sqlite`);
  try {
    await f.journal.sweep();
    expect(kill).toHaveBeenCalledExactlyOnceWith(anchor.pid, 'SIGKILL');
    expect(sql.prepare('SELECT pid FROM command_pids').all()).toEqual([
      { pid: anchor.pgid },
    ]);
  } finally {
    sql.close();
  }
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

// An old admission (or a re-sessioned marked descendant) has no watchdog in its group.
it('reaps verified work in an uncertain group with no watchdog across restarts', async () => {
  const f = await fixture();
  const command = { pid: 4242, pgid: 4242, startTime: 'unbounded-command' };
  const hidden = { pid: 4243, pgid: 4242, startTime: 'unreadable-child' };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [command, hidden],
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids.filter((pid) => pid === command.pid).map((pid) => [pid, f.token]),
    ),
    ...(pids.includes(hidden.pid) ? { unreadable: [hidden.pid] } : {}),
  }));
  const first = await f.journal.sweep();
  const again = CommandProcessJournal.open(f.db, path.dirname(f.db));
  journals.push(again);
  const second = await again.sweep();
  console.log(
    'NO_WATCHDOG',
    JSON.stringify({ calls: kill.mock.calls, first, second }),
  );
  expect(kill.mock.calls).toContainEqual([command.pid, 'SIGKILL']);
});

it('reaps late forks even while previously reaped identities remain visible', async () => {
  const f = await fixture();
  const original = [
    { pid: 4242, pgid: 4242, startTime: 'command' },
    { pid: 4243, pgid: 4242, startTime: 'watchdog' },
  ];
  const late = [
    { pid: 4244, pgid: 4242, startTime: 'late-a' },
    { pid: 4245, pgid: 4242, startTime: 'late-b' },
  ];
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length < 2 ? original : [...original, ...late],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const result = await f.journal.sweep();
  console.log(
    'LATE_FORKS',
    JSON.stringify({ calls: kill.mock.calls, outcomes: result.outcomes }),
  );
  expect(kill.mock.calls).toEqual(
    expect.arrayContaining(
      [...original, ...late].map((p) => [p.pid, 'SIGKILL']),
    ),
  );
});

it('reaps a late watchdog alongside forks despite known terminal rows', async () => {
  const f = await fixture();
  const original = [
    { pid: 4242, pgid: 4242, startTime: 'command' },
    { pid: 4243, pgid: 4242, startTime: 'watchdog' },
  ];
  const late = [
    { pid: 4244, pgid: 4242, startTime: 'late-a' },
    { pid: 4245, pgid: 4242, startTime: 'late-b' },
  ];
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockImplementation(async () => ({
    supported: true,
    processes: kill.mock.calls.length < 2 ? original : [...original, ...late],
  }));
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
    watchdogs: new Set([4243, 4245]),
  }));
  const result = await f.journal.sweep();
  console.log(
    'LATE_FORKS',
    JSON.stringify({ calls: kill.mock.calls, outcomes: result.outcomes }),
  );
  expect(kill.mock.calls).toEqual(
    expect.arrayContaining(
      [...original, ...late].map((p) => [p.pid, 'SIGKILL']),
    ),
  );
});

it('bounds terminal scan descriptors during a many-candidate Linux sweep', async () => {
  const f = await fixture();
  const records = Array.from({ length: 64 }, (_, i) => ({
    pid: 4242 + i,
    pgid: 4242,
    startTime: `member-${i}`,
  }));
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(pids.map((pid) => [pid, f.token])),
  }));
  const actual =
    await vi.importActual<typeof import('./process-table.js')>(
      './process-table.js',
    );
  let active = 0,
    peak = 0,
    failures = 0;
  vi.mocked(readCommandTerminal).mockImplementation(async () => {
    const reading = await actual.readLinuxProcessTable({
      readdir: async () => Array.from({ length: 64 }, (_, i) => String(i + 1)),
      open: async () => {
        if (active >= 256) {
          failures++;
          throw Object.assign(new Error('injected descriptor cap'), {
            code: 'EMFILE',
          });
        }
        active++;
        peak = Math.max(peak, active);
        return {
          read: async (buffer, position) => {
            await new Promise((resolve) => setImmediate(resolve));
            if (position > 0) return 0;
            const bytes = Buffer.from(
              '1 (fixture) Z 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1\n',
            );
            buffer.set(bytes);
            return bytes.length;
          },
          close: async () => {
            active--;
          },
        };
      },
    });
    return reading.supported ? 'terminated' : 'unavailable';
  });
  const result = await f.journal.sweep();
  const failed = result.outcomes.filter((o) => o.status === 'failed').length;
  console.log('TERMINAL_FDS', JSON.stringify({ peak, failures, failed }));
  expect(failed).toBe(0);
  expect(peak).toBeLessThanOrEqual(32);
  expect(failures).toBe(0);
});

it('batches durable receipts for a large vetoed macOS group', async () => {
  const f = await fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const records = Array.from({ length: 8000 }, (_, i) => ({
    pid: 4242 + i,
    pgid: 4242,
    startTime: `member-${i}`,
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids.filter((pid) => pid !== 4242).map((pid) => [pid, f.token]),
    ),
    watchdogs: new Set([4243]),
    ...(pids.includes(4242) ? { unreadable: [4242] } : {}),
  }));
  const prepare = Database.prototype.prepare;
  let saves = 0;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    if (sql === 'UPDATE restart_sweeps SET result = ? WHERE id = ?') saves++;
    return prepare.call(this, sql);
  });
  const start = performance.now();
  const result = await f.journal.sweep();
  const elapsed = performance.now() - start;
  console.log('VETO_RECEIPTS', JSON.stringify({ saves, elapsed }));
  expect(saves).toBeLessThan(20);
  expect(kill).not.toHaveBeenCalled();
  expect(
    result.outcomes.filter((outcome) => outcome.status === 'abstained').length,
  ).toBeGreaterThanOrEqual(8000);
}, 30000);

/** Roles may only retain a bound; every permitted signal still needs its own evidence. */
it.each([0, 1, 2])(
  'preserves only verified watchdog groups (%i watchdog roles)',
  async (count) => {
    const f = await fixture();
    const records = [4242, 4243, 4244, 4245].map((pid) => ({
      pid,
      pgid: 4242,
      startTime: `member-${pid}`,
    }));
    const watchdogs = new Set([4243, 4244].slice(0, count));
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: records,
    });
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(
        pids.filter((pid) => pid !== 4245).map((pid) => [pid, f.token]),
      ),
      watchdogs,
      unreadable: pids.includes(4245) ? [4245] : [],
    }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = await f.journal.sweep();
    if (count === 0) {
      expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
      expect(
        result.outcomes.some((o) => o.reason?.includes('Preserved group')),
      ).toBe(false);
    } else {
      expect(kill).not.toHaveBeenCalled();
      for (const pid of watchdogs)
        expect(result.outcomes).toContainEqual(
          expect.objectContaining({
            pid,
            status: 'abstained',
            reason: expect.stringMatching(/bound/),
          }),
        );
    }
  },
);

it('does not accept an unrelated life with a forged watchdog role as a bound', async () => {
  const f = await fixture();
  const records = [4242, 4243, 4244].map((pid) => ({
    pid,
    pgid: 4242,
    startTime: String(pid),
  }));
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids
        .filter((pid) => pid !== 4244)
        .map((pid) => [pid, pid === 4243 ? 'another-life' : f.token]),
    ),
    watchdogs: new Set([4243]),
    unreadable: pids.includes(4244) ? [4244] : [],
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
});

it('cleans a re-sessioned marked descendant without borrowing its former watchdog', async () => {
  const f = await fixture();
  const records = [
    { pid: 4242, pgid: 4242, startTime: 'watchdog' },
    { pid: 5000, pgid: 5000, startTime: 'escape' },
    { pid: 5001, pgid: 5000, startTime: 'hidden' },
  ];
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids.filter((pid) => pid !== 5001).map((pid) => [pid, f.token]),
    ),
    watchdogs: new Set([4242]),
    unreadable: pids.includes(5001) ? [5001] : [],
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL');
});

it('an authored watchdog role only withholds signals when a companion is unreadable', async () => {
  const f = await fixture();
  const authored = { pid: 4242, pgid: 4242, startTime: 'authored-role' };
  const hidden = { pid: 4243, pgid: 4242, startTime: 'unreadable' };
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [authored, hidden],
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids.filter((pid) => pid === authored.pid).map((pid) => [pid, f.token]),
    ),
    watchdogs: new Set([authored.pid]),
    unreadable: pids.includes(hidden.pid) ? [hidden.pid] : [],
  }));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await f.journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: authored.pid,
      status: 'abstained',
      reason: expect.stringMatching(/bound.*unreadable/),
    }),
  );
});

/** A role from an earlier snapshot cannot preserve a bound proven to have ended. */
it.each(['gone', 'recycled'] as const)(
  'reaps verified companions when the only watchdog is %s at the final gate',
  async (state) => {
    const f = await fixture();
    const command = { pid: 4242, pgid: 4242, startTime: 'command' };
    const watchdog = { pid: 4243, pgid: 4242, startTime: 'watchdog' };
    const hidden = { pid: 4244, pgid: 4242, startTime: 'hidden' };
    let finalMarks = false;
    vi.mocked(readProcessTable).mockImplementation(async () => ({
      supported: true,
      processes: [
        command,
        hidden,
        ...(!finalMarks
          ? [watchdog]
          : state === 'recycled'
            ? [{ ...watchdog, startTime: 'replacement' }]
            : []),
      ],
    }));
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => {
      if (pids.length === 1) finalMarks = true;
      return {
        supported: true,
        marks: new Map(
          pids.filter((pid) => pid !== hidden.pid).map((pid) => [pid, f.token]),
        ),
        watchdogs: new Set([watchdog.pid]),
        unreadable: pids.includes(hidden.pid) ? [hidden.pid] : [],
      };
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = await f.journal.sweep();
    expect(kill).toHaveBeenCalledWith(command.pid, 'SIGKILL');
    expect(kill).not.toHaveBeenCalledWith(watchdog.pid, 'SIGKILL');
    expect(
      result.outcomes.some((outcome) =>
        outcome.reason?.includes('Preserved group'),
      ),
    ).toBe(false);
  },
);

/** A decided preservation receipt must survive loss during unrelated terminal queries. */
it('commits final-gate preservation before awaiting another group terminal query', async () => {
  const f = await fixture();
  const records = [
    { pid: 4242, pgid: 4242, startTime: 'command' },
    { pid: 4243, pgid: 4242, startTime: 'watchdog' },
    { pid: 5000, pgid: 5000, startTime: 'independent' },
  ];
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids
        .filter((pid) => !(pids.length === 1 && pid === 4242))
        .map((pid) => [pid, f.token]),
    ),
    watchdogs: new Set([4243]),
    unreadable: pids.length === 1 && pids[0] === 4242 ? [4242] : [],
  }));
  vi.mocked(readCommandTerminal).mockImplementation(async (record) => {
    expect(record.pid).toBe(5000);
    expect(kill.mock.calls).toEqual([[5000, 'SIGKILL']]);
    const sql = new Database(`${f.db}.commands.sqlite`);
    const row = sql
      .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
      .get() as { result: string };
    sql.close();
    const saved = JSON.parse(row.result) as {
      outcomes: { pid?: number; status: string; reason?: string }[];
    };
    console.log('PRESERVATION_BEFORE_TERMINAL', JSON.stringify(saved));
    expect(saved.outcomes).toContainEqual(
      expect.objectContaining({
        pid: 4243,
        status: 'abstained',
        reason: expect.stringMatching(/bound.*unreadable/),
      }),
    );
    return 'terminated';
  });
  await f.journal.sweep();
});

/** Invalid stored identifiers are decided diagnostics before any anchor can be queried. */
it('commits invalid PID diagnostics before awaiting anchor confirmation', async () => {
  const f = await fixture();
  const sql = new Database(`${f.db}.commands.sqlite`);
  sql.prepare('UPDATE command_pids SET pid = -1').run();
  sql.close();
  const record = { pid: 4242, pgid: 4242, startTime: 'command' };
  let reads = 0;
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[record.pid, f.token]]),
  });
  vi.mocked(readProcessTable).mockImplementation(async () => {
    if (++reads === 2) {
      const reader = new Database(`${f.db}.commands.sqlite`);
      try {
        const row = reader
          .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
          .get() as { result: string };
        expect(JSON.parse(row.result)).toMatchObject({
          outcomes: expect.arrayContaining([
            expect.objectContaining({
              status: 'abstained',
              reason: 'Invalid durable command PID record',
            }),
          ]),
        });
      } finally {
        reader.close();
      }
    }
    return { supported: true, processes: [record] };
  });
  await f.journal.sweep();
  expect(reads).toBeGreaterThanOrEqual(2);
});

/** Blocking receipt I/O must not open an extra PID-reuse window in the final signal batch. */
it('keeps receipt I/O out of the final identity-to-signal interval', async () => {
  const f = await fixture();
  const records = [
    { pid: 4242, pgid: 4242, startTime: 'command' },
    { pid: 4243, pgid: 4242, startTime: 'watchdog' },
    { pid: 5000, pgid: 5000, startTime: 'independent' },
  ];
  let tables = 0;
  let signalled = false;
  let reusedBeforeSignal = false;
  vi.mocked(readProcessTable).mockImplementation(async () => {
    tables++;
    return { supported: true, processes: records };
  });
  vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
    supported: true,
    marks: new Map(
      pids
        .filter((pid) => !(pids.length === 1 && pid === 4242))
        .map((pid) => [pid, f.token]),
    ),
    watchdogs: new Set([4243]),
  }));
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    // A synchronous disk stall can let the kernel recycle an independent PID.
    // Model that external event at the newly introduced receipt-write boundary.
    if (
      sql === 'UPDATE restart_sweeps SET result = ? WHERE id = ?' &&
      tables >= 3 &&
      !signalled
    ) {
      reusedBeforeSignal = true;
    }
    return prepare.call(this, sql);
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    signalled = true;
    return true;
  });
  await f.journal.sweep();
  expect(kill).toHaveBeenCalledExactlyOnceWith(5000, 'SIGKILL');
  expect(reusedBeforeSignal).toBe(false);
});
