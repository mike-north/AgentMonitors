/**
 * Tests for `AgentMonitorRuntime.doctorReport()` — the workspace-wide,
 * durable-state health report behind `agentmonitors doctor` (issue #267).
 *
 * Assertions trace to docs/specs/005-cli-reference.md §14 ("doctor") and the
 * per-monitor rollup contract there; they are written from the spec, not from
 * whatever the implementation currently emits.
 *
 * @see docs/specs/005-cli-reference.md
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
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');

/** A non-stateful source that emits one observation per tick (materializes an event). */
const firingSource: ObservationSource = {
  name: 'test-firing',
  scopeSchema: { type: 'object', properties: {} },
  async observe(): Promise<ObservationResult> {
    return {
      observations: [
        { title: 'Something changed', summary: 'Something changed' },
      ],
    };
  },
};

function makeRuntime(dbPath: string): AgentMonitorRuntime {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registry.register(firingSource);
  return new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
}

function writeMonitor(
  monitorsDir: string,
  id: string,
  frontmatter: string[],
): void {
  const dir = path.join(monitorsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    ['---', ...frontmatter, '---', 'Handle it.', ''].join('\n'),
    'utf-8',
  );
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-doctor-'));
  tempDirs.push(dir);
  return dir;
}

describe('AgentMonitorRuntime.doctorReport', () => {
  it('rolls up an observed monitor with its lead-session delivery counts (spec 005 §14)', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors');
    writeMonitor(monitorsDir, 'watch-src', [
      'name: Watch source',
      'watch:',
      '  type: test-firing',
      'urgency: normal',
    ]);

    const runtime = makeRuntime(':memory:');
    // Open a lead session BEFORE the tick so the emitted event projects into it.
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'doctor-lead',
        workspacePath: root,
      }),
    );
    const tick = await runtime.tick(monitorsDir, root);
    expect(tick.emittedEventIds).toHaveLength(1);

    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    expect(report.monitorsDirExists).toBe(true); // §14: directory found
    expect(report.hasLeadSession).toBe(true); // §14: lead session present
    expect(report.leadSessions).toHaveLength(1);
    expect(report.invalidCount).toBe(0);
    expect(report.monitors).toHaveLength(1);

    const monitor = report.monitors[0];
    expect(monitor?.id).toBe('watch-src'); // id = folder name (001 §)
    expect(monitor?.sourceName).toBe('test-firing'); // source type
    expect(monitor?.urgency).toBe('normal');
    expect(monitor?.valid).toBe(true);
    expect(monitor?.neverObserved).toBe(false); // it was observed on the tick
    expect(monitor?.lastObservedAt).toBeInstanceOf(Date);
    expect(monitor?.lastEventAt).toBeInstanceOf(Date);
    // The projected event is unread for the lead session — claiming ≠ acking (000 AP).
    expect(monitor?.delivery).toEqual({
      unread: 1,
      claimed: 0,
      acknowledged: 0,
    });
  });

  it('marks a never-ticked monitor as never observed with next-due = now when due (spec 005 §14)', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors');
    writeMonitor(monitorsDir, 'idle', [
      'name: Idle',
      'watch:',
      '  type: test-firing',
      'urgency: normal',
    ]);

    const runtime = makeRuntime(':memory:');
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    expect(report.hasLeadSession).toBe(false); // no session opened → marker
    const monitor = report.monitors[0];
    expect(monitor?.neverObserved).toBe(true);
    expect(monitor?.lastObservedAt).toBeUndefined();
    expect(monitor?.lastEventAt).toBeUndefined();
    expect(monitor?.due).toBe(true); // never observed → due on the next tick
    // A due monitor's next-due is "now" (scheduling stage semantics reused).
    expect(monitor?.nextDueAt?.toISOString()).toBe(NOW.toISOString());
    expect(monitor?.delivery).toEqual({
      unread: 0,
      claimed: 0,
      acknowledged: 0,
    });
  });

  it('reports an unknown-source monitor as invalid with a validation error (spec 005 §14)', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors');
    writeMonitor(monitorsDir, 'mystery', [
      'name: Mystery',
      'watch:',
      '  type: not-a-real-source',
      'urgency: normal',
    ]);

    const runtime = makeRuntime(':memory:');
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    expect(report.invalidCount).toBe(1);
    const monitor = report.monitors[0];
    expect(monitor?.valid).toBe(false);
    expect(monitor?.validationError).toContain('not-a-real-source');
  });

  // Issue #297: scheduleForMonitor() never throws — an invalid IANA timezone
  // surfaces as `PollingDecision.error` instead. `doctor` is a diagnostic
  // surface like `explain`; it must never crash on one bad monitor's config,
  // and must report the timezone failure through the SAME valid/validationError
  // shape as any other authoring error, alongside an unaffected sibling.
  it('reports an invalid schedule timezone as invalid without crashing, isolated from a healthy sibling (issue #297)', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors');
    writeMonitor(monitorsDir, 'aaa-bad-timezone', [
      'name: Bad timezone',
      'watch:',
      '  type: schedule',
      "  cron: '* * * * *'",
      '  timezone: Not/AZone',
      'urgency: normal',
    ]);
    writeMonitor(monitorsDir, 'zzz-works', [
      'name: Works fine',
      'watch:',
      '  type: test-firing',
      'urgency: normal',
    ]);

    const registry = new SourceRegistry();
    registry.register(firingSource);
    registry.register({
      name: 'schedule',
      scopeSchema: { type: 'object', properties: {} },
      observe: () => Promise.resolve({ observations: [] }),
    });
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(createDb(':memory:')),
      registry,
      [claudeCodeAdapter],
    );

    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    expect(report.invalidCount).toBe(1);
    const byId = new Map(report.monitors.map((m) => [m.id, m]));
    const badTimezone = byId.get('aaa-bad-timezone');
    expect(badTimezone?.valid).toBe(false);
    expect(badTimezone?.validationError).toContain('Not/AZone');

    // The healthy sibling is unaffected — reported valid, with its own cadence.
    const works = byId.get('zzz-works');
    expect(works?.valid).toBe(true);
    expect(works?.validationError).toBeUndefined();
  });

  it('describes cadence from the cron for schedule monitors and the interval otherwise', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors');
    // Interval source (registered) → cadence "every 5m".
    writeMonitor(monitorsDir, 'interval-mon', [
      'name: Interval',
      'watch:',
      '  type: test-firing',
      '  interval: 5m',
      'urgency: normal',
    ]);
    // Schedule monitor (unregistered source, but cadence is read from the cron).
    writeMonitor(monitorsDir, 'schedule-mon', [
      'name: Scheduled',
      'watch:',
      '  type: schedule',
      "  cron: '0 9 * * 1-5'",
      '  timezone: UTC',
      'urgency: normal',
    ]);

    const runtime = makeRuntime(':memory:');
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    const byId = new Map(report.monitors.map((m) => [m.id, m]));
    expect(byId.get('interval-mon')?.cadence).toBe('every 5m');
    expect(byId.get('schedule-mon')?.cadence).toBe("cron '0 9 * * 1-5'");
  });

  it('reports monitorsDirExists=false and no monitors when the directory is missing (spec 005 §14)', async () => {
    const root = scratch();
    const monitorsDir = path.join(root, '.claude', 'monitors'); // never created

    const runtime = makeRuntime(':memory:');
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });

    expect(report.monitorsDirExists).toBe(false);
    expect(report.monitors).toHaveLength(0);
    expect(report.invalidCount).toBe(0);
  });
});
