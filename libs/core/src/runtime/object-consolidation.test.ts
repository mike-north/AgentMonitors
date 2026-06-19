/**
 * Issue #110 — object-level event consolidation (the 2026-06-19 strategy-call
 * scope: consolidate **by object, not by monitor**; NOT cross-source
 * correlation).
 *
 * Decided behavior under verification:
 *
 *   "Consolidate by object, not by monitor: one event per changed object per
 *    notification window, reported as a before/after delta against the last-
 *    reported state; the envelope may carry multiple events when multiple
 *    objects changed; zero reasoning in the daemon."
 *
 *   Canonical case: N saves of ONE object within a single notification window
 *   must become ONE before/after delta, not N fragment events.
 *
 * These tests drive a REAL runtime tick (UAT layer) end-to-end: a stateful
 * source emits one save per tick; a `notify.strategy: debounce` window holds the
 * burst (the "notification window"); `baseline-strategy: net` is the consolidating
 * configuration (the recipient's catch-up span collapses to ONE net delta per
 * object at claim, 002 §1.1.7). We assert:
 *
 *   - N saves of object A in one window → the away recipient claims exactly ONE
 *     before/after delta for A (cursor → final), NOT N.
 *   - A second object B changed in the same window adds a SECOND delivered event
 *     in the SAME claim envelope ("per object, not per monitor").
 *   - For contrast, the canonical "N → 1" does NOT hold under the DEFAULT
 *     `incremental` strategy: the same burst delivers N ordered deltas. This pins
 *     the finding that consolidation is OPT-IN (`baseline-strategy: net`), not the
 *     default.
 *
 * Expected diff text is written BY HAND from the `buildTextDiff` format spec
 * (002 §5.2: line-level `- <n>: <before>` / `+ <n>: <after>`) and the §1.1.7
 * net semantics ("single net delta equivalent to diffing the baseline snapshot
 * against the final observation's snapshot"). No snapshot/gold-master assertions
 * (repo policy). Time is controlled with fake timers.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.7 (baseline strategy, per-recipient net)
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff format)
 * @see ../../../../docs/specs/001-monitor-definition.md §3.7 (baseline-strategy authoring; default incremental)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';
import type { MonitorEventRecord } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

const MONITOR_ID = 'spec-watch';
const OBJECT_A = 'docs/spec.md';
const OBJECT_B = 'docs/other.md';

/**
 * A stateful source whose `observe()` returns whatever observations the test
 * pre-loaded for the current tick (one entry per tick). This lets a test
 * script a precise sequence of per-object "saves" landing on successive ticks,
 * exactly as a file-watch source would report independent edits.
 */
function scriptedSource(
  ticks: { objectKey: string; snapshotText: string }[][],
): ObservationSource {
  let tickIndex = 0;
  return {
    name: 'scripted-save',
    scopeSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    stateful: true,
    observe(): Promise<ObservationResult> {
      const batch = ticks[Math.min(tickIndex, ticks.length - 1)] ?? [];
      tickIndex += 1;
      return Promise.resolve({
        observations: batch.map((b) => ({
          title: `change ${b.objectKey}`,
          summary: `change ${b.objectKey}`,
          snapshotText: b.snapshotText,
          objectKey: b.objectKey,
        })),
        nextState: { tickIndex },
      });
    },
  };
}

/**
 * Write a MONITOR.md with the scripted source, an explicit `debounce` window
 * (the "notification window"), and the supplied baseline strategy. `interval:
 * 1s` makes the monitor due on every tick (advanced clock), so each tick emits
 * one save and the debounce window holds the burst until it settles.
 */
function writeMonitor(
  rootDir: string,
  baselineStrategy: 'incremental' | 'net',
  settleFor: string,
): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors', MONITOR_ID);
  mkdirSync(monitorsDir, { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'MONITOR.md'),
    `---
name: Spec watcher
watch:
  type: scripted-save
  interval: 1s
urgency: normal
notify:
  strategy: debounce
  settle-for: ${settleFor}
baseline-strategy: ${baselineStrategy}
---
Review the spec change.
`,
    'utf-8',
  );
  return path.join(rootDir, '.claude', 'monitors');
}

/**
 * Claim the away recipient's pending catch-up at a normal-urgency lifecycle the
 * way the daemon does (turn-idle surfaces low/normal payload-less; turn-
 * interruptible surfaces the normal inbox prompt). For asserting the consolidated
 * delivered SET + per-recipient deltas we read the store directly (the daemon's
 * `claimDelivery` payload for normal urgency is the generic inbox prompt, not the
 * event list — but the same `collapseNetForClaim` runs underneath it).
 */
function claimConsolidated(
  store: RuntimeStore,
  sessionId: string,
): {
  delivered: MonitorEventRecord[];
  deltas: Map<string, string | undefined>;
} {
  const candidates = store.pendingEventsForSession(sessionId, 'normal');
  const delivered = store.collapseNetForClaim(sessionId, candidates);
  const deltas = store.perRecipientDiffsForSession(
    sessionId,
    delivered.map((e) => e.id),
  );
  store.markClaimed(
    sessionId,
    candidates.map((e) => e.id),
    'turn-interruptible',
  );
  return { delivered, deltas };
}

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  monitorsDir: string;
  rootDir: string;
}

function setup(
  baselineStrategy: 'incremental' | 'net',
  ticks: { objectKey: string; snapshotText: string }[][],
  settleFor = '30s',
): Harness {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-objconsol-'));
  tempDirs.push(rootDir);
  const db = createDb(path.join(rootDir, 'agentmon.db'));
  const registry = new SourceRegistry();
  registry.register(scriptedSource(ticks));
  const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
  return {
    runtime,
    // A second RuntimeStore over the SAME db, the pattern used elsewhere in
    // service.test.ts to read durable state the claim payload doesn't expose.
    store: new RuntimeStore(db),
    monitorsDir: writeMonitor(rootDir, baselineStrategy, settleFor),
    rootDir,
  };
}

describe('issue #110: per-object before/after consolidation (net) end-to-end', () => {
  // Canonical case: 15 saves of ONE object within a single debounce window under
  // `baseline-strategy: net` → the away recipient claims exactly ONE before/after
  // delta (cursor → final), NOT 15 fragment events. (002 §1.1.7: "single net delta
  // equivalent to diffing the baseline snapshot against the final observation's
  // snapshot"; "a within-tick burst that emits several observations for one object
  // collapses the same way".)
  it('15 saves of one object in one window → ONE consolidated before/after delta (net)', async () => {
    vi.useFakeTimers();
    const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(T0);

    const SAVES = 15;
    // Tick 0: baseline save (v0). Ticks 1..15: the burst v1..v15. A final tick
    // after the debounce window settles flushes the held burst.
    const burst = Array.from({ length: SAVES }, (_, i) => [
      { objectKey: OBJECT_A, snapshotText: `v${String(i + 1)}` },
    ]);
    const ticks = [
      [{ objectKey: OBJECT_A, snapshotText: 'v0' }],
      ...burst,
      [], // settle-flush tick: no new save
    ];

    const { runtime, store, monitorsDir, rootDir } = setup('net', ticks);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-away',
        workspacePath: rootDir,
      }),
    );

    // Tick 0 (v0): emitted immediately into a fresh debounce window; on the next
    // tick the window has not settled yet, so v0 is still held. To anchor the
    // recipient's cursor at v0 cleanly we advance past the window once for the
    // baseline, claim it, THEN run the burst inside a single fresh window.
    //
    // Tick the baseline in: advance the clock past settle-for so v0 flushes.
    await runtime.tick(monitorsDir, rootDir); // observe v0 → held in debounce
    vi.setSystemTime(T0 + 31_000); // past 30s settle
    await runtime.tick(monitorsDir, rootDir); // flush v0 (burst tick 1 also observed: v1)
    // The recipient claims so its cursor anchors at the flushed baseline state.
    claimConsolidated(store, session.id);
    // The "before" of the consolidated delta is whatever the baseline claim
    // anchored the recipient's per-object cursor to (the newest baseline-claim
    // artifact). Read it so the net delta assertion is EXACT (not a regex).
    const anchored = store.getSessionObjectCursor(
      session.id,
      MONITOR_ID,
      OBJECT_A,
      rootDir,
    )?.baselineContent;
    expect(anchored).toBeDefined();

    // Now the BURST: drive ticks within ONE debounce window. Each tick observes
    // one new save (v2..v15) and the window keeps re-arming (settle-for resets on
    // each new observation), so the whole burst accumulates as one held batch.
    let clock = T0 + 31_000;
    for (let i = 0; i < SAVES; i++) {
      clock += 1_000; // 1s between saves — well inside the 30s settle window
      vi.setSystemTime(clock);
      await runtime.tick(monitorsDir, rootDir);
    }
    // Settle: advance past the window with no new save → the burst flushes.
    clock += 31_000;
    vi.setSystemTime(clock);
    await runtime.tick(monitorsDir, rootDir);

    // The shared chain keeps EVERY save (incremental substrate, 002 §1.1.7) — we
    // are NOT collapsing the durable history, only the per-recipient delivery.
    const shared = store
      .listEvents({ monitorId: MONITOR_ID })
      .filter((e) => e.objectKey === OBJECT_A);
    expect(shared.length).toBeGreaterThan(1);

    // The away recipient claims its catch-up span: under `net`, exactly ONE
    // before/after delta for object A — NOT 15.
    const { delivered, deltas } = claimConsolidated(store, session.id);
    const deliveredForA = delivered.filter((e) => e.objectKey === OBJECT_A);
    expect(deliveredForA).toHaveLength(1);

    // The surviving delta is the endpoint (the final save of the burst).
    const finalSave = `v${String(SAVES)}`;
    expect(deliveredForA[0]?.snapshotText).toBe(finalSave);

    // Its per-recipient delta is the single net before/after: the recipient's
    // anchored cursor → the final burst save (v15). 002 §1.1.7: "single net delta
    // equivalent to diffing the baseline snapshot against the final observation's
    // snapshot." 002 §5.2 single-line format: `- 1: <before>` / `+ 1: <after>`.
    const delta = deltas.get(deliveredForA[0]?.id ?? '');
    expect(delta).toBe(`- 1: ${anchored ?? ''}\n+ 1: ${finalSave}`);
    // Exactly one before/after pair — not a multi-line replay of 15 steps.
    expect(delta?.split('\n')).toHaveLength(2);
  });

  // "Per object, not per monitor": two distinct objects changed in the SAME
  // window each yield their OWN consolidated delta in the SAME claim envelope —
  // the envelope carries MULTIPLE events (one per changed object), not one merged
  // monitor-level event and not a per-save fragment storm.
  it('two objects changed in one window → TWO consolidated deltas in one envelope (net)', async () => {
    vi.useFakeTimers();
    const T0 = new Date('2026-02-01T00:00:00.000Z').getTime();
    vi.setSystemTime(T0);

    // Baseline tick seeds both objects; then a burst where BOTH objects change
    // several times within the window.
    const ticks: { objectKey: string; snapshotText: string }[][] = [
      [
        { objectKey: OBJECT_A, snapshotText: 'a0' },
        { objectKey: OBJECT_B, snapshotText: 'b0' },
      ],
      [
        { objectKey: OBJECT_A, snapshotText: 'a1' },
        { objectKey: OBJECT_B, snapshotText: 'b1' },
      ],
      [
        { objectKey: OBJECT_A, snapshotText: 'a2' },
        { objectKey: OBJECT_B, snapshotText: 'b2' },
      ],
      [{ objectKey: OBJECT_A, snapshotText: 'a3' }],
      [],
    ];

    const { runtime, store, monitorsDir, rootDir } = setup('net', ticks);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-multi',
        workspacePath: rootDir,
      }),
    );

    // Flush + claim the baseline so cursors anchor for both objects.
    await runtime.tick(monitorsDir, rootDir); // observe a0/b0 → held
    vi.setSystemTime(T0 + 31_000);
    await runtime.tick(monitorsDir, rootDir); // flush a0/b0 (also observes a1/b1)
    claimConsolidated(store, session.id);

    // Burst: drive remaining ticks inside one window, then settle-flush.
    let clock = T0 + 31_000;
    for (const _ of [1, 2, 3]) {
      clock += 1_000;
      vi.setSystemTime(clock);
      await runtime.tick(monitorsDir, rootDir);
    }
    clock += 31_000;
    vi.setSystemTime(clock);
    await runtime.tick(monitorsDir, rootDir);

    const { delivered } = claimConsolidated(store, session.id);

    // Exactly TWO delivered events — one per changed object (per object, not per
    // monitor and not per save).
    const byObject = new Map<string, MonitorEventRecord[]>();
    for (const e of delivered) {
      const list = byObject.get(e.objectKey ?? '') ?? [];
      list.push(e);
      byObject.set(e.objectKey ?? '', list);
    }
    expect(byObject.get(OBJECT_A)).toHaveLength(1);
    expect(byObject.get(OBJECT_B)).toHaveLength(1);
    expect(delivered).toHaveLength(2);

    // Each is the endpoint state of its own object's burst.
    expect(byObject.get(OBJECT_A)?.[0]?.snapshotText).toBe('a3');
    expect(byObject.get(OBJECT_B)?.[0]?.snapshotText).toBe('b2');
  });

  // Finding-pinning contrast: the canonical "N → 1" does NOT hold under the
  // DEFAULT `incremental` strategy. The SAME burst delivers N ordered deltas —
  // proof that per-object consolidation is OPT-IN (`baseline-strategy: net`), not
  // the default. (002 §1.1.7: default is incremental → N deltas for an N-step
  // catch-up span.)
  it('DEFAULT (incremental): same burst delivers N ordered deltas — NOT consolidated', async () => {
    vi.useFakeTimers();
    const T0 = new Date('2026-03-01T00:00:00.000Z').getTime();
    vi.setSystemTime(T0);

    const SAVES = 5;
    const burst = Array.from({ length: SAVES }, (_, i) => [
      { objectKey: OBJECT_A, snapshotText: `s${String(i + 1)}` },
    ]);
    const ticks = [[{ objectKey: OBJECT_A, snapshotText: 's0' }], ...burst, []];

    const { runtime, store, monitorsDir, rootDir } = setup(
      'incremental',
      ticks,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-incr',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // observe s0 → held
    vi.setSystemTime(T0 + 31_000);
    await runtime.tick(monitorsDir, rootDir); // flush s0 (observes s1)
    claimConsolidated(store, session.id);

    let clock = T0 + 31_000;
    for (let i = 0; i < SAVES; i++) {
      clock += 1_000;
      vi.setSystemTime(clock);
      await runtime.tick(monitorsDir, rootDir);
    }
    clock += 31_000;
    vi.setSystemTime(clock);
    await runtime.tick(monitorsDir, rootDir);

    const { delivered } = claimConsolidated(store, session.id);
    const deliveredForA = delivered.filter((e) => e.objectKey === OBJECT_A);

    // Under the DEFAULT incremental strategy, every save in the catch-up span is
    // delivered (play-by-play) — more than one event for the single object. This
    // is the gap: the canonical "N saves → 1 delta" is NOT the default.
    expect(deliveredForA.length).toBeGreaterThan(1);
  });
});
