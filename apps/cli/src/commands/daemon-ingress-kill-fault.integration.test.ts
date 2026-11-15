/**
 * Process-boundary acceptance for 002's atomic ingress contract. The inventory
 * is captured at the real SQLite driver while real sources ingest, hold and
 * recover work. Every discovered write occurrence gets a SIGKILL and a fault
 * scenario; clocks advance by command and readiness comes only from events.
 */
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import type { MonitorEventRecord } from '@agentmonitors/core';
import {
  epoch,
  fixture,
  message,
  stop,
  type Message,
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
        let discoveryFailure: { error: unknown } | undefined;
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
        } catch (error) {
          discoveryFailure = { error };
          throw error;
        } finally {
          await discovery.cleanup(discoveryFailure);
        }
        for (const point of points)
          for (const mode of ['kill', 'fault']) {
            const f = await fixture(source, policy);
            let scenarioFailure: { error: unknown } | undefined;
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
            } catch (error) {
              scenarioFailure = { error };
              throw error;
            } finally {
              await f.cleanup(scenarioFailure);
            }
          }
      }
    }, 180_000);
  }

/** A successful RPC must not conceal a caught write after the last admission. */
it('rejects a caught unclassified write after the final tick with its SQL', async () => {
  const f = await fixture('poll', 'immediate');
  let refused = false;
  let failure: { error: unknown } | undefined;
  try {
    const child = await f.start();
    await f.control(child, {
      stage: 'accept',
      trace: true,
      caughtWriteAfterTick: true,
    });
    await expect(f.tick(child, epoch + 2000)).rejects.toThrow(
      'Unclassified ingress write: insert into "observation_history"',
    );
    refused = true;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    // Expected refusals remain sticky even if the scenario catches tick's error.
    if (refused) {
      await expect(f.cleanup()).rejects.toThrow(
        'Unclassified ingress write: insert into "observation_history"',
      );
    } else {
      await f.cleanup(failure);
    }
  }
});

for (const boundary of ['stop', 'cleanup'] as const) {
  it(`rejects queued classification diagnostics at ${boundary}`, async () => {
    const f = await fixture('poll', 'immediate');
    let cleaned = false;
    try {
      const child = await f.start();
      // Model diagnostics already delivered after the last consumed message.
      // Use two to require a full drain, with exact SQL retained for each.
      for (const sql of [
        'INSERT INTO late_a VALUES (1)',
        'DELETE FROM late_b',
      ]) {
        child.messages.push({
          kind: 'unclassified-write',
          sql,
          message: `Unclassified ingress write: ${sql}`,
        });
      }
      const original = new Error('original scenario failure');
      cleaned = boundary === 'cleanup';
      const finished =
        boundary === 'stop' ? stop(child) : f.cleanup({ error: original });
      const error: unknown = await finished.catch(
        (failure: unknown) => failure,
      );
      expect(String(error)).toContain('INSERT INTO late_a VALUES (1)');
      expect(String(error)).toContain('DELETE FROM late_b');
      if (boundary === 'cleanup') {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw error;
        expect(error.errors).toContain(original);
        expect(String(error)).toContain('original scenario failure');
      }
    } finally {
      if (!cleaned) {
        await f.cleanup().catch((error: unknown) => {
          expect(String(error)).toContain('INSERT INTO late_a VALUES (1)');
          expect(String(error)).toContain('DELETE FROM late_b');
        });
      }
    }
  });
}

/** Watch completion must wait for diagnostics ordered before the final IPC acknowledgment. */
it('rejects a diagnostic after watch-idle before the final acknowledgment', async () => {
  const f = await fixture('watch', 'immediate');
  // This unspawned handle models IPC ordering only; it grants no process signal authority.
  const child = new ChildProcess();
  const owned: Owned = {
    child,
    messages: [],
    changed: new EventEmitter(),
    exit: Promise.resolve(),
    dead: false,
    output: '',
  };
  let round = 0;
  const push = (value: Message): void => {
    owned.messages.push(value);
    owned.changed.emit('change');
  };
  child.send = (command) => {
    if (typeof command !== 'object' || command === null) {
      throw new Error('Expected an instrumentation control object');
    }
    if ('round' in command) {
      round = Number(command.round);
    }
    if ('writtenRound' in command) {
      queueMicrotask(() => {
        push({ kind: 'controlled' });
        push({ kind: 'watch-idle', round, snapshots: ['one'] });
        // Separate turns force watch-idle to resolve before the diagnostic arrives.
        setImmediate(() =>
          push({
            kind: 'unclassified-write',
            sql: 'INSERT INTO late_watch VALUES (1)',
            message:
              'Unclassified ingress write: INSERT INTO late_watch VALUES (1)',
          }),
        );
      });
    } else if (Object.keys(command).length === 0) {
      setImmediate(() => push({ kind: 'controlled' }));
    } else {
      queueMicrotask(() => push({ kind: 'controlled' }));
    }
    return true;
  };
  try {
    await expect(f.change(owned, 'one', epoch + 2000)).rejects.toThrow(
      'INSERT INTO late_watch VALUES (1)',
    );
  } finally {
    await nextTurn();
    await f.cleanup();
  }
});

/** Cleanup must expose retry assertion causes through Vitest's normal error renderer. */
it('renders the retry failure cause and every cleanup SQL diagnostic', async () => {
  const f = await fixture('poll', 'immediate');
  let cleaned = false;
  try {
    const child = await f.start();
    const statements = [
      'INSERT INTO display_probe VALUES (1)',
      'DELETE FROM display_probe',
    ];
    for (const sql of statements) {
      child.messages.push({
        kind: 'unclassified-write',
        sql,
        message: `Unclassified ingress write: ${sql}`,
      });
    }
    const assertion = new Error('underlying scenario assertion failure');
    const original = new Error('retry stage context', { cause: assertion });
    cleaned = true;
    const error: unknown = await f
      .cleanup({ error: original })
      .catch((failure: unknown) => failure);
    let rendered = '';
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        rendered += chunk.toString();
        done();
      },
    });
    // Initialize a project for stack rendering, without collecting or running nested tests.
    const vitest = await createVitest(
      'test',
      { config: false, root: f.root, watch: false },
      {},
      { stdout: output, stderr: output },
    );
    try {
      vitest.logger.printError(error);
      // Terminal styling must not change the failure content required by this contract.
      const text = stripVTControlCharacters(rendered);
      expect(text).toContain('retry stage context');
      for (const sql of statements) {
        expect(text).toContain(sql);
      }
      expect(text).toContain(
        'Caused by: Error: underlying scenario assertion failure',
      );
      const causeOutput = text.split(
        'Caused by: Error: underlying scenario assertion failure',
      )[1];
      expect(causeOutput).toMatch(
        /daemon-ingress-kill-fault\.integration\.test\.ts:\d+:\d+/,
      );
    } finally {
      await vitest.close();
    }
  } finally {
    if (!cleaned) {
      await f.cleanup();
    }
  }
});
