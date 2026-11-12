/**
 * Held notify work keeps its timing while a valid monitor's source fails
 * (issue #558, 002 §2.6). A debounce batch flushes at its original deadline and
 * a rollup batch at its matching window even when every observe() rejects:
 * runtime timing owns the flush, so no new observation or source recovery is
 * required. The source baseline, the captured envelopes and the scheduling
 * timestamp stay as they were, the error is never turned into an event, and the
 * failure stays visible next to the flush.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2.6, §4.3, §4.4, §10.7
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const roots: string[] = [];
const clients: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Authored policies whose accepted work waits in durable notify state. */
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 10s\n';
/** The window opens at 09:00 UTC, one hour after {@link START}. */
const ROLLUP = "notify:\n  strategy: rollup\n  window: '0 9 * * *'\n";

/** First observation instant. Every test drives time from here. */
const START = new Date('2026-03-20T08:00:00.000Z');

/**
 * What the controlled source does for one monitor in one workspace. A `change`
 * reports one captured observation and advances the baseline to `ref: B`; a
 * `fail` rejects without touching anything, exactly like a source that cannot
 * reach its repository. A `stall` call stays pending until the test rejects it
 * with that same error, so the test can act while observe() is in flight.
 */
type Mode = 'quiet' | 'change' | 'fail' | 'stall';

interface MonitorSpec {
  id: string;
  notify: string;
  /** Overrides `watch.type`; `schedule` opts into cron scheduling (002 §2.2). */
  type?: string;
  /** Extra `watch` lines, e.g. an interval or a cron. */
  watch?: string;
  urgency?: string;
}

function monitorFile(spec: MonitorSpec, label: unknown = spec.id) {
  return `---\nname: ${spec.id}\nwatch:\n  type: ${spec.type ?? 'controlled'}\n  label: ${String(label)}\n${spec.watch ?? '  interval: 1s\n'}urgency: ${spec.urgency ?? 'low'}\n${spec.notify}---\nHandle ${spec.id}.\n`;
}

/**
 * A file-backed runtime over one shared SQLite file, with one or more
 * workspaces that each own a monitors tree. Each workspace/monitor pair has its
 * own source mode, so siblings and same-id monitors in other workspaces can be
 * driven independently.
 */
function fixture(workspaces: Record<string, MonitorSpec[]>) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'held-work-source-errors-'));
  roots.push(root);
  const dbPath = path.join(root, 'state.sqlite');
  const modes = new Map<string, Mode>();
  const calls = new Map<string, number>();
  const stalled: ((error: Error) => void)[] = [];
  let announceStall: (() => void) | undefined;
  const modeKey = (workspace: string, id: string) =>
    JSON.stringify([workspace, id]);
  const paths: Record<string, { workspace: string; monitors: string }> = {};
  for (const [name, specs] of Object.entries(workspaces)) {
    const workspace = path.join(root, name);
    const monitors = path.join(workspace, 'monitors');
    for (const spec of specs) {
      mkdirSync(path.join(monitors, spec.id), { recursive: true });
      writeFileSync(
        path.join(monitors, spec.id, 'MONITOR.md'),
        monitorFile(spec),
      );
      modes.set(modeKey(workspace, spec.id), 'quiet');
    }
    mkdirSync(monitors, { recursive: true });
    paths[name] = { workspace, monitors };
  }

  const observe: ObservationSource['observe'] = (config, context) => {
    const key = modeKey(context.workspacePath ?? '', String(config['label']));
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const mode = modes.get(key) ?? 'quiet';
    if (mode === 'fail')
      return Promise.reject(
        new Error(`repository unavailable for ${String(config['label'])}`),
      );
    if (mode === 'stall') {
      return new Promise((_resolve, reject) => {
        stalled.push(reject);
        announceStall?.();
      });
    }
    const previous = context.previousState as { ref?: string } | undefined;
    return Promise.resolve({
      observations:
        mode === 'change'
          ? [
              {
                title: `Captured ${String(config['label'])}`,
                objectKey: 'ref',
                snapshotText: `content of ${String(config['label'])}`,
                payload: { captured: true },
              },
            ]
          : [],
      nextState: { ref: mode === 'change' ? 'B' : (previous?.ref ?? 'A') },
    });
  };
  const scopeSchema = {
    type: 'object',
    properties: {
      label: { type: 'string' },
      interval: { type: 'string' },
      cron: { type: 'string' },
    },
  };

  function open() {
    const db = createDb(dbPath);
    const client: unknown = Reflect.get(db, '$client');
    if (!(client instanceof Database))
      throw new Error('Expected an owned SQLite connection');
    clients.push(client);
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register({
      name: 'controlled',
      stateful: true,
      scopeSchema,
      observe,
    });
    registry.register({
      name: 'schedule',
      stateful: true,
      scopeSchema,
      observe,
    });
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime };
  }
  let current = open();
  const sessions = Object.fromEntries(
    Object.entries(paths).map(([name, { workspace }]) => [
      name,
      current.runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: `lead-${name}`,
          workspacePath: workspace,
        }),
      ).id,
    ]),
  );

  const ws = (name: string) => {
    const entry = paths[name];
    if (!entry) throw new Error(`unknown workspace ${name}`);
    return entry;
  };
  return {
    paths,
    set(name: string, id: string, mode: Mode) {
      modes.set(modeKey(ws(name).workspace, id), mode);
    },
    /** Resolves once an observe() call in `stall` mode is pending. */
    nextStall: () =>
      new Promise<void>((resolve) => {
        announceStall = resolve;
      }),
    /** Reject every pending `stall` call as an unavailable repository. */
    failStalled(label: string) {
      for (const reject of stalled.splice(0))
        reject(new Error(`repository unavailable for ${label}`));
    },
    calls: (name: string, id: string) =>
      calls.get(modeKey(ws(name).workspace, id)) ?? 0,
    at(iso: string) {
      vi.setSystemTime(new Date(iso));
    },
    tick: (name: string) =>
      current.runtime.tick(ws(name).monitors, ws(name).workspace),
    state: (name: string, id: string) =>
      current.store.getMonitorState(id, ws(name).workspace),
    events: (name: string, id: string) =>
      current.store
        .listEvents({ monitorId: id, workspacePath: ws(name).workspace })
        .reverse(),
    sessionEvents: (name: string) =>
      current.store.listEvents({ sessionId: sessions[name] ?? '' }),
    history: (name: string, id: string) =>
      current.store
        .listObservationHistory({
          monitorId: id,
          workspacePath: ws(name).workspace,
        })
        .map((row) => ({ result: row.result, data: row.observationData })),
    explain: (name: string, id: string) =>
      current.runtime.explainMonitor({
        monitorId: id,
        monitorsDir: ws(name).monitors,
        workspacePath: ws(name).workspace,
      }),
    rewrite(name: string, spec: MonitorSpec, label: unknown) {
      writeFileSync(
        path.join(ws(name).monitors, spec.id, 'MONITOR.md'),
        monitorFile(spec, label),
      );
    },
    remove(name: string, id: string) {
      rmSync(path.join(ws(name).monitors, id), {
        recursive: true,
        force: true,
      });
    },
    /** Declare an ephemeral monitor on the controlled source for the workspace's lead session. */
    declareEphemeral(name: string, label: string, urgency: string) {
      return current.runtime.declareEphemeralMonitor({
        sessionId: sessions[name] ?? '',
        source: 'controlled',
        scope: { label, interval: '1s' },
        urgency,
      });
    },
    cancelEphemeral: (name: string, ephemeralId: string) =>
      current.runtime.cancelEphemeralMonitor(sessions[name] ?? '', ephemeralId),
    exec: (sql: string) => current.client.exec(sql),
    reopen() {
      current.client.close();
      current = open();
    },
    dbPath,
  };
}

/** Held envelopes, or an empty list once a flush has cleared them. */
function heldTitles(state: { notifyState: Record<string, unknown> }) {
  const notify = state.notifyState as {
    pendingDebounce?: { observations: { observation: { title: string } }[] };
    pendingRollup?: { observations: { observation: { title: string } }[] };
  };
  return (
    notify.pendingDebounce?.observations ??
    notify.pendingRollup?.observations ??
    []
  ).map((envelope) => envelope.observation.title);
}

/** Accept one change into held work at 08:00:01 and start failing the source. */
async function holdThenFail(
  f: ReturnType<typeof fixture>,
  name = 'a',
  id = 'held',
) {
  await f.tick(name); // 08:00:00 baseline `ref: A`
  f.set(name, id, 'change');
  f.at('2026-03-20T08:00:01.000Z');
  const accepted = await f.tick(name);
  expect(accepted.emittedEventIds).toEqual([]);
  f.set(name, id, 'fail');
  const held = f.state(name, id);
  expect(heldTitles(held)).toEqual([`Captured ${id}`]);
  expect(held.sourceState).toEqual({ ref: 'B' });
  return held;
}

const flushCases = [
  {
    strategy: 'debounce',
    notify: DEBOUNCE,
    // dueAt = 08:00:01 + 10s
    before: '2026-03-20T08:00:10.000Z',
    deadline: '2026-03-20T08:00:11.000Z',
  },
  {
    strategy: 'rollup',
    notify: ROLLUP,
    before: '2026-03-20T08:59:59.000Z',
    deadline: '2026-03-20T09:00:00.000Z',
  },
] as const;

describe('held notify work despite source observation failures (#558)', () => {
  it.each(flushCases)(
    '$strategy: flushes at the original deadline while every observe() rejects, preserving the baseline and captured work',
    async ({ notify, before, deadline }) => {
      const f = fixture({ a: [{ id: 'held', notify }] });
      const held = await holdThenFail(f);

      // Before the deadline: the failure is reported and nothing moves.
      f.at(before);
      const early = await f.tick('a');
      expect(early.emittedEventIds).toEqual([]);
      expect(early.erroredObservations).toEqual([
        { monitorId: 'held', message: 'repository unavailable for held' },
      ]);
      expect(f.state('a', 'held')).toEqual(held);

      // At the deadline: the held batch flushes with no new observation.
      f.at(deadline);
      const flushed = await f.tick('a');
      expect(f.calls('a', 'held')).toBe(4); // the source was still asked, and failed
      expect(flushed.emittedEventIds).toHaveLength(1);
      // The failure stays visible beside the successful flush.
      expect(flushed.erroredObservations).toEqual([
        { monitorId: 'held', message: 'repository unavailable for held' },
      ]);

      // Exactly the accepted observation, with its captured content, urgency
      // and observation time; nothing is manufactured from the error.
      const events = f.events('a', 'held');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: flushed.emittedEventIds[0],
        // The named monitor's title, with the captured source title as the
        // summary (002 §5.4).
        title: 'held',
        summary: 'Captured held',
        snapshotText: 'content of held',
        urgency: 'low',
        objectKey: 'ref',
        createdAt: new Date('2026-03-20T08:00:01.000Z'),
      });
      expect(f.sessionEvents('a').map((event) => event.id)).toEqual(
        flushed.emittedEventIds,
      );

      // The baseline and the scheduling timestamp are the last good ones; only
      // the hold is gone.
      const after = f.state('a', 'held');
      expect(after.sourceState).toEqual(held.sourceState);
      expect(after.lastObservationAt).toEqual(held.lastObservationAt);
      expect(heldTitles(after)).toEqual([]);

      // Audit: the flush is recorded, and the newest row is still the failure.
      expect(f.history('a', 'held').slice(0, 2)).toEqual([
        {
          result: 'errored',
          data: { error: 'repository unavailable for held' },
        },
        { result: 'triggered', data: { observed: 0, emitted: 1 } },
      ]);
      const report = await f.explain('a', 'held');
      expect(
        report.stages.find((stage) => stage.id === 'observation'),
      ).toMatchObject({
        status: 'failure',
        reason: 'Source observation failed: repository unavailable for held',
      });
    },
  );

  it('does not manufacture an event or touch state when a failing source holds nothing', async () => {
    const f = fixture({ a: [{ id: 'held', notify: DEBOUNCE }] });
    await f.tick('a');
    const before = f.state('a', 'held');
    f.set('a', 'held', 'fail');
    for (const at of ['2026-03-20T08:00:05.000Z', '2026-03-20T08:01:00.000Z']) {
      f.at(at);
      const result = await f.tick('a');
      expect(result.emittedEventIds).toEqual([]);
      expect(result.erroredObservations).toHaveLength(1);
    }
    expect(f.events('a', 'held')).toEqual([]);
    expect(f.state('a', 'held')).toEqual(before);
    expect(f.history('a', 'held').map((row) => row.result)).toEqual([
      'errored',
      'errored',
      'no-change',
    ]);
  });

  it.each(flushCases)(
    '$strategy: a permanently unavailable source flushes once, keeps failing visibly and never re-delivers',
    async ({ notify, deadline }) => {
      const f = fixture({ a: [{ id: 'held', notify }] });
      const held = await holdThenFail(f);
      const instants = [
        deadline,
        new Date(new Date(deadline).getTime() + 1_000).toISOString(),
        new Date(new Date(deadline).getTime() + 60_000).toISOString(),
        // The next day's window opens on an empty batch: no empty delivery.
        new Date(new Date(deadline).getTime() + 86_400_000).toISOString(),
      ];
      const emitted: string[] = [];
      for (const at of instants) {
        f.at(at);
        const result = await f.tick('a');
        emitted.push(...result.emittedEventIds);
        expect(result.erroredObservations).toEqual([
          { monitorId: 'held', message: 'repository unavailable for held' },
        ]);
      }
      expect(emitted).toHaveLength(1);
      expect(f.events('a', 'held')).toHaveLength(1);
      const after = f.state('a', 'held');
      expect(after.sourceState).toEqual(held.sourceState);
      expect(after.lastObservationAt).toEqual(held.lastObservationAt);
      expect(heldTitles(after)).toEqual([]);
      expect(
        f.history('a', 'held').filter((row) => row.result === 'triggered'),
      ).toHaveLength(1);
    },
  );

  it.each(flushCases)(
    '$strategy: held work survives close/reopen and flushes from the reopened store while the source fails',
    async ({ notify, before, deadline }) => {
      const f = fixture({ a: [{ id: 'held', notify }] });
      const held = await holdThenFail(f);
      f.at(before);
      await f.tick('a');
      f.reopen();
      expect(f.state('a', 'held')).toEqual(held);
      f.at(deadline);
      const flushed = await f.tick('a');
      expect(flushed.emittedEventIds).toHaveLength(1);
      expect(flushed.erroredObservations).toHaveLength(1);
      f.reopen();
      const after = f.state('a', 'held');
      expect(heldTitles(after)).toEqual([]);
      expect(after.sourceState).toEqual(held.sourceState);
      expect(after.lastObservationAt).toEqual(held.lastObservationAt);
      expect(f.events('a', 'held').map((event) => event.id)).toEqual(
        flushed.emittedEventIds,
      );
    },
  );

  it.each(flushCases)(
    '$strategy: a failed flush write keeps the accepted work held for the next tick',
    async ({ notify, deadline }) => {
      const f = fixture({ a: [{ id: 'held', notify }] });
      const held = await holdThenFail(f);
      f.exec(
        "CREATE TRIGGER flush_fault BEFORE UPDATE ON monitor_state WHEN NEW.monitor_id = 'held' AND NEW.notify_state IS NOT OLD.notify_state BEGIN SELECT RAISE(ABORT, 'flush state fault'); END",
      );
      f.at(deadline);
      const failed = await f.tick('a');
      expect(failed.emittedEventIds).toEqual([]);
      expect(failed.erroredObservations).toContainEqual({
        monitorId: 'held',
        message: 'repository unavailable for held',
      });
      expect(
        failed.erroredObservations.some(({ message }) =>
          message.includes('flush state fault'),
        ),
      ).toBe(true);
      // The whole flush rolled back: no event, and the hold is intact.
      expect(f.events('a', 'held')).toEqual([]);
      expect(f.state('a', 'held')).toEqual(held);
      expect(f.history('a', 'held')[0]?.result).toBe('errored');

      f.exec('DROP TRIGGER flush_fault');
      f.at(new Date(new Date(deadline).getTime() + 1_000).toISOString());
      const retried = await f.tick('a');
      expect(retried.emittedEventIds).toHaveLength(1);
      expect(f.events('a', 'held')).toHaveLength(1);
      expect(heldTitles(f.state('a', 'held'))).toEqual([]);
    },
  );

  it('keeps sibling monitors progressing while one source fails and its held flush fails', async () => {
    const f = fixture({
      a: [
        { id: 'held', notify: DEBOUNCE },
        { id: 'sibling', notify: '' },
      ],
    });
    await holdThenFail(f);
    f.exec(
      "CREATE TRIGGER flush_fault BEFORE UPDATE ON monitor_state WHEN NEW.monitor_id = 'held' AND NEW.notify_state IS NOT OLD.notify_state BEGIN SELECT RAISE(ABORT, 'flush state fault'); END",
    );
    f.set('a', 'sibling', 'change');
    f.at('2026-03-20T08:00:11.000Z');
    const faulted = await f.tick('a');
    expect(f.events('a', 'sibling').map((event) => event.id)).toEqual(
      faulted.emittedEventIds,
    );
    expect(faulted.emittedEventIds).toHaveLength(1);
    expect(heldTitles(f.state('a', 'held'))).toEqual(['Captured held']);

    f.exec('DROP TRIGGER flush_fault');
    f.at('2026-03-20T08:00:12.000Z');
    const both = await f.tick('a');
    expect(f.events('a', 'held')).toHaveLength(1);
    expect(f.events('a', 'sibling')).toHaveLength(2);
    expect(both.emittedEventIds).toHaveLength(2);
    expect(f.state('a', 'sibling').sourceState).toEqual({ ref: 'B' });
    expect(both.erroredObservations).toEqual([
      { monitorId: 'held', message: 'repository unavailable for held' },
    ]);
  });

  it('flushes only the failing workspace’s held work for a monitor id shared across workspaces', async () => {
    const f = fixture({
      a: [{ id: 'held', notify: DEBOUNCE }],
      b: [{ id: 'held', notify: DEBOUNCE }],
    });
    await holdThenFail(f, 'a');
    // Workspace b holds its own work later, so its deadline is still ahead.
    await f.tick('b');
    f.set('b', 'held', 'change');
    f.at('2026-03-20T08:00:06.000Z');
    await f.tick('b');
    f.set('b', 'held', 'fail');
    const heldB = f.state('b', 'held');
    expect(heldTitles(heldB)).toEqual(['Captured held']);

    f.at('2026-03-20T08:00:11.000Z');
    const flushedA = await f.tick('a');
    const stillB = await f.tick('b');
    expect(flushedA.emittedEventIds).toHaveLength(1);
    expect(stillB.emittedEventIds).toEqual([]);
    expect(f.events('a', 'held')).toHaveLength(1);
    expect(f.events('b', 'held')).toEqual([]);
    expect(f.state('b', 'held')).toEqual(heldB);
    expect(f.sessionEvents('b')).toEqual([]);

    f.at('2026-03-20T08:00:16.000Z');
    const flushedB = await f.tick('b');
    expect(flushedB.emittedEventIds).toHaveLength(1);
    expect(f.sessionEvents('a').map((event) => event.id)).toEqual(
      flushedA.emittedEventIds,
    );
    expect(f.sessionEvents('b').map((event) => event.id)).toEqual(
      flushedB.emittedEventIds,
    );
  });

  describe('due and not-due source paths', () => {
    /** A cron-scheduled source: due at minute 0 of each hour only (002 §2.2). */
    const scheduled = (notify: string): MonitorSpec => ({
      id: 'held',
      notify,
      type: 'schedule',
      watch: "  cron: '0 * * * *'\n",
    });

    it('debounce: the failing source’s next due tick flushes work accepted before the failure', async () => {
      const f = fixture({ a: [scheduled(DEBOUNCE)] });
      f.set('a', 'held', 'change');
      await f.tick('a'); // 08:00 due: accepted, dueAt 08:00:10
      f.set('a', 'held', 'fail');
      const held = f.state('a', 'held');
      expect(heldTitles(held)).toEqual(['Captured held']);
      f.at('2026-03-20T09:00:00.000Z');
      const flushed = await f.tick('a');
      expect(flushed.emittedEventIds).toHaveLength(1);
      expect(flushed.erroredObservations).toHaveLength(1);
      expect(f.state('a', 'held').lastObservationAt).toEqual(
        held.lastObservationAt,
      );
    });

    it('rollup: a not-due tick still opens the window after the source has failed (existing not-due window check)', async () => {
      const f = fixture({
        a: [scheduled("notify:\n  strategy: rollup\n  window: '30 9 * * *'\n")],
      });
      f.set('a', 'held', 'change');
      await f.tick('a'); // 08:00 due: accepted into the batch
      f.set('a', 'held', 'fail');
      f.at('2026-03-20T09:00:00.000Z');
      const failed = await f.tick('a'); // due: rejects, window closed
      expect(failed.emittedEventIds).toEqual([]);
      expect(failed.erroredObservations).toHaveLength(1);
      const callsAfterFailure = f.calls('a', 'held');
      f.at('2026-03-20T09:30:00.000Z');
      const flushed = await f.tick('a'); // not due: the source is not asked
      expect(f.calls('a', 'held')).toBe(callsAfterFailure);
      expect(flushed.emittedEventIds).toHaveLength(1);
      expect(heldTitles(f.state('a', 'held'))).toEqual([]);
    });
  });

  describe('definitions that cannot be trusted keep held work blocked (#554/#556)', () => {
    it('a schema-invalid definition never flushes held work, even past its deadline', async () => {
      const spec = { id: 'held', notify: DEBOUNCE };
      const f = fixture({ a: [spec] });
      const held = await holdThenFail(f);
      f.rewrite('a', spec, 5); // `label` must be a string
      f.at('2026-03-20T08:00:11.000Z');
      const result = await f.tick('a');
      expect(result.emittedEventIds).toEqual([]);
      expect(result.skippedMonitors).toEqual([
        expect.objectContaining({
          monitorId: 'held',
          validationError: expect.any(String),
        }),
      ]);
      expect(f.state('a', 'held')).toEqual(held);
      expect(f.events('a', 'held')).toEqual([]);
    });

    it('a definition rejected while observe() is in flight closes the gate, so the failure flushes nothing', async () => {
      const spec = { id: 'held', notify: DEBOUNCE };
      const f = fixture({ a: [spec] });
      const held = await holdThenFail(f);
      f.set('a', 'held', 'stall');
      f.at('2026-03-20T08:00:11.000Z');
      const stalled = f.nextStall();
      const inFlight = f.tick('a');
      await stalled;
      // A concurrent rescan finds the edited, schema-invalid definition and
      // closes the admission gate to protect the held work (002 §2.0, §4.6).
      f.rewrite('a', spec, 5);
      const rescan = await f.tick('a');
      expect(rescan.skippedMonitors).toEqual([
        expect.objectContaining({
          monitorId: 'held',
          validationError: expect.any(String),
        }),
      ]);
      f.failStalled('held');
      const failed = await inFlight;
      expect(failed.emittedEventIds).toEqual([]);
      expect(failed.erroredObservations).toEqual([
        { monitorId: 'held', message: 'repository unavailable for held' },
      ]);
      expect(f.state('a', 'held')).toEqual(held);
      expect(f.events('a', 'held')).toEqual([]);
    });

    it('a monitor retired while observe() is in flight flushes nothing when the failure arrives', async () => {
      // An ephemeral monitor of `high` urgency holds a debounce batch by default
      // (15s settle, 002 §4.3). Its next due tick is in flight when the declaring
      // session cancels it; the reaped declaration is retired (002 §2.2, §10.7),
      // so the failure that follows must not flush the hold into an event for it
      // (002 §2.6: the flush runs only while the admission gate is open).
      const f = fixture({ a: [] });
      const record = f.declareEphemeral('a', 'eph', 'high');
      await f.tick('a'); // 08:00:00 baseline `ref: A`
      f.set('a', 'eph', 'change');
      f.at('2026-03-20T08:00:01.000Z');
      expect((await f.tick('a')).emittedEventIds).toEqual([]);
      const held = f.state('a', record.id);
      expect(heldTitles(held)).toEqual(['Captured eph']);

      f.set('a', 'eph', 'stall');
      f.at('2026-03-20T08:00:16.000Z'); // dueAt = 08:00:01 + 15s
      const stalled = f.nextStall();
      const inFlight = f.tick('a');
      await stalled;
      f.cancelEphemeral('a', record.id);
      f.failStalled('eph');
      const failed = await inFlight;

      expect(failed.emittedEventIds).toEqual([]);
      expect(f.events('a', record.id)).toEqual([]);
      expect(f.sessionEvents('a')).toEqual([]);
      expect(f.state('a', record.id)).toEqual(held); // the hold was not flushed
      expect(
        f.history('a', record.id).some((row) => row.result === 'triggered'),
      ).toBe(false);
      // The source failure is still recorded as for any failing poll (002 §10.7).
      expect(failed.erroredObservations).toEqual([
        { monitorId: record.id, message: 'repository unavailable for eph' },
      ]);
    });

    it('a missing definition never flushes held work, even past its deadline', async () => {
      const f = fixture({ a: [{ id: 'held', notify: DEBOUNCE }] });
      const held = await holdThenFail(f);
      f.remove('a', 'held');
      f.at('2026-03-20T08:00:11.000Z');
      const result = await f.tick('a');
      expect(result.emittedEventIds).toEqual([]);
      expect(f.state('a', 'held')).toEqual(held);
      expect(f.events('a', 'held')).toEqual([]);
    });
  });

  it('process death after the flush commits leaves the delivered work durable and the failure re-reported', async () => {
    const f = fixture({
      a: [
        {
          id: 'held',
          notify: `${DEBOUNCE}payload:\n  form: prose\n`,
        },
      ],
    });
    const held = await holdThenFail(f);
    f.reopen();
    const { workspace, monitors } = f.paths['a'] ?? {
      workspace: '',
      monitors: '',
    };

    // A real child process ticks at the deadline with a rejecting source. Its
    // Interpret adapter announces that the flush committed and never returns;
    // the parent then SIGKILLs it before the tick reaches its audit write.
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(
          new URL('./test-fixtures/held-flush-worker.mjs', import.meta.url),
        ),
        f.dbPath,
        monitors,
        workspace,
        String(new Date('2026-03-20T08:00:11.000Z').getTime()),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        killSignal: 'SIGKILL',
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
      child.on('exit', (code, signal) => resolve(signal ?? code));
    });
    const committed = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('\n')) resolve(stdout.trim());
      });
      void exited.then((status) =>
        reject(
          new Error(
            `worker exited (${String(status)}) before committing: ${stderr}`,
          ),
        ),
      );
    });
    expect(committed).toBe('interpreting');
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');

    f.reopen();
    const after = f.state('a', 'held');
    expect(heldTitles(after)).toEqual([]);
    expect(after.sourceState).toEqual(held.sourceState);
    expect(after.lastObservationAt).toEqual(held.lastObservationAt);
    const events = f.events('a', 'held');
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Captured held');

    // The scheduling timestamp did not advance, so the next tick asks the
    // source again: the failure is recorded again and nothing is re-delivered.
    f.at('2026-03-20T08:00:12.000Z');
    const next = await f.tick('a');
    expect(next.emittedEventIds).toEqual([]);
    expect(next.erroredObservations).toEqual([
      { monitorId: 'held', message: 'repository unavailable for held' },
    ]);
    expect(f.events('a', 'held')).toHaveLength(1);
    expect(f.history('a', 'held')[0]?.result).toBe('errored');
  }, 30_000);
});
