/**
 * Process-boundary proof of terminal-retry repair (002 §2.7). Real source
 * failure retains an envelope; store transitions exhaust its attempt budget.
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

/** Retain a real source change, then exhaust it through the production store transition. */
async function terminal(
  f: Fixture,
  child: Owned,
  policy: Policy,
): Promise<string> {
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

/** Exactly one representation must account for the observation at every restart. */
async function recovered(
  f: Fixture,
  retryId: string,
  action: Repair,
  original: ReturnType<typeof truth>,
) {
  const before = truth(f, retryId);
  expect(before.events).toEqual([]);
  expect(before.snapshots).toEqual([]);
  const row = before.retries[0];
  const armed = row?.status === 'pending';
  if (action === 'rearm' && armed) {
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
  const terminalCount = before.retries.length && !armed ? 1 : 0;
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
  if (armed) {
    expect(after.retries).toEqual([]);
    expect(after.losses).toEqual([]);
    expect(after.events).toEqual([{ snapshot_text: 'one' }]);
    expect(after.snapshots).toEqual([{ content: 'one' }]);
  } else {
    expect(after).toEqual(before);
  }
}

for (const action of ['rearm', 'skip'] satisfies Repair[]) {
  for (const policy of ['immediate', 'debounce', 'rollup'] satisfies Policy[]) {
    it(`monitor retry ${action}/${policy}: every traced write survives kill and fault`, async () => {
      const discovery = await fixture('poll', policy);
      let points: string[];
      try {
        const child = await discovery.start();
        const retryId = await terminal(discovery, child, policy);
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
        console.log(`monitor retry ${action}/${policy}/committed-control`);
        expect(truth(discovery, retryId)).toMatchObject(
          action === 'rearm'
            ? {
                retries: [
                  expect.objectContaining({ id: retryId, status: 'pending' }),
                ],
                losses: [],
              }
            : { retries: [], losses: [expect.anything()] },
        );
        points = [
          ...new Set(
            child.messages
              .filter((value) => value.kind === 'write')
              .map((value) => String(value.point)),
          ),
        ];
        expect(
          points.length,
          `${action}/${policy} write inventory`,
        ).toBeGreaterThan(0);
        await stop(child);
        await recovered(discovery, retryId, action, original);
      } finally {
        await discovery.cleanup();
      }
      for (const point of points) {
        for (const mode of ['kill', 'fault']) {
          const label = `monitor retry ${action}/${policy}/${mode} :: ${point}`;
          console.log(label);
          const f = await fixture('poll', policy);
          try {
            const child = await f.start();
            const retryId = await terminal(f, child, policy);
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
            await recovered(f, retryId, action, original);
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
