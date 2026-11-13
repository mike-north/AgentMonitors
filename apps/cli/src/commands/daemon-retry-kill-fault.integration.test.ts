/**
 * Process-boundary proof of terminal-retry repair (002 §2.7). Real source
 * failure retains an envelope; store transitions exhaust its attempt budget.
 * Registered verify artifacts exercise cleanup instead of ordinary repair.
 * Each repair's executed SQL supplies its own kill/fault inventory. Independent
 * reads distinguish terminal work, armed work and a skipped observation's loss;
 * successful controls prove the committed branches as well as rollback.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import {
  createDb,
  parseMonitorFile,
  RuntimeStore,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  type DoctorReport,
} from '@agentmonitors/core';
import {
  cli,
  epoch,
  fixture,
  message,
  stop,
  type Owned,
  type Policy,
} from './ingress-harness.test-support.js';

/** Repairs share one transaction contract regardless of the envelope's notify pacing. */
type Repair = 'rearm' | 'skip';
/** Ownership and legacy admission state select distinct durable repair paths. */
type Branch = 'ordinary' | 'retired-artifact' | 'legacy-unpositioned';
type Fixture = Awaited<ReturnType<typeof fixture>>;
const execute = promisify(execFile);

/** Stored identity and lifecycle fields whose preservation makes a repair coherent. */
interface RetryRow {
  id: string;
  status: 'pending' | 'terminal';
  attempt_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  envelope: string;
  envelope_bytes: number;
  admission_sequence: number | null;
  workspace_path: string;
  monitor_id: string;
  source_name: string;
  created_at: number;
  updated_at: number;
}

/** Exercise the user-facing binary, retaining its exit status and diagnostic text. */
async function repair(f: Fixture, action: Repair, retryId: string) {
  try {
    const result = await execute(
      process.execPath,
      [
        cli,
        'monitor',
        'retry',
        action,
        f.monitorId,
        retryId,
        '--workspace',
        f.root,
        '--socket',
        `${f.root}/d.sock`,
        '--format',
        'json',
      ],
      {
        env: { ...process.env, AGENTMONITORS_DB: f.dbPath },
        timeout: 10_000,
      },
    );
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !('stdout' in error) ||
      !('stderr' in error)
    )
      throw error;
    return {
      code: error.code,
      output: String(error.stdout) + String(error.stderr),
    };
  }
}

/** Build terminal work through store transitions, using real source failure for ordinary work. */
async function terminal(
  f: Fixture,
  child: Owned,
  policy: Policy,
  branch: Branch,
): Promise<string> {
  if (branch === 'retired-artifact') {
    return retiredTerminal(f);
  }
  await f.control(child, { stage: 'seed-retry', seedRetry: true });
  await f.change(child, 'one', epoch + 2_000);
  if (policy !== 'immediate') await f.flush(child, epoch + 60_000);
  const db = createDb(f.dbPath);
  // createDb's native handle is internal; ownership is confined to this helper.
  const native = (db as unknown as { $client: Database.Database }).$client;
  try {
    const store = new RuntimeStore(db);
    const retries = store.listMaterializationRetries({
      monitorId: f.monitorId,
    });
    expect(retries).toHaveLength(1);
    const retry = retries[0];
    if (!retry) throw new Error('Missing retained source change');
    for (let n = 0; n < MATERIALIZATION_RETRY_MAX_ATTEMPTS; n++)
      store.markMaterializationRetryFailed(
        retry.id,
        'fixture exhausts retained work',
      );
    expect(store.getMaterializationRetry(retry.id).status).toBe('terminal');
    if (branch === 'legacy-unpositioned') {
      // Upgraded retries can predate admission positions (002 §2.7). Current
      // admission always reserves one; restore only that legacy storage fact.
      native
        .prepare(
          'UPDATE materialization_retry_outbox SET admission_sequence = NULL WHERE id = ?',
        )
        .run(retry.id);
    }
    return retry.id;
  } finally {
    native.close();
  }
}

/**
 * Register exact ownership while active, retain through the store, then retire
 * only after exhaustion. No tick may discard the row before the repair traces it.
 * The unchanged API baseline prevents newer source work from obscuring cleanup.
 */
async function retiredTerminal(f: Fixture): Promise<string> {
  const owner = await f.open('verify-owner');
  const runId = 'abcdef012345';
  const objectKey = `${f.root}/logs/agentmonitors-verify-${runId}.md`;
  const parsed = parseMonitorFile(
    `${f.root}/monitors/${f.monitorId}/MONITOR.md`,
  );
  if (!parsed.ok) throw new Error('Invalid fixture monitor');
  const db = createDb(f.dbPath);
  // createDb's native handle is internal; this helper exclusively owns its connection.
  const native = (db as unknown as { $client: Database.Database }).$client;
  try {
    const store = new RuntimeStore(db);
    store.registerVerifyArtifact({
      runId,
      ownerSessionId: owner.id,
      workspacePath: f.root,
      monitorId: f.monitorId,
      objectKey,
      registeredAt: new Date(epoch),
    });
    const [retry] = store.enqueueMaterializationRetries(
      [
        {
          workspacePath: f.root,
          monitorId: f.monitorId,
          sourceName: 'api-poll',
          error: 'fixture retains verify scratch work',
          envelope: {
            monitor: parsed.monitor,
            observation: {
              title: 'Verify scratch changed',
              objectKey,
              snapshotText: 'scratch',
            },
            observedAt: new Date(epoch),
            effectiveUrgency: 'normal',
          },
        },
      ],
      new Date(epoch),
    );
    if (!retry) throw new Error('Missing retained verify artifact');
    for (let n = 0; n < MATERIALIZATION_RETRY_MAX_ATTEMPTS; n++) {
      store.markMaterializationRetryFailed(
        retry.id,
        'fixture exhausts verify scratch work',
      );
    }
    expect(store.getMaterializationRetry(retry.id).status).toBe('terminal');
    store.recordVerifyArtifactCleanup(
      runId,
      'owner-request',
      new Date(epoch + 1_000),
    );
    return retry.id;
  } finally {
    native.close();
  }
}

/** Read truth outside the interrupted writer, preserving the exact retained identity. */
function truth(f: Fixture, retryId: string) {
  const db = new Database(f.dbPath, { readonly: true });
  try {
    const retries = db
      .prepare<[], RetryRow>('SELECT * FROM materialization_retry_outbox')
      .all();
    const losses = db
      .prepare(
        "SELECT observation_data FROM observation_history WHERE json_extract(observation_data, '$.retryId') = ? AND json_extract(observation_data, '$.skipped') = 1",
      )
      .all(retryId);
    const events = db
      .prepare('SELECT snapshot_text FROM monitor_events ORDER BY sequence')
      .all();
    const snapshots = db
      .prepare('SELECT content FROM monitor_snapshots ORDER BY sequence')
      .all();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    return { retries, losses, events, snapshots };
  } finally {
    db.close();
  }
}

/** Cleanup must not invent failure history for work its owner retired (002 §2.8). */
function noCleanupErrors(f: Fixture): void {
  const db = new Database(f.dbPath, { readonly: true });
  try {
    expect(
      db
        .prepare("SELECT * FROM observation_history WHERE result = 'errored'")
        .all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
}

/** Exactly one representation must account for the observation at every restart. */
async function recovered(
  f: Fixture,
  retryId: string,
  action: Repair,
  branch: Branch,
  original: ReturnType<typeof truth>,
) {
  const before = truth(f, retryId);
  expect(before.events).toEqual([]);
  expect(before.snapshots).toEqual([]);
  const row = before.retries[0];
  const armed = row?.status === 'pending';
  if (branch === 'retired-artifact') {
    expect(before.losses).toEqual([]);
    noCleanupErrors(f);
    if (before.retries.length) {
      expect(before).toEqual(original);
    } else {
      expect(before).toEqual({ ...original, retries: [] });
    }
  } else if (action === 'rearm' && armed) {
    expect(before.retries).toEqual([
      {
        ...original.retries[0],
        id: retryId,
        status: 'pending',
        attempt_count: 0,
        last_error: null,
        next_attempt_at: expect.any(Number),
        updated_at: expect.any(Number),
      },
    ]);
    expect(before.losses).toEqual([]);
  } else if (action === 'skip' && before.retries.length === 0) {
    expect(before.losses).toHaveLength(1);
  } else {
    expect(before).toEqual(original);
  }
  const restarted = await f.start(epoch + 180_000);
  // Two completed ticks prove automatic work cannot replay after its first success.
  await f.tick(restarted, epoch + 240_000);
  await f.tick(restarted, epoch + 300_000);
  const report = await f.rpc<DoctorReport>('doctor.report', {
    monitorsDir: `${f.root}/monitors`,
    workspacePath: f.root,
  });
  expect(report.monitors).toHaveLength(1);
  const monitor = report.monitors[0];
  const terminalCount =
    branch !== 'retired-artifact' && before.retries.length && !armed ? 1 : 0;
  expect(monitor?.materializationRetries).toMatchObject({
    pending: 0,
    terminal: terminalCount,
    records: terminalCount ? [expect.objectContaining({ id: retryId })] : [],
  });
  if (before.losses.length) {
    expect(monitor?.unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: f.objectKey,
    });
  } else {
    expect(monitor?.unretainedObservationLoss).toBeUndefined();
  }
  await stop(restarted);
  const after = truth(f, retryId);
  if (branch === 'retired-artifact') {
    // Startup's owned drain completes any cleanup that rolled back at interruption.
    expect(after).toEqual({ ...original, retries: [] });
    noCleanupErrors(f);
  } else if (armed) {
    expect(after.retries).toEqual([]);
    expect(after.losses).toEqual([]);
    expect(after.events).toEqual([{ snapshot_text: 'one' }]);
    expect(after.snapshots).toEqual([{ content: 'one' }]);
  } else {
    expect(after).toEqual(before);
  }
}

for (const branch of [
  'ordinary',
  'retired-artifact',
  'legacy-unpositioned',
] satisfies Branch[]) {
  // Only skip has another write branch when a legacy retry has no position;
  // rearm uses the identical UPDATE, with no position-dependent write branch.
  const actions: Repair[] =
    branch === 'legacy-unpositioned' ? ['skip'] : ['rearm', 'skip'];
  for (const action of actions) {
    for (const policy of [
      'immediate',
      'debounce',
      'rollup',
    ] satisfies Policy[]) {
      it(`monitor retry ${action}/${policy}/${branch}: every traced write survives kill and fault`, async () => {
        const discovery = await fixture('poll', policy);
        let points: string[];
        try {
          const child = await discovery.start();
          const retryId = await terminal(discovery, child, policy, branch);
          const original = truth(discovery, retryId);
          await discovery.control(child, {
            stage: action,
            trace: true,
            seedRetry: false,
          });
          const result = await repair(discovery, action, retryId);
          expect(result.code, result.output).toBe(0);
          // A control acknowledgment follows every earlier trace on this IPC channel.
          await discovery.control(child, { trace: false });
          // A successful repair must reach its requested branch, rather than
          // passing solely because unchanged terminal work is crash-safe.
          console.log(
            `monitor retry ${action}/${policy}/${branch}/committed-control`,
          );
          expect(truth(discovery, retryId)).toMatchObject(
            branch === 'retired-artifact'
              ? { retries: [], losses: [] }
              : action === 'rearm'
                ? {
                    retries: [
                      expect.objectContaining({
                        id: retryId,
                        status: 'pending',
                      }),
                    ],
                    losses: [],
                  }
                : { retries: [], losses: [expect.anything()] },
          );
          if (branch === 'retired-artifact') {
            expect(JSON.parse(result.output)).toMatchObject({
              outcome: 'verify-artifact-cleanup',
            });
            noCleanupErrors(discovery);
          }
          points = [
            ...new Set(
              child.messages
                .filter((value) => value.kind === 'write')
                .map((value) => String(value.point)),
            ),
          ];
          console.log(
            `write inventory ${action}/${policy}/${branch}: ${JSON.stringify(points)}`,
          );
          expect(
            points.length,
            `${action}/${policy}/${branch} write inventory`,
          ).toBeGreaterThan(0);
          await stop(child);
          await recovered(discovery, retryId, action, branch, original);
        } finally {
          await discovery.cleanup();
        }
        for (const point of points) {
          for (const mode of ['kill', 'fault']) {
            const label = `monitor retry ${action}/${policy}/${branch}/${mode} :: ${point}`;
            console.log(label);
            const f = await fixture('poll', policy);
            try {
              const child = await f.start();
              const retryId = await terminal(f, child, policy, branch);
              const original = truth(f, retryId);
              await f.control(child, {
                stage: action,
                trace: true,
                point,
                mode,
                seedRetry: false,
              });
              const attempted = repair(f, action, retryId);
              expect(
                await message(child, (value) => value.kind === 'interrupted'),
              ).toMatchObject({ point, mode });
              if (mode === 'kill') {
                await stop(child);
                expect(child.signal).toBe('SIGKILL');
              }
              const result = await attempted;
              expect(result.code, result.output).not.toBe(0);
              expect(result.output).toMatch(
                mode === 'kill'
                  ? /outcome unknown/
                  : /failed.*Injected ingress write failure/s,
              );
              await stop(child);
              await recovered(f, retryId, action, branch, original);
            } catch (error) {
              throw new Error(label, { cause: error });
            } finally {
              await f.cleanup();
            }
          }
        }
      }, 30_000);
    }
  }
}
