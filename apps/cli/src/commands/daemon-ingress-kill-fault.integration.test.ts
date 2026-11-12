/**
 * Process-boundary acceptance for 002's atomic ingress contract. The inventory
 * is captured at the real SQLite driver while real sources ingest, hold and
 * recover work. Every discovered write occurrence gets a SIGKILL and a fault
 * scenario; clocks advance by command and readiness comes only from events.
 * TODO https://github.com/mike-north/AgentMonitors/issues/615: kill during retry re-arm and skip.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type {
  MonitorEventRecord,
  RuntimeTickResult,
} from '@agentmonitors/core';
import { callDaemon } from '../daemon-ipc.js';
import { waitForOwnedGroupTermination } from '../../../../scripts/owned-test-group.mjs';

/** A mutation probe may select a scratch copy; normal/CI execution uses the built CLI. */
const cli =
  process.env.INGRESS_TEST_CLI ??
  path.resolve(import.meta.dirname, '../../dist/index.cjs');
const preload = path.join(import.meta.dirname, 'fixtures/ingress-preload.mjs');
/** Fixed wall time controls scheduling; parent timeout budgets use its real clock. */
const epoch = Date.parse('2026-01-01T00:00:02Z');
/** Private instrumentation messages contain original results or observed driver writes. */
interface Message {
  kind: string;
  [key: string]: unknown;
}
type Source = 'poll' | 'watch';
type Policy = 'immediate' | 'debounce' | 'rollup';
type Stage = 'accept' | 'flush' | 'retry-admit' | 'retry-drain';
/** Only this direct-child handle confers authority to signal a test daemon. */
interface Owned {
  child: ChildProcess;
  messages: Message[];
  changed: EventEmitter;
  exit: Promise<void>;
  dead: boolean;
  signal?: NodeJS.Signals | null;
  stopped?: Promise<void>;
  output: string;
}

/** A deadline is a failure bound, never a successful synchronization signal. */
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded 10s`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Consume a previously observed or future message without polling or sleeps. */
async function message(
  owned: Owned,
  predicate: (value: Message) => boolean,
): Promise<Message> {
  let release: (() => void) | undefined;
  try {
    return await bounded(
      new Promise<Message>((resolve, reject) => {
        const check = () => {
          // A caught runtime error must not hide a missing inventory classification.
          const unclassified = owned.messages.find(
            (value) => value.kind === 'unclassified-write',
          );
          if (unclassified) {
            reject(new Error(String(unclassified.message)));
            return;
          }
          const index = owned.messages.findIndex(predicate);
          if (index >= 0) {
            const found = owned.messages.splice(index, 1)[0];
            if (found) resolve(found);
          } else if (owned.dead) reject(new Error('Owned daemon exited'));
        };
        release = () => owned.changed.off('change', check);
        owned.changed.on('change', check);
        check();
      }),
      'Instrumentation message',
    );
  } catch (error) {
    throw new Error(
      `${String(error)}\n${owned.output}\n${JSON.stringify(owned.messages)}`,
      { cause: error },
    );
  } finally {
    release?.();
  }
}

/** Always reap the exact child before unlinking its socket or database. */
async function stop(owned: Owned): Promise<void> {
  owned.stopped ??= (async () => {
    if (!owned.dead) owned.child.kill('SIGKILL');
    await bounded(owned.exit, 'Owned daemon exit');
  })();
  await owned.stopped;
}

/** Real loopback HTTP, filesystem, socket, sessions and SQLite all belong to one case. */
async function fixture(source: Source, policy: Policy) {
  const root = mkdtempSync(path.join(tmpdir(), 'am-ingress-'));
  const socket = path.join(root, 'd.sock');
  const dbPath = path.join(root, 'inbox.db');
  const monitors = path.join(root, 'monitors');
  let body = 'baseline';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP address');
  mkdirSync(path.join(monitors, source), { recursive: true });
  const watched = path.join(root, 'watched.txt');
  writeFileSync(watched, body);
  const watchConfig =
    source === 'poll'
      ? `  type: api-poll\n  url: http://127.0.0.1:${address.port}/\n`
      : `  type: file-fingerprint\n  globs: ['watched.txt']\n  cwd: ${JSON.stringify(root)}\n`;
  const notify =
    policy === 'immediate'
      ? ''
      : policy === 'debounce'
        ? 'notify:\n  strategy: debounce\n  settle-for: 2s\n'
        : "notify:\n  strategy: rollup\n  window: '* * * * *'\n";
  writeFileSync(
    path.join(monitors, source, 'MONITOR.md'),
    `---\nname: Ingress\nwatch:\n${watchConfig}  interval: 1s\nurgency: normal\n${notify}---\nHandle the change.\n`,
  );
  const children: Owned[] = [];
  const rpc = <T>(
    method: Parameters<typeof callDaemon>[0],
    params: Record<string, unknown> = {},
  ) => callDaemon<T>(method, params, { socketPath: socket, timeoutMs: 10_000 });
  const start = async (now = epoch) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        'daemon',
        'run',
        monitors,
        '--workspace',
        root,
        '--socket',
        socket,
        '--poll-ms',
        '3600000',
        '--reap-after-ms',
        '0',
      ],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          HOME: root,
          XDG_DATA_HOME: path.join(root, 'data'),
          NODE_PATH: path.resolve(import.meta.dirname, '../../node_modules'),
          AGENTMONITORS_DB: dbPath,
          AGENTMONITORS_SOCKET: socket,
          INGRESS_TEST_NOW: String(now),
          INGRESS_TEST_WATCH: source === 'watch' ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let resolveExit!: () => void;
    const owned: Owned = {
      child,
      messages: [],
      changed: new EventEmitter(),
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      dead: false,
      output: '',
    };
    children.push(owned);
    child.on('message', (value: Message) => {
      owned.messages.push(value);
      owned.changed.emit('change');
    });
    child.on('error', (error) => {
      owned.output += error.message;
      owned.dead = true;
      resolveExit();
      owned.changed.emit('change');
    });
    child.on('close', (_code, signal) => {
      owned.signal = signal;
      owned.dead = true;
      resolveExit();
      owned.changed.emit('change');
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        owned.output = (owned.output + chunk.toString()).slice(-65_536);
      });
    await message(owned, (value) => value.kind === 'tick');
    if (source === 'watch')
      await message(owned, (value) => value.kind === 'watch-idle');
    return owned;
  };
  const control = async (owned: Owned, command: Record<string, unknown>) => {
    owned.child.send(command);
    await message(owned, (value) => value.kind === 'controlled');
  };
  const tick = async (
    owned: Owned,
    now: number,
  ): Promise<RuntimeTickResult> => {
    await control(owned, { now });
    // callDaemon has no close rejection; the owned exit bounds an abruptly closed request.
    return bounded(
      Promise.race([
        rpc<RuntimeTickResult>('daemon.tick', {
          monitorsDir: monitors,
          workspacePath: root,
        }),
        owned.exit.then(() => {
          throw new Error('Owned daemon exited during tick');
        }),
      ]),
      'Daemon tick',
    );
  };
  const open = (name: string, role = 'lead') =>
    rpc<{ id: string }>('session.open', {
      adapter: 'claude-code',
      hostSessionId: name,
      role,
      agentIdentity: 'ingress-test',
      hookStatePath: path.join(root, `${name}.json`),
      workspacePath: root,
    });
  let round = 0;
  const observeFile = async (
    owned: Owned,
    now: number,
    flush: boolean,
    expected?: string,
  ) => {
    const currentRound = ++round;
    await control(owned, { now, flush, round: currentRound });
    // Native callbacks may arrive between truncate and write on Linux. One
    // round represents a completed input, with completion ordered by IPC;
    // flush-only rounds never manufacture another filesystem transition.
    if (!flush) writeFileSync(watched, body);
    await control(owned, { writtenRound: currentRound });
    return message(
      owned,
      (value) =>
        value.kind === 'watch-error' ||
        (value.kind === 'watch-idle' &&
          value.round === currentRound &&
          (expected === undefined ||
            (Array.isArray(value.snapshots) &&
              value.snapshots.includes(expected)))),
    );
  };
  const change = async (owned: Owned, value: string, now: number) => {
    body = value;
    if (source === 'poll') return tick(owned, now);
    return observeFile(owned, now, false, value);
  };
  const flush = (owned: Owned, now: number) =>
    source === 'poll' ? tick(owned, now) : observeFile(owned, now, true);
  return {
    root,
    monitorId: source,
    objectKey:
      source === 'poll' ? `http://127.0.0.1:${address.port}/` : watched,
    dbPath,
    rpc,
    start,
    control,
    tick,
    change,
    flush,
    open,
    cleanup: async () => {
      const stopped = await Promise.allSettled(children.map(stop));
      // Direct exit is enough to restart; group confirmation is required before
      // unlinking fixtures. Check the two exclusively owned groups concurrently.
      const groups = await Promise.allSettled(
        children.map(async (owned) => {
          if (owned.child.pid && process.platform !== 'win32') {
            await waitForOwnedGroupTermination(
              owned.child.pid,
              Date.now() + 5_000,
            );
          }
        }),
      );
      server.closeAllConnections();
      await bounded(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        'HTTP close',
      );
      const failures = [...stopped, ...groups].filter(
        (result) => result.status === 'rejected',
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Owned process cleanup failed; fixture retained',
        );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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
