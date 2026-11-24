/** Policy applies when opening a runtime; routing and session coordination preserve it without applying it. */
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  createDb,
  RuntimeStore,
  type AgentSessionRecord,
  type ObservationHistoryRecord,
} from '@agentmonitors/core';
import { afterEach, expect, it, vi } from 'vitest';
import { runLoop } from './commands/daemon.js';
import { callDaemon, daemonAvailable } from './daemon-ipc.js';
import { createRuntime } from './runtime.js';

const cli = path.resolve(import.meta.dirname, '../dist/index.cjs');
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Invoke the shipped executable asynchronously so its IPC server can run in this process. */
function execute(
  args: string[],
  cwd: string,
  input = '',
  projectDir = cwd,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd,
        timeout: 10000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
          AGENTMONITORS_DB: '',
          AGENTMONITORS_SOCKET: '',
        },
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) {
          reject(error);
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

/** Write raw policy text alongside coordinates without invoking the policy under test. */
function coordinate(root: string, enabled: boolean, value: string): void {
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(
    path.join(root, '.claude', 'agentmonitors.local.md'),
    `---\nenabled: ${String(enabled)}\ndb: ${path.join(root, 'state.db')}\nsocket: ${path.join(root, 'daemon.sock')}\nclaim-ttl-ms: ${value}\n---\n`,
  );
}

it('unscoped offline history uses cwd storage policy despite foreign CLAUDE_PROJECT_DIR and keeps its global query', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  const root = mkdtempSync(path.join(tmpdir(), 'claim-history-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  coordinate(a, true, '60000');
  coordinate(b, true, '0');
  const db = createDb(path.join(a, 'state.db'));
  // The fixture owns native close; the public database handle deliberately hides it.
  const native = (db as unknown as { $client: Database.Database }).$client;
  const store = new RuntimeStore(db);
  store.recordObservationHistory({
    monitorId: 'from-a',
    workspacePath: a,
    sourceName: 'manual',
    result: 'no-change',
    observationData: {},
  });
  store.recordObservationHistory({
    monitorId: 'from-b',
    workspacePath: b,
    sourceName: 'manual',
    result: 'no-change',
    observationData: {},
  });
  native.close();
  try {
    const unscoped = await execute(
      ['monitor', 'history', '--format', 'json'],
      a,
      '',
      b,
    );
    expect(unscoped.code, unscoped.stderr).toBe(0);
    const rows: ObservationHistoryRecord[] = JSON.parse(unscoped.stdout);
    expect(rows.map((row) => row.monitorId).sort()).toEqual([
      'from-a',
      'from-b',
    ]);
    const scoped = await execute(
      ['monitor', 'history', '--workspace', a, '--format', 'json'],
      a,
      '',
      b,
    );
    expect(scoped.code, scoped.stderr).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject([
      { monitorId: 'from-a', workspacePath: a },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['start', 'end'])(
  'disabled session %s stays silently disabled with an invalid unapplied policy',
  async (action) => {
    const root = mkdtempSync(path.join(tmpdir(), 'claim-disabled-'));
    coordinate(root, false, '0');
    try {
      const result = await execute(
        ['session', action],
        root,
        JSON.stringify({ session_id: 'disabled', cwd: root }),
      );
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('ends a live session after invalid policy edits and preserves that unapplied field on the next start', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claim-session-'));
  coordinate(root, true, '60000');
  const monitors = path.join(root, '.claude', 'monitors');
  mkdirSync(monitors);
  const socketPath = path.join(root, 'daemon.sock');
  const dbPath = path.join(root, 'state.db');
  const loop = runLoop(monitors, root, 20, socketPath, 0, dbPath);
  try {
    await vi.waitFor(async () =>
      expect(await daemonAvailable(socketPath)).toBe(true),
    );
    const payload = JSON.stringify({ session_id: 'live-session', cwd: root });
    const start = await execute(['session', 'start'], root, payload);
    expect(start.code, start.stderr).toBe(0);
    const statePath = path.join(root, '.claude', 'agentmonitors.local.md');
    writeFileSync(
      statePath,
      readFileSync(statePath, 'utf8').replace(
        'claim-ttl-ms: 60000',
        'claim-ttl-ms: 0 \t',
      ),
    );
    const end = await execute(['session', 'end'], root, payload);
    expect(end.code, end.stderr).toBe(0);
    expect(end.stdout).toBe('');
    const sessions = await callDaemon<AgentSessionRecord[]>(
      'session.list',
      {},
      { socketPath },
    );
    expect(
      sessions.find((s) => s.hostSessionId === 'live-session')?.status,
    ).toBe('dormant');
    const restart = await execute(['session', 'start'], root, payload);
    expect(restart.code, restart.stderr).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toContain('claim-ttl-ms: 0 \t\n');
    expect(() => createRuntime(dbPath, undefined, undefined, root)).toThrow(
      'claim-ttl-ms must be a positive safe integer in milliseconds',
    );
  } finally {
    await callDaemon('stop', {}, { socketPath });
    await loop;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

/** Explicit store construction applies strict policy even when automatic startup is disabled. */
it.each([
  '0',
  '-1',
  '1.5',
  'Infinity',
  'true',
  'nope',
  '',
  '"60000"',
  '9007199254740992',
])(
  'runtime construction rejects raw policy %j without falling back',
  (value) => {
    const root = mkdtempSync(path.join(tmpdir(), 'claim-apply-'));
    coordinate(root, false, value);
    try {
      expect(() =>
        createRuntime(path.join(root, 'state.db'), undefined, undefined, root),
      ).toThrow('claim-ttl-ms must be a positive safe integer in milliseconds');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
