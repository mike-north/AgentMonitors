/**
 * Regression coverage for issue #345 (and the underlying mechanism tracked by
 * #307): `file-fingerprint` baseline / change-detection state must NOT leak
 * across two workspaces that reuse the same monitor id in one shared global DB.
 *
 * This mirrors the issue's two-project repro at the runtime layer, driving the
 * REAL bundled `file-fingerprint` source (via `registerCoreSources`) against a
 * single on-disk SQLite DB — the exact contract the daemon uses — rather than a
 * hand-built stub. Both workspaces scaffold a monitor whose id is
 * `my-first-monitor` (the getting-started default, `ID = parent dir name`), so
 * their persisted state collides on `monitorId` alone unless it is namespaced by
 * `(workspacePath, monitorId)`.
 *
 * Pre-fix, `monitor_state` was keyed by `monitorId` alone: the second
 * workspace's first tick read the first workspace's fingerprints and reported a
 * `descoped`/`deleted` change for a file that only ever existed in the other
 * project. Post-fix, each workspace keeps an independent baseline, so a second
 * project reusing the default id never observes the first project's files.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/345
 * @see https://github.com/mike-north/AgentMonitors/issues/307
 * @see docs/specs/002-runtime-delivery.md §3 (Persisted Monitor State)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
  type MonitorEventRecord,
} from '@agentmonitors/core';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCoreSources } from './sources.js';

const MONITOR_ID = 'my-first-monitor';

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Build a runtime + store pair over `dbPath` with the real bundled sources. */
function buildRuntime(dbPath: string): {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
} {
  const registry = new SourceRegistry();
  registerCoreSources(registry);
  const store = new RuntimeStore(createDb(dbPath));
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  return { runtime, store };
}

/**
 * Scaffold a workspace whose `.claude/monitors/<MONITOR_ID>/MONITOR.md` watches
 * every `.ts` file (the getting-started default recursive-TypeScript glob).
 * Returns the monitors dir the tick loop scans. `urgency: normal` so a detected
 * change materializes immediately (no high-urgency debounce settle in the way of
 * a deterministic assertion).
 */
function scaffoldWorkspace(root: string): string {
  const monitorDir = path.join(root, '.claude', 'monitors', MONITOR_ID);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    [
      '---',
      'name: My monitor',
      'watch:',
      '  type: file-fingerprint',
      '  globs:',
      "    - '**/*.ts'",
      'urgency: normal',
      '---',
      '',
      'Review and take appropriate action.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return path.join(root, '.claude', 'monitors');
}

/** Write a `.ts` file at the workspace root. */
function writeTs(root: string, name: string, body: string): void {
  writeFileSync(path.join(root, name), body, 'utf-8');
}

/**
 * Force the monitor due for `workspacePath` on the next tick without disturbing
 * its persisted source/notify baseline: re-persist the CURRENT state with
 * `lastObservationAt` reset to the epoch so `elapsed >= interval`. Deterministic
 * substitute for waiting out the real file-fingerprint poll interval.
 */
function forceDue(store: RuntimeStore, workspacePath: string): void {
  const state = store.getMonitorState(MONITOR_ID, workspacePath);
  store.setMonitorState(MONITOR_ID, workspacePath, {
    sourceState: state.sourceState,
    notifyState: state.notifyState,
    lastObservationAt: new Date(0),
  });
}

/** Every string field of an event a foreign path could hide in. */
function eventText(event: MonitorEventRecord): string {
  return [
    event.objectKey ?? '',
    event.title,
    event.summary,
    JSON.stringify(event.payload),
    JSON.stringify(event.snapshotMetadata),
  ].join('\0');
}

/** Fingerprint keys (watched file paths) persisted for one workspace scope. */
function fingerprintPaths(
  store: RuntimeStore,
  workspacePath: string,
): string[] {
  const sourceState = store.getMonitorState(MONITOR_ID, workspacePath)
    .sourceState as { fingerprints?: Record<string, string> } | undefined;
  return Object.keys(sourceState?.fingerprints ?? {});
}

describe('file-fingerprint workspace isolation (issue #345 / #307)', () => {
  it('keeps two workspaces sharing a monitor id from leaking baseline state', async () => {
    const home = tempDir('agentmon-iso-home-');
    const dbPath = path.join(home, 'inbox.db');

    const project1 = tempDir('agentmon-iso-p1-');
    const project2 = tempDir('agentmon-iso-p2-');
    const monitorsDir1 = scaffoldWorkspace(project1);
    const monitorsDir2 = scaffoldWorkspace(project2);

    // Distinct file names per project so a cross-workspace leak is unambiguous:
    // a project2 observation must never mention a `p1-*` path, and vice versa.
    writeTs(project1, 'p1-alpha.ts', 'export const a = 1;\n');
    writeTs(project2, 'p2-alpha.ts', 'export const a = 2;\n');

    // ── Daemon A: project1 ────────────────────────────────────────────────
    const a = buildRuntime(dbPath);
    a.runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'host-1',
        workspacePath: project1,
      }),
    );
    // First tick only establishes the baseline (file-fingerprint reports no
    // change on a first run), persisting project1's fingerprints under the
    // (project1, my-first-monitor) scope.
    await a.runtime.tick(monitorsDir1, project1);

    // ── Daemon B: project2, SAME db, SAME monitor id ──────────────────────
    const b = buildRuntime(dbPath);
    b.runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'host-2',
        workspacePath: project2,
      }),
    );
    // project2's FIRST-EVER tick. Pre-fix, this read project1's fingerprints
    // and emitted a `descoped` event for `p1-alpha.ts`. Post-fix it is a clean
    // baseline with zero events.
    const p2Baseline = await b.runtime.tick(monitorsDir2, project2);
    expect(p2Baseline.emittedEventIds).toHaveLength(0);

    let project2Events = b.runtime.listEvents({ workspacePath: project2 });
    expect(project2Events).toHaveLength(0);
    // The core regression assertion: nothing project2 observed references a
    // project1 path.
    for (const event of project2Events) {
      expect(eventText(event)).not.toContain('p1-');
    }

    // Baselines are independent: each scope holds only its own file.
    expect(fingerprintPaths(a.store, project1)).toEqual([
      path.join(project1, 'p1-alpha.ts'),
    ]);
    expect(fingerprintPaths(b.store, project2)).toEqual([
      path.join(project2, 'p2-alpha.ts'),
    ]);
    expect(fingerprintPaths(b.store, project2).join('\n')).not.toContain('p1-');

    // ── project2 detects its OWN change, still no leak ────────────────────
    writeTs(project2, 'p2-beta.ts', 'export const b = 2;\n');
    forceDue(b.store, project2);
    const p2Change = await b.runtime.tick(monitorsDir2, project2);
    expect(p2Change.emittedEventIds).toHaveLength(1);

    project2Events = b.runtime.listEvents({ workspacePath: project2 });
    // Exactly the new project2 file, reported as created; nothing from project1.
    expect(project2Events).toHaveLength(1);
    const created = project2Events[0];
    expect(created?.objectKey).toBe(path.join(project2, 'p2-beta.ts'));
    expect(created?.workspacePath).toBe(project2);
    for (const event of project2Events) {
      expect(eventText(event)).not.toContain('p1-');
    }
    // No spurious deletion/descope for a file that only ever existed elsewhere.
    expect(
      project2Events.some((event) => /deleted|descoped/i.test(event.title)),
    ).toBe(false);

    // Observation-history audit trail is workspace-scoped too: project2's
    // history never references project1.
    const p2History = b.runtime.listObservationHistory({
      monitorId: MONITOR_ID,
      workspacePath: project2,
    });
    expect(p2History.length).toBeGreaterThan(0);
    for (const record of p2History) {
      expect(record.workspacePath).toBe(project2);
      expect(JSON.stringify(record.observationData)).not.toContain('p1-');
    }

    // ── Restart-safety: fresh runtime over the SAME db (daemon restart) ───
    writeTs(project2, 'p2-gamma.ts', 'export const g = 3;\n');
    const c = buildRuntime(dbPath);
    forceDue(c.store, project2);
    const p2Restart = await c.runtime.tick(monitorsDir2, project2);
    // The pre-restart baseline (p2-alpha, p2-beta) survived, so only the new
    // file is a change — proving scoped state is durable, not re-baselined.
    expect(p2Restart.emittedEventIds).toHaveLength(1);
    const restartEvents = c.runtime.listEvents({ workspacePath: project2 });
    const gammaEvent = restartEvents.find(
      (event) => event.objectKey === path.join(project2, 'p2-gamma.ts'),
    );
    // The per-object text lives on `summary`; `title` is the monitor's
    // authored name since issue #449 (002 §5.4).
    expect(gammaEvent?.summary).toMatch(/created/i);
    for (const event of restartEvents) {
      expect(eventText(event)).not.toContain('p1-');
    }
    expect(fingerprintPaths(c.store, project2).sort()).toEqual(
      [
        path.join(project2, 'p2-alpha.ts'),
        path.join(project2, 'p2-beta.ts'),
        path.join(project2, 'p2-gamma.ts'),
      ].sort(),
    );

    // ── project1's own state stayed correct and project1-only throughout ──
    forceDue(c.store, project1);
    writeTs(project1, 'p1-beta.ts', 'export const b = 1;\n');
    await c.runtime.tick(monitorsDir1, project1);
    const project1Events = c.runtime.listEvents({ workspacePath: project1 });
    for (const event of project1Events) {
      expect(eventText(event)).not.toContain('p2-');
    }
    expect(fingerprintPaths(c.store, project1).join('\n')).not.toContain('p2-');
  });
});
