/** Restricted members never borrow a sibling's proof, including at the last signal gate. */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import {
  readBootIdentity,
  readCommandMarks,
  readCommandTerminal,
  readDarwinCommandTerminals,
} from './command-process-marks.js';
import { readProcessTable } from './process-table.js';
vi.mock('./process-table.js', () => ({ readProcessTable: vi.fn() }));
vi.mock('./command-process-marks.js', () => ({
  COMMAND_LIFE_ENV: 'AGENTMONITORS_COMMAND_LIFE',
  readBootIdentity: vi.fn(),
  readCommandMarks: vi.fn(),
  readCommandTerminal: vi.fn(),
  readDarwinCommandTerminals: vi.fn(),
}));
// Resolve SQLite for the real host before simulating Darwin process semantics.
const nativeBinding = new Database(':memory:');
nativeBinding.close();
/** Private vnode admission uses POSIX uid/mode and directory-sync semantics. */
const itPosix = it.skipIf(process.platform === 'win32');
const journals: CommandProcessJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  vi.restoreAllMocks();
});

/** Fake identities and intercepted signals keep safety assertions independent of host work. */
async function fixture() {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const root = mkdtempSync(path.join(tmpdir(), 'am-vgate-'));
  const db = path.join(root, 'db');
  vi.mocked(readBootIdentity).mockResolvedValue('boot');
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [{ pid: process.pid, pgid: process.pid, startTime: 'owner' }],
  });
  vi.mocked(readCommandTerminal).mockResolvedValue('terminated');
  vi.mocked(readDarwinCommandTerminals).mockImplementation(
    async (records) =>
      new Map(records.map((record) => [record.pid, 'terminated'])),
  );
  const first = CommandProcessJournal.open(db, root);
  journals.push(first);
  const env = await first.environment();
  first.spawned(4242);
  const sql = new Database(`${db}.commands.sqlite`);
  sql
    .prepare('UPDATE command_lives SET owner=?')
    .run(JSON.stringify({ pid: 99, pgid: 99, startTime: 'dead' }));
  sql.close();
  const next = CommandProcessJournal.open(db, root);
  journals.push(next);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const records = [4242, 4243, 4244].map((pid) => ({
    pid,
    pgid: 4242,
    startTime: `fixture-${pid}`,
  }));
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: records,
  });
  return {
    journal: next,
    admission: first,
    db,
    kill,
    life: env.AGENTMONITORS_COMMAND_LIFE ?? '',
  };
}

itPosix(
  'never signals an unrelated same-group shell or an argv-only mark without its own proof',
  async () => {
    const f = await fixture();
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(pids.includes(4242) ? [[4242, f.life]] : []),
      vnodes: new Set(pids.includes(4242) ? [4242] : []),
      unreadable: pids.filter((pid) => pid !== 4242),
      unreadableReasons: new Map([
        [4243, 'unrelated shell: no matching inherited vnode'],
        [4244, 'argv-only mark: no matching inherited vnode'],
      ]),
    }));
    const result = await f.journal.sweep();
    expect(f.kill.mock.calls).toEqual([[4242, 'SIGKILL']]);
    for (const pid of [4243, 4244])
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({
          pid,
          status: 'abstained',
          reason: expect.stringMatching(/no matching inherited vnode/),
        }),
      );
  },
);

itPosix(
  're-reads the candidate own vnode at signal time and records a vanished proof as abstention',
  async () => {
    const f = await fixture();
    let reads = 0;
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => {
      reads++;
      return {
        supported: true,
        marks: new Map(reads === 1 ? [[4242, f.life]] : []),
        vnodes: new Set(reads === 1 ? [4242] : []),
        unreadable: pids.filter((pid) => reads > 1 || pid !== 4242),
        unreadableReasons: new Map([
          [4242, 'macOS vnode descriptor enumeration unavailable'],
        ]),
      };
    });
    const result = await f.journal.sweep();
    expect(reads).toBeGreaterThan(1);
    expect(f.kill).not.toHaveBeenCalled();
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({
        pid: 4242,
        status: 'abstained',
        reason: expect.stringMatching(
          /vnode descriptor enumeration unavailable/,
        ),
      }),
    );
  },
);

/** No pending attribution or occupied suspicion may remain when the tuple retires. */
itPosix(
  'retires the exact token only after a later readable vacant snapshot discharges its life',
  async () => {
    const f = await fixture();
    const token = f.admission.lifeToken();
    if (!token) throw new Error('Missing committed fixture token');
    expect(existsSync(token.path)).toBe(true);
    vi.mocked(readProcessTable).mockResolvedValue({
      supported: true,
      processes: [],
    });
    vi.mocked(readCommandMarks).mockResolvedValue({
      supported: true,
      marks: new Map(),
    });
    await f.journal.sweep();
    const sql = new Database(`${f.db}.commands.sqlite`);
    try {
      expect(
        sql.prepare('SELECT COUNT(*) AS n FROM command_lives').get(),
      ).toEqual({ n: 0 });
    } finally {
      sql.close();
    }
    expect(existsSync(token.path)).toBe(false);
    expect(f.kill).not.toHaveBeenCalled();
  },
);

/** Vnode proof extends only its holder's authority, never the existing envp anchor path. */
itPosix(
  'does not let a vnode holder authorize a readable unmarked sibling through group continuity',
  async () => {
    const f = await fixture();
    vi.mocked(readCommandMarks).mockImplementation(async (pids) => ({
      supported: true,
      marks: new Map(pids.includes(4242) ? [[4242, f.life]] : []),
      vnodes: new Set(pids.includes(4242) ? [4242] : []),
      unreadable: [],
    }));
    const result = await f.journal.sweep();
    expect(f.kill.mock.calls).toEqual([[4242, 'SIGKILL']]);
    for (const pid of [4243, 4244])
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid, status: 'abstained' }),
      );
  },
);
