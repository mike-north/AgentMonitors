/**
 * `monitor explain` delivery counts for a `net` monitor: rows the per-recipient
 * net collapse suppressed are reported under their own count and are never
 * folded into `claimed` or `acknowledged` (a claimed row was surfaced to the
 * session; a net-suppressed row deliberately was not). The collapse only
 * suppresses rows that no earlier claim had already surfaced, so a later
 * recap never relabels shown rows as suppressed.
 *
 * Every expected counts object below is derived from what the scenario showed
 * the session, and is asserted exactly (`toEqual`), so an extra or missing
 * count key fails.
 *
 * A recap re-shows claimed-but-unacknowledged endpoints. It must render each
 * one with the delta that endpoint was first claimed with (this recipient's
 * cursor → endpoint), not a recomputation against a cursor that the earlier
 * claim already moved to the endpoint.
 *
 * Deltas are line-based (`buildTextDiff`, 002 §5.2): a single-line snapshot
 * changing from `a` to `b` renders as `- 1: a` / `+ 1: b`.
 *
 * @see docs/specs/002-runtime-delivery.md §1.1.7 (net collapse over unclaimed events)
 * @see docs/specs/002-runtime-delivery.md §5.2 (snapshots and diffs)
 * @see docs/specs/002-runtime-delivery.md §9 (claimed set equals rendered set)
 * @see docs/specs/005-cli-reference.md `monitor explain` delivery counts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const connections: Database.Database[] = [];
afterEach(() => {
  for (const client of connections.splice(0)) {
    if (client.open) client.close();
  }
  vi.useRealTimers();
});

/**
 * One lead session plus a single high-urgency monitor over one shared object,
 * with the given `baseline-strategy`. `emit(version)` produces exactly one
 * settled event for that object.
 */
function setup(baselineStrategy: 'net' | 'incremental') {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'explain-net-'));
  const monitorsDir = path.join(workspace, 'monitors');
  let snapshot: string | undefined;
  const source: ObservationSource = {
    name: 'versioned-object',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    observe: () =>
      Promise.resolve({
        observations:
          snapshot === undefined
            ? []
            : [
                {
                  objectKey: 'shared-object',
                  snapshotText: snapshot,
                  title: snapshot,
                  summary: snapshot,
                },
              ],
        nextState: {},
      }),
  };
  const registry = new SourceRegistry();
  registry.register(source);
  const db = createDb(path.join(workspace, 'runtime.db'));
  connections.push((db as unknown as { $client: Database.Database }).$client);
  const store = new RuntimeStore(db);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'explain-net',
      workspacePath: workspace,
    }),
  );
  mkdirSync(path.join(monitorsDir, 'net-mon'), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'net-mon', 'MONITOR.md'),
    `---
name: net-mon
watch:
  type: versioned-object
  interval: 1s
urgency: high
notify:
  strategy: debounce
  settle-for: 1s
baseline-strategy: ${baselineStrategy}
---
Handle net-mon changes.
`,
  );
  const emit = async (version: string) => {
    vi.advanceTimersByTime(60_000);
    snapshot = version;
    await runtime.tick(monitorsDir, workspace);
    snapshot = undefined;
    vi.advanceTimersByTime(60_000);
    await runtime.tick(monitorsDir, workspace);
  };
  const deliveryCounts = async () => {
    const report = await runtime.explainMonitor({
      monitorId: 'net-mon',
      monitorsDir,
      workspacePath: workspace,
    });
    return report.stages.find((stage) => stage.id === 'delivery')?.details;
  };
  const allEventIds = () =>
    store
      .listDeliveryProjectionsForMonitor('net-mon', workspace)
      .map((projection) => projection.eventId);
  const shownSummaries = (
    lifecycle: Parameters<typeof runtime.claimDelivery>[1],
  ) =>
    runtime.claimDelivery(session.id, lifecycle)?.events.map((e) => e.summary);
  /** What a claim rendered: each event's summary and per-recipient delta. */
  const shownWithDiffs = (
    lifecycle: Parameters<typeof runtime.claimDelivery>[1],
  ) =>
    runtime
      .claimDelivery(session.id, lifecycle)
      ?.events.map((e) => ({ summary: e.summary, diffText: e.diffText }));
  return {
    runtime,
    session,
    emit,
    deliveryCounts,
    allEventIds,
    shownSummaries,
    shownWithDiffs,
  };
}

describe('monitor explain delivery counts (net-suppressed rows)', () => {
  it('counts net-suppressed rows separately from claimed and unread (#572)', async () => {
    const h = setup('net');
    // v1, v2, v3 accumulate unread; one claim surfaces only the newest (v3)
    // and net-suppresses the older intermediates v1, v2.
    await h.emit('v1');
    await h.emit('v2');
    await h.emit('v3');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v3']);
    // v4 arrives after the claim and stays unread.
    await h.emit('v4');

    // Shown: v3 (claimed). Never shown: v1, v2 (suppressed), v4 (unread).
    expect(await h.deliveryCounts()).toEqual({
      claimed: 1,
      netSuppressed: 2,
      unread: 1,
    });
  });

  it('keeps net-suppressed rows out of acknowledged after an ack by event ID (#572)', async () => {
    const h = setup('net');
    await h.emit('v1');
    await h.emit('v2');
    await h.emit('v3');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v3']);

    // Ack-all acknowledges only what the session was shown (v3).
    h.runtime.acknowledgeSession(h.session.id);
    expect(await h.deliveryCounts()).toEqual({
      acknowledged: 1,
      netSuppressed: 2,
    });

    // A scoped ack naming every row (as `events ack --event-ids` can) must not
    // turn the never-shown v1, v2 into acknowledged rows.
    h.runtime.acknowledgeSession(h.session.id, h.allEventIds());
    expect(await h.deliveryCounts()).toEqual({
      acknowledged: 1,
      netSuppressed: 2,
    });
  });

  it('does not relabel rows an earlier claim showed when a recap collapses over them (#572)', async () => {
    const h = setup('net');
    await h.emit('v1');
    await h.emit('v2');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v2']);
    await h.emit('v3');
    await h.emit('v4');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v4']);
    // Shown: v2, v4. Suppressed: v1, v3.
    expect(await h.deliveryCounts()).toEqual({
      claimed: 2,
      netSuppressed: 2,
    });

    await h.emit('v5');
    // The recap renders only the newest version of the object.
    expect(h.shownSummaries('post-compact')).toEqual(['v5']);
    // Shown: v2, v4 (earlier claims) and v5 (the recap) — all claimed.
    // Only v1, v3 were never shown.
    expect(await h.deliveryCounts()).toEqual({
      claimed: 3,
      netSuppressed: 2,
    });

    // The rows the session was shown stay unread until acknowledged, so
    // ack-all acknowledges all three of them.
    h.runtime.acknowledgeSession(h.session.id);
    expect(await h.deliveryCounts()).toEqual({
      acknowledged: 3,
      netSuppressed: 2,
    });
  });

  it('reports no netSuppressed count for an incremental monitor (#572)', async () => {
    const h = setup('incremental');
    await h.emit('v1');
    await h.emit('v2');
    await h.emit('v3');
    // `incremental` delivers every version in order.
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v1', 'v2', 'v3']);
    await h.emit('v4');

    expect(await h.deliveryCounts()).toEqual({
      claimed: 3,
      unread: 1,
    });
  });
});

describe('net collapse across successive recaps', () => {
  it('keeps the endpoint delta when a later recap re-shows a claimed endpoint (#572)', async () => {
    const h = setup('net');
    await h.emit('v1');
    await h.emit('v2');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v2']);
    await h.emit('v3');
    await h.emit('v4');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v4']);
    await h.emit('v5');

    // The cursor sits at v4 (the last artifact shown), so v5's delta is
    // v4 → v5. Every recap until acknowledgement re-shows that same delta.
    const v4ToV5 = { summary: 'v5', diffText: '- 1: v4\n+ 1: v5' };
    expect(h.shownWithDiffs('post-compact')).toEqual([v4ToV5]);
    expect(h.shownWithDiffs('post-compact')).toEqual([v4ToV5]);
    expect(h.shownWithDiffs('post-compact')).toEqual([v4ToV5]);
  });

  it('keeps a claimed endpoint delta in a recap with no newer event (#572)', async () => {
    const h = setup('net');
    await h.emit('v1');
    await h.emit('v2');
    expect(h.shownSummaries('turn-interruptible')).toEqual(['v2']);
    await h.emit('v3');
    await h.emit('v4');
    // The cursor sat at v2 when v4 was claimed, so v4's delta is v2 → v4.
    const v2ToV4 = { summary: 'v4', diffText: '- 1: v2\n+ 1: v4' };
    expect(h.shownWithDiffs('turn-interruptible')).toEqual([v2ToV4]);

    expect(h.shownWithDiffs('post-compact')).toEqual([v2ToV4]);
    expect(h.shownWithDiffs('post-compact')).toEqual([v2ToV4]);
  });
});
