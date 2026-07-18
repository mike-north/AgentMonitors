/**
 * Regression tests for issue #436 (human review finding, service.ts
 * `toDeliveryEventSummary`): the `diffText` a transport receives on a
 * {@link DeliveryEventSummary} MUST be THIS recipient's per-recipient delta
 * (`session_event_state.diff_text`, computed against its OWN baseline cursor),
 * NOT the shared latest-snapshot delta on `MonitorEventRecord.diffText`.
 *
 * The bug: the delivery mapper populated `diffText` from the shared
 * `MonitorEventRecord.diffText`. Under divergent recipient cursors that surfaces
 * the WRONG change summary — a recipient last seen at `a1` should receive the
 * full `a1→a3` span, but the shared row only carries `a2→a3` (the latest
 * snapshot delta). That is incomplete/incorrect evidence and violates the
 * per-recipient Diff + session-isolation contract (002 §1.1.2). Both the claim
 * path (`claimDelivery`) and the preview path (`previewSettledHighDelivery`) go
 * through the same mapper, so both are covered.
 *
 * Expected diff text is written BY HAND from the `buildTextDiff` format spec
 * (002 §5.2: line-level `- <n>: <before>` / `+ <n>: <after>`), never captured
 * from program output. No snapshot/gold-master assertions (repo policy).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.2 (the shared/per-recipient seam)
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff format)
 * @see ../../../../docs/specs/006-agent-integration.md §4.2.1 (change summary on the delivery surface)
 * @see ../../../../docs/specs/roadmap.md §G10
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const MONITOR_ID = 'watcher';
const OBJECT_KEY = 'obj-1';

/**
 * Deterministic, strictly-increasing event timestamps well in the past — so
 * every high-urgency event is comfortably past the 15s claim-time settle window
 * against the real clock (no fake timers needed for the settle gate).
 */
let clock = 0;
function nextTime(): Date {
  clock += 1_000;
  return new Date(Date.UTC(2024, 0, 1) + clock);
}

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  /** A REAL temp dir — the claim path writes each session's hook-state file here. */
  workspace: string;
  /** On-disk DB path — needed to force a legacy NULL row (see {@link nullOutPerRecipientDiff}). */
  dbPath: string;
}

function freshRuntime(): Harness {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-prdeliv-'));
  tempDirs.push(rootDir);
  const dbPath = path.join(rootDir, 'agentmon.db');
  const store = new RuntimeStore(createDb(dbPath));
  const runtime = new AgentMonitorRuntime(store, new SourceRegistry());
  return { runtime, store, workspace: rootDir, dbPath };
}

/**
 * Force a `session_event_state` row back to the pre-G10 shape (NULL
 * per-recipient `diff_text`) to exercise the legacy fallback path. The store
 * only ever WRITES this column at projection time, so a regression test for
 * the legacy migration case must produce the NULL directly — done over a
 * second raw better-sqlite3 connection to the same on-disk DB (WAL mode
 * allows concurrent readers/writers). Mirrors the identical helper in
 * `per-recipient-diff.test.ts`.
 */
function nullOutPerRecipientDiff(
  dbPath: string,
  sessionId: string,
  eventId: string,
): void {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(
        'UPDATE session_event_state SET diff_text = NULL WHERE session_id = ? AND event_id = ?',
      )
      .run(sessionId, eventId);
  } finally {
    raw.close();
  }
}

function openLead(h: Harness, hostSessionId: string): string {
  return h.store.openSession({
    adapter: 'claude-code',
    hostSessionId,
    agentIdentity: hostSessionId,
    role: 'lead',
    workspacePath: h.workspace,
    hookStatePath: path.join(h.workspace, `${hostSessionId}.json`),
  }).id;
}

/**
 * Materialize ONE shared HIGH-urgency event for {@link OBJECT_KEY} carrying
 * `artifact`, exactly as `processObservation` does: diff against the latest
 * stored snapshot for the SHARED `monitor_events.diff_text`, project + compute
 * each recipient's per-recipient `diff_text` inside `insertEvent`, then persist
 * the new snapshot. Returns the event id.
 */
function materializeHigh(h: Harness, artifact: string): string {
  const { store, workspace } = h;
  const previous = store.latestSnapshot(MONITOR_ID, OBJECT_KEY, workspace);
  const sharedDiff = previous
    ? buildTextDiff(previous.content, artifact)
    : null;
  const event = store.insertEvent(
    {
      workspacePath: workspace,
      monitorId: MONITOR_ID,
      sourceName: 'manual',
      urgency: 'high',
      title: artifact,
      body: 'Review the change.',
      summary: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: artifact,
      diffText: sharedDiff,
      objectKey: OBJECT_KEY,
      baselineStrategy: 'incremental',
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    },
    { previousContent: previous?.content ?? null },
  );
  store.saveSnapshot({
    workspacePath: workspace,
    monitorId: MONITOR_ID,
    objectKey: OBJECT_KEY,
    eventId: event.id,
    content: artifact,
  });
  return event.id;
}

describe('per-recipient change summary on the delivery surface (issue #436)', () => {
  /**
   * Two lead sessions at divergent cursors receive the SAME shared event via the
   * preview + claim paths, but each `diffText` spans that recipient's OWN
   * baseline: A (caught up to a2) spans a2→a3; B (still at a1) spans a1→a3. The
   * shared `MonitorEventRecord.diffText` is only a2→a3, so surfacing it to B
   * would be the bug this guards against.
   */
  it('surfaces divergent per-recipient diffs (not the shared latest-snapshot delta) to two recipients', () => {
    const h = freshRuntime();
    const { runtime, store } = h;
    const aId = openLead(h, 'sess-A');
    const bId = openLead(h, 'sess-B');

    // obs1 (a1): baseline for both. obs2 (a2): both still co-registered at a1.
    const e1 = materializeHigh(h, 'a1');
    const e2 = materializeHigh(h, 'a2');

    // A claims through a2 → A's cursor advances to a2. B never claims → B stays
    // anchored at a1. Their baselines now diverge.
    store.markClaimed(aId, [e1, e2], 'turn-interruptible');

    // obs3 (a3): ONE shared event projected into both.
    const e3 = materializeHigh(h, 'a3');

    // The shared latest-snapshot delta on the event row is a2→a3 — what the buggy
    // mapper would have surfaced to EVERY recipient regardless of cursor.
    expect(store.getEventById(e3).diffText).toBe('- 1: a2\n+ 1: a3');

    // Preview path (read-only): each recipient's e3 change summary spans its own
    // baseline.
    const previewDiff = (sessionId: string): string | undefined =>
      runtime
        .previewSettledHighDelivery(sessionId)
        .find((event) => event.eventId === e3)?.diffText;

    expect(previewDiff(aId)).toBe('- 1: a2\n+ 1: a3'); // A: a2→a3
    expect(previewDiff(bId)).toBe('- 1: a1\n+ 1: a3'); // B: a1→a3 (full span)
    expect(previewDiff(aId)).not.toBe(previewDiff(bId));

    // Claim path (mutating): the same mapper feeds the surfaced claim. Claims are
    // per-session and independent, so ordering does not matter.
    const claimDiff = (sessionId: string): string | undefined =>
      runtime
        .claimDelivery(sessionId, 'turn-interruptible')
        ?.events.find((event) => event.eventId === e3)?.diffText;

    expect(claimDiff(aId)).toBe('- 1: a2\n+ 1: a3'); // A: a2→a3
    expect(claimDiff(bId)).toBe('- 1: a1\n+ 1: a3'); // B: a1→a3 (full span)
  });

  /**
   * Legacy fallback: a row whose per-recipient `diff_text` is genuinely NULL
   * (pre-G10, forced via {@link nullOutPerRecipientDiff} — the store only ever
   * WRITES this column at projection time, so no in-band call produces a NULL
   * row today) MUST fall back to the shared `MonitorEventRecord.diffText`, so
   * an existing install keeps surfacing a change summary rather than dropping
   * it.
   *
   * Regression note (issue #442 review): the prior version of this test never
   * actually nulled the row — a single co-registered session's per-recipient
   * delta happens to equal the shared diff BY COINCIDENCE (pre-G10 parity), so
   * `perRecipientDiffsForSession(...) ?? event.diffText` never executed its
   * fallback branch. Deleting the fallback would have left that version green.
   */
  it('falls back to the shared diff when the per-recipient delta is NULL (legacy row)', () => {
    const h = freshRuntime();
    const { runtime, store, dbPath } = h;
    const onlyId = openLead(h, 'sess-only');

    materializeHigh(h, 'a1'); // baseline
    const e2 = materializeHigh(h, 'a2');

    const shared = store.getEventById(e2).diffText;
    expect(shared).toBe('- 1: a1\n+ 1: a2');

    // Force the projected per-recipient row back to the pre-G10 NULL shape.
    nullOutPerRecipientDiff(dbPath, onlyId, e2);

    // The batch reader MUST omit a NULL per-recipient row entirely (its own
    // contract — see `perRecipientDiffsForSession`'s doc comment), not surface
    // it as an empty string.
    expect(store.perRecipientDiffsForSession(onlyId, [e2]).has(e2)).toBe(false);

    // Both the preview (read-only) and claim (mutating) delivery paths go
    // through the SAME mapper, so both must fall back to the shared diff.
    const previewDiff = runtime
      .previewSettledHighDelivery(onlyId)
      .find((event) => event.eventId === e2)?.diffText;
    expect(previewDiff).toBe(shared ?? undefined);

    const claimDiff = runtime
      .claimDelivery(onlyId, 'turn-interruptible')
      ?.events.find((event) => event.eventId === e2)?.diffText;
    expect(claimDiff).toBe(shared ?? undefined);
  });
});
