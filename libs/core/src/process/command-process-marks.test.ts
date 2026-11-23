/** Ownership evidence distinguishes inherited environment from ordinary diagnostic argv. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import {
  readCommandMarks,
  readDarwinCommandTerminals,
} from './command-process-marks.js';
import { readDarwinCommandMarks } from './darwin-command-marks.js';
import { readProcessTable } from './process-table.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./process-table.js', () => ({ readProcessTable: vi.fn() }));
vi.mock('./darwin-command-marks.js', () => ({
  readDarwinCommandMarks: vi.fn(),
  withDarwinCommandMarkReader: (operation: () => Promise<unknown>) =>
    operation(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
const directories: string[] = [];
const journals: CommandProcessJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** System ps still contains nonce-shaped diagnostic argv, independent of kernel envp. */
function darwinQueries(pids: readonly number[], nonce: string): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.mocked(readDarwinCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map(),
    unreadable: [],
  });
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (typeof callback !== 'function' || !Array.isArray(args))
      throw new Error('Unexpected system query');
    const output = args.includes('kern.boottime')
      ? 'boot\n'
      : args.includes('pid=,stat=,lstart=')
        ? pids.map((pid) => `${pid} Z survivor`).join('\n')
        : args.includes('stat=,lstart=')
          ? 'Z survivor\n'
          : pids
              .map(
                (pid) =>
                  `${pid} node diagnostic AGENTMONITORS_COMMAND_LIFE=${nonce}`,
              )
              .join('\n');
    callback(null, output, '');
    return Object.create(null);
  });
}

/** Durable numeric suspicion requires an abstention even when readable envp contains no mark. */
async function previousLife(pids: readonly number[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-marks-'));
  directories.push(dir);
  const db = path.join(dir, 'db');
  const journal = CommandProcessJournal.open(db, dir);
  journals.push(journal);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [{ pid: process.pid, pgid: process.pid, startTime: 'owner' }],
  });
  darwinQueries(pids, '');
  const nonce = (await journal.environment()).AGENTMONITORS_COMMAND_LIFE ?? '';
  for (const pid of pids) journal.spawned(pid);
  const sql = new Database(`${db}.commands.sqlite`);
  sql
    .prepare('UPDATE command_lives SET owner = ?')
    .run(JSON.stringify({ pid: 99, pgid: 99, startTime: 'dead' }));
  sql.close();
  const next = CommandProcessJournal.open(db, dir);
  journals.push(next);
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: pids.map((pid) => ({ pid, pgid: pid, startTime: 'survivor' })),
  });
  darwinQueries(pids, nonce);
  return { journal: next, nonce };
}

it('never signals argv-only nonce text and records an abstention', async () => {
  const { journal } = await previousLife([4242]);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: 4242,
      status: 'abstained',
      reason: expect.stringMatching(/mark|environment/),
    }),
  );
});

it('reaps an inherited environment mark through the existing identity gate', async () => {
  const { journal, nonce } = await previousLife([4242]);
  vi.mocked(readDarwinCommandMarks).mockResolvedValue({
    supported: true,
    marks: new Map([[4242, nonce]]),
    unreadable: [],
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await journal.sweep();
  expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGKILL');
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({ pid: 4242, status: 'reaped' }),
  );
});

it.each(['reader unavailable', 'process unreadable'] as const)(
  'records a reason and withholds signals when %s',
  async (scenario) => {
    const { journal } = await previousLife([4242]);
    vi.mocked(readDarwinCommandMarks).mockResolvedValue(
      scenario === 'reader unavailable'
        ? { supported: false, reason: 'macOS environment reader unavailable' }
        : {
            supported: true,
            marks: new Map(),
            unreadable: [4242],
            unreadableReason: 'macOS process environment unreadable',
          },
    );
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = await journal.sweep();
    expect(result.status).toBe('incomplete');
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({
        status: 'abstained',
        reason: expect.stringMatching(/unavailable|unreadable/),
      }),
    );
    if (scenario === 'process unreadable')
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: 4242 }),
      );
    expect(kill).not.toHaveBeenCalled();
  },
);

it('passes only requested identifiers in one batch, including large discovery sets', async () => {
  darwinQueries([], '');
  const pids = Array.from({ length: 4097 }, (_, i) => 4242 + i);
  await readCommandMarks(pids);
  expect(readDarwinCommandMarks).toHaveBeenCalledExactlyOnceWith(pids);
  expect(execFile).not.toHaveBeenCalled();
});

it('needs no helper for an empty PID set', async () => {
  darwinQueries([], '');
  vi.mocked(readDarwinCommandMarks).mockClear();
  expect(await readCommandMarks([])).toEqual({
    supported: true,
    marks: new Map(),
  });
  expect(readDarwinCommandMarks).not.toHaveBeenCalled();
});

it('checks all macOS signal candidates in one batch before any signal', async () => {
  const { journal, nonce } = await previousLife([4242, 4243]);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readDarwinCommandMarks).mockImplementation(async (pids) => {
    expect(kill).not.toHaveBeenCalled();
    return {
      supported: true,
      marks: new Map(pids.map((pid) => [pid, nonce])),
      unreadable: [],
    };
  });
  await journal.sweep();
  expect(kill).toHaveBeenCalledTimes(2);
  // Discovery, final ownership verification, then post-signal discovery.
  expect(vi.mocked(readDarwinCommandMarks).mock.calls.slice(0, 2)).toEqual([
    [[4242, 4243]],
    [[4242, 4243]],
  ]);
});

it.each(['mark', 'boot', 'start-time'] as const)(
  'withholds a macOS batch signal when fresh %s evidence disagrees',
  async (gate) => {
    const { journal, nonce } = await previousLife([4242, 4243]);
    let reads = 0;
    vi.mocked(readDarwinCommandMarks).mockImplementation(async (pids) => {
      reads++;
      if (reads === 2 && gate === 'start-time')
        vi.mocked(readProcessTable).mockResolvedValue({
          supported: true,
          processes: [
            { pid: 4242, pgid: 4242, startTime: 'reused' },
            { pid: 4243, pgid: 4243, startTime: 'survivor' },
          ],
        });
      return {
        supported: true,
        marks: new Map(
          pids
            .filter((pid) => !(reads === 2 && gate === 'mark' && pid === 4242))
            .map((pid) => [pid, nonce]),
        ),
        unreadable: [],
      };
    });
    if (gate === 'boot') {
      let bootReads = 0;
      vi.mocked(execFile).mockImplementation(
        (_file, args, _options, callback) => {
          if (typeof callback !== 'function' || !Array.isArray(args))
            throw new Error('Unexpected query');
          callback(
            null,
            args.includes('kern.boottime')
              ? ++bootReads === 1
                ? 'boot\n'
                : 'changed\n'
              : '4243 Z survivor\n',
            '',
          );
          return Object.create(null);
        },
      );
    }
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = await journal.sweep();
    expect(kill.mock.calls.some(([pid]) => pid === 4242)).toBe(false);
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ pid: 4242, status: 'abstained' }),
    );
    if (gate !== 'boot') expect(kill).toHaveBeenCalledWith(4243, 'SIGKILL');
  },
);

it('confirms macOS batch reaps only with terminal or absent incarnation evidence', async () => {
  darwinQueries([], '');
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    if (typeof callback !== 'function')
      throw new Error('Missing query callback');
    expect(readProcessTable).toHaveBeenCalled();
    callback(
      null,
      '4242 Z survivor\n4243 S survivor\n4244 S replacement\n',
      '',
    );
    return Object.create(null);
  });
  vi.mocked(readProcessTable).mockResolvedValue({
    supported: true,
    processes: [4242, 4243, 4244, 4246].map((pid) => ({
      pid,
      pgid: pid,
      startTime: 'survivor',
    })),
  });
  const records = [4242, 4243, 4244, 4245, 4246].map((pid) => ({
    pid,
    pgid: pid,
    startTime: 'survivor',
  }));
  expect(await readDarwinCommandTerminals(records)).toEqual(
    new Map([
      [4242, 'terminated'],
      [4243, 'running'],
      [4244, 'terminated'],
      [4245, 'terminated'],
      [4246, 'unavailable'],
    ]),
  );
  expect(execFile).toHaveBeenCalledTimes(1);
});
