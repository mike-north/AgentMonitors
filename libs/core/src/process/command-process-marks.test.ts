/** Ownership evidence must distinguish inherited environment from ordinary diagnostic argv. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import { readCommandMarks } from './command-process-marks.js';
import { readProcessTable } from './process-table.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./process-table.js', () => ({ readProcessTable: vi.fn() }));

const directories: string[] = [];
const journals: CommandProcessJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Emulate macOS ps faithfully enough to preserve its argv/environment ambiguity. */
function darwinQueries(pids: readonly number[], nonce: string): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (typeof callback !== 'function' || !Array.isArray(args))
      throw new Error('Unexpected system query');
    const output = args.includes('kern.boottime')
      ? 'boot\n'
      : args.includes('pid=,uid=')
        ? pids.map((pid) => `${pid} ${process.getuid?.()}`).join('\n')
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

/** Keep the journal real while all candidate processes and signals are simulated. */
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
  return next;
}

it('never signals argv-only nonce text and records an abstention', async () => {
  const journal = await previousLife([4242]);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const result = await journal.sweep();
  expect(kill).not.toHaveBeenCalled();
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      pid: 4242,
      status: 'abstained',
      reason: expect.stringMatching(/environment|unproven/),
    }),
  );
});

it('startup with 100 survivors uses a bounded number of host-wide environment scans', async () => {
  const journal = await previousLife(
    Array.from({ length: 100 }, (_, i) => 4242 + i),
  );
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(execFile).mockClear();
  await journal.sweep();
  const hostEnvironmentScans = vi
    .mocked(execFile)
    .mock.calls.filter(
      (call) => call[1]?.includes('-A') && call[1]?.includes('eww'),
    );
  expect(hostEnvironmentScans.length).toBeLessThanOrEqual(2);
});

it('bounds macOS mark queries to the requested PIDs', async () => {
  darwinQueries([4242], '00000000-0000-4000-8000-000000000000');
  vi.mocked(execFile).mockClear();
  await readCommandMarks([4242]);
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    '/bin/ps',
    ['-p', '4242', '-o', 'pid=,uid='],
    expect.any(Object),
    expect.any(Function),
  );
  expect(
    vi.mocked(execFile).mock.calls.every((call) => !call[1]?.includes('-A')),
  ).toBe(true);
});

it('batches large discovery PID sets without one system query per small group', async () => {
  const pids = Array.from({ length: 4097 }, (_, i) => 4242 + i);
  darwinQueries(pids, '00000000-0000-4000-8000-000000000000');
  vi.mocked(execFile).mockClear();
  const result = await readCommandMarks(pids);
  expect(vi.mocked(execFile).mock.calls).toHaveLength(3);
  for (const call of vi.mocked(execFile).mock.calls) {
    const args = call[1];
    if (!Array.isArray(args) || typeof args[1] !== 'string')
      throw new Error('Missing PID list');
    expect(args[1].split(',').length).toBeLessThanOrEqual(2048);
  }
  expect(result.supported && result.unreadable?.length).toBe(pids.length);
});
