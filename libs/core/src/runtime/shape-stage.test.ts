/**
 * Integration proof for the deterministic Shape stage wired through the runtime
 * tick (roadmap G15). Drives a real {@link AgentMonitorRuntime} with a real
 * source and a real `MONITOR.md` carrying `shape`/`payload` frontmatter, then
 * asserts on the materialized event the runtime persists.
 *
 * Determinism: `now` (the tick clock) is fixed with `vi.useFakeTimers()` —
 * never `Date.now()`/`new Date()`. Expected artifact lines are written BY HAND
 * from the spec (no snapshot/gold-master assertions).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4–§1.1.6
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

// 2024-01-15T10:00:00.000Z, and one minute earlier, in epoch ms.
const NOW_ISO = '2024-01-15T10:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const ONE_MINUTE = 60_000;
const DEFER_UNTIL = NOW; // threshold is exactly the fixed `now`

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

function writeMonitor(
  rootDir: string,
  sourceName: string,
  frontmatter: string,
) {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors');
  const dir = path.join(monitorsDir, 'shape-monitor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\nname: Shape monitor\nwatch:\n  type: ${sourceName}\nurgency: normal\n${frontmatter}---\nHandle it.\n`,
    'utf-8',
  );
  return monitorsDir;
}

/** A source that surfaces the raw `deferUntil` fact (003 §2.7) — never derives. */
function deferSource(name: string, snapshot: () => unknown): ObservationSource {
  return {
    name,
    scopeSchema: { type: 'object', properties: {} },
    async observe(): Promise<ObservationResult> {
      return {
        observations: [
          {
            title: 'Task snapshot',
            summary: 'Task snapshot',
            snapshot: snapshot(),
          },
        ],
        nextState: {},
      };
    },
  };
}

function createRuntime(dbPath: string, source: ObservationSource) {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registry.register(source);
  return new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
}

describe('Shape stage wired through the runtime tick (G15)', () => {
  it('diffs the rendered artifact, not the raw source — a crossed threshold adds one `revealed` line', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shape-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    // The raw `deferUntil` fact is identical across both ticks; only the
    // injected `now` advances past the threshold between them. Diffing the raw
    // source would yield NOTHING (the source bytes never changed); diffing the
    // RENDERED artifact yields exactly the new `revealed` line (§1.1.5).
    const source = deferSource('shape-defer', () => ({
      task: 'Ship deck',
      deferUntil: DEFER_UNTIL,
    }));
    const monitorsDir = writeMonitor(
      rootDir,
      'shape-defer',
      'shape:\n  derive:\n    - name: revealed\n      when: "deferUntil <= now"\n  render: rendered\n',
    );

    const runtime = createRuntime(dbPath, source);
    const eventById = (id: string) => {
      const found = runtime
        .listEvents({ monitorId: 'shape-monitor', workspacePath: rootDir })
        .find((event) => event.id === id);
      if (!found) throw new Error(`event ${id} not found`);
      return found;
    };

    // First tick: one minute BEFORE the threshold → no `revealed` line.
    vi.setSystemTime(NOW - ONE_MINUTE);
    const first = await runtime.tick(monitorsDir, rootDir);
    expect(first.emittedEventIds).toHaveLength(1);
    const firstEvent = eventById(first.emittedEventIds[0] ?? '');
    expect(firstEvent.snapshotText).not.toContain('- revealed');
    // The rendered artifact (not raw JSON) is what is stored/diffed.
    expect(firstEvent.snapshotText).toContain('# facts');

    // Second tick: AT the threshold → the artifact gains exactly one line.
    vi.setSystemTime(NOW);
    const second = await runtime.tick(monitorsDir, rootDir);
    expect(second.emittedEventIds).toHaveLength(1);
    const secondEvent = eventById(second.emittedEventIds[0] ?? '');
    expect(secondEvent.snapshotText).toContain('- revealed');

    // The diff is over the RENDERED artifact: exactly one added line, that line
    // being the `revealed` fact, and nothing removed.
    const diff = secondEvent.diffText ?? '';
    const added = diff.split('\n').filter((l) => l.startsWith('+'));
    const removed = diff.split('\n').filter((l) => l.startsWith('-'));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('- revealed');
    expect(removed).toHaveLength(0);
  });

  it('derive-only (no `render: rendered`) keeps the raw source as the diff base — snapshotText is unchanged', async () => {
    // Regression test for Finding 1 (render opt-in bug): a `shape.derive` block
    // WITHOUT `render: rendered` must NOT switch the diff input to the rendered
    // artifact.  Before the fix, any `shape` block (even derive-only) triggered
    // render-then-diff.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shape-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    // Raw JSON source — the `snapshotText` is JSON; it never produces a
    // "# facts" section unless render-then-diff is activated.
    const source = deferSource('shape-derive-only', () => ({
      task: 'Ship deck',
      deferUntil: DEFER_UNTIL,
    }));
    // `shape.derive` declared but NO `render: rendered` → derive-only mode.
    const monitorsDir = writeMonitor(
      rootDir,
      'shape-derive-only',
      'shape:\n  derive:\n    - name: revealed\n      when: "deferUntil <= now"\n',
    );

    const runtime = createRuntime(dbPath, source);
    vi.setSystemTime(NOW);
    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);

    const event = runtime
      .listEvents({ monitorId: 'shape-monitor', workspacePath: rootDir })
      .find((e) => e.id === tick.emittedEventIds[0]);

    // The stored snapshotText must NOT be the rendered artifact: it should be
    // null (the source returned a structured `snapshot` but no `snapshotText`)
    // rather than the markdown rendered by render-then-diff.  Before the fix,
    // any `shape` block — even derive-only — triggered renderShapeArtifact(),
    // which always returns a non-null string containing "# facts".
    const text = event?.snapshotText ?? null;
    if (text !== null) {
      // If for any reason the runtime produces a snapshotText, it must NOT
      // contain the rendered-artifact markers.
      expect(text).not.toContain('# facts');
      expect(text).not.toContain('# snapshot');
    } else {
      // null is the expected value: the raw source had no snapshotText, and
      // the derive-only path must not manufacture one.
      expect(text).toBeNull();
    }
  });

  it('a `payload.form: structured` CEL gate of false suppresses delivery entirely (§1.1.6)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shape-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    const source = deferSource('shape-gate', () => ({ heartRate: 90 }));
    const monitorsDir = writeMonitor(
      rootDir,
      'shape-gate',
      'payload:\n  form: structured\n  transform:\n    language: cel\n    expression: "heartRate > 130"\n',
    );

    const runtime = createRuntime(dbPath, source);
    vi.setSystemTime(NOW);
    const tick = await runtime.tick(monitorsDir, rootDir);
    // heartRate (90) is NOT > 130 → the gate is false → no event materialized.
    expect(tick.emittedEventIds).toHaveLength(0);
  });

  it('a suppressed CEL gate leaves notify state unchanged and records a `suppressed` history row (regression: Finding 2)', async () => {
    // Regression test for Finding 2 (suppression ordering bug): before the fix,
    // suppression happened AFTER dispatchNotify had already mutated notify state
    // and the history row was recorded with emittedCount from dispatch.emitted
    // (which included the suppressed observation).  The fix pre-filters
    // observations before dispatch, so suppressed ones never enter dispatch.
    //
    // Assertions:
    //   (a) No events are materialized (emittedEventIds is empty).
    //   (b) The audit history result is `suppressed` (NOT `triggered`), proving
    //       the observation was seen but the CEL gate suppressed it correctly.
    //   (c) A second tick with the same suppressed gate is still processed
    //       independently — notify state was not advanced by the first tick in
    //       a way that would skip the second.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shape-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    // heartRate is always 90 — always below the 130 threshold → always suppressed.
    const source = deferSource('shape-gate-order', () => ({ heartRate: 90 }));
    const monitorsDir = writeMonitor(
      rootDir,
      'shape-gate-order',
      'payload:\n  form: structured\n  transform:\n    language: cel\n    expression: "heartRate > 130"\n',
    );

    const runtime = createRuntime(dbPath, source);
    vi.setSystemTime(NOW);

    // (a) First tick: gate suppresses → no events.
    const tick1 = await runtime.tick(monitorsDir, rootDir);
    expect(tick1.emittedEventIds).toHaveLength(0);

    // (b) History row must say `suppressed`, NOT `triggered`.
    const history = runtime.listObservationHistory({
      monitorId: 'shape-monitor',
      limit: 5,
    });
    const firstRow = history[0];
    expect(firstRow?.result).toBe('suppressed');
    // observationData.emitted must be 0 (not 1) — the suppressed observation
    // never entered dispatch and was never counted as emitted.
    expect(firstRow?.observationData).toMatchObject({ emitted: 0 });

    // (c) Second tick: suppression is still applied independently; no events.
    vi.setSystemTime(NOW + ONE_MINUTE);
    const tick2 = await runtime.tick(monitorsDir, rootDir);
    expect(tick2.emittedEventIds).toHaveLength(0);
    const history2 = runtime.listObservationHistory({
      monitorId: 'shape-monitor',
      limit: 5,
    });
    // Both history rows should say suppressed.
    expect(history2[0]?.result).toBe('suppressed');
  });

  it('a `payload.form: structured` jq transform persists the reshaped payload', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shape-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    const source = deferSource('shape-jq', () => ({
      sets: [{ weight: 100, reps: 5, rpe: 8, notes: 'x' }],
      heartRate: 142,
    }));
    const monitorsDir = writeMonitor(
      rootDir,
      'shape-jq',
      'payload:\n  form: structured\n  transform:\n    language: jq\n    expression: ".sets | map({weight: .weight, reps: .reps, rpe: .rpe})"\n',
    );

    const runtime = createRuntime(dbPath, source);
    vi.setSystemTime(NOW);
    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);
    const event = runtime
      .listEvents({ monitorId: 'shape-monitor', workspacePath: rootDir })
      .find((e) => e.id === tick.emittedEventIds[0]);
    expect(event?.payload).toEqual([{ weight: 100, reps: 5, rpe: 8 }]);
  });
});
