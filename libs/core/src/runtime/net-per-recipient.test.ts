/**
 * Tests for roadmap G10 PR-B: the `net` baseline collapse and the G14 Interpret
 * stage rewired onto the PER-RECIPIENT seam (002 §1.1.7 / §1.1.8).
 *
 * PR-A moved the Diff right of the Pace→Diff seam (each recipient diffs the
 * shared artifact against its OWN baseline cursor). PR-B completes the rewire:
 *
 *  - The shared `monitor_events` chain records EVERY observation in order (the
 *    incremental substrate, Decision Q3) — `net` is NO LONGER collapsed on the
 *    shared side. Instead `net` is a PER-RECIPIENT decision at CLAIM time: group
 *    a recipient's unclaimed events per `objectKey`; for a `net` monitor deliver
 *    only the NEWEST event per object (diff recomputed against the recipient's
 *    cursor) and record the older intermediates CLAIMED-BUT-SUPPRESSED (retained
 *    + explainable via `monitor explain`, never delivered). `incremental`
 *    (default) delivers all in order.
 *  - Interpret runs per DISTINCT per-recipient delta — two recipients at
 *    divergent baselines invoke the adapter twice; identical baselines once.
 *
 * Expected diff text is written BY HAND from the `buildTextDiff` format spec
 * (002 §5.2: line-level `- <n>: <before>` / `+ <n>: <after>`), never captured
 * from program output. No snapshot/gold-master assertions (repo policy). Time is
 * controlled deterministically (monotone synthetic event timestamps, or fake
 * timers for the runtime path).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.7 (baseline strategy, per-recipient net)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.8 (Interpret per distinct delta)
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff format)
 * @see ../../../../docs/specs/roadmap.md §G10
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
} from '../adapter/interpret.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';
import type { MonitorEventRecord } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const MONITOR_ID = 'watcher';
const OBJECT_KEY = 'obj-1';
const WORKSPACE = '/ws';

/** Deterministic, strictly-increasing event timestamps (no real clock). */
let clock = 0;
function nextTime(): Date {
  clock += 1_000;
  return new Date(Date.UTC(2026, 0, 1) + clock);
}

function freshStore(): RuntimeStore {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-netpr-'));
  tempDirs.push(rootDir);
  return new RuntimeStore(createDb(path.join(rootDir, 'agentmon.db')));
}

/** Open a lead session and return its id (the store-level helpers key on id). */
function openLead(store: RuntimeStore, hostSessionId: string): string {
  return store.openSession({
    adapter: 'claude-code',
    hostSessionId,
    agentIdentity: hostSessionId,
    role: 'lead',
    workspacePath: WORKSPACE,
    hookStatePath: path.join(WORKSPACE, `${hostSessionId}.json`),
  }).id;
}

/**
 * Materialize ONE shared event for {@link OBJECT_KEY} carrying `artifact`,
 * exactly as `processObservation` does, with the given `baselineStrategy`
 * persisted on the event. Returns the event id.
 */
function materialize(
  store: RuntimeStore,
  artifact: string,
  baselineStrategy: 'incremental' | 'net',
): string {
  const previous = store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE);
  const sharedDiff = previous
    ? buildTextDiff(previous.content, artifact)
    : null;
  const event = store.insertEvent(
    {
      workspacePath: WORKSPACE,
      monitorId: MONITOR_ID,
      sourceName: 'manual',
      urgency: 'normal',
      title: artifact,
      body: '',
      summary: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: artifact,
      diffText: sharedDiff,
      objectKey: OBJECT_KEY,
      baselineStrategy,
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    },
    { previousContent: previous?.content ?? null },
  );
  store.saveSnapshot({
    workspacePath: WORKSPACE,
    monitorId: MONITOR_ID,
    objectKey: OBJECT_KEY,
    eventId: event.id,
    content: artifact,
  });
  return event.id;
}

/** The per-recipient delta a session recorded for one event (NULL → undefined). */
function recipientDelta(
  store: RuntimeStore,
  sessionId: string,
  eventId: string,
): string | undefined {
  return store.perRecipientDiffsForSession(sessionId, [eventId]).get(eventId);
}

/**
 * Claim a recipient's UNCLAIMED set the way `claimDelivery` does for a
 * concrete-event lifecycle (the turn-interruptible/idle branches use
 * `pendingEventsForSession`, which excludes already-claimed rows — so a prior
 * claim's events are not re-collapsed): collapse `net` (delivered subset), then
 * mark the FULL candidate set claimed so the cursor advances and the suppressed
 * intermediates are consumed. Returns the delivered (post-collapse) events.
 */
function claimNet(
  store: RuntimeStore,
  sessionId: string,
): MonitorEventRecord[] {
  const candidates = store.pendingEventsForSession(sessionId);
  const delivered = store.collapseNetForClaim(sessionId, candidates);
  store.markClaimed(
    sessionId,
    candidates.map((event) => event.id),
    'turn-interruptible',
  );
  return delivered;
}

describe('net per-recipient collapse at claim (G10 PR-B, 002 §1.1.7)', () => {
  // Criterion 1: a recipient AWAY across 3 separate-tick edits to one object
  // under `net` claims and receives exactly ONE net delta (cursor → artifact3);
  // the two intermediates are recorded claimed-but-suppressed (explainable, not
  // delivered).
  it('1a. away across 3 separate ticks under net → ONE net delta (cursor→a3), 2 intermediates suppressed', () => {
    const store = freshStore();
    const away = openLead(store, 'sess-away');

    // The recipient is caught up to its baseline a0 (claims the baseline event so
    // its cursor anchors at a0). Then three separate-tick edits a1, a2, a3 land
    // while it is AWAY — it never claims between them, so its cursor stays at a0.
    materialize(store, 'a0', 'net'); // baseline
    claimNet(store, away); // recipient caught up: cursor → a0

    const e1 = materialize(store, 'a1', 'net');
    const e2 = materialize(store, 'a2', 'net');
    const e3 = materialize(store, 'a3', 'net');

    const delivered = claimNet(store, away);

    // Exactly ONE net delta delivered — the newest event (a3).
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.id).toBe(e3);

    // Its per-recipient delta spans the recipient's cursor (a0) → endpoint (a3),
    // a single net delta — NOT a replay of a1/a2. 002 §5.2 line format.
    expect(recipientDelta(store, away, e3)).toBe('- 1: a0\n+ 1: a3');

    // The TWO intermediates (a1, a2) are recorded claimed-but-suppressed:
    // retained + explainable, never delivered.
    const projections = store.listDeliveryProjectionsForMonitor(
      MONITOR_ID,
      WORKSPACE,
    );
    const suppressed = projections.filter(
      (p) => p.sessionId === away && p.netSuppressed,
    );
    expect(suppressed.map((p) => p.eventId).sort()).toEqual([e1, e2].sort());
    // The newest (a3) is NOT suppressed.
    expect(
      projections.find((p) => p.sessionId === away && p.eventId === e3)
        ?.netSuppressed,
    ).toBeUndefined();

    // The suppressed intermediates are excluded from delivery surfaces.
    const unreadIds = store
      .unreadEventsForSession(away)
      .map((event) => event.id);
    expect(unreadIds).not.toContain(e1);
    expect(unreadIds).not.toContain(e2);
  });

  // Criterion 1 (incremental contrast): the SAME away scenario under
  // `incremental` delivers all 3 ordered deltas — none suppressed.
  it('1b. same away scenario under incremental → 3 ordered deltas, none suppressed', () => {
    const store = freshStore();
    const away = openLead(store, 'sess-incr');

    materialize(store, 'a0', 'incremental'); // baseline
    claimNet(store, away); // recipient caught up: cursor → a0
    const e1 = materialize(store, 'a1', 'incremental');
    const e2 = materialize(store, 'a2', 'incremental');
    const e3 = materialize(store, 'a3', 'incremental');

    const delivered = claimNet(store, away);

    // All three intermediate deltas delivered, in order (the play-by-play).
    expect(delivered.map((event) => event.id)).toEqual([e1, e2, e3]);

    // None are net-suppressed.
    const projections = store.listDeliveryProjectionsForMonitor(
      MONITOR_ID,
      WORKSPACE,
    );
    expect(
      projections.filter((p) => p.sessionId === away && p.netSuppressed),
    ).toHaveLength(0);

    // Each delta is the incremental step against the recipient's then-current
    // cursor: a0→a1, a1→a2, a2→a3 (002 §5.2). The cursor only advances at claim,
    // so at projection time every event diffed against the seeded a0 baseline;
    // the FIRST event's delta is a0→a1 and is the one delivered in order.
    expect(recipientDelta(store, away, e1)).toBe('- 1: a0\n+ 1: a1');
  });

  // Criterion 1 (recipient that missed nothing): a recipient that claims after
  // every single edit gets a single-step delta under BOTH strategies — `net`
  // and `incremental` are identical in the degenerate one-observation span.
  it('1c. a recipient that missed nothing gets the single-step delta under both strategies', () => {
    for (const strategy of ['net', 'incremental'] as const) {
      const store = freshStore();
      const live = openLead(store, `sess-live-${strategy}`);

      materialize(store, 'a0', strategy); // baseline
      claimNet(store, live); // claim baseline → cursor a0

      const e1 = materialize(store, 'a1', strategy);
      const delivered1 = claimNet(store, live);
      expect(delivered1.map((e) => e.id)).toEqual([e1]);
      expect(recipientDelta(store, live, e1)).toBe('- 1: a0\n+ 1: a1');

      const e2 = materialize(store, 'a2', strategy);
      const delivered2 = claimNet(store, live);
      expect(delivered2.map((e) => e.id)).toEqual([e2]);
      expect(recipientDelta(store, live, e2)).toBe('- 1: a1\n+ 1: a2');

      // Nothing was ever suppressed — every span had exactly one observation.
      const projections = store.listDeliveryProjectionsForMonitor(
        MONITOR_ID,
        WORKSPACE,
      );
      expect(
        projections.filter((p) => p.sessionId === live && p.netSuppressed),
      ).toHaveLength(0);
    }
  });

  // Criterion 2 (backward-compat / degenerate equivalence): a `net` monitor with
  // a single session that never misses a window behaves exactly like today (one
  // event per window), and `net` ≡ `incremental` in that degenerate case.
  it('2. net with a never-missing session ≡ incremental (one delta per window)', () => {
    const states = ['s0', 's1', 's2'];

    function run(strategy: 'net' | 'incremental'): string[] {
      const store = freshStore();
      const only = openLead(store, `sess-bc-${strategy}`);
      const deliveredDeltas: string[] = [];
      let firstBaselineConsumed = false;
      for (const state of states) {
        materialize(store, state, strategy);
        const delivered = claimNet(store, only);
        for (const event of delivered) {
          const delta = recipientDelta(store, only, event.id);
          // The baseline event has no delta (nothing precedes it).
          if (delta !== undefined) deliveredDeltas.push(delta);
        }
        firstBaselineConsumed = true;
      }
      expect(firstBaselineConsumed).toBe(true);
      return deliveredDeltas;
    }

    const net = run('net');
    const incremental = run('incremental');
    // Identical, single-step deltas: s0→s1 then s1→s2.
    expect(net).toEqual(['- 1: s0\n+ 1: s1', '- 1: s1\n+ 1: s2']);
    expect(net).toEqual(incremental);
  });

  // Criterion 2 (co-registered, never-miss): two sessions both claiming after
  // every edit each get the single-step delta; nothing suppressed for either.
  it('2b. two co-registered never-missing sessions each get single-step deltas, none suppressed', () => {
    const store = freshStore();
    const a = openLead(store, 'sess-co-A');
    const b = openLead(store, 'sess-co-B');

    materialize(store, 'a0', 'net'); // baseline
    claimNet(store, a);
    claimNet(store, b);

    const e1 = materialize(store, 'a1', 'net');
    const da = claimNet(store, a);
    const db = claimNet(store, b);
    expect(da.map((e) => e.id)).toEqual([e1]);
    expect(db.map((e) => e.id)).toEqual([e1]);
    expect(recipientDelta(store, a, e1)).toBe('- 1: a0\n+ 1: a1');
    expect(recipientDelta(store, b, e1)).toBe('- 1: a0\n+ 1: a1');

    const projections = store.listDeliveryProjectionsForMonitor(
      MONITOR_ID,
      WORKSPACE,
    );
    expect(projections.filter((p) => p.netSuppressed)).toHaveLength(0);
  });

  // Criterion 4 (no shared-collapse regression): the shared `monitor_events`
  // chain keeps every intermediate for a `net` monitor (N=4: baseline + 3),
  // while the per-recipient `net` delivery is exactly 1.
  it('4. shared chain keeps all N intermediates while per-recipient net delivery is 1', () => {
    const store = freshStore();
    const away = openLead(store, 'sess-reg');

    materialize(store, 'a0', 'net');
    materialize(store, 'a1', 'net');
    materialize(store, 'a2', 'net');
    materialize(store, 'a3', 'net');

    // Shared chain: every observation recorded (baseline + 3 edits = 4).
    const shared = store.listEvents({ monitorId: MONITOR_ID });
    expect(shared).toHaveLength(4);
    // Every edit's snapshot survives on the shared chain — nothing folded.
    expect(shared.map((e) => e.snapshotText).sort()).toEqual([
      'a0',
      'a1',
      'a2',
      'a3',
    ]);

    // Per-recipient net delivery: exactly one.
    const delivered = claimNet(store, away);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.snapshotText).toBe('a3');
  });

  // Cursor-advance correctness when intermediates are suppressed: after a net
  // claim that suppressed a1/a2 and delivered a3, the recipient's NEXT span must
  // start from a3 (the newest claimed artifact), not from a1.
  it('cursor advances to the newest claimed artifact even when intermediates are suppressed', () => {
    const store = freshStore();
    const away = openLead(store, 'sess-advance');

    materialize(store, 'a0', 'net'); // baseline → cursor a0
    materialize(store, 'a1', 'net');
    materialize(store, 'a2', 'net');
    materialize(store, 'a3', 'net');
    claimNet(store, away); // delivers a3, suppresses a1/a2, cursor → a3

    const cursor = store.getSessionObjectCursor(
      away,
      MONITOR_ID,
      OBJECT_KEY,
      WORKSPACE,
    );
    expect(cursor?.baselineContent).toBe('a3');

    // A later edit a4: the recipient now spans a3 → a4 (proof the cursor moved
    // to the delivered endpoint, not a stale intermediate).
    const e4 = materialize(store, 'a4', 'net');
    const delivered = claimNet(store, away);
    expect(delivered.map((e) => e.id)).toEqual([e4]);
    expect(recipientDelta(store, away, e4)).toBe('- 1: a3\n+ 1: a4');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 3: G14 Interpret per DISTINCT per-recipient delta (002 §1.1.8).
// Driven through the real runtime tick so the per-recipient deltas are produced
// by the genuine projection path (PR-A seam), with a deterministic fake adapter.
// ───────────────────────────────────────────────────────────────────────────

/** A source emitting one observation per tick with the next supplied snapshot. */
function scriptedSource(snapshots: string[]): ObservationSource {
  let index = 0;
  return {
    name: 'scripted',
    scopeSchema: { type: 'object', properties: {}, additionalProperties: true },
    stateful: true,
    observe(): Promise<ObservationResult> {
      const snapshotText = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return Promise.resolve({
        observations: [
          {
            title: 'change',
            summary: 'change',
            snapshotText,
            objectKey: 'obj-1',
          },
        ],
        nextState: { index },
      });
    },
  };
}

interface RecordingFake extends InterpretAdapter {
  readonly calls: InterpretInput[];
}

/** A fake adapter that records every delta it is handed and always delivers. */
function recordingDeliverAdapter(): RecordingFake {
  const calls: InterpretInput[] = [];
  return {
    name: 'fake-interpret',
    calls,
    interpret(input: InterpretInput): Promise<InterpretResult> {
      calls.push(input);
      // Digest keyed on the delta so distinct deltas yield distinct verdicts.
      return Promise.resolve({
        decision: 'deliver',
        digest: `digest:${input.delta}`,
      });
    },
  };
}

function writeProseMonitor(rootDir: string): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors', 'interp');
  mkdirSync(monitorsDir, { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'MONITOR.md'),
    `---
name: Interpret monitor
watch:
  type: scripted
  interval: 1s
urgency: normal
payload:
  form: prose
---
Tell me only if the change is substantive.
`,
    'utf-8',
  );
  return path.join(rootDir, '.claude', 'monitors');
}

const TICK_GAP_MS = 1_100;
function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TICK_GAP_MS));
}

function setupProse(fake: InterpretAdapter): {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  monitorsDir: string;
  rootDir: string;
} {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-interp-pr-'));
  tempDirs.push(rootDir);
  const store = new RuntimeStore(createDb(path.join(rootDir, 'agentmon.db')));
  const registry = new SourceRegistry();
  registry.register(scriptedSource(['v1', 'v2', 'v3']));
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    fake,
  );
  return { runtime, store, monitorsDir: writeProseMonitor(rootDir), rootDir };
}

describe('Interpret per distinct delta on the per-recipient seam (G10 PR-B, 002 §1.1.8)', () => {
  // Criterion 3: two recipients at DIVERGENT baselines → adapter invoked TWICE
  // for the shared event (one call per distinct delta), each verdict recorded on
  // its own session.
  it('3a. two recipients at divergent baselines → adapter invoked TWICE (one per distinct delta)', async () => {
    const fake = recordingDeliverAdapter();
    const { runtime, store, monitorsDir, rootDir } = setupProse(fake);
    const a = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-A',
        workspacePath: rootDir,
      }),
    );
    const b = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-B',
        workspacePath: rootDir,
      }),
    );

    // Tick 1 (v1 baseline): both seed their cursor to v1 → identical → ONE call.
    await runtime.tick(monitorsDir, rootDir);
    expect(fake.calls).toHaveLength(1);

    // Tick 2 (v2): both still co-registered at v1 → identical v1→v2 → ONE call.
    await pause();
    await runtime.tick(monitorsDir, rootDir);
    expect(fake.calls).toHaveLength(2);

    // A claims through v2 → A's cursor advances to v2. B stays away → B's cursor
    // remains at v1. Their baselines now DIVERGE.
    runtime.claimDelivery(a.id, 'turn-interruptible');

    // Tick 3 (v3): ONE shared event, but A spans v2→v3 while B spans v1→v3 —
    // DISTINCT deltas → the adapter is invoked TWICE for this event.
    await pause();
    await runtime.tick(monitorsDir, rootDir);
    expect(fake.calls).toHaveLength(4); // 1 + 1 + 2 (divergent)

    // The two v3 calls carried the two DISTINCT per-recipient deltas.
    const v3Calls = fake.calls.slice(2).map((c) => c.delta);
    expect(new Set(v3Calls).size).toBe(2);

    // Each session recorded the digest keyed on ITS OWN v3 delta.
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    const v3Event = report.events.find((e) => e.snapshotText === 'v3');
    expect(v3Event).toBeDefined();
    const projA = report.projections.find(
      (p) => p.sessionId === a.id && p.eventId === v3Event?.id,
    );
    const projB = report.projections.find(
      (p) => p.sessionId === b.id && p.eventId === v3Event?.id,
    );
    // Distinct per-recipient deltas → distinct recorded digests (verdict per
    // session, 002 §1.1.8).
    expect(projA?.interpretDigest).toBeDefined();
    expect(projB?.interpretDigest).toBeDefined();
    expect(projA?.interpretDigest).not.toBe(projB?.interpretDigest);
    void store;
  });

  // Criterion 3: two recipients at IDENTICAL baselines → adapter invoked ONCE,
  // verdict fanned to both.
  it('3b. two recipients at identical baselines → adapter invoked ONCE, verdict fanned', async () => {
    const fake = recordingDeliverAdapter();
    const { runtime, monitorsDir, rootDir } = setupProse(fake);
    const a = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-A',
        workspacePath: rootDir,
      }),
    );
    const b = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-B',
        workspacePath: rootDir,
      }),
    );

    // Both stay co-registered (neither claims), so every tick their cursors and
    // therefore their per-recipient deltas are identical → one call per tick.
    await runtime.tick(monitorsDir, rootDir); // baseline: 1 call
    expect(fake.calls).toHaveLength(1);

    await pause();
    await runtime.tick(monitorsDir, rootDir); // v2: still identical → 1 more call
    expect(fake.calls).toHaveLength(2);

    // The single v2 call's verdict was fanned to BOTH sessions (same digest).
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    const v2Event = report.events.find((e) => e.snapshotText === 'v2');
    const projA = report.projections.find(
      (p) => p.sessionId === a.id && p.eventId === v2Event?.id,
    );
    const projB = report.projections.find(
      (p) => p.sessionId === b.id && p.eventId === v2Event?.id,
    );
    expect(projA?.interpretDigest).toBe(projB?.interpretDigest);
    expect(projA?.interpretDigest).toBeDefined();
  });
});
