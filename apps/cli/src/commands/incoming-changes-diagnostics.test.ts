/** Real CLI, SQLite reopen and Unix-socket diagnosis for recoverable Git observation failures. */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  createDb,
  type MonitorExplainReport,
  type ObservationHistoryRecord,
} from '@agentmonitors/core';
import incoming from '@agentmonitors/source-incoming-changes';
import { createDaemonServer } from '../daemon-ipc.js';
import { decodeToon } from '../toon-format.js';

const DIAGNOSTIC =
  'incoming-changes: could not resolve the configured ref to a commit. Check watch.cwd (an accessible Git repository), watch.branch (default HEAD), and that git is installed. No baseline was established or advanced; continuous monitoring will retry.';
const CLI = path.resolve(import.meta.dirname, '../../dist/index.cjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Async children let the owned in-process socket server make progress. */
function run(root: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: root,
        env: {
          ...process.env,
          AGENTMONITORS_DB: path.join(root, 'state.db'),
          AGENTMONITORS_SOCKET: path.join(root, 'daemon.sock'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Owned CLI exceeded 15s'));
      }, 15_000);
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    },
  );
}

function git(repo: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Mike North',
      '-c',
      'user.email=michael.l.north@gmail.com',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function fixture() {
  // Keep macOS Unix socket paths below sockaddr_un's length limit.
  const root = mkdtempSync(
    path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'am305-'),
  );
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(path.join(repo, 'a.txt'), 'A\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'Initial fixture']);
  git(repo, ['branch', 'watched']);
  const monitorsDir = path.join(root, 'monitors');
  function monitor(cwd = repo, branch = 'watched') {
    const dir = path.join(monitorsDir, 'incoming');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'MONITOR.md');
    writeFileSync(
      file,
      `---\nname: Incoming\nwatch: ${JSON.stringify({ type: 'incoming-changes', paths: ['a.txt'], cwd, branch, interval: '1s' })}\nurgency: normal\n---\nReview changes.\n`,
    );
    return file;
  }
  const file = monitor();
  return { root, repo, file, monitorsDir, monitor };
}

/** Own and close the opaque database's actual connection to prove disk recovery. */
function open(root: string) {
  const db = createDb(path.join(root, 'state.db'));
  const client: unknown = Reflect.get(db, '$client');
  if (typeof client !== 'object' || client === null) {
    throw new Error('Expected owned SQLite connection');
  }
  const close: unknown = Reflect.get(client, 'close');
  if (typeof close !== 'function') {
    throw new Error('Expected SQLite close method');
  }
  const store = new RuntimeStore(db),
    registry = new SourceRegistry();
  registry.register(incoming);
  registry.register({
    name: 'healthy',
    scopeSchema: {},
    observe: async () => ({ observations: [{ title: 'Sibling observed' }] }),
  });
  return {
    store,
    runtime: new AgentMonitorRuntime(store, registry, []),
    close: () => {
      close.call(client);
    },
  };
}

describe('incoming-changes unavailable diagnosis', () => {
  it.each(['text', 'json'])(
    'rejects non-repo and unknown branch through real CLI %s without creating a DB',
    async (format) => {
      const f = fixture();
      for (const [cwd, branch] of [
        [f.root, 'HEAD'],
        [f.repo, 'missing'],
      ] as const) {
        const result = await run(f.root, [
          'monitor',
          'test',
          f.monitor(cwd, branch),
          '--format',
          format,
        ]);
        expect(result.code).toBe(1);
        if (format === 'json') {
          expect(JSON.parse(result.stdout)).toEqual({
            error: `Observation failed: ${DIAGNOSTIC}`,
          });
          expect(result.stderr).toBe('');
        } else {
          expect(result.stdout).toBe(
            'Testing monitor "Incoming" (source: incoming-changes)...\n',
          );
          expect(result.stderr).toBe(
            `Error: Observation failed: ${DIAGNOSTIC}\n`,
          );
        }
        expect(existsSync(path.join(f.root, 'state.db'))).toBe(false);
      }
      const valid = await run(f.root, [
        'monitor',
        'test',
        f.monitor(),
        '--format',
        'json',
      ]);
      expect(valid.code).toBe(0);
      expect(valid.stderr).toBe('');
      expect(JSON.parse(valid.stdout)).toEqual({
        monitor: 'Incoming',
        source: 'incoming-changes',
        baseline: true,
        observations: [],
      });
    },
  );

  it('retains the last real SHA across outage/reopen, isolates errors and recovers the missed change', async () => {
    const f = fixture();
    let owned = open(f.root);
    try {
      await owned.runtime.tick(f.monitorsDir, f.root);
      const baseline = owned.store.getMonitorState('incoming', f.root);
      expect(baseline.sourceState).toEqual({
        ref: git(f.repo, ['rev-parse', 'HEAD']),
      });
      owned.store.setMonitorState('incoming', f.root, {
        ...baseline,
        lastObservationAt: new Date(0),
      });
      const due = owned.store.getMonitorState('incoming', f.root);
      git(f.repo, ['branch', '-D', 'watched']);
      const sibling = path.join(f.monitorsDir, 'zzz-healthy');
      mkdirSync(sibling);
      writeFileSync(
        path.join(sibling, 'MONITOR.md'),
        '---\nwatch:\n  type: healthy\nurgency: normal\n---\nHandle change.\n',
      );
      const failed = await owned.runtime.tick(f.monitorsDir, f.root);
      expect(failed.erroredObservations).toEqual([
        { monitorId: 'incoming', message: DIAGNOSTIC },
      ]);
      expect(failed.emittedEventIds).toHaveLength(1);
      expect(owned.store.getMonitorState('incoming', f.root)).toEqual(due);
      owned.close();
      owned = open(f.root);
      expect(owned.store.getMonitorState('incoming', f.root)).toEqual(due);
      const repeated = await owned.runtime.tick(f.monitorsDir, f.root);
      expect(repeated.erroredObservations).toEqual([
        { monitorId: 'incoming', message: DIAGNOSTIC },
      ]);
      expect(
        owned.store
          .listObservationHistory({
            monitorId: 'incoming',
            workspacePath: f.root,
          })
          .slice(0, 2)
          .map((row) => ({ result: row.result, data: row.observationData })),
      ).toEqual([
        { result: 'errored', data: { error: DIAGNOSTIC } },
        { result: 'errored', data: { error: DIAGNOSTIC } },
      ]);
      writeFileSync(path.join(f.repo, 'a.txt'), 'B after outage\n');
      git(f.repo, ['add', '.']);
      git(f.repo, ['commit', '-m', 'Recovery fixture']);
      git(f.repo, ['branch', 'watched']);
      expect(
        (await owned.runtime.tick(f.monitorsDir, f.root)).erroredObservations,
      ).toEqual([]);
      const events = owned.runtime.listEvents({
        monitorId: 'incoming',
        workspacePath: f.root,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.snapshotText).toBe('B after outage\n');
      expect(events[0]?.payload).toEqual({
        path: 'a.txt',
        status: 'M',
        fromRef:
          baseline.sourceState && Reflect.get(baseline.sourceState, 'ref'),
        toRef: git(f.repo, ['rev-parse', 'HEAD']),
      });
      const report = await owned.runtime.explainMonitor({
        monitorId: 'incoming',
        workspacePath: f.root,
        monitorsDir: f.monitorsDir,
      });
      expect(
        report.stages.find((stage) => stage.id === 'observation')?.status,
      ).toBe('ok');
    } finally {
      owned.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'shows exact errors via real socket and offline fallback without rewriting legacy bytes',
    async () => {
      const f = fixture(),
        owned = open(f.root);
      const legacy = `\u001b[31mlegacy\u001b[0m\r\n  error\t${'😀'.repeat(520)}`;
      const safe = `legacy error ${'😀'.repeat(496)}...`;
      const cases = [
        [DIAGNOSTIC, DIAGNOSTIC],
        [legacy, safe],
      ] as const;
      let server: ReturnType<typeof createDaemonServer> | undefined;
      try {
        for (const [raw, displayed] of cases) {
          if (raw === DIAGNOSTIC) {
            git(f.repo, ['branch', '-D', 'watched']);
            expect(
              (await owned.runtime.tick(f.monitorsDir, f.root))
                .erroredObservations,
            ).toEqual([{ monitorId: 'incoming', message: DIAGNOSTIC }]);
          } else {
            owned.store.recordObservationHistory({
              monitorId: 'incoming',
              sourceName: 'incoming-changes',
              workspacePath: f.root,
              result: 'errored',
              observationData: { error: raw },
            });
          }
          // Same-id rows in another workspace must not enter this diagnosis.
          owned.store.recordObservationHistory({
            monitorId: 'incoming',
            sourceName: 'incoming-changes',
            workspacePath: `${f.root}-other`,
            result: 'errored',
            observationData: { error: 'OTHER WORKSPACE' },
          });
          server = createDaemonServer({
            runtime: owned.runtime,
            socketPath: path.join(f.root, 'daemon.sock'),
          });
          await server.listen();
          for (const live of [true, false]) {
            if (!live) {
              await server?.close();
              server = undefined;
            }
            for (const format of ['text', 'json', 'toon']) {
              const history = await run(f.root, [
                'monitor',
                'history',
                'incoming',
                '--workspace',
                f.root,
                '--limit',
                '1',
                '--format',
                format,
              ]);
              expect(history.code).toBe(0);
              expect(history.stderr).toBe('');
              if (format === 'text') {
                expect(history.stdout).toContain(
                  `incoming  (incoming-changes)  ${displayed}\n`,
                );
                expect(history.stdout).not.toContain('\u001b');
                expect(history.stdout).not.toContain('OTHER WORKSPACE');
              } else {
                const rows: ObservationHistoryRecord[] =
                  format === 'json'
                    ? JSON.parse(history.stdout)
                    : decodeToon(
                        history.stdout.replace(/^No daemon running.*\n/, ''),
                      );
                expect(rows[0]?.result).toBe('errored');
                expect(rows[0]?.observationData).toEqual({ error: raw });
              }
              const explained = await run(f.root, [
                'monitor',
                'explain',
                'incoming',
                '--dir',
                f.monitorsDir,
                '--workspace',
                f.root,
                '--format',
                format,
              ]);
              expect(explained.code).toBe(0);
              expect(explained.stderr).toBe('');
              if (format === 'text')
                expect(explained.stdout).toContain(
                  `✗ Observation: Source observation failed: ${displayed}`,
                );
              else {
                const report: MonitorExplainReport =
                  format === 'json'
                    ? JSON.parse(explained.stdout)
                    : decodeToon(
                        explained.stdout.replace(/^No daemon running.*\n/, ''),
                      );
                expect(
                  report.stages.find((stage) => stage.id === 'observation'),
                ).toMatchObject({
                  status: 'failure',
                  reason: `Source observation failed: ${displayed}`,
                  details: { error: raw },
                });
              }
            }
          }
          expect(
            owned.store.listObservationHistory({
              monitorId: 'incoming',
              workspacePath: f.root,
              limit: 1,
            })[0]?.observationData,
          ).toEqual({ error: raw });
        }
      } finally {
        await server?.close();
        owned.close();
      }
    },
    30_000,
  );
});
