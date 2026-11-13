/**
 * Process-boundary acceptance for 002's atomic ingress contract. The inventory
 * is captured at the real SQLite driver while real sources ingest, hold and
 * recover work. Every discovered write occurrence gets a SIGKILL and a fault
 * scenario; clocks advance by command and readiness comes only from events.
 */
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { MonitorEventRecord } from '@agentmonitors/core';
import {
  epoch,
  fixture,
  message,
  stop,
  type Owned,
  type Policy,
  type Source,
} from './ingress-harness.test-support.js';

type Stage = 'accept' | 'flush' | 'retry-admit' | 'retry-drain';
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Advance exactly the workflow that produced a point, keeping older phases unarmed. */
async function exercise(
  f: Fixture,
  child: Owned,
  policy: Policy,
  stage: Stage,
  arm?: { point: string; mode: string },
) {
  const holding = policy !== 'immediate';
  const retry = stage === 'retry-admit' || stage === 'retry-drain';
  const acquisition = !holding && retry ? 'retry-admit' : 'accept';
  await f.control(child, {
    stage: acquisition,
    trace: true,
    point: null,
    ...(stage === acquisition ? arm : {}),
    seedRetry: !holding && retry,
  });
  const accepted = await f.change(child, 'one', epoch + 2000);
  if (stage === 'accept' || (!holding && stage === 'retry-admit'))
    return accepted;
  if (holding) {
    const release = stage === 'retry-drain' ? 'retry-admit' : stage;
    await f.control(child, {
      stage: release,
      point: null,
      ...(stage === release ? arm : {}),
      seedRetry: retry,
    });
    const flushed = await f.flush(child, epoch + 60_000);
    if (stage !== 'retry-drain') return flushed;
  }
  // Recovery writes are armed only after the real event fault retained its envelope.
  await f.control(child, { stage, point: null, ...arm, seedRetry: false });
  return f.tick(child, epoch + 120_000);
}

/** Event and projection truth is read independently after the crashed connection is gone. */
function assertDurableTruth(
  f: Fixture,
  recipients: readonly string[],
  failedMonitor?: string,
): void {
  const db = new Database(f.dbPath);
  try {
    const events = db
      .prepare('SELECT count(*) n FROM monitor_events')
      .get() as { n: number };
    const triggered = db
      .prepare(
        "SELECT count(*) n FROM observation_history WHERE result = 'triggered'",
      )
      .get() as { n: number };
    if (events.n === 0) expect(triggered.n).toBe(0);
    const partial = db
      .prepare(
        'SELECT count(*) n FROM monitor_events e WHERE (SELECT count(*) FROM session_event_state s WHERE s.event_id = e.id) != 2',
      )
      .get() as { n: number };
    expect(partial.n).toBe(0);
    // Compare the separate durable artifacts against source values and exact
    // event identities; inline monitor_events.snapshot_text is not snapshot truth.
    const committed = db
      .prepare('SELECT id FROM monitor_events ORDER BY sequence')
      .all() as { id: string }[];
    expect(committed.length).toBeLessThanOrEqual(2);
    const route = {
      workspace_path: f.root,
      monitor_id: f.monitorId,
      object_key: f.objectKey,
    };
    expect(
      db
        .prepare(
          'SELECT workspace_path, monitor_id, object_key, event_id, content FROM monitor_snapshots ORDER BY sequence',
        )
        .all(),
    ).toEqual(
      committed.map((event, index) => ({
        ...route,
        event_id: event.id,
        content: ['one', 'two'][index],
      })),
    );
    // Nothing is claimed in this fixture: each recipient must retain the first
    // event's artifact as its baseline, even after later events and a restart.
    const first = committed[0];
    expect(
      db
        .prepare(
          'SELECT session_id, workspace_path, monitor_id, object_key, baseline_snapshot_id, baseline_content FROM session_object_cursor ORDER BY session_id',
        )
        .all(),
    ).toEqual(
      first
        ? [...recipients].sort().map((sessionId) => ({
            ...route,
            session_id: sessionId,
            baseline_snapshot_id: first.id,
            baseline_content: 'one',
          }))
        : [],
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    if (failedMonitor) {
      const errors = db
        .prepare(
          "SELECT count(*) n FROM observation_history WHERE monitor_id = ? AND result = 'errored'",
        )
        .get(failedMonitor) as { n: number };
      expect(errors.n).toBeGreaterThan(0);
    }
  } finally {
    db.close();
  }
}

for (const source of ['poll', 'watch'] satisfies Source[])
  for (const policy of ['immediate', 'debounce', 'rollup'] satisfies Policy[]) {
    it(`${source}/${policy}: every discovered write survives a kill and a fault`, async () => {
      const stages: Stage[] =
        policy === 'immediate'
          ? ['accept', 'retry-admit', 'retry-drain']
          : ['accept', 'flush', 'retry-admit', 'retry-drain'];
      for (const stage of stages) {
        const discovery = await fixture(source, policy);
        let points: string[];
        try {
          const child = await discovery.start();
          await discovery.open('lead-a');
          await discovery.open('lead-b');
          await exercise(discovery, child, policy, stage);
          points = [
            ...new Set(
              child.messages
                .filter(
                  (value) =>
                    value.kind === 'write' &&
                    String(value.point).startsWith(`${stage} ::`),
                )
                .map((value) => String(value.point)),
            ),
          ];
          expect(
            points.length,
            `${source}/${policy}/${stage} inventory`,
          ).toBeGreaterThan(0);
          console.log(
            `${source}/${policy}/${stage}: ${points.length} write points`,
          );
          if (process.env.INGRESS_TEST_INVENTORY === '1')
            console.log(JSON.stringify(points));
        } finally {
          await discovery.cleanup();
        }
        for (const point of points)
          for (const mode of ['kill', 'fault']) {
            const f = await fixture(source, policy);
            try {
              const first = await f.start();
              const leadA = await f.open('lead-a');
              const leadB = await f.open('lead-b');
              const subagent = await f.open('subagent', 'subagent');
              const attempted = exercise(f, first, policy, stage, {
                point,
                mode,
              }).catch((error: unknown) => ({ error }));
              expect(
                await message(first, (value) => value.kind === 'interrupted'),
              ).toMatchObject({ point, mode });
              if (mode === 'kill') {
                await stop(first);
                expect(first.signal, point).toBe('SIGKILL');
              } else {
                const result = await attempted;
                // Observation history is explicitly best-effort after the commit (002 §15).
                if (!point.includes('observation_history')) {
                  if (source === 'poll' || stage === 'retry-drain') {
                    expect(result, point).toMatchObject({
                      erroredObservations: [{ monitorId: source }],
                    });
                  } else {
                    expect(result, point).toMatchObject({
                      kind: 'watch-error',
                      monitorId: source,
                    });
                  }
                }
              }
              await stop(first);
              await attempted;
              assertDurableTruth(
                f,
                [leadA.id, leadB.id],
                mode === 'fault' && !point.includes('observation_history')
                  ? source
                  : undefined,
              );
              const restarted = await f.start(epoch + 180_000);
              expect((await f.open('lead-a')).id).toBe(leadA.id);
              expect((await f.open('lead-b')).id).toBe(leadB.id);
              await f.flush(restarted, epoch + 240_000);
              await f.change(restarted, 'two', epoch + 242_000);
              await f.flush(restarted, epoch + 300_000);
              await f.flush(restarted, epoch + 360_000);
              for (const lead of [leadA, leadB]) {
                const events = await f.rpc<MonitorEventRecord[]>(
                  'events.list',
                  { sessionId: lead.id, unreadOnly: true },
                );
                // events.list is newest-first; its reverse is persisted monitor order.
                expect(
                  events.map((event) => event.snapshotText).reverse(),
                  `${source}/${policy}/${mode}: ${point}`,
                ).toEqual(['one', 'two']);
                expect(new Set(events.map((event) => event.id)).size).toBe(2);
              }
              expect(
                await f.rpc('events.list', {
                  sessionId: subagent.id,
                  unreadOnly: true,
                }),
              ).toEqual([]);
              assertDurableTruth(f, [leadA.id, leadB.id]);
            } finally {
              await f.cleanup();
            }
          }
      }
    }, 180_000);
  }
