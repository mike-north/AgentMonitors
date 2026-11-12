/**
 * `agentmonitors monitor retry rearm|skip` through the built CLI, against a
 * real `daemon run` and, with no daemon reachable, in-process. A monitor
 * whose materialization retry is terminal takes no newer input (002 §2.7);
 * these tests prove each repair gets it moving again, in order, and that both
 * survive a daemon restart between the repair and its effect.
 *
 * The retry is retained by a real SQLite fault on `monitor_events` during a
 * real tick of the bundled file-fingerprint source. It is exhausted through
 * the store's own failed-attempt transition, which is what each failed drain
 * attempt calls; waiting out the real backoff would take minutes.
 *
 * @see ../../../docs/specs/005-cli-reference.md `monitor retry`
 * @see ../../../docs/specs/002-runtime-delivery.md §2, §2.7
 * @see https://www.sqlite.org/lang_createtrigger.html#raise
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentMonitorRuntime,
  claudeCodeAdapter,
  createDb,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  RuntimeStore,
  SourceRegistry,
} from '@agentmonitors/core';
import type { Database } from 'better-sqlite3';
import fileFingerprintSource from '@agentmonitors/source-file-fingerprint';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Nx completes the package build before this suite consumes the shared bundle. */
const cli = path.resolve(import.meta.dirname, '../dist/index.cjs');
const execute = promisify(execFile);
const MONITOR = 'watcher';

let root: string;
let monitors: string;
let watched: string;
let dbPath: string;
let socketPath: string;
let env: NodeJS.ProcessEnv;
const daemons: (() => Promise<void>)[] = [];

beforeEach(() => {
  // A short owned path respects macOS's Unix socket pathname limit.
  root = realpathSync(mkdtempSync('/tmp/am-repair-'));
  monitors = path.join(root, 'monitors');
  watched = path.join(root, 'watched.txt');
  dbPath = path.join(root, 'state.db');
  socketPath = path.join(root, 'daemon.sock');
  env = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: path.join(root, 'data'),
    AGENTMONITORS_DB: dbPath,
    AGENTMONITORS_SOCKET: socketPath,
  };
  mkdirSync(path.join(monitors, MONITOR), { recursive: true });
  writeFileSync(
    path.join(monitors, MONITOR, 'MONITOR.md'),
    [
      '---',
      'watch:',
      '  type: file-fingerprint',
      '  globs:',
      "    - 'watched.txt'",
      `  cwd: ${JSON.stringify(root)}`,
      "  interval: '1s'",
      'urgency: normal',
      '---',
      'Inspect.',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  for (const stop of daemons.splice(0)) await stop();
  rmSync(root, { recursive: true, force: true });
});

/** Open the workspace store with native access for faults and assertions. */
function openStore(): { store: RuntimeStore; client: Database } {
  const db = createDb(dbPath);
  return {
    store: new RuntimeStore(db),
    client: (db as unknown as { $client: Database }).$client,
  };
}

/**
 * Baseline the file at `v1`, then retain its change to `v2` behind a native
 * fault and (unless `exhaust` is false) exhaust that retry. The fault stays
 * installed when `keepFault` is set. Returns the retry id.
 */
async function seedRetry(options: {
  exhaust?: boolean;
  keepFault?: boolean;
}): Promise<string> {
  writeFileSync(watched, 'v1');
  const { store, client } = openStore();
  try {
    const registry = new SourceRegistry();
    registry.register(fileFingerprintSource);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    await runtime.tick(monitors, root);
    writeFileSync(watched, 'v2');
    client.exec(`CREATE TRIGGER fault BEFORE INSERT ON monitor_events
      WHEN NEW.monitor_id = '${MONITOR}'
      BEGIN SELECT RAISE(ABORT, 'native fault on ${MONITOR}'); END;`);
    // The file's mtime must move past the baseline's whole second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retained = await runtime.tick(monitors, root);
    expect(retained.erroredObservations).toHaveLength(1);
    const [retry] = store.listMaterializationRetries({ monitorId: MONITOR });
    if (!retry) throw new Error('no retained retry');
    if (options.exhaust !== false) {
      for (let n = 0; n < MATERIALIZATION_RETRY_MAX_ATTEMPTS; n += 1) {
        store.markMaterializationRetryFailed(retry.id, 'native fault');
      }
      expect(store.getMaterializationRetry(retry.id).status).toBe('terminal');
    }
    if (!options.keepFault) client.exec('DROP TRIGGER fault');
    return retry.id;
  } finally {
    client.close();
  }
}

/** File contents of this monitor's events, in materialization order. */
function eventContents(): string[] {
  const { client } = openStore();
  try {
    return client
      .prepare<[string], { content: string }>(
        `SELECT s.content FROM monitor_events e
         JOIN monitor_snapshots s ON s.event_id = e.id
         WHERE e.monitor_id = ? ORDER BY e.sequence`,
      )
      .all(MONITOR)
      .map(({ content }) => content);
  } finally {
    client.close();
  }
}

function retryRow(id: string) {
  const { store, client } = openStore();
  try {
    return store
      .listMaterializationRetries({ monitorId: MONITOR })
      .find((retry) => retry.id === id);
  } finally {
    client.close();
  }
}

function erroredMessages(): string[] {
  const { store, client } = openStore();
  try {
    return store
      .listObservationHistory({ monitorId: MONITOR, workspacePath: root })
      .filter(({ result }) => result === 'errored')
      .map(({ observationData }) => String(observationData['error']));
  } finally {
    client.close();
  }
}

/** Start `daemon run` and wait until it has ticked and serves its socket. */
async function startDaemon(pollMs: number): Promise<() => Promise<void>> {
  const before = erroredMessages().length;
  const daemon = spawn(
    process.execPath,
    [
      cli,
      'daemon',
      'run',
      monitors,
      '--workspace',
      root,
      '--poll-ms',
      String(pollMs),
      '--socket',
      socketPath,
      '--reap-after-ms',
      '0',
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk: string) => (output += chunk));
  daemon.stderr.on('data', (chunk: string) => (output += chunk));
  const exited = new Promise<void>((resolve) =>
    daemon.once('exit', () => resolve()),
  );
  const stop = async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
      if (!stopped) {
        daemon.kill('SIGKILL');
        await exited;
      }
    }
    const index = daemons.indexOf(stop);
    if (index >= 0) daemons.splice(index, 1);
  };
  daemons.push(stop);
  await vi.waitFor(
    () => {
      if (daemon.exitCode !== null) {
        throw new Error(`daemon exited early: ${output}`);
      }
      expect(existsSync(socketPath)).toBe(true);
      // Its first tick has reported the paused monitor, if it is paused.
      if (retryPaused()) {
        expect(erroredMessages().length).toBeGreaterThan(before);
      }
    },
    { timeout: 15_000, interval: 100 },
  );
  return stop;
}

function retryPaused(): boolean {
  const { store, client } = openStore();
  try {
    return store
      .listMaterializationRetries({ monitorId: MONITOR })
      .some(({ status }) => status === 'terminal');
  } finally {
    client.close();
  }
}

async function run(
  args: string[],
  cwd = root,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execute(process.execPath, [cli, ...args], {
      cwd,
      timeout: 15_000,
      env,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
    };
  }
}

function repairArgs(
  verb: 'rearm' | 'skip',
  retryId: string,
  ...extra: string[]
): string[] {
  return [
    'monitor',
    'retry',
    verb,
    MONITOR,
    retryId,
    '--workspace',
    root,
    '--socket',
    socketPath,
    ...extra,
  ];
}

async function doctorJson(): Promise<{
  monitors: { unretainedObservationLoss: Record<string, unknown> | null }[];
  checks: { name: string; status: string; remediation?: string | null }[];
}> {
  const result = await run([
    'doctor',
    '--dir',
    monitors,
    '--workspace',
    root,
    '--socket',
    socketPath,
    '--format',
    'json',
  ]);
  return JSON.parse(result.stdout);
}

async function explainMaterialization(): Promise<{
  status: string;
  reason: string;
}> {
  const result = await run([
    'monitor',
    'explain',
    MONITOR,
    '--dir',
    monitors,
    '--workspace',
    root,
    '--socket',
    socketPath,
    '--format',
    'json',
  ]);
  const report = JSON.parse(result.stdout) as {
    stages: { id: string; status: string; reason: string }[];
  };
  const stage = report.stages.find(({ id }) => id === 'materialization');
  if (!stage) throw new Error(`no materialization stage: ${result.stdout}`);
  return stage;
}

describe.each([
  ['with one daemon throughout', false],
  ['across a daemon restart', true],
] as const)('monitor retry, %s', (_label, restart) => {
  /**
   * The daemon that serves the repair. When a restart follows, it does not
   * tick again, so the repair takes effect only in the next daemon.
   */
  async function daemonForRepair(): Promise<() => Promise<void>> {
    return startDaemon(restart ? 600_000 : 200);
  }

  /** Stop the repairing daemon and start the next one, when restarting. */
  async function maybeRestart(stop: () => Promise<void>): Promise<void> {
    if (!restart) return;
    await stop();
    await startDaemon(200);
  }

  it('re-arms a terminal retry; it completes and later input follows in order', async () => {
    const id = await seedRetry({});
    const baseline = eventContents();
    const stop = await daemonForRepair();
    // Newer input waits behind the paused retry.
    writeFileSync(watched, 'v3');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(eventContents()).toEqual(baseline);

    const rearmed = await run(repairArgs('rearm', id, '--format', 'json'));
    expect(rearmed.code).toBe(0);
    const result = JSON.parse(rearmed.stdout);
    expect(result).toMatchObject({
      action: 'rearm',
      monitorId: MONITOR,
      workspacePath: root,
      via: 'daemon',
      retry: { id, status: 'pending', attemptCount: 0, lastError: null },
    });
    expect(Object.keys(result.retry).sort()).toEqual([
      'attemptCount',
      'createdAt',
      'id',
      'lastError',
      'nextAttemptAt',
      'status',
      'updatedAt',
    ]);

    await maybeRestart(stop);
    await vi.waitFor(
      () => expect(eventContents()).toEqual([...baseline, 'v2', 'v3']),
      { timeout: 15_000, interval: 100 },
    );
    expect(retryRow(id)).toBeUndefined();
  }, 60_000);

  it('re-arms a terminal retry whose next attempt fails again; the monitor stays paused', async () => {
    const id = await seedRetry({ keepFault: true });
    const baseline = eventContents();
    const stop = await daemonForRepair();
    writeFileSync(watched, 'v3');

    const rearmed = await run(repairArgs('rearm', id, '--format', 'text'));
    expect(rearmed.code).toBe(0);
    expect(rearmed.stdout).toContain(
      `Re-armed retry ${id} of monitor ${MONITOR}: its failed attempts are reset and it is next attempted at `,
    );

    await maybeRestart(stop);
    await vi.waitFor(
      () =>
        expect(retryRow(id)).toMatchObject({
          status: 'pending',
          attemptCount: 1,
          lastError: expect.stringContaining('native fault on watcher'),
        }),
      { timeout: 15_000, interval: 100 },
    );
    expect(eventContents()).toEqual(baseline);
    const doctor = await doctorJson();
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: `monitor:${MONITOR}`, status: 'fail' }),
    );
  }, 60_000);

  it('skips a terminal retry; its loss stays reported until superseded and the monitor resumes', async () => {
    const id = await seedRetry({});
    const baseline = eventContents();
    const stop = await daemonForRepair();

    const skipped = await run(
      repairArgs(
        'skip',
        id,
        '--reason',
        'superseded upstream',
        '--format',
        'text',
      ),
    );
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toContain(
      `Skipped retry ${id} of monitor ${MONITOR}. Its observation is recorded as an outstanding loss`,
    );
    expect(retryRow(id)).toBeUndefined();

    await maybeRestart(stop);
    // The daemon keeps ticking; an unchanged file supersedes nothing.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const expectedError = `native fault Retry skipped after ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} failed attempts: superseded upstream.`;
    const doctor = await doctorJson();
    expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject({
      count: 1,
      error: expectedError,
      objectKey: watched,
    });
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: `monitor:${MONITOR}`, status: 'fail' }),
    );
    const explain = await explainMaterialization();
    expect(explain.status).toBe('failure');
    expect(explain.reason).toContain(expectedError);

    // The monitor takes newer input, and the event for the same file
    // supersedes the loss.
    writeFileSync(watched, 'v3');
    await vi.waitFor(
      () => expect(eventContents()).toEqual([...baseline, 'v3']),
      { timeout: 15_000, interval: 100 },
    );
    const resumed = await doctorJson();
    expect(resumed.monitors[0]?.unretainedObservationLoss).toBeNull();
  }, 60_000);
});

describe('monitor retry refusals', () => {
  it('refuses a retry that is not terminal, through the daemon and in-process', async () => {
    const id = await seedRetry({ exhaust: false, keepFault: true });

    const expectedRefusal = (verb: string, past: string) =>
      new RegExp(
        `^Error: ${verb} failed for retry ${id} of monitor ${MONITOR} in workspace ${root}: Materialization retry record is pending, not terminal, so it cannot be ${past}\\. It is still retried automatically \\(\\d of 5 attempts failed; next attempt at \\d{4}-[^)]+\\): ${id}\\n$`,
      );

    // In-process: no daemon is running.
    for (const [verb, label, past] of [
      ['rearm', 'Re-arm', 're-armed'],
      ['skip', 'Skip', 'skipped'],
    ] as const) {
      const refused = await run(repairArgs(verb, id));
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(expectedRefusal(label, past));
    }

    // Through a live daemon.
    await startDaemon(600_000);
    for (const [verb, label, past] of [
      ['rearm', 'Re-arm', 're-armed'],
      ['skip', 'Skip', 'skipped'],
    ] as const) {
      const refused = await run(repairArgs(verb, id));
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(expectedRefusal(label, past));
    }
    expect(retryRow(id)?.status).toBe('pending');
    expect(
      (await doctorJson()).monitors[0]?.unretainedObservationLoss,
    ).toBeNull();
  }, 60_000);

  it("reports a reachable daemon's error and never applies the repair behind it", async () => {
    const id = await seedRetry({});
    // A reachable daemon that answers every request with an error, as an
    // older or failing daemon would.
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          id: string;
        };
        socket.end(
          JSON.stringify({ id: request.id, error: 'daemon is busy' }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      for (const verb of ['rearm', 'skip'] as const) {
        const refused = await run(repairArgs(verb, id, '--format', 'text'));
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('daemon is busy');
        expect(refused.stdout).not.toContain('applied to the persisted store');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(retryRow(id)?.status).toBe('terminal');
  }, 30_000);

  it('reports an unknown retry id as not found, in JSON', async () => {
    await seedRetry({});
    const refused = await run(
      repairArgs('skip', '01KUNKNOWNRETRY000000000000', '--format', 'json'),
    );
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toEqual({
      error: `Skip failed for retry 01KUNKNOWNRETRY000000000000 of monitor ${MONITOR} in workspace ${root}: Materialization retry record not found: 01KUNKNOWNRETRY000000000000`,
    });
  }, 30_000);
});

describe('monitor retry without a daemon', () => {
  it('runs the re-arm doctor suggests in-process, and the next tick completes it before later input', async () => {
    const id = await seedRetry({});
    const baseline = eventContents();

    // Doctor names both repairs for the paused monitor's terminal retry.
    const doctor = await doctorJson();
    const check = doctor.checks.find(
      ({ name }) => name === `monitor:${MONITOR}`,
    );
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toContain(
      `\`agentmonitors monitor retry rearm ${MONITOR} ${id}\``,
    );
    expect(check?.remediation).toContain(
      `\`agentmonitors monitor retry skip ${MONITOR} ${id}\``,
    );
    // So does the tick report.
    const once = await run([
      'daemon',
      'once',
      monitors,
      '--workspace',
      root,
      '--format',
      'json',
    ]);
    expect(once.stdout).toContain(`monitor retry rearm ${MONITOR} ${id}`);
    expect(once.stdout).toContain(`monitor retry skip ${MONITOR} ${id}`);

    // Run the suggested command exactly as written, from the workspace.
    const suggested = /`agentmonitors (monitor retry rearm [^`]+)`/.exec(
      check?.remediation ?? '',
    )?.[1];
    const rearmed = await run([
      ...(suggested ?? '').split(' '),
      '--format',
      'text',
    ]);
    expect(rearmed.code).toBe(0);
    expect(rearmed.stdout).toContain(
      'No daemon running — applied to the persisted store',
    );
    expect(retryRow(id)).toMatchObject({ status: 'pending', attemptCount: 0 });

    writeFileSync(watched, 'v3');
    // The re-armed retry is due after its first retry delay.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const tick = await run([
      'daemon',
      'once',
      monitors,
      '--workspace',
      root,
      '--format',
      'json',
    ]);
    expect(tick.code).toBe(0);
    expect(eventContents()).toEqual([...baseline, 'v2', 'v3']);
    expect(retryRow(id)).toBeUndefined();
  }, 60_000);

  it('skips in-process; doctor and explain report the loss read from the store', async () => {
    const id = await seedRetry({});
    const skipped = await run(repairArgs('skip', id, '--format', 'json'));
    expect(skipped.code).toBe(0);
    expect(JSON.parse(skipped.stdout)).toMatchObject({
      action: 'skip',
      via: 'in-process',
      retry: { id, status: 'terminal' },
    });
    const doctor = await doctorJson();
    expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: watched,
      error: expect.stringContaining('Retry skipped after 5 failed attempts.'),
    });
    expect((await explainMaterialization()).status).toBe('failure');
  }, 30_000);
});
