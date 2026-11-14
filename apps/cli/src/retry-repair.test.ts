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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
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
import { RETRY_REPAIR_TIMEOUT_MS } from './runtime-client.js';
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
  // Inherit the coordinator's short owned parent so fixture writes stay in
  // the operator's temp boundary while retaining macOS-compatible sockets.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'am-repair-')));
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
  writeMonitor(monitors, MONITOR);
});

/** A file-fingerprint monitor `id` under `dir` watching this test's file. */
function writeMonitor(dir: string, id: string): void {
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(
    path.join(dir, id, 'MONITOR.md'),
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
}

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
  /** Another monitor and workspace than the suite's own `watcher` in `root`. */
  target?: { monitorId: string; monitorsDir: string; workspace: string };
}): Promise<string> {
  const monitorId = options.target?.monitorId ?? MONITOR;
  const monitorsDir = options.target?.monitorsDir ?? monitors;
  const workspace = options.target?.workspace ?? root;
  const sqlMonitorId = monitorId.replaceAll("'", "''");
  writeFileSync(watched, 'v1');
  const { store, client } = openStore();
  try {
    const registry = new SourceRegistry();
    registry.register(fileFingerprintSource);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    await runtime.tick(monitorsDir, workspace);
    writeFileSync(watched, 'v2');
    client.exec(`CREATE TRIGGER fault BEFORE INSERT ON monitor_events
      WHEN NEW.monitor_id = '${sqlMonitorId}'
      BEGIN SELECT RAISE(ABORT, 'native fault on ${sqlMonitorId}'); END;`);
    // The file's mtime must move past the baseline's whole second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retained = await runtime.tick(monitorsDir, workspace);
    expect(retained.erroredObservations).toHaveLength(1);
    const [retry] = store.listMaterializationRetries({ monitorId });
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

/**
 * Start `daemon run` and wait until it has ticked and serves its socket.
 * Sessions are reaped as soon as they are idle unless `reapAfterMs` says
 * otherwise.
 */
async function startDaemon(
  pollMs: number,
  reapAfterMs = 0,
): Promise<() => Promise<void>> {
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
      String(reapAfterMs),
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
      // Longer than the repairs' own 15-second wait for a daemon's reply.
      timeout: 30_000,
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

/**
 * Listen on the suite's socket as a stand-in daemon: `onRequest` gets each
 * connection once its first request line has arrived. Returns a closer.
 */
async function fakeDaemon(
  onRequest: (
    socket: net.Socket,
    request: { id: string; method: string },
  ) => void,
): Promise<() => Promise<void>> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // The CLI may hang up first; a late write must not fail the suite.
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      onRequest(
        socket,
        JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          id: string;
          method: string;
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
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
    const close = await fakeDaemon((socket, request) => {
      socket.end(
        JSON.stringify({ id: request.id, error: 'daemon is busy' }) + '\n',
      );
    });
    try {
      for (const verb of ['rearm', 'skip'] as const) {
        const refused = await run(repairArgs(verb, id, '--format', 'text'));
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('daemon is busy');
        expect(refused.stdout).not.toContain('applied to the persisted store');
      }
    } finally {
      await close();
    }
    expect(retryRow(id)?.status).toBe('terminal');
  }, 30_000);

  it('refuses a skip reason over 200 characters and changes nothing', async () => {
    const id = await seedRetry({});
    const lossesBefore = erroredMessages().length;
    const refused = await run(
      repairArgs('skip', id, '--reason', 'r'.repeat(201), '--format', 'text'),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      `Error: Skip failed for retry ${id} of monitor ${MONITOR} in workspace ${root}: Skip reason is 201 characters; at most 200 are allowed.\n`,
    );
    expect(retryRow(id)?.status).toBe('terminal');
    expect(erroredMessages()).toHaveLength(lossesBefore);
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

/**
 * 005 `monitor retry`: once a daemon has accepted the request, a missing reply
 * leaves the repair's outcome unknown. The daemon may have applied it (its
 * store write can wait out another writer's lock), so the CLI reports that,
 * points at the read-only commands that tell, and never writes the store.
 */
describe('monitor retry behind a daemon that received the request but did not answer', () => {
  /** The unknown-outcome report for `label`, with its scoped follow-ups. */
  function expectOutcomeUnknown(
    result: { stdout: string; stderr: string; code: number },
    label: 'Re-arm' | 'Skip',
    id: string,
  ): void {
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('applied to the persisted store');
    expect(result.stderr).toContain(
      `Error: ${label} outcome unknown for retry ${id} of monitor ${MONITOR} in workspace ${root}: the daemon received the request but no reply arrived (`,
    );
    expect(result.stderr).toContain(
      'may already have been applied, or may still be applied; nothing was written to the store from here. Check with `agentmonitors monitor explain -- watcher` or `agentmonitors doctor` before running it again.',
    );
  }

  it('reports a skip whose reply comes after the client timeout as unknown, and writes nothing', async () => {
    const id = await seedRetry({});
    const lossesBefore = erroredMessages().length;
    // Past the repairs' 15-second client timeout (RETRY_REPAIR_TIMEOUT_MS),
    // as a daemon blocked on another writer's lock for longer would answer.
    const LATE_REPLY_MS = 16_000;
    const methods: string[] = [];
    const close = await fakeDaemon((socket, request) => {
      methods.push(request.method);
      setTimeout(() => {
        socket.end(
          JSON.stringify({ id: request.id, result: retryRow(id) }) + '\n',
        );
      }, LATE_REPLY_MS);
    });
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await run(repairArgs('skip', id, '--format', 'text'));
    } finally {
      await close();
    }
    expect(methods).toEqual(['retry.skip']);
    expectOutcomeUnknown(result, 'Skip', id);
    expect(result.stderr).toContain(
      `(Timed out waiting for AgentMon daemon at ${socketPath})`,
    );
    // The CLI did not skip it behind the daemon.
    expect(retryRow(id)?.status).toBe('terminal');
    expect(erroredMessages()).toHaveLength(lossesBefore);
    // 005 `monitor retry`: two 5-second store lock waits (the daemon's own
    // tick, then the repair) plus a margin.
    expect(RETRY_REPAIR_TIMEOUT_MS).toBe(15_000);
    expect(RETRY_REPAIR_TIMEOUT_MS).toBeLessThan(LATE_REPLY_MS);
  }, 45_000);

  it('reports a repair whose connection drops after the request as unknown, and writes nothing', async () => {
    const id = await seedRetry({});
    const lossesBefore = erroredMessages().length;
    const methods: string[] = [];
    const close = await fakeDaemon((socket, request) => {
      methods.push(request.method);
      socket.destroy();
    });
    try {
      for (const [verb, label] of [
        ['rearm', 'Re-arm'],
        ['skip', 'Skip'],
      ] as const) {
        const result = await run(repairArgs(verb, id, '--format', 'text'));
        expectOutcomeUnknown(result, label, id);
      }
      const json = await run(repairArgs('skip', id, '--format', 'json'));
      expect(json.code).toBe(1);
      expect((JSON.parse(json.stdout) as { error: string }).error).toMatch(
        /^Skip outcome unknown for retry /u,
      );
    } finally {
      await close();
    }
    expect(methods).toEqual(['retry.rearm', 'retry.skip', 'retry.skip']);
    expect(retryRow(id)).toMatchObject({
      status: 'terminal',
      attemptCount: 5,
    });
    expect(erroredMessages()).toHaveLength(lossesBefore);
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
      `\`agentmonitors monitor retry rearm -- ${MONITOR} ${id}\``,
    );
    expect(check?.remediation).toContain(
      `\`agentmonitors monitor retry skip -- ${MONITOR} ${id}\``,
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
    expect(once.stdout).toContain(
      `monitor retry rearm --workspace ${root} -- ${MONITOR} ${id}`,
    );
    expect(once.stdout).toContain(
      `monitor retry skip --workspace ${root} -- ${MONITOR} ${id}`,
    );

    // Run the suggested repair from the workspace, with the format option
    // before its option terminator.
    const suggested = /`agentmonitors (monitor retry rearm [^`]+)`/.exec(
      check?.remediation ?? '',
    )?.[1];
    const rearmed = await run([
      'monitor',
      'retry',
      'rearm',
      '--format',
      'text',
      ...(suggested ?? '').split(' ').slice(3),
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
    // 005 doctor: a skipped retry has no span position, so it is named as
    // `an observation (<objectKey>, "<title>")`, followed by its own error.
    const doctorText = await run([
      'doctor',
      '--dir',
      monitors,
      '--workspace',
      root,
      '--socket',
      socketPath,
      '--format',
      'text',
    ]);
    expect(doctorText.stdout).toContain(
      `monitor:${MONITOR}: observation dropped (1 outstanding; newest: an observation (${watched}, `,
    );
    expect(doctorText.stdout).toContain(
      'Retry skipped after 5 failed attempts.',
    );
    // 002 §10.7: explain's materialization reason, with the same naming.
    const materialization = await explainMaterialization();
    expect(materialization.status).toBe('failure');
    expect(materialization.reason).toContain(
      `1 observation(s) were dropped because the runtime could not keep them; the newest, an observation (${watched}, `,
    );
    expect(materialization.reason).toMatch(
      /Retry skipped after 5 failed attempts\.$/u,
    );
  }, 30_000);

  it('prints a skip hint that runs verbatim from another directory, quoted and scoped to the workspace', async () => {
    // A workspace path with spaces whose definitions sit in its own
    // `.claude/monitors`, and a monitor id with a single quote.
    const workspace = path.join(root, 'my work');
    const workspaceMonitors = path.join(workspace, '.claude', 'monitors');
    const monitorId = "it's mine";
    writeMonitor(workspaceMonitors, monitorId);
    const id = await seedRetry({
      target: { monitorId, monitorsDir: workspaceMonitors, workspace },
    });
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);

    const skipped = await run(
      [
        'monitor',
        'retry',
        'skip',
        monitorId,
        id,
        '--workspace',
        workspace,
        '--socket',
        socketPath,
        '--format',
        'text',
      ],
      elsewhere,
    );
    expect(skipped.code).toBe(0);
    const hint = `agentmonitors monitor explain --workspace '${workspace}' --dir '${workspaceMonitors}' -- 'it'\\''s mine'`;
    expect(skipped.stdout).toContain(`; see \`${hint}\`.`);

    // Run it through `sh` exactly as printed, from the same directory.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'agentmonitors'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
      { mode: 0o755 },
    );
    const printed = /; see `([^`]+)`\./u.exec(skipped.stdout)?.[1] ?? '';
    const explained = await execute(
      '/bin/sh',
      [
        '-c',
        printed.replace('monitor explain ', 'monitor explain --format json '),
      ],
      {
        cwd: elsewhere,
        env: { ...env, PATH: `${bin}:${env['PATH'] ?? ''}` },
        timeout: 15_000,
      },
    );
    const report = JSON.parse(explained.stdout) as {
      monitorId: string;
      stages: { id: string; status: string; reason: string }[];
    };
    expect(report.monitorId).toBe(monitorId);
    // It read that workspace's definition and the loss the skip recorded.
    expect(
      report.stages.find(({ id: stage }) => stage === 'definition')?.status,
    ).toBe('ok');
    expect(
      report.stages.find(({ id: stage }) => stage === 'materialization')
        ?.reason,
    ).toMatch(/Retry skipped after 5 failed attempts\.$/u);
  }, 30_000);
});

describe('monitor retry on a retired verify artifact', () => {
  /** A verify run token, as `verify --use-workspace-daemon` names its scratch file. */
  const RUN = 'abcdef012345';

  function scratchFile(): string {
    return path.join(root, `agentmonitors-verify-${RUN}.md`);
  }

  /**
   * Retain the suite monitor's change to its verify scratch file behind a
   * native fault on that file's events only, and exhaust the retry. The fault
   * stays installed, so only a repair can remove the row, while the monitor's
   * real file still materializes. `ownership` says where the run's artifact
   * is registered: in this workspace, in a foreign one, or nowhere.
   */
  async function seedScratchRetry(
    ownership: 'registered' | 'foreign' | 'unregistered',
  ): Promise<string> {
    writeFileSync(
      path.join(monitors, MONITOR, 'MONITOR.md'),
      [
        '---',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        "    - 'watched.txt'",
        `    - 'agentmonitors-verify-${RUN}.md'`,
        `  cwd: ${JSON.stringify(root)}`,
        "  interval: '1s'",
        'urgency: normal',
        '---',
        'Inspect.',
        '',
      ].join('\n'),
    );
    writeFileSync(watched, 'v1');
    writeFileSync(scratchFile(), 's1');
    const { store, client } = openStore();
    try {
      const registry = new SourceRegistry();
      registry.register(fileFingerprintSource);
      const runtime = new AgentMonitorRuntime(store, registry, [
        claudeCodeAdapter,
      ]);
      if (ownership !== 'unregistered') {
        const workspace =
          ownership === 'registered' ? root : path.join(root, 'foreign');
        mkdirSync(workspace, { recursive: true });
        const owner = runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: `agentmonitors-verify-${RUN}`,
            workspacePath: workspace,
          }),
        );
        runtime.registerVerifyArtifact({
          runId: RUN,
          ownerSessionId: owner.id,
          workspacePath: workspace,
          monitorId: MONITOR,
          objectKey: scratchFile(),
        });
      }
      await runtime.tick(monitors, root);
      writeFileSync(scratchFile(), 's2');
      client.exec(`CREATE TRIGGER scratch_fault BEFORE INSERT ON monitor_events
        WHEN instr(NEW.title || NEW.body || NEW.payload, 'agentmonitors-verify-') > 0
        BEGIN SELECT RAISE(ABORT, 'native fault on the scratch file'); END;`);
      // The file's mtime must move past the baseline's whole second.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const retained = await runtime.tick(monitors, root);
      expect(retained.erroredObservations).toHaveLength(1);
      const [retry] = store.listMaterializationRetries({ monitorId: MONITOR });
      if (!retry) throw new Error('no retained retry');
      for (let n = 0; n < MATERIALIZATION_RETRY_MAX_ATTEMPTS; n += 1) {
        store.markMaterializationRetryFailed(retry.id, 'native fault');
      }
      expect(store.getMaterializationRetry(retry.id).status).toBe('terminal');
      return retry.id;
    } finally {
      client.close();
    }
  }

  /** The run requests cleanup, as verify does after its proof (002 §2.8). */
  function retireScratch(): void {
    const { store, client } = openStore();
    try {
      new AgentMonitorRuntime(store, new SourceRegistry(), [
        claudeCodeAdapter,
      ]).requestVerifyArtifactCleanup({ runId: RUN });
    } finally {
      client.close();
    }
  }

  /** The text a repair prints when it removed the row as cleanup (005). */
  function expectCleanupText(stdout: string, id: string): void {
    expect(stdout).toContain(
      `Removed retry ${id} of monitor ${MONITOR} as verify-artifact cleanup: its observation is a verify scratch artifact whose cleanup has taken effect, so it is neither re-armed nor recorded as a loss.`,
    );
    expect(stdout).toContain(
      'The monitor takes newer input on its next tick unless other retained work is still ahead of it.',
    );
  }

  /** No loss is reported, and newer legitimate input arrives after it. */
  async function expectNoLossAndResume(baseline: string[]): Promise<void> {
    const doctor = await doctorJson();
    expect(doctor.monitors[0]?.unretainedObservationLoss).toBeNull();
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: `monitor:${MONITOR}` }),
    );
    expect(
      doctor.checks.find(({ name }) => name === `monitor:${MONITOR}`)?.status,
    ).not.toBe('fail');
    writeFileSync(watched, 'v3');
    await vi.waitFor(
      () => expect(eventContents()).toEqual([...baseline, 'v3']),
      { timeout: 15_000, interval: 100 },
    );
    const resumed = await doctorJson();
    expect(resumed.monitors[0]?.unretainedObservationLoss).toBeNull();
  }

  it.each(['skip', 'rearm'] as const)(
    '%s through the daemon removes it as cleanup, records no loss, and the monitor resumes',
    async (verb) => {
      const id = await seedScratchRetry('registered');
      const baseline = eventContents();
      const lossesBefore = erroredMessages().length;
      // A daemon that keeps the owner session and does not tick again, so
      // only the repair can remove the paused row.
      const stop = await startDaemon(600_000, 3_600_000);
      expect(retryRow(id)?.status).toBe('terminal');
      retireScratch();
      const erroredBefore = erroredMessages().length;
      expect(erroredBefore).toBeGreaterThan(lossesBefore);

      const result = await run(repairArgs(verb, id, '--format', 'text'));
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('applied to the persisted store');
      expectCleanupText(result.stdout, id);
      expect(retryRow(id)).toBeUndefined();
      // Neither a loss row nor any other errored row was written.
      expect(erroredMessages()).toHaveLength(erroredBefore);

      await stop();
      await startDaemon(200);
      await expectNoLossAndResume(baseline);
    },
    60_000,
  );

  it.each(['skip', 'rearm'] as const)(
    '%s in-process removes it as cleanup, records no loss, and the monitor resumes',
    async (verb) => {
      const id = await seedScratchRetry('registered');
      const baseline = eventContents();
      retireScratch();
      const erroredBefore = erroredMessages().length;

      const result = await run(repairArgs(verb, id, '--format', 'json'));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: verb,
        outcome: 'verify-artifact-cleanup',
        monitorId: MONITOR,
        workspacePath: root,
        via: 'in-process',
        retry: { id, status: 'terminal', attemptCount: 5 },
      });
      expect(retryRow(id)).toBeUndefined();
      expect(erroredMessages()).toHaveLength(erroredBefore);

      await startDaemon(200);
      await expectNoLossAndResume(baseline);
    },
    60_000,
  );

  it.each([
    { ownership: 'unregistered', label: 'not registered' },
    {
      ownership: 'foreign',
      label: 'registered and retired only in a foreign workspace',
    },
  ] as const)(
    'skip still records the loss when the scratch key is $label',
    async ({ ownership }) => {
      const id = await seedScratchRetry(ownership);
      if (ownership === 'foreign') retireScratch();

      const result = await run(repairArgs('skip', id, '--format', 'json'));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: 'skip',
        outcome: 'skipped',
        via: 'in-process',
      });
      const doctor = await doctorJson();
      expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject({
        count: 1,
        objectKey: scratchFile(),
        error: expect.stringContaining(
          'Retry skipped after 5 failed attempts.',
        ),
      });
    },
    30_000,
  );
});

/** Explain's repairs must address the reported retry when pasted from another workspace. */
it.each(['rearm', 'skip'] as const)(
  'regression: explain %s preserves workspace scope through a POSIX shell',
  async (verb) => {
    const workspace = path.join(root, "Mike's workspace; $literal");
    mkdirSync(workspace);
    const id = await seedRetry({
      target: { monitorId: MONITOR, monitorsDir: monitors, workspace },
    });
    const caller = path.join(root, 'caller');
    mkdirSync(caller);
    // Only the executable lookup is supplied by the harness: the printed
    // command and all its arguments are handed unchanged to the shell.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'agentmonitors'),
      `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`,
      { mode: 0o700 },
    );
    const explained = await run(
      [
        'monitor',
        'explain',
        MONITOR,
        '--workspace',
        workspace,
        '--dir',
        monitors,
        '--format',
        'json',
      ],
      caller,
    );
    expect(explained.code).toBe(0);
    const report = JSON.parse(explained.stdout) as {
      stages: { id: string; reason: string }[];
    };
    const reason = report.stages.find(
      ({ id }) => id === 'materialization',
    )?.reason;
    const command = reason?.match(
      new RegExp('`(agentmonitors monitor retry ' + verb + ' [^`]+)`'),
    )?.[1];
    expect(command).toBeDefined();
    const result = await execute('/bin/sh', ['-c', command ?? 'exit 99'], {
      cwd: caller,
      // Keep format detection independent of the invoking terminal. The shim
      // uses absolute paths, so no host executables belong on this PATH.
      env: {
        HOME: root,
        XDG_DATA_HOME: env['XDG_DATA_HOME'],
        AGENTMONITORS_DB: dbPath,
        AGENTMONITORS_SOCKET: socketPath,
        PATH: bin,
      },
      timeout: 30_000,
    });
    expect(result.stdout).toContain(
      `${verb === 'rearm' ? 'Re-armed' : 'Skipped'} retry ${id} of monitor ${MONITOR}`,
    );
    const { store, client } = openStore();
    try {
      if (verb === 'rearm') {
        expect(store.getMaterializationRetry(id)).toMatchObject({
          workspacePath: workspace,
          status: 'pending',
          attemptCount: 0,
        });
      } else {
        expect(
          store.listMaterializationRetries({ workspacePath: workspace }),
        ).toEqual([]);
        expect(
          store.outstandingUnretainedObservationLoss(MONITOR, workspace),
        ).toBeDefined();
      }
    } finally {
      client.close();
    }
  },
);

/** Legal leading-hyphen IDs stay positional when a printed repair is pasted into a shell. */
it.each([
  ['explain', 'rearm'],
  ['explain', 'skip'],
  ['doctor', 'rearm'],
  ['doctor', 'skip'],
] as const)(
  'regression: %s %s repairs a leading-hyphen monitor through a POSIX shell',
  async (surface, verb) => {
    const monitorId = '-watcher';
    writeMonitor(monitors, monitorId);
    const workspace = path.join(root, "Mike's workspace; $literal");
    mkdirSync(workspace);
    const id = await seedRetry({
      target: { monitorId, monitorsDir: monitors, workspace },
    });
    const caller = path.join(root, 'caller');
    mkdirSync(caller);
    // The shim supplies executable lookup only; every printed argument goes
    // unchanged through the shell from outside the retry's workspace.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'agentmonitors'),
      `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`,
      { mode: 0o700 },
    );
    const flags = [
      '--workspace',
      workspace,
      '--dir',
      monitors,
      '--format',
      'json',
    ];
    const diagnostic = await run(
      surface === 'explain'
        ? ['monitor', 'explain', ...flags, '--', monitorId]
        : ['doctor', ...flags],
      caller,
    );
    // Doctor reports the stopped monitor as unhealthy; explain still succeeds.
    expect(diagnostic.code).toBe(surface === 'doctor' ? 1 : 0);
    const report = JSON.parse(diagnostic.stdout) as {
      stages?: { id: string; reason: string }[];
      checks?: { name: string; remediation?: string }[];
    };
    const prose =
      surface === 'explain'
        ? report.stages?.find(({ id }) => id === 'materialization')?.reason
        : report.checks?.find(({ name }) => name === `monitor:${monitorId}`)
            ?.remediation;
    const command = prose?.match(
      new RegExp('`(agentmonitors monitor retry ' + verb + ' [^`]+)`'),
    )?.[1];
    expect(command).toBeDefined();
    const result = await execute('/bin/sh', ['-c', command ?? 'exit 99'], {
      cwd: caller,
      // Match the workspace-scope regressions: format detection must not
      // depend on the invoking terminal, and the shim uses absolute paths.
      env: {
        HOME: root,
        XDG_DATA_HOME: env['XDG_DATA_HOME'],
        AGENTMONITORS_DB: dbPath,
        AGENTMONITORS_SOCKET: socketPath,
        PATH: bin,
      },
      timeout: 30_000,
    });
    expect(result.stdout).toContain(
      `${verb === 'rearm' ? 'Re-armed' : 'Skipped'} retry ${id} of monitor ${monitorId}`,
    );
    const { store, client } = openStore();
    try {
      if (verb === 'rearm') {
        expect(store.getMaterializationRetry(id)).toMatchObject({
          workspacePath: workspace,
          monitorId,
          status: 'pending',
          attemptCount: 0,
        });
      } else {
        expect(
          store.listMaterializationRetries({
            monitorId,
            workspacePath: workspace,
          }),
        ).toEqual([]);
        expect(
          store.outstandingUnretainedObservationLoss(monitorId, workspace),
        ).toBeDefined();
      }
    } finally {
      client.close();
    }
  },
);

/**
 * 005 §6/§15: every follow-up addresses the same monitor when pasted verbatim,
 * even when its legal ID looks like an option. Real persisted retries/losses
 * distinguish the intended workspace from a command that merely parses.
 */
it.each([
  ['skip success', 'skip', 'explain'],
  ['unknown rearm', 'unknown-rearm', 'explain'],
  ['unknown skip', 'unknown-skip', 'explain'],
  ['doctor dropped explain', 'dropped', 'explain'],
  ['doctor dropped history', 'dropped', 'history'],
  ['doctor pending retry', 'pending', 'explain'],
  ['doctor terminal retry', 'terminal', 'explain'],
  ['doctor orphan dropped observation', 'orphan-dropped', 'history'],
  ['doctor orphan retained work', 'orphan-retained', 'explain'],
] as const)(
  'follow-up regression: %s for a leading-hyphen monitor through a POSIX shell',
  async (_label, scenario, followUp) => {
    const monitorId = '-watcher';
    const workspace = path.join(root, "Mike's workspace; $literal");
    const definitions = path.join(workspace, '.claude', 'monitors');
    writeMonitor(definitions, monitorId);
    const id = await seedRetry({
      exhaust: scenario !== 'pending',
      target: { monitorId, monitorsDir: definitions, workspace },
    });
    const caller = path.join(root, 'caller');
    const bin = path.join(root, 'bin');
    mkdirSync(caller);
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'agentmonitors'),
      `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`,
      { mode: 0o700 },
    );
    const repair = (verb: string) =>
      run(
        [
          'monitor',
          'retry',
          verb,
          '--workspace',
          workspace,
          '--socket',
          socketPath,
          '--format',
          'text',
          '--',
          monitorId,
          id,
        ],
        caller,
      );
    let prose: string;
    if (scenario.startsWith('unknown-')) {
      // A real accepted socket request with a lost reply must produce the
      // inspection hint without performing an in-process repair.
      const methods: string[] = [];
      const close = await fakeDaemon((socket, request) => {
        methods.push(request.method);
        socket.end();
      });
      try {
        const verb = scenario === 'unknown-rearm' ? 'rearm' : 'skip';
        const result = await repair(verb);
        expect(result.code).toBe(1);
        expect(methods).toEqual([`retry.${verb}`]);
        expect(result.stderr).toContain('outcome unknown');
        prose = result.stderr;
      } finally {
        await close();
      }
    } else {
      if (scenario === 'skip' || scenario.includes('dropped')) {
        const result = await repair('skip');
        expect(result.code).toBe(0);
        prose = result.stdout;
      } else {
        prose = '';
      }
      if (scenario.startsWith('orphan-')) {
        // Preserve the file while removing it from definition discovery.
        renameSync(
          path.join(definitions, monitorId, 'MONITOR.md'),
          path.join(root, 'retired-monitor.md'),
        );
      }
      if (scenario !== 'skip') {
        const diagnostic = await run(
          [
            'doctor',
            '--workspace',
            workspace,
            '--dir',
            definitions,
            '--socket',
            socketPath,
            '--format',
            'json',
          ],
          caller,
        );
        expect(diagnostic.code).toBe(1);
        const report = JSON.parse(diagnostic.stdout) as {
          checks: { name: string; remediation?: string }[];
        };
        const prefix =
          scenario === 'orphan-dropped'
            ? 'dropped-observation'
            : scenario === 'orphan-retained'
              ? 'retry-outbox'
              : 'monitor';
        prose =
          report.checks.find(({ name }) => name === `${prefix}:${monitorId}`)
            ?.remediation ?? '';
      }
    }
    const command = [
      ...prose.matchAll(
        /`(agentmonitors monitor (?:explain|history) [^`]+)`/gu,
      ),
    ]
      .map((match) => match[1])
      .find((value) => value?.startsWith(`agentmonitors monitor ${followUp} `));
    expect(command).toBeDefined();
    const result = await execute('/bin/sh', ['-c', command ?? 'exit 99'], {
      cwd: caller,
      // Same allowlist as the repair regressions: no inherited format or
      // executable lookup can conceal an argument parsing failure.
      env: {
        HOME: root,
        XDG_DATA_HOME: env['XDG_DATA_HOME'],
        AGENTMONITORS_DB: dbPath,
        AGENTMONITORS_SOCKET: socketPath,
        PATH: bin,
      },
      timeout: 30_000,
    });
    if (scenario === 'skip' || scenario.includes('dropped')) {
      expect(result.stdout).toContain('Retry skipped after 5 failed attempts.');
    } else {
      expect(result.stdout).toContain(id);
    }
    // Inspection must leave the retained work or outstanding loss intact.
    const { store, client } = openStore();
    try {
      if (scenario === 'skip' || scenario.includes('dropped')) {
        expect(
          store.outstandingUnretainedObservationLoss(monitorId, workspace),
        ).toBeDefined();
      } else {
        expect(store.getMaterializationRetry(id)).toMatchObject({
          monitorId,
          workspacePath: workspace,
          status: scenario === 'pending' ? 'pending' : 'terminal',
        });
      }
    } finally {
      client.close();
    }
  },
);
