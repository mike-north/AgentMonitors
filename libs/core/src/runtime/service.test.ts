import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord, RuntimeTickResult } from './types.js';
import { AgentMonitorRuntime, cronMatchesDate } from './service.js';

function createRuntime(
  dbPath: string,
  source: ObservationSource,
): AgentMonitorRuntime {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registry.register(source);
  return new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
}

function createMonitorFile(
  rootDir: string,
  sourceName: string,
  // Accepts a bare level (`normal`) or an authored band (`normal..high`); the
  // value is injected verbatim into the YAML `urgency:` field.
  urgency = 'normal',
  body = 'Handle it.',
  extraWatchConfig = '',
): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors', 'test-monitor');
  const monitorFile = path.join(monitorsDir, 'MONITOR.md');
  mkdirSync(monitorsDir, { recursive: true });
  writeFileSync(
    monitorFile,
    `---
name: Test monitor
watch:
  type: ${sourceName}
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
${extraWatchConfig}
urgency: ${urgency}
---
${body}
`,
    'utf-8',
  );
  return path.join(rootDir, '.claude', 'monitors');
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('AgentMonitorRuntime', () => {
  it('matches schedule cron expressions in the configured timezone', () => {
    const when = new Date('2026-03-20T16:00:00.000Z');

    expect(cronMatchesDate('0 9 * * *', when, 'America/Los_Angeles')).toBe(
      true,
    );
    expect(cronMatchesDate('0 9 * * *', when, 'UTC')).toBe(false);
  });

  it('persists source state across runtime restarts and emits changes later', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const watchedFile = path.join(rootDir, 'watched.txt');
    writeFileSync(watchedFile, 'hello', 'utf-8');
    const monitorsDir = createMonitorFile(
      rootDir,
      'test-stateful',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'test-stateful',
      scopeSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      stateful: true,
      async observe(
        config: Record<string, unknown>,
        context: ObservationContext,
      ): Promise<ObservationResult> {
        const filePath = String(config['filePath']);
        const content = readFileSync(filePath, 'utf-8');
        const previous =
          context.previousState &&
          typeof context.previousState === 'object' &&
          !Array.isArray(context.previousState)
            ? (context.previousState as { content?: string })
            : {};

        return {
          observations:
            previous.content !== undefined && previous.content !== content
              ? [
                  {
                    title: 'Watched file changed',
                    summary: 'Watched file changed',
                    snapshotText: content,
                    objectKey: filePath,
                    queryScope: { filePath },
                  },
                ]
              : [],
          nextState: { content },
        };
      },
    };

    const firstRuntime = createRuntime(dbPath, source);
    const session = firstRuntime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-1',
        workspacePath: rootDir,
      }),
    );

    const firstTick = await firstRuntime.tick(monitorsDir, rootDir);
    expect(firstTick.emittedEventIds).toHaveLength(0);
    // Issue #117: a genuine no-change tick has no errored observations — the
    // not-a-bug case stays clean (the CLI must not "cry wolf").
    expect(firstTick.erroredObservations).toEqual([]);

    writeFileSync(watchedFile, 'hello world', 'utf-8');
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const restartedRuntime = createRuntime(dbPath, source);
    const secondTick = await restartedRuntime.tick(monitorsDir, rootDir);
    expect(secondTick.emittedEventIds).toHaveLength(1);

    const unread = restartedRuntime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.summary).toContain('Watched file changed');
  });

  // Regression for G1 / SP2: monitor state is keyed by monitorId, so a tick over a
  // tree with two folders deriving the same id must be refused, not processed.
  it('refuses to tick when two monitors derive the same id', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');

    const monitorBody = `---
name: Dup monitor
watch:
  type: file-fingerprint
  globs: ["*.ts"]
urgency: normal
---
Handle it.
`;
    for (const rel of ['dup', path.join('nested', 'dup')]) {
      const dir = path.join(monitorsDir, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'MONITOR.md'), monitorBody, 'utf-8');
    }

    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );

    await expect(runtime.tick(monitorsDir, rootDir)).rejects.toThrow(
      /Duplicate monitor ids/,
    );
  });

  it('claims high-urgency deliveries after the debounce window and updates hook state', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-high',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'urgent-monitor',
      sourceName: 'manual',
      urgency: 'high',
      title: 'CI failed',
      body: 'CI failed on the default branch',
      summary: 'CI failed on the default branch',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'ci/default',
      queryScope: { pipeline: 'default' },
      tags: ['ci'],
      createdAt: new Date(Date.now() - 20_000),
    });

    const claim = runtime.claimDelivery(session.id, 'turn-interruptible');
    expect(claim?.mode).toBe('delivery');
    expect(claim?.urgency).toBe('high');
    expect(claim?.events).toHaveLength(1);

    const hookState = JSON.parse(readFileSync(session.hookStatePath, 'utf-8'));
    expect(hookState.hasPendingHigh).toBe(false);
    expect(hookState.unread.high).toBe(1);
  });

  it('returns recap deliveries after post-compact with recap messaging', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-recap',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'doc-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc comments',
      body: 'New comments landed',
      summary: 'New comments landed',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-1',
      queryScope: { doc: 'doc-1' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    const claim = runtime.claimDelivery(session.id, 'post-compact');
    expect(claim?.mode).toBe('recap');
    expect(claim?.message).toContain('Recap');
    expect(claim?.message).toContain('agentmonitors events list --session');
    expect(claim?.events).toHaveLength(1);
  });

  // Plan D Task 1: delivery claims must carry the raw monitor body (instructions) so
  // a downstream delivery transport can surface what the agent should DO, not just
  // the title/summary. Covers both the settled-high path and the recap path.
  it('includes the raw monitor body in each DeliveryEventSummary for a high-urgency delivery claim', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-body-high',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    const distinctBody =
      'When CI fails: immediately check the failing test suite and fix the root cause before continuing.';
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'ci-monitor',
      sourceName: 'manual',
      urgency: 'high',
      title: 'CI failed',
      body: distinctBody,
      summary: 'CI failed on the default branch',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'ci/default',
      queryScope: { pipeline: 'default' },
      tags: ['ci'],
      // Aged past the 15s settle window — mirrors the existing high-urgency test idiom
      createdAt: new Date(Date.now() - 20_000),
    });

    const claim = runtime.claimDelivery(session.id, 'turn-interruptible');
    expect(claim?.mode).toBe('delivery');
    expect(claim?.urgency).toBe('high');
    expect(claim?.events).toHaveLength(1);
    // The raw body (monitor instructions) must be present and unmodified
    expect(claim?.events[0]?.body).toBe(distinctBody);
  });

  it('includes the raw monitor body in each DeliveryEventSummary for a recap delivery claim', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-body-recap',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    const distinctBody =
      'When a doc comment arrives: review the linked PR and leave feedback within 24 hours.';
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'doc-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc comments',
      body: distinctBody,
      summary: 'New comments landed',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-1',
      queryScope: { doc: 'doc-1' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    const claim = runtime.claimDelivery(session.id, 'post-compact');
    expect(claim?.mode).toBe('recap');
    expect(claim?.events).toHaveLength(1);
    // The raw body (monitor instructions) must be present and unmodified
    expect(claim?.events[0]?.body).toBe(distinctBody);
  });

  it('defers low-urgency delivery until idle lifecycle points', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-low',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'slack-monitor',
      sourceName: 'manual',
      urgency: 'low',
      title: 'Background chatter',
      body: 'A low-urgency Slack update arrived',
      summary: 'A low-urgency Slack update arrived',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'slack/general',
      queryScope: { channel: 'general' },
      tags: ['slack'],
      createdAt: new Date(),
    });

    expect(runtime.claimDelivery(session.id, 'turn-interruptible')).toBeNull();

    const claim = runtime.claimDelivery(session.id, 'turn-idle');
    expect(claim?.mode).toBe('delivery');
    expect(claim?.urgency).toBe('low');
    expect(claim?.message).toBe('AgentMon has inbox updates ready for review.');
  });

  it('coalesces normal-urgency reminders until unread events are acknowledged', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-normal',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'docs-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc update',
      body: 'A document changed',
      summary: 'A document changed',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-1',
      queryScope: { doc: 'doc-1' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    const firstClaim = runtime.claimDelivery(session.id, 'turn-interruptible');
    expect(firstClaim?.urgency).toBe('normal');

    store.insertEvent({
      workspacePath: rootDir,
      monitorId: 'docs-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Second doc update',
      body: 'Another document changed',
      summary: 'Another document changed',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-2',
      queryScope: { doc: 'doc-2' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    expect(runtime.claimDelivery(session.id, 'turn-interruptible')).toBeNull();

    runtime.acknowledgeSession(session.id);
    expect(runtime.claimDelivery(session.id, 'turn-interruptible')).toBeNull();
  });

  it('returns only session-projected events when querying session history', () => {
    const workspaceA = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-a-'));
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-b-'));
    tempDirs.push(workspaceA, workspaceB);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-a-history',
        workspacePath: workspaceA,
      }),
    );
    const sessionB = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-b-history',
        workspacePath: workspaceB,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: workspaceA,
      monitorId: 'docs-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc A comments',
      body: 'Doc A received comments',
      summary: 'Doc A received comments',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-a',
      queryScope: { doc: 'doc-a', team: 'eng' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    expect(runtime.listEvents({ sessionId: sessionA.id })).toHaveLength(1);
    expect(runtime.listEvents({ sessionId: sessionB.id })).toHaveLength(0);
  });

  it('emits all debounced high-urgency observations after the settle window', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'test-burst',
      'high',
      'Handle urgent changes.',
      "  interval: '1s'\n",
    );

    let firstObservationCycle = true;
    const source: ObservationSource = {
      name: 'test-burst',
      scopeSchema: { type: 'object', properties: {} },
      stateful: true,
      async observe(): Promise<ObservationResult> {
        if (!firstObservationCycle) {
          return { observations: [], nextState: { sent: true } };
        }
        firstObservationCycle = false;
        return {
          observations: [
            {
              title: 'Burst event 1',
              summary: 'Burst event 1',
            },
            {
              title: 'Burst event 2',
              summary: 'Burst event 2',
            },
          ],
          nextState: { sent: true },
        };
      },
    };

    const runtime = createRuntime(dbPath, source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-burst',
        workspacePath: rootDir,
      }),
    );

    const firstTick = await runtime.tick(monitorsDir, rootDir);
    expect(firstTick.emittedEventIds).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const settleStart = Date.now();
    while (Date.now() - settleStart < 15_100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const secondTick = await runtime.tick(monitorsDir, rootDir);
    expect(secondTick.emittedEventIds).toHaveLength(2);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(2);
  }, 20_000);

  // --- RANGE urgency + per-observation salience (issue #109) ---------------
  //
  // Contract (002 §4.1, §5.1; 003 §2.3): a monitor's authored `urgency` is a
  // band `lo..hi`; a source observation MAY carry a `salience`; the runtime
  // resolves the effective urgency as `clamp(salience ?? lo, lo, hi)`. The
  // materialized event row carries that effective urgency. See also the schema-
  // and parser-level tests for band parse/validation.

  it('salience within the authored band escalates the materialized event urgency (002 §5.1)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    // Band normal..high authorizes a source to escalate up to `high`. An
    // explicit throttle notify is used so the (escalated) observation emits on
    // the first tick — otherwise escalating to `high` would engage the default
    // 15s high-urgency debounce and the event would still be held. We are
    // asserting the *materialized urgency*, not notify timing here.
    const monitorsDir = createMonitorFile(
      rootDir,
      'salience-within-band',
      'normal..high',
      'Handle salient changes.',
      'notify:\n  strategy: throttle\n  suppress-for: 1h\n',
    );

    const source: ObservationSource = {
      name: 'salience-within-band',
      scopeSchema: { type: 'object', properties: {} },
      async observe(): Promise<ObservationResult> {
        return {
          observations: [
            {
              title: 'Flagged item crossed overdue',
              summary: 'Flagged item crossed overdue',
              salience: 'high',
            },
          ],
        };
      },
    };

    const runtime = createRuntime(':memory:', source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-salience-within-band',
        workspacePath: rootDir,
      }),
    );

    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(high, normal, high) === high — escalated within the band.
    expect(unread[0]?.urgency).toBe('high');
  });

  it('clamps a salience above the band to the high bound (002 §4.1)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    // Band low..normal: a `high` salience must clamp down to `normal`.
    const monitorsDir = createMonitorFile(
      rootDir,
      'salience-above-band',
      'low..normal',
    );

    const source: ObservationSource = {
      name: 'salience-above-band',
      scopeSchema: { type: 'object', properties: {} },
      async observe(): Promise<ObservationResult> {
        return {
          observations: [
            {
              title: 'Source thinks this is urgent',
              summary: 'Source thinks this is urgent',
              salience: 'high',
            },
          ],
        };
      },
    };

    const runtime = createRuntime(':memory:', source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-salience-above-band',
        workspacePath: rootDir,
      }),
    );

    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(high, low, normal) === normal — clamped to the band's high bound.
    expect(unread[0]?.urgency).toBe('normal');
  });

  it('clamps a salience below the band to the low bound (002 §4.1)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    // Band normal..high: a `low` salience must clamp up to `normal`.
    const monitorsDir = createMonitorFile(
      rootDir,
      'salience-below-band',
      'normal..high',
    );

    const source: ObservationSource = {
      name: 'salience-below-band',
      scopeSchema: { type: 'object', properties: {} },
      async observe(): Promise<ObservationResult> {
        return {
          observations: [
            {
              title: 'Source thinks this is noise',
              summary: 'Source thinks this is noise',
              salience: 'low',
            },
          ],
        };
      },
    };

    const runtime = createRuntime(':memory:', source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-salience-below-band',
        workspacePath: rootDir,
      }),
    );

    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(low, normal, high) === normal — clamped to the band's low bound.
    expect(unread[0]?.urgency).toBe('normal');
  });

  it('a degenerate band (bare scalar urgency) never escalates — backward compat (003 §2.3)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    // Bare scalar `normal` is the degenerate band normal..normal: a `high`
    // salience cannot escalate it. This is the exact behavior an existing
    // monitor (authored before salience existed) must keep.
    const monitorsDir = createMonitorFile(rootDir, 'degenerate-band', 'normal');

    const source: ObservationSource = {
      name: 'degenerate-band',
      scopeSchema: { type: 'object', properties: {} },
      async observe(): Promise<ObservationResult> {
        return {
          observations: [
            {
              title: 'Source thinks this is urgent',
              summary: 'Source thinks this is urgent',
              salience: 'high',
            },
          ],
        };
      },
    };

    const runtime = createRuntime(':memory:', source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-degenerate-band',
        workspacePath: rootDir,
      }),
    );

    const tick = await runtime.tick(monitorsDir, rootDir);
    expect(tick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(high, normal, normal) === normal — no escalation past the scalar.
    expect(unread[0]?.urgency).toBe('normal');
  });

  it('an escalated observation flushes the whole held debounce batch early without splitting it (002 §4.1)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
    try {
      const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
      tempDirs.push(rootDir);
      // Band normal..high with an explicit long debounce: every observation is
      // held to settle. tick 1 holds a `normal` observation; tick 2 delivers a
      // `high`-salience (escalated) observation that must flush the WHOLE batch
      // immediately — well before the 30s settle window — and must NOT split it
      // (both observations emit together, held-first ordering preserved).
      const monitorsDir = createMonitorFile(
        rootDir,
        'early-flush',
        'normal..high',
        'Handle it.',
        "  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: 30s\n",
      );

      let cycle = 0;
      const source: ObservationSource = {
        name: 'early-flush',
        scopeSchema: { type: 'object', properties: {} },
        stateful: true,
        async observe(): Promise<ObservationResult> {
          cycle += 1;
          if (cycle === 1) {
            return {
              observations: [
                { title: 'Held normal item', summary: 'Held normal item' },
              ],
              nextState: { cycle },
            };
          }
          if (cycle === 2) {
            return {
              observations: [
                {
                  title: 'Escalated item',
                  summary: 'Escalated item',
                  salience: 'high',
                },
              ],
              nextState: { cycle },
            };
          }
          return { observations: [], nextState: { cycle } };
        },
      };

      const runtime = createRuntime(':memory:', source);
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'claude-session-early-flush',
          workspacePath: rootDir,
        }),
      );

      // Tick 1: the normal observation is held in the debounce batch.
      const firstTick = await runtime.tick(monitorsDir, rootDir);
      expect(firstTick.emittedEventIds).toHaveLength(0);

      // Advance only 1s — far short of the 30s settle window — so any emission
      // on tick 2 can ONLY be the escalation-driven early flush, not a normal
      // settle expiry.
      vi.advanceTimersByTime(1_000);

      // Tick 2: the escalated observation flushes the whole batch early.
      const secondTick = await runtime.tick(monitorsDir, rootDir);
      // Whole batch (held normal + escalated high) — NOT split: 2 events.
      expect(secondTick.emittedEventIds).toHaveLength(2);

      const unread = runtime.listEvents({
        sessionId: session.id,
        unreadOnly: true,
      });
      expect(unread).toHaveLength(2);
      // Held-first ordering preserved (the batch was flushed, not reordered).
      const titles = unread
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((event) => event.title);
      expect(titles).toContain('Held normal item');
      expect(titles).toContain('Escalated item');
      // The escalated event carries the escalated effective urgency.
      const escalated = unread.find(
        (event) => event.title === 'Escalated item',
      );
      expect(escalated?.urgency).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: restart-safety after range-urgency upgrade (issue #109).
  //
  // A daemon persisted a `notifyState.pendingDebounce` batch BEFORE the
  // range-urgency upgrade shipped (i.e. the envelope objects have no
  // `effectiveUrgency` field). On the next restart, `hydrateStoredObservationEnvelope`
  // used to pass `effectiveUrgency: envelope.effectiveUrgency` straight through,
  // yielding `undefined`. That `undefined` flowed to `processObservation` and
  // was written as the event's `urgency`, producing an invalid DB row.
  //
  // The fix: backfill with `effectiveObservationUrgency(monitor, observation)` when
  // the field is absent. This also degrades cleanly when the persisted monitor
  // snapshot itself lacks `urgencyMax` (old monitor): `URGENCY_BY_RANK[NaN] ?? lo`
  // returns the base urgency (`lo`).
  it('backfills effectiveUrgency on hydration of a pre-upgrade debounce batch (restart-safety, issue #109)', async () => {
    vi.useFakeTimers();
    const T0 = new Date('2026-01-15T10:00:00.000Z');
    vi.setSystemTime(T0);
    try {
      const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-upgrade-'));
      tempDirs.push(rootDir);
      // A plain `normal` monitor — degenerate band — to match a pre-upgrade
      // monitor snapshot that has no `urgencyMax` field.
      const monitorsDir = createMonitorFile(
        rootDir,
        'upgrade-source',
        'normal',
        'Handle it.',
        "  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: 30s\n",
      );

      const source: ObservationSource = {
        name: 'upgrade-source',
        scopeSchema: { type: 'object', properties: {} },
        stateful: true,
        // Returns no observations — the only emission on the flush tick is the
        // pre-seeded, pre-upgrade persisted batch.
        async observe(): Promise<ObservationResult> {
          return { observations: [], nextState: {} };
        },
      };

      // Build the runtime with a concrete DB so we can seed state directly.
      const db = createDb(':memory:');
      const registry = new SourceRegistry();
      registry.register(source);
      const store = new RuntimeStore(db);
      const runtime = new AgentMonitorRuntime(store, registry, [
        claudeCodeAdapter,
      ]);

      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'claude-session-upgrade',
          workspacePath: rootDir,
        }),
      );

      // Seed a pre-upgrade persisted debounce batch: observation envelope without
      // `effectiveUrgency` (field is deliberately absent — simulates state
      // serialized before the range-urgency change was deployed).
      // `dueAt` is in the past relative to the tick time below so the batch flushes.
      const preUpgradeEnvelope = {
        monitor: {
          id: 'test-monitor',
          displayName: 'Test monitor',
          // Old monitor snapshot: frontmatter has `urgency` but no `urgencyMax`.
          frontmatter: {
            name: 'Test monitor',
            watch: { type: 'upgrade-source' },
            urgency: 'normal',
            // `urgencyMax` intentionally absent — simulates pre-upgrade snapshot.
          },
          instructions: 'Handle it.',
          filePath: path.join(
            rootDir,
            '.claude',
            'monitors',
            'test-monitor',
            'MONITOR.md',
          ),
        },
        observation: {
          title: 'Pre-upgrade observation',
          summary: 'Pre-upgrade observation',
          // `salience` absent — simulates pre-upgrade observation.
        },
        observedAt: T0.toISOString(),
        // `effectiveUrgency` intentionally absent — the key pre-upgrade condition.
      };

      store.setMonitorState('test-monitor', {
        notifyState: {
          pendingDebounce: {
            observations: [preUpgradeEnvelope],
            // dueAt is 1ms before the tick time (advance below) so it expires.
            dueAt: new Date(T0.getTime() + 999).toISOString(),
          },
        },
      });

      // Advance past the dueAt so the batch is eligible to flush.
      vi.advanceTimersByTime(1_000);

      // Run a tick — the source returns no new observations, but the persisted
      // batch is now due and must flush through hydrateStoredObservationEnvelope.
      const tick = await runtime.tick(monitorsDir, rootDir);
      expect(tick.emittedEventIds).toHaveLength(1);

      // The materialized event MUST have a valid urgency, never `undefined`.
      // For a pre-upgrade plain-normal monitor with no salience, effective
      // urgency degrades to the base urgency: `normal`.
      const events = runtime.listEvents({
        sessionId: session.id,
        unreadOnly: true,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.urgency).toBe('normal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects events only into matching workspace sessions and supports scope filters', () => {
    const workspaceA = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-a-'));
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-b-'));
    tempDirs.push(workspaceA, workspaceB);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-a',
        workspacePath: workspaceA,
      }),
    );
    const sessionB = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-b',
        workspacePath: workspaceB,
      }),
    );

    const store = new RuntimeStore(db);
    store.insertEvent({
      workspacePath: workspaceA,
      monitorId: 'docs-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc A comments',
      body: 'Doc A received comments',
      summary: 'Doc A received comments',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-a',
      queryScope: { doc: 'doc-a', team: 'eng' },
      tags: ['docs'],
      createdAt: new Date(),
    });
    store.insertEvent({
      workspacePath: workspaceA,
      monitorId: 'docs-monitor',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Doc B comments',
      body: 'Doc B received comments',
      summary: 'Doc B received comments',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'doc-b',
      queryScope: { doc: 'doc-b', team: 'eng' },
      tags: ['docs'],
      createdAt: new Date(),
    });

    const workspaceAUnread = runtime.listEvents({
      sessionId: sessionA.id,
      unreadOnly: true,
      scope: { doc: 'doc-a' },
    });
    const workspaceBUnread = runtime.listEvents({
      sessionId: sessionB.id,
      unreadOnly: true,
    });

    expect(workspaceAUnread).toHaveLength(1);
    expect(workspaceAUnread[0]?.objectKey).toBe('doc-a');
    expect(workspaceBUnread).toHaveLength(0);
  });

  // The source-agnostic changeKind primitive must be persisted into the event's
  // queryScope by the runtime, so any source gets it filterable for free.
  it('persists observation.changeKind into the event queryScope for filtering', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const monitorsDir = createMonitorFile(
      rootDir,
      'change-kind-source',
      'normal',
    );

    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    registry.register({
      name: 'change-kind-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            {
              title: 'Thing removed upstream',
              objectKey: 'thing-1',
              changeKind: 'deleted',
              queryScope: { objectId: 'thing-1' },
            },
          ],
        }),
    });
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-ck',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir);

    const all = runtime.listEvents({ sessionId: session.id });
    expect(all).toHaveLength(1);
    expect(all[0]?.queryScope.changeKind).toBe('deleted');
    // the source's own queryScope entries are preserved alongside it
    expect(all[0]?.queryScope.objectId).toBe('thing-1');

    // and the event is filterable by changeKind
    const deletedOnly = runtime.listEvents({
      sessionId: session.id,
      scope: { changeKind: 'deleted' },
    });
    expect(deletedOnly).toHaveLength(1);
  });

  // T2: snapshot history is keyed by (workspace, monitor, objectKey) — SP5.
  it('stores and retrieves snapshots isolated by workspace, monitor, and object key', () => {
    const db = createDb(':memory:');
    const store = new RuntimeStore(db);
    store.saveSnapshot({
      workspacePath: '/ws',
      monitorId: 'm1',
      objectKey: 'obj',
      eventId: 'e1',
      content: 'v1',
    });

    expect(store.latestSnapshot('m1', 'obj', '/ws')?.content).toBe('v1');
    // None of these share the (workspace, monitor, objectKey) tuple, so each is
    // its own isolated history.
    expect(store.latestSnapshot('m1', 'other-obj', '/ws')).toBeNull();
    expect(store.latestSnapshot('other-m', 'obj', '/ws')).toBeNull();
    expect(store.latestSnapshot('m1', 'obj', '/other-ws')).toBeNull();
    expect(store.latestSnapshot('m1', 'obj', null)).toBeNull();

    // The null-workspace (global) bucket is its own key: it round-trips
    // independently and does not disturb the '/ws' bucket.
    store.saveSnapshot({
      workspacePath: null,
      monitorId: 'm1',
      objectKey: 'obj',
      eventId: 'e2',
      content: 'global-v1',
    });
    expect(store.latestSnapshot('m1', 'obj', null)?.content).toBe('global-v1');
    expect(store.latestSnapshot('m1', 'obj', '/ws')?.content).toBe('v1');
  });

  // T2: a prior snapshot for the same object produces a diff on the next change.
  it('computes a diff against the prior snapshot when an object changes', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'snap-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    let content = 'alpha\nbeta\n';
    const source: ObservationSource = {
      name: 'snap-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            { title: 'snapshot', objectKey: 'obj-1', snapshotText: content },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-snap',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // v1 — no prior snapshot, no diff
    content = 'alpha\nbeta changed\n';
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDir, rootDir); // v2 — diffs against v1

    const events = runtime.listEvents({ sessionId: session.id });
    expect(events).toHaveLength(2);
    const withDiff = events.filter((event) => event.diffText);
    expect(withDiff).toHaveLength(1);
    expect(withDiff[0]?.diffText).toContain('changed');
  });

  // G6: each due monitor's outcome is recorded to observation_history per tick.
  it('records observation history (triggered, then no-change) per tick', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'history-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    let emit = true;
    const source: ObservationSource = {
      name: 'history-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: emit ? [{ title: 'thing', objectKey: 'obj-1' }] : [],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-history',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // observation emitted -> triggered
    emit = false;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDir, rootDir); // nothing observed -> no-change

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(2);
    // newest first
    expect(history[0]?.result).toBe('no-change');
    expect(history[1]?.result).toBe('triggered');
    expect(history[1]?.sourceName).toBe('history-source');
    expect(history[1]?.observationData).toEqual({ observed: 1, emitted: 1 });
  });

  it('explains invalid monitor frontmatter at the definition stage', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsDir, 'bad-monitor');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Bad monitor
---
Handle it.
`,
      'utf-8',
    );

    const source: ObservationSource = {
      name: 'unused-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
    };
    const runtime = createRuntime(dbPath, source);

    const report = await runtime.explainMonitor({
      monitorId: 'bad-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    expect(report.verdict).toMatchObject({
      stage: 'definition',
      status: 'failure',
    });
    expect(report.stages[0]?.reason).toContain('failed to parse or validate');
  });

  it('explains an errored source as a failure but an unchanged source as healthy/idle (not a bug, issue #94)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    const errorMonitorDir = path.join(monitorsDir, 'aaa-error-monitor');
    const unchangedMonitorDir = path.join(monitorsDir, 'zzz-unchanged-monitor');
    mkdirSync(errorMonitorDir, { recursive: true });
    mkdirSync(unchangedMonitorDir, { recursive: true });
    writeFileSync(
      path.join(errorMonitorDir, 'MONITOR.md'),
      `---
name: Error monitor
watch:
  type: error-source
  interval: '1s'
urgency: normal
---
Handle errors.
`,
      'utf-8',
    );
    writeFileSync(
      path.join(unchangedMonitorDir, 'MONITOR.md'),
      `---
name: Unchanged monitor
watch:
  type: unchanged-source
  interval: '1s'
urgency: normal
---
Handle unchanged.
`,
      'utf-8',
    );

    const registry = new SourceRegistry();
    registry.register({
      name: 'error-source',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> => {
        throw new Error('source failed');
      },
    });
    registry.register({
      name: 'unchanged-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
    });
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(createDb(dbPath)),
      registry,
      [claudeCodeAdapter],
    );
    await runtime.tick(monitorsDir, rootDir);

    const errored = await runtime.explainMonitor({
      monitorId: 'aaa-error-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });
    expect(errored.verdict).toMatchObject({
      stage: 'observation',
      status: 'failure',
    });
    expect(errored.stages.find((stage) => stage.id === 'observation')).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('errored'),
      }),
    );

    // Issue #94 contract: "your watched thing genuinely didn't change" is NOT a
    // bug. A no-change observation must surface as a distinct healthy/idle
    // status with an affirmative verdict — never a ✗ failure.
    const unchanged = await runtime.explainMonitor({
      monitorId: 'zzz-unchanged-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });
    expect(unchanged.verdict).toMatchObject({
      stage: 'observation',
      status: 'healthy',
    });
    const unchangedObservation = unchanged.stages.find(
      (stage) => stage.id === 'observation',
    );
    expect(unchangedObservation?.status).toBe('healthy');
    // Affirmative, not-a-bug wording (002 §10.7 / issue #94).
    expect(unchangedObservation?.reason).toContain('0 changes');
    expect(unchangedObservation?.reason).toContain('not a bug');
    // A healthy/idle monitor must carry no ✗ failure anywhere downstream: the
    // absence of events/projections is expected, not a fault.
    expect(unchanged.stages.some((stage) => stage.status === 'failure')).toBe(
      false,
    );
    expect(
      unchanged.stages.find((stage) => stage.id === 'materialization')?.status,
    ).toBe('healthy');
    expect(
      unchanged.stages.find((stage) => stage.id === 'delivery')?.status,
    ).toBe('healthy');
  });

  it('explains a rebaselined source as healthy/idle (not a bug, issue #94)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    const rebaselineMonitorDir = path.join(monitorsDir, 'rebaseline-monitor');
    mkdirSync(rebaselineMonitorDir, { recursive: true });
    writeFileSync(
      path.join(rebaselineMonitorDir, 'MONITOR.md'),
      `---
name: Rebaseline monitor
watch:
  type: rebaseline-source
  interval: '1s'
urgency: normal
---
Handle rebaseline.
`,
      'utf-8',
    );

    const registry = new SourceRegistry();
    registry.register({
      name: 'rebaseline-source',
      scopeSchema: { type: 'object' },
      // Zero observations + outcome:'rebaselined' → runtime records 'rebaselined'.
      observe: () =>
        Promise.resolve({ observations: [], outcome: 'rebaselined' }),
    });
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(createDb(dbPath)),
      registry,
      [claudeCodeAdapter],
    );
    await runtime.tick(monitorsDir, rootDir);

    const report = await runtime.explainMonitor({
      monitorId: 'rebaseline-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });
    expect(report.verdict).toMatchObject({
      stage: 'observation',
      status: 'healthy',
    });
    const observation = report.stages.find(
      (stage) => stage.id === 'observation',
    );
    expect(observation?.status).toBe('healthy');
    expect(observation?.reason).toContain('not a bug');
    expect(report.stages.some((stage) => stage.status === 'failure')).toBe(
      false,
    );
  });

  it('explains a monitor stopped by pending debounce notify state', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'explain-debounce-source',
      'high',
      'Handle it.',
      "  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: 30s\n",
    );

    const source: ObservationSource = {
      name: 'explain-debounce-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [{ title: 'held observation', objectKey: 'obj-held' }],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    const report = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    expect(report.verdict.stage).toBe('notify');
    expect(report.verdict.status).toBe('pending');
    expect(report.stages.find((stage) => stage.id === 'notify')).toMatchObject({
      status: 'pending',
    });
    expect(
      report.stages.find((stage) => stage.id === 'notify')?.reason,
    ).toContain('debounce');
  });

  it('explains materialized events with no lead session and claimed delivery state', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'explain-delivery-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'explain-delivery-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            { title: 'delivery observation', objectKey: 'obj-delivery' },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    const withoutSession = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });
    expect(withoutSession.verdict.stage).toBe('delivery');
    expect(withoutSession.verdict.status).toBe('failure');
    expect(
      withoutSession.stages.find((stage) => stage.id === 'delivery')?.reason,
    ).toContain('No lead session');

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-explain',
        workspacePath: rootDir,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDir, rootDir);
    runtime.claimDelivery(session.id, 'turn-interruptible');

    const delivered = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    expect(delivered.verdict.status).toBe('ok');
    expect(delivered.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          deliveryState: 'claimed',
        }),
      ]),
    );
  });

  it('scopes explain events and projections to the explained workspace when the same monitorId exists in two workspaces (issue #94 review, session isolation)', async () => {
    // The inbox DB is GLOBAL (not per-workspace), so the same monitorId can be
    // materialized in two different workspaces. `monitor explain` for one
    // workspace must NOT count the other workspace's events or projections
    // (comments 3408123729 + 3408123736).
    const dbRoot = mkdtempSync(path.join(tmpdir(), 'agentmon-shared-db-'));
    tempDirs.push(dbRoot);
    const dbPath = path.join(dbRoot, 'agentmon.db');

    const writeSharedMonitor = (rootDir: string): string => {
      const monitorDir = path.join(
        rootDir,
        '.claude',
        'monitors',
        'shared-monitor',
      );
      mkdirSync(monitorDir, { recursive: true });
      writeFileSync(
        path.join(monitorDir, 'MONITOR.md'),
        `---
name: Shared monitor
watch:
  type: shared-source
  interval: '1s'
urgency: normal
---
Handle it.
`,
        'utf-8',
      );
      return path.join(rootDir, '.claude', 'monitors');
    };

    const workspaceA = mkdtempSync(path.join(tmpdir(), 'agentmon-ws-a-'));
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'agentmon-ws-b-'));
    tempDirs.push(workspaceA, workspaceB);
    const monitorsDirA = writeSharedMonitor(workspaceA);
    const monitorsDirB = writeSharedMonitor(workspaceB);

    // One source, one shared DB, two workspaces.
    const source: ObservationSource = {
      name: 'shared-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [{ title: 'shared change', objectKey: 'obj-shared' }],
        }),
    };
    const runtime = createRuntime(dbPath, source);

    // A lead session in each workspace so each materialized event projects.
    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-ws-a',
        workspacePath: workspaceA,
      }),
    );
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-ws-b',
        workspacePath: workspaceB,
      }),
    );

    // Workspace A ticks once (1 event, projected to sessionA). Workspace B ticks
    // twice (2 events, projected to sessionB). If explain leaked across
    // workspaces, A would report B's extra event/projections too.
    await runtime.tick(monitorsDirA, workspaceA);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDirB, workspaceB);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDirB, workspaceB);

    const explainA = await runtime.explainMonitor({
      monitorId: 'shared-monitor',
      monitorsDir: monitorsDirA,
      workspacePath: workspaceA,
    });

    // Materialization stage: only workspace A's single event.
    expect(explainA.events).toHaveLength(1);
    expect(
      explainA.events.every((event) => event.workspacePath === workspaceA),
    ).toBe(true);

    // Delivery stage: only projections to workspace A's session.
    expect(
      explainA.projections.every(
        (projection) => projection.sessionId === sessionA.id,
      ),
    ).toBe(true);
    expect(
      explainA.projections.every(
        (projection) => projection.workspacePath === workspaceA,
      ),
    ).toBe(true);
    // Exactly one projection (A's single event → A's single session).
    expect(explainA.projections).toHaveLength(1);
  });

  // --- Regression tests for #149: verdict severity ranking ----------------
  //
  // Bug: explainVerdict() selected the *first* stage whose status !== 'ok',
  // so a healthy Observation stage (status='healthy') short-circuited the scan
  // and masked a downstream failure or pending stage. The fix ranks statuses
  // failure(3) > pending(2) > healthy(1) > ok(0) and selects the worst.

  it('verdict selects downstream failure over a healthy observation stage (regression #149: healthy-obs + delivery failure → failure verdict)', async () => {
    // Scenario: observation ran with no change (healthy/○), but no lead session
    // is registered, so if an event had materialized it would not have projected.
    // The key case from the issue: event materialized (from a prior trigger) but
    // now the source is quiet. We simulate this by: first doing a triggered tick
    // (creates the event), then doing a no-change tick (observation=healthy),
    // and explaining WITHOUT a registered lead session.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    let callCount = 0;
    const source: ObservationSource = {
      name: 'verdict-ranking-source',
      scopeSchema: { type: 'object' },
      observe: () => {
        callCount++;
        // First tick: emit an observation (event materializes).
        // Subsequent ticks: no change (observation=healthy).
        return Promise.resolve(
          callCount === 1
            ? {
                observations: [
                  {
                    title: 'change detected',
                    objectKey: 'obj-verdict',
                  },
                ],
              }
            : { observations: [] },
        );
      },
    };

    const monitorsDir = createMonitorFile(
      rootDir,
      'verdict-ranking-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );
    const runtime = createRuntime(dbPath, source);

    // Tick 1: event materializes. No lead session yet.
    await runtime.tick(monitorsDir, rootDir);
    // Tick 2: source is quiet (no-change → observation=healthy). Still no session.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDir, rootDir);

    const report = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    // Observation stage is healthy (no-change on latest tick).
    expect(
      report.stages.find((stage) => stage.id === 'observation')?.status,
    ).toBe('healthy');

    // Materialization stage: events exist from tick 1 → ok.
    expect(
      report.stages.find((stage) => stage.id === 'materialization')?.status,
    ).toBe('ok');

    // Delivery stage is failure: events exist but no lead session registered.
    const deliveryStage = report.stages.find(
      (stage) => stage.id === 'delivery',
    );
    expect(deliveryStage?.status).toBe('failure');
    expect(deliveryStage?.reason).toContain('No lead session');

    // Verdict must reflect the downstream failure, NOT the healthy observation.
    // Pre-fix: verdict was { status: 'healthy', stage: 'observation' } — the
    // healthy observation masked the delivery failure (#149 repro).
    expect(report.verdict.status).toBe('failure');
    expect(report.verdict.stage).toBe('delivery');
    expect(report.verdict.reason).toContain('No lead session');
  });

  it('verdict and materialization stage are pending (not failure) when debounce is holding the batch (regression #149)', async () => {
    // Scenario: source emitted an observation, but the debounce settle window has
    // not expired. No event has materialized yet — that's correct behavior, not a
    // fault. Pre-fix: the materialization stage rendered ✗/failure because the
    // code only checked observationHealthy (false for a triggered result), not
    // whether the notify layer was holding the batch.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'debounce-pending-verdict-source',
      'high',
      'Handle it.',
      "  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: 30s\n",
    );

    const source: ObservationSource = {
      name: 'debounce-pending-verdict-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            { title: 'debounced observation', objectKey: 'obj-debounce' },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    const report = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    // Notify stage must be pending (debounce actively holding the batch, dueAt
    // still in the future). The overdue flag in details must be false.
    const notifyStage = report.stages.find((stage) => stage.id === 'notify');
    expect(notifyStage?.status).toBe('pending');
    expect(
      (notifyStage?.details as { overdue?: boolean } | undefined)?.overdue,
    ).toBe(false);
    expect(notifyStage?.reason).toContain('debounce is holding');

    // Materialization stage must be pending (no event yet, but that's expected
    // because notify is holding). Pre-fix: this was 'failure' (#149 repro).
    const materializationStage = report.stages.find(
      (stage) => stage.id === 'materialization',
    );
    expect(materializationStage?.status).toBe('pending');
    expect(materializationStage?.reason).toContain('settle window');

    // Verdict: pending at notify (the highest-severity stage).
    // The pending notify + pending materialization both rank above ok observation,
    // and 'failure' > 'pending', so the first pending stage (notify) wins on tie.
    expect(report.verdict.status).toBe('pending');
    // The verdict stage is notify: it's the earliest-encountered pending stage
    // (both notify and materialization are pending, same severity, notify comes
    // first in the stage list).
    expect(report.verdict.stage).toBe('notify');

    // --format json contract: verdict.status and verdict.stage must be correct.
    const json = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(json.verdict.status).toBe('pending');
    expect(json.verdict.stage).toBe('notify');
  });

  it('materialization is pending (not failure) when debounce settle window has elapsed but the next daemon tick has not yet flushed the batch (Copilot review #155)', async () => {
    // Scenario (Copilot review #155): pendingDebounce can be present with
    // dueAt <= now when the settle window has expired but the next tick/watch
    // cycle has not yet run to flush and clear the batch. In that window the
    // batch is still queued — it will materialize on the next tick — so
    // materialization is still pending, not a failure. The notify stage renders
    // "settle window has elapsed; will flush on next tick" rather than the
    // "holding until T" text used while the window is still open.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    // Use a real 1s settle window so we can let it expire before calling explain.
    const monitorsDir = createMonitorFile(
      rootDir,
      'overdue-debounce-source',
      'high',
      'Handle it.',
      "  interval: '1s'\nnotify:\n  strategy: debounce\n  settle-for: 1s\n",
    );

    const source: ObservationSource = {
      name: 'overdue-debounce-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            { title: 'queued observation', objectKey: 'obj-overdue' },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    // Tick 1: observation is held in the debounce batch (dueAt = now + 1s).
    await runtime.tick(monitorsDir, rootDir);

    // Simulate explaining after the settle window has expired but before the
    // next flush tick: pass a `now` that is 2 seconds in the future, making
    // the stored dueAt appear overdue.
    const futureNow = new Date(Date.now() + 2_000);
    const report = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
      now: futureNow,
    });

    // Notify stage must still be pending (the batch is queued, just overdue).
    const notifyStage = report.stages.find((stage) => stage.id === 'notify');
    expect(notifyStage?.status).toBe('pending');
    // The reason must reference "next tick", not "holding until".
    expect(notifyStage?.reason).toContain('next daemon tick');
    // The overdue flag in details must be true.
    expect(
      (notifyStage?.details as { overdue?: boolean } | undefined)?.overdue,
    ).toBe(true);

    // Materialization stage must be pending (the batch hasn't been flushed yet).
    // Pre-fix: this fell through to `notify = ok` → materialization = failure.
    const materializationStage = report.stages.find(
      (stage) => stage.id === 'materialization',
    );
    expect(materializationStage?.status).toBe('pending');
    expect(materializationStage?.reason).toContain('next daemon tick');

    // Verdict: pending (not failure) — the batch will materialize on next tick.
    expect(report.verdict.status).toBe('pending');
  });

  it('a genuinely all-healthy/idle monitor still yields the healthy not-a-bug verdict after #149 fix (regression guard for #98)', async () => {
    // #98 established that a no-change/idle monitor is NOT a bug and must show
    // the ○ healthy verdict. The #149 severity-ranking fix must not regress that.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'all-healthy-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'all-healthy-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    const report = await runtime.explainMonitor({
      monitorId: 'test-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    // All downstream stages should also be healthy.
    expect(report.stages.some((stage) => stage.status === 'failure')).toBe(
      false,
    );
    expect(
      report.stages.find((stage) => stage.id === 'observation')?.status,
    ).toBe('healthy');
    expect(
      report.stages.find((stage) => stage.id === 'materialization')?.status,
    ).toBe('healthy');
    expect(report.stages.find((stage) => stage.id === 'delivery')?.status).toBe(
      'healthy',
    );

    // Verdict must be healthy, not-a-bug (#98 contract preserved).
    expect(report.verdict.status).toBe('healthy');
  });

  it('classifies a debounced-flush tick (emit with zero new observations) as triggered, not no-change', async () => {
    // Regression for PR #30: a tick that flushes a previously-debounced batch has
    // zero *new* observations yet still emits events. It must be recorded as
    // `triggered`, not `no-change`. The pre-fix ternary keyed off `observed === 0`
    // first and misclassified this (common) case — e.g. the default high-urgency
    // settle flushing. See https://github.com/mike-north/AgentMonitors/pull/30
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsDir, 'debounce-monitor');
    mkdirSync(monitorDir, { recursive: true });
    // High urgency with an explicit, minimal (1s) debounce: tick 1 holds the
    // observation (suppressed); after the settle elapses, tick 2 flushes it with
    // no new observation (the bug scenario).
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Debounce flush
watch:
  type: debounce-source
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
  interval: '1s'
urgency: high
notify:
  strategy: debounce
  settle-for: 1s
---
Handle it.
`,
      'utf-8',
    );

    let emit = true;
    const source: ObservationSource = {
      name: 'debounce-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: () =>
        Promise.resolve({
          observations: emit ? [{ title: 'thing', objectKey: 'obj-1' }] : [],
          nextState: { sent: true },
        }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-debounce',
        workspacePath: rootDir,
      }),
    );

    const first = await runtime.tick(monitorsDir, rootDir); // held in debounce
    expect(first.emittedEventIds).toHaveLength(0);
    emit = false;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await runtime.tick(monitorsDir, rootDir); // flush, no new obs
    expect(second.emittedEventIds).toHaveLength(1);

    const history = runtime.listObservationHistory({
      monitorId: 'debounce-monitor',
    });
    expect(history).toHaveLength(2);
    // newest first: the flush tick emitted with zero new observations
    expect(history[0]?.result).toBe('triggered');
    expect(history[0]?.observationData).toEqual({ observed: 0, emitted: 1 });
    // the earlier tick held the observation without emitting
    expect(history[1]?.result).toBe('suppressed');
    expect(history[1]?.observationData).toEqual({ observed: 1, emitted: 0 });
  });

  // G5: a source that implements watch() is driven continuously by the runtime;
  // each yielded observation flows through the same notify/materialize/project
  // pipeline as observe(), and stop() aborts the watcher cleanly.
  it('drives a watch()-based source end-to-end and stops cleanly', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    // normal urgency => immediate emit (no debounce), so the yielded observation
    // materializes without waiting for a settle window.
    const monitorsDir = createMonitorFile(
      rootDir,
      'watch-source',
      'normal',
      'Handle it.',
    );

    let watchAborted = false;
    const source: ObservationSource = {
      name: 'watch-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context: ObservationContext) {
        yield {
          title: 'live event',
          summary: 'live event',
          objectKey: 'obj-live',
        };
        // then idle until the runtime aborts us.
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              watchAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    const runtime = createRuntime(dbPath, source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-watch',
        workspacePath: rootDir,
      }),
    );

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    expect(handle.monitorIds).toEqual(['test-monitor']);

    // let the watcher consume the yielded observation.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.summary).toContain('live event');

    await handle.stop();
    expect(watchAborted).toBe(true);
  });

  // Regression: when a source returns no nextState (e.g. transient rev-parse
  // failure), the previously-persisted sourceState must be left intact rather
  // than overwritten with an empty/undefined value. The pre-fix code always
  // passed nextSourceState: { value: undefined }, which caused ingest() to write
  // undefined, zeroing the stored SHA and causing event loss on the next tick.
  it('preserves persisted sourceState when a tick returns no nextState', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'preserve-state-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    let tick = 0;
    const source: ObservationSource = {
      name: 'preserve-state-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> => {
        tick++;
        if (tick === 1) {
          // First tick: establish baseline, record the initial state token.
          return Promise.resolve({ observations: [], nextState: { v: 1 } });
        }
        // Second tick: source had a transient failure — returns observations
        // but deliberately omits nextState.
        return Promise.resolve({ observations: [] });
      },
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-preserve-state',
        workspacePath: rootDir,
      }),
    );

    // First tick establishes the state token { v: 1 }.
    await runtime.tick(monitorsDir, rootDir);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // Second tick: source returns no nextState (transient failure path).
    await runtime.tick(monitorsDir, rootDir);

    // The persisted sourceState must still be { v: 1 } — not wiped to {}.
    const store = new RuntimeStore(createDb(dbPath));
    const state = store.getMonitorState('test-monitor');
    expect(state.sourceState).toEqual({ v: 1 });
  });

  // G5: while a monitor is watched, the tick loop must not also observe() it
  // (no double-processing); once the watcher stops, the tick loop resumes it.
  it('skips a watched monitor in the tick loop and resumes it after stop', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'watch-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'watch-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield
      async *watch(_config, context: ObservationContext) {
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    };

    const runtime = createRuntime(dbPath, source);
    const handle = await runtime.watchMonitors(monitorsDir, rootDir);

    const duringWatch = await runtime.tick(monitorsDir, rootDir);
    expect(duringWatch.evaluatedMonitors).not.toContain('test-monitor');

    await handle.stop();

    // after stop, the monitor is due again (1s interval) and the tick observes it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const afterStop = await runtime.tick(monitorsDir, rootDir);
    expect(afterStop.evaluatedMonitors).toContain('test-monitor');
  });

  // Issue #46: per-monitor observe() failure isolation in tick().
  // https://github.com/mike-north/AgentMonitors/issues/46
  //
  // A single source whose observe() throws must not abort the tick — all other
  // due monitors must still run. The failing monitor's history row must be
  // `errored`; the succeeding monitor's history row must be `triggered`.

  // Helper: write a two-source monitor directory (avoids repeating boilerplate
  // for the throw-first and throw-last direction tests).
  function createTwoMonitorDir(
    rootDir: string,
    firstMonitorName: string,
    firstSourceName: string,
    secondMonitorName: string,
    secondSourceName: string,
  ): string {
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    for (const [monitorName, sourceName] of [
      [firstMonitorName, firstSourceName],
      [secondMonitorName, secondSourceName],
    ] as const) {
      const dir = path.join(monitorsDir, monitorName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        `---
name: ${monitorName}
watch:
  type: ${sourceName}
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
  interval: '1s'
urgency: normal
---
Handle it.
`,
        'utf-8',
      );
    }
    return monitorsDir;
  }

  it('isolates a failing observe() so other monitors still run and records errored history (thrower sorts first)', async () => {
    // aaa-throws (sorts first, observe throws) then zzz-works (sorts last).
    // Proves that a failure in the FIRST monitor does not abort the tick.
    // H2: also asserts observationData shape and covers the non-Error throw branch.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    const throwingSource: ObservationSource = {
      name: 'throwing-source-a',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> => {
        throw new Error('simulated source failure');
      },
    };
    const workingSource: ObservationSource = {
      name: 'working-source-z',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [
            {
              title: 'Working monitor fired',
              summary: 'Working monitor fired',
              objectKey: 'obj-1',
            },
          ],
        }),
    };

    const monitorsDir = createTwoMonitorDir(
      rootDir,
      'aaa-throws',
      'throwing-source-a',
      'zzz-works',
      'working-source-z',
    );

    const db = createDb(dbPath);
    const registry = new SourceRegistry();
    registry.register(throwingSource);
    registry.register(workingSource);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-isolation-a',
        workspacePath: rootDir,
      }),
    );

    // (a) tick must not reject even though aaa-throws' source throws
    const result = await runtime.tick(monitorsDir, rootDir);

    // M1: both monitors appear in evaluatedMonitors
    expect(result.evaluatedMonitors).toContain('aaa-throws');
    expect(result.evaluatedMonitors).toContain('zzz-works');

    // (b) the working monitor emitted an event
    expect(result.emittedEventIds.length).toBeGreaterThan(0);
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events.some((e) => e.monitorId === 'zzz-works')).toBe(true);

    // (c) the failing monitor's history row records 'errored' with the right shape
    const throwingHistory = runtime.listObservationHistory({
      monitorId: 'aaa-throws',
    });
    expect(throwingHistory).toHaveLength(1);
    expect(throwingHistory[0]?.result).toBe('errored');
    // H2: assert observationData shape (spec 002 §observation_history)
    expect(throwingHistory[0]?.observationData).toEqual({
      error: 'simulated source failure',
    });

    // (d) the working monitor's history row records 'triggered'
    const workingHistory = runtime.listObservationHistory({
      monitorId: 'zzz-works',
    });
    expect(workingHistory).toHaveLength(1);
    expect(workingHistory[0]?.result).toBe('triggered');

    // Issue #117: the errored monitor is surfaced on the tick result (same
    // source as the 'errored' history row), so a tick can report the failure
    // rather than print a bare `emitted 0`. The working monitor must NOT appear.
    expect(result.erroredObservations).toEqual([
      { monitorId: 'aaa-throws', message: 'simulated source failure' },
    ]);
  });

  // M3: also cover the reverse ordering — thrower sorts LAST — to prove a failure
  // in a later monitor does not corrupt an earlier monitor's result.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('isolates a failing observe() so earlier monitors are unaffected (thrower sorts last)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');

    const workingSource: ObservationSource = {
      name: 'working-source-a',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [
            {
              title: 'Early monitor fired',
              summary: 'Early monitor fired',
              objectKey: 'obj-early',
            },
          ],
        }),
    };
    const throwingSource: ObservationSource = {
      name: 'throwing-source-z',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> => {
        throw new Error('late source failure');
      },
    };

    const monitorsDir = createTwoMonitorDir(
      rootDir,
      'aaa-works',
      'working-source-a',
      'zzz-throws',
      'throwing-source-z',
    );

    const db = createDb(dbPath);
    const registry = new SourceRegistry();
    registry.register(workingSource);
    registry.register(throwingSource);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-isolation-z',
        workspacePath: rootDir,
      }),
    );

    // tick must not reject even though zzz-throws' source throws
    const result = await runtime.tick(monitorsDir, rootDir);

    // M1: both monitors appear in evaluatedMonitors
    expect(result.evaluatedMonitors).toContain('aaa-works');
    expect(result.evaluatedMonitors).toContain('zzz-throws');

    // the working monitor (which ran FIRST) still emitted its event
    expect(result.emittedEventIds.length).toBeGreaterThan(0);
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events.some((e) => e.monitorId === 'aaa-works')).toBe(true);

    expect(
      runtime.listObservationHistory({ monitorId: 'aaa-works' })[0]?.result,
    ).toBe('triggered');
    expect(
      runtime.listObservationHistory({ monitorId: 'zzz-throws' })[0]?.result,
    ).toBe('errored');

    // Issue #117: only the errored monitor is surfaced, with its message.
    expect(result.erroredObservations).toEqual([
      { monitorId: 'zzz-throws', message: 'late source failure' },
    ]);
  });

  // H2: covers the non-Error throw branch — a source that throws a plain string
  // rather than an Error must still produce result:'errored' with a stringified
  // observationData.error.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('records errored history with String() fallback when source throws a non-Error value', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const monitorsDir = createMonitorFile(
      rootDir,
      'non-error-throw-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'non-error-throw-source',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> => {
        throw 'string failure value'; // intentional non-Error throw for coverage
      },
    };

    const runtime = createRuntime(path.join(rootDir, 'agentmon.db'), source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-non-error-throw',
        workspacePath: rootDir,
      }),
    );

    const result = await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.result).toBe('errored');
    // String(error) of a plain string is the string itself
    expect(history[0]?.observationData).toEqual({
      error: 'string failure value',
    });

    // Issue #117: a non-Error throw is surfaced on the tick result with the
    // same String()-fallback message that lands in the history row.
    expect(result.erroredObservations).toEqual([
      { monitorId: 'test-monitor', message: 'string failure value' },
    ]);
  });

  // Issue #46: when a monitor's observe() throws the tick must NOT call ingest()
  // for that monitor. Because ingest() is what calls setMonitorState(), skipping
  // it preserves the previously-persisted sourceState so no subsequent delta is
  // dropped.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('preserves persisted sourceState when observe() throws on tick 2 (no baseline loss)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'state-preserve-throw-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    // Track what previousState each tick receives so we can assert tick 3 still
    // sees the tick-1 baseline.
    const receivedPreviousStates: unknown[] = [];

    let tickCount = 0;
    const source: ObservationSource = {
      name: 'state-preserve-throw-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (_config, context): Promise<ObservationResult> => {
        tickCount++;
        receivedPreviousStates.push(context.previousState);
        if (tickCount === 1) {
          // Tick 1: emit something and establish the baseline state.
          return Promise.resolve({
            observations: [
              { title: 'Initial event', summary: 'Initial event' },
            ],
            nextState: { baseline: 'tick-1' },
          });
        }
        if (tickCount === 2) {
          // Tick 2: throw — simulating a transient source failure.
          throw new Error('transient failure on tick 2');
        }
        // Tick 3+: succeed with no new observations. The previousState we
        // receive must still be the tick-1 baseline, not an empty object.
        return Promise.resolve({
          observations: [],
          nextState: { baseline: 'tick-3' },
        });
      },
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-state-preserve-throw',
        workspacePath: rootDir,
      }),
    );

    // Tick 1: establishes baseline { baseline: 'tick-1' }.
    await runtime.tick(monitorsDir, rootDir);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // Tick 2: source throws; ingest() must be skipped (preserving tick-1 state).
    await runtime.tick(monitorsDir, rootDir);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // Tick 3: source recovers. Assert it received the tick-1 baseline, not {}/undefined.
    await runtime.tick(monitorsDir, rootDir);

    // previousState on tick 3 (index 2) must equal the tick-1 baseline.
    expect(receivedPreviousStates[2]).toEqual({ baseline: 'tick-1' });

    // Observation history: tick 1 = triggered, tick 2 = errored, tick 3 = no-change.
    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(3);
    // newest first
    expect(history[0]?.result).toBe('no-change');
    expect(history[1]?.result).toBe('errored');
    expect(history[2]?.result).toBe('triggered');
  });

  // M2: Throwing-monitor + debounce-flush interaction.
  // A tick where monitor A's observe() throws must not prevent monitor B from
  // flushing a previously-held debounce batch in the same tick.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('does not prevent a debounce flush on a later monitor when an earlier monitor throws', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');

    // Monitor aaa-throws: always errors
    const throwingMonitorDir = path.join(monitorsDir, 'aaa-throws-debounce');
    mkdirSync(throwingMonitorDir, { recursive: true });
    writeFileSync(
      path.join(throwingMonitorDir, 'MONITOR.md'),
      `---
name: Throwing monitor debounce
watch:
  type: debounce-test-throwing-source
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
  interval: '1s'
urgency: normal
---
Handle it.
`,
      'utf-8',
    );

    // Monitor zzz-debounce: high urgency with a short 1s settle so we can
    // observe the flush in a reasonable time window.
    const debounceMonitorDir = path.join(monitorsDir, 'zzz-debounce-flush');
    mkdirSync(debounceMonitorDir, { recursive: true });
    writeFileSync(
      path.join(debounceMonitorDir, 'MONITOR.md'),
      `---
name: Debounce flush monitor
watch:
  type: debounce-test-working-source
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
  interval: '1s'
urgency: high
notify:
  strategy: debounce
  settle-for: 1s
---
Handle it.
`,
      'utf-8',
    );

    let debounceEmit = true;
    const throwingSource: ObservationSource = {
      name: 'debounce-test-throwing-source',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> => {
        throw new Error('always fails');
      },
    };
    const debounceSource: ObservationSource = {
      name: 'debounce-test-working-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: debounceEmit
            ? [{ title: 'debounce event', objectKey: 'obj-debounce' }]
            : [],
          nextState: { sent: true },
        }),
    };

    const db = createDb(dbPath);
    const registry = new SourceRegistry();
    registry.register(throwingSource);
    registry.register(debounceSource);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-debounce-isolation',
        workspacePath: rootDir,
      }),
    );

    // Tick 1: thrower errors; debounce monitor holds its observation (settle pending).
    const firstTick = await runtime.tick(monitorsDir, rootDir);
    expect(firstTick.emittedEventIds).toHaveLength(0);

    debounceEmit = false;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // Tick 2: thrower errors again; debounce settle has elapsed so flush should fire.
    const secondTick = await runtime.tick(monitorsDir, rootDir);
    // The debounce flush must have emitted despite the co-running thrower.
    expect(secondTick.emittedEventIds).toHaveLength(1);

    expect(
      runtime.listObservationHistory({ monitorId: 'aaa-throws-debounce' })[0]
        ?.result,
    ).toBe('errored');
    expect(
      runtime.listObservationHistory({ monitorId: 'zzz-debounce-flush' })[0]
        ?.result,
    ).toBe('triggered');
  });

  // Issue #46: watch-path per-observation isolation.
  // A FlakyStore subclass that throws on a sentinel observation title provides
  // a clean public seam to trigger ingest() failure without private mocking.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('isolates an ingest() failure in consumeWatch() so the watcher survives and subsequent observations still flow', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    // normal urgency => immediate emit (no debounce settle needed).
    const monitorsDir = createMonitorFile(
      rootDir,
      'watch-ingest-source',
      'normal',
      'Handle it.',
    );

    // Subclass RuntimeStore to throw on the sentinel observation so ingest()
    // fails for that specific observation without patching private methods.
    class FlakyStore extends RuntimeStore {
      override insertEvent(
        input: Omit<MonitorEventRecord, 'id'>,
      ): MonitorEventRecord {
        if (input.title === 'boom') {
          throw new Error('simulated insert failure');
        }
        return super.insertEvent(input);
      }
    }

    const db = createDb(dbPath);
    const registry = new SourceRegistry();

    // Watch source: yields 'boom' (ingest will fail), then 'ok' (ingest succeeds),
    // then idles until aborted.
    registry.register({
      name: 'watch-ingest-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context: ObservationContext) {
        yield { title: 'boom', summary: 'boom', objectKey: 'obj-boom' };
        yield { title: 'ok', summary: 'ok', objectKey: 'obj-ok' };
        // idle until aborted
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });

    const runtime = new AgentMonitorRuntime(new FlakyStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-watch-ingest-isolation',
        workspacePath: rootDir,
      }),
    );

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    expect(handle.monitorIds).toEqual(['test-monitor']);

    // give the watcher enough time to consume both observations
    await new Promise((resolve) => setTimeout(resolve, 100));

    // (a) watcher survived 'boom' — handle still active and 'ok' produced an event
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events.some((e) => e.title === 'ok')).toBe(true);

    // (b) 'ok' produced a triggered history row
    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    const triggered = history.filter((h) => h.result === 'triggered');
    expect(triggered.length).toBeGreaterThan(0);

    // (c) 'boom' produced an errored history row
    const errored = history.filter((h) => h.result === 'errored');
    expect(errored).toHaveLength(1);
    expect(errored[0]?.observationData).toEqual({
      error: 'simulated insert failure',
    });

    await handle.stop();
  });

  // Issue #56: a source that signals outcome:'rebaselined' must produce a
  // 'rebaselined' row in observation_history, not 'no-change'.
  // A source that returns no observations with no outcome still produces 'no-change'
  // (regression guard: sources that don't set the diagnostic are unaffected).
  // https://github.com/mike-north/AgentMonitors/issues/56
  it('records rebaselined history when source sets outcome:rebaselined (not no-change)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'rebaselined-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'rebaselined-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [],
          nextState: { ref: 'abc123' },
          outcome: 'rebaselined',
        }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-rebaselined',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    // Must be 'rebaselined', not 'no-change'
    expect(history[0]?.result).toBe('rebaselined');
    expect(history[0]?.observationData).toEqual({ observed: 0, emitted: 0 });
  });

  it('records no-change history when source returns no observations with no outcome (unaffected by #56)', async () => {
    // Regression guard: sources that do not set outcome are unaffected by #56.
    // A genuinely quiet tick (zero observations, no outcome field) must still record no-change.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'quiet-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'quiet-source',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({ observations: [] }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-quiet',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.result).toBe('no-change');
  });

  // Issue #56 (precedence invariant): the classification orders
  // emitted>0 → 'triggered' ABOVE the rebaselined check. A source that both
  // emits an observation AND signals outcome:'rebaselined' must record
  // 'triggered' — an emitted event always wins. incoming-changes never does
  // this today (its re-baseline return is always empty), so this guards the
  // core invariant against a future source.
  // https://github.com/mike-north/AgentMonitors/issues/56
  it('classifies triggered over rebaselined when an observation is emitted (issue #56 precedence)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'emit-and-rebaseline-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'emit-and-rebaseline-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [{ title: 'change', objectKey: 'obj-1' }],
          nextState: { ref: 'abc123' },
          outcome: 'rebaselined',
        }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-emit-rebaseline',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    // Emitted event wins over the rebaselined diagnostic.
    expect(history[0]?.result).toBe('triggered');
    expect(history[0]?.observationData).toEqual({ observed: 1, emitted: 1 });
  });

  // Issue #56 (PR review): `rebaselined` is, by contract (002 §observation_history),
  // a tick that returned ZERO observations. If a source returns observations that
  // get suppressed (emitted=0, observed>0) AND mistakenly sets outcome:'rebaselined',
  // the runtime must record `suppressed`, not `rebaselined` — the observed===0 guard
  // enforces the invariant at the boundary so a misbehaving source can't mask a
  // genuine suppressed tick.
  // https://github.com/mike-north/AgentMonitors/issues/56
  it('records suppressed (not rebaselined) when a held observation accompanies the rebaselined diagnostic', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    // High urgency → default 15s debounce: the observation is held (emitted=0,
    // observed=1) on this tick, exercising the observed>0 + rebaselined case.
    const monitorsDir = createMonitorFile(
      rootDir,
      'suppress-and-rebaseline-source',
      'high',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'suppress-and-rebaseline-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [{ title: 'held', objectKey: 'obj-1' }],
          nextState: { ref: 'abc123' },
          outcome: 'rebaselined',
        }),
    };

    const runtime = createRuntime(dbPath, source);
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-suppress-rebaseline',
        workspacePath: rootDir,
      }),
    );

    const tick = await runtime.tick(monitorsDir, rootDir);
    // Held by debounce — nothing emitted this tick.
    expect(tick.emittedEventIds).toHaveLength(0);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    // observed>0 wins: a held observation is `suppressed`, never `rebaselined`.
    expect(history[0]?.result).toBe('suppressed');
    expect(history[0]?.observationData).toEqual({ observed: 1, emitted: 0 });
  });

  // Issue #46 / Copilot comment 1: per-observation materialization isolation in
  // ingest(). When a batch of ≥2 dispatched observations is being materialized
  // and the FIRST processObservation() call succeeds but a LATER one fails,
  // the successful observation's event id must still appear in emittedEventIds
  // and in the DB — the tick must not reject and already-written ids must not
  // be lost.
  // https://github.com/mike-north/AgentMonitors/issues/46
  it('preserves already-emitted event ids when a later observation in the same batch fails to materialize', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    // normal urgency → immediate emit (no debounce settle needed).
    const monitorsDir = createMonitorFile(
      rootDir,
      'partial-batch-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    // FlakyStore: throw on insertEvent for the sentinel title so the second
    // observation in the batch fails to materialize.
    class FlakyStore extends RuntimeStore {
      override insertEvent(
        input: Omit<MonitorEventRecord, 'id'>,
      ): MonitorEventRecord {
        if (input.title === 'bad-obs') {
          throw new Error('insert failure for bad-obs');
        }
        return super.insertEvent(input);
      }
    }

    const db = createDb(dbPath);
    const registry = new SourceRegistry();
    registry.register({
      name: 'partial-batch-source',
      scopeSchema: { type: 'object' },
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [
            // First observation: succeeds
            { title: 'good-obs', summary: 'good-obs', objectKey: 'obj-good' },
            // Second observation: insertEvent will throw
            { title: 'bad-obs', summary: 'bad-obs', objectKey: 'obj-bad' },
          ],
        }),
    });

    const runtime = new AgentMonitorRuntime(new FlakyStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-partial-batch',
        workspacePath: rootDir,
      }),
    );

    // (i) tick must not reject
    const result = await runtime.tick(monitorsDir, rootDir);

    // (ii) the successful observation's event IS in emittedEventIds AND in
    //      listEvents — the id must not be lost due to the later failure
    expect(result.emittedEventIds).toHaveLength(1);
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('good-obs');
    expect(result.emittedEventIds[0]).toBe(events[0]?.id);

    // (iii) an errored history row exists for the failing observation
    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    const errored = history.filter((h) => h.result === 'errored');
    expect(errored).toHaveLength(1);
    expect(errored[0]?.observationData).toEqual({
      error: 'insert failure for bad-obs',
    });

    // (iv) the batch-level triggered row was still recorded (the batch had
    //      dispatched observations, so the outcome is triggered regardless of
    //      materialization failures)
    const triggered = history.filter((h) => h.result === 'triggered');
    expect(triggered).toHaveLength(1);
  });

  // --- G13: author-declared baseline strategy (net default vs incremental) --
  //
  // Contract (001 §3.7, 002 §1.1.7; default changed 2026-06-19, Refs #110):
  // the per-recipient Diff stage spans a *catch-up span* — the set of shaped
  // observations that accumulated for a recipient since its baseline.
  // `baseline-strategy` declares how that span is delivered:
  //   - `net` (default): a single net delta (the endpoint state vs. the
  //     baseline) — a recipient that missed N observations receives ONE delta;
  //     intermediate observations are discarded. Omitting the field yields
  //     `net` (the standard delivery contract).
  //   - `incremental`: each observation in the span, in order — a recipient
  //     that missed N observations receives N ordered deltas. Use when the
  //     sequence matters (e.g. comment threads); must be declared explicitly.
  //
  // Each test establishes a baseline snapshot on tick 1, then delivers a
  // catch-up span of N=3 successive states (one shared objectKey) in a single
  // tick 2. Expected delta counts are written by hand from 002 §1.1.7.
  describe('baseline strategy (G13, 002 §1.1.7)', () => {
    const SPAN_OBJECT_KEY = 'doc-1';
    // Baseline established on tick 1, then a 3-observation catch-up span on
    // tick 2. Distinct text per state so each transition is a real diff.
    const BASELINE_STATE = 'line-a\nline-b\nline-c\n';
    const SPAN_STATES = [
      'line-a EDIT-1\nline-b\nline-c\n',
      'line-a EDIT-1\nline-b EDIT-2\nline-c\n',
      'line-a EDIT-1\nline-b EDIT-2\nline-c EDIT-3\n',
    ] as const;

    /**
     * Write a MONITOR.md that watches `scripted-span` with an optional
     * `baseline-strategy` frontmatter line. `urgency: normal` + no `notify`
     * means every observation in a single `observe()` call emits immediately as
     * one catch-up span (no debounce/throttle in play — the baseline strategy is
     * the only variable under test).
     */
    function writeSpanMonitor(
      rootDir: string,
      baselineStrategyLine: string,
    ): string {
      const monitorsDir = path.join(
        rootDir,
        '.claude',
        'monitors',
        'span-monitor',
      );
      mkdirSync(monitorsDir, { recursive: true });
      writeFileSync(
        path.join(monitorsDir, 'MONITOR.md'),
        `---
name: Span monitor
watch:
  type: scripted-span
  interval: '1s'
urgency: normal
${baselineStrategyLine}---
Handle it.
`,
        'utf-8',
      );
      return path.join(rootDir, '.claude', 'monitors');
    }

    /**
     * A source scripted to emit, on its FIRST observe(), a single baseline
     * observation, and on its SECOND observe(), the full catch-up span of
     * `SPAN_STATES` (all in one call — a recipient that missed every
     * intermediate change). Subsequent observe() calls emit nothing.
     */
    function scriptedSpanSource(): ObservationSource {
      let call = 0;
      return {
        name: 'scripted-span',
        scopeSchema: { type: 'object', properties: {} },
        observe: (): Promise<ObservationResult> => {
          call += 1;
          if (call === 1) {
            return Promise.resolve({
              observations: [
                {
                  title: 'baseline',
                  objectKey: SPAN_OBJECT_KEY,
                  snapshotText: BASELINE_STATE,
                },
              ],
            });
          }
          if (call === 2) {
            return Promise.resolve({
              observations: SPAN_STATES.map((snapshotText, index) => ({
                title: `edit ${String(index + 1)}`,
                summary: `edit ${String(index + 1)}`,
                objectKey: SPAN_OBJECT_KEY,
                snapshotText,
              })),
            });
          }
          return Promise.resolve({ observations: [] });
        },
      };
    }

    /**
     * Drive tick 1 (baseline) then tick 2 (the N-observation catch-up span) for
     * a monitor authored with the given `baseline-strategy` line, returning the
     * recipient session id, the runtime, the monitorsDir, and the shared
     * `monitor_events` chain for the session ordered oldest-first.
     */
    async function deliverSpan(
      baselineStrategyLine: string,
      hostSessionId: string,
    ): Promise<{
      runtime: AgentMonitorRuntime;
      monitorsDir: string;
      rootDir: string;
      sessionId: string;
      events: MonitorEventRecord[];
    }> {
      const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-g13-'));
      tempDirs.push(rootDir);
      const monitorsDir = writeSpanMonitor(rootDir, baselineStrategyLine);
      const runtime = createRuntime(':memory:', scriptedSpanSource());
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId,
          workspacePath: rootDir,
        }),
      );

      // Tick 1: establish the baseline snapshot (one observation, no prior
      // snapshot → no diff). This is the recipient's baseline.
      await runtime.tick(monitorsDir, rootDir);
      // The interval is 1s; advance past it so tick 2 is due.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      // Tick 2: deliver the 3-observation catch-up span in one shot.
      await runtime.tick(monitorsDir, rootDir);

      // Oldest-first so the shared chain order is asserted directly.
      const events = runtime
        .listEvents({ sessionId: session.id })
        .slice()
        .reverse();
      return { runtime, monitorsDir, rootDir, sessionId: session.id, events };
    }

    // Criterion (b) + G10 PR-B (002 §1.1.7, Decision Q3): under `net`, the
    // SHARED `monitor_events` chain now records EVERY intermediate (N=3 span
    // events + baseline = 4), but the per-recipient DELIVERY collapses to ONE
    // net delta at claim — the newest event per object — with the older
    // intermediates recorded claimed-but-suppressed (explainable, not delivered).
    it('net: the shared chain keeps every intermediate, but the recipient is delivered one net delta', async () => {
      const { runtime, monitorsDir, rootDir, sessionId, events } =
        await deliverSpan('baseline-strategy: net\n', 'claude-g13-net');

      // G10 PR-B / criterion 4 (no shared-collapse regression): the shared chain
      // is the incremental substrate — all three span observations materialized,
      // none collapsed. Baseline (1) + N=3 = 4 total shared events.
      expect(events).toHaveLength(4);
      const spanEvents = events.filter((event) => event.title !== 'baseline');
      expect(spanEvents).toHaveLength(3);
      // The three span events share a sub-second tick timestamp, so listEvents'
      // createdAt ordering ties; assert the SET of titles + each title's own
      // endpoint snapshot (nothing folded), not a strict order.
      const byTitle = new Map(spanEvents.map((event) => [event.title, event]));
      expect([...byTitle.keys()].sort()).toEqual([
        'edit 1',
        'edit 2',
        'edit 3',
      ]);
      expect(byTitle.get('edit 1')?.snapshotText).toBe(SPAN_STATES[0]);
      expect(byTitle.get('edit 2')?.snapshotText).toBe(SPAN_STATES[1]);
      expect(byTitle.get('edit 3')?.snapshotText).toBe(SPAN_STATES[2]);

      // Claim the catch-up span (normal urgency → turn-interruptible). The
      // per-recipient `net` collapse runs at claim: only the newest event per
      // object is delivered; the two intermediates are recorded suppressed.
      runtime.claimDelivery(sessionId, 'turn-interruptible');

      const report = await runtime.explainMonitor({
        monitorId: 'span-monitor',
        monitorsDir,
        workspacePath: rootDir,
      });
      const spanIds = new Set(spanEvents.map((event) => event.id));
      const spanProjections = report.projections.filter(
        (projection) =>
          projection.sessionId === sessionId && spanIds.has(projection.eventId),
      );
      // ONE delivered (not net-suppressed) + TWO claimed-but-suppressed.
      const delivered = spanProjections.filter((p) => !p.netSuppressed);
      const suppressed = spanProjections.filter((p) => p.netSuppressed);
      expect(delivered).toHaveLength(1);
      expect(suppressed).toHaveLength(2);

      // The surviving net delta is the NEWEST event (edit 3, where things stand
      // now), and its per-recipient diff spans the recipient's baseline →
      // endpoint, so all three line edits appear in one delta (collapsed, not
      // replayed). 002 §1.1.7.
      const survivor = events.find((e) => e.id === delivered[0]?.eventId);
      expect(survivor?.title).toBe('edit 3');
      expect(survivor?.snapshotText).toBe(SPAN_STATES[2]);
      const netDelta = delivered[0]?.diffText;
      expect(netDelta).toContain('EDIT-1');
      expect(netDelta).toContain('EDIT-2');
      expect(netDelta).toContain('EDIT-3');

      // The two suppressed intermediates are edits 1 and 2 — recorded, retrievable
      // via explain, never delivered.
      const suppressedTitles = suppressed
        .map((p) => events.find((e) => e.id === p.eventId)?.title)
        .sort();
      expect(suppressedTitles).toEqual(['edit 1', 'edit 2']);
    });

    /**
     * Assert an `incremental`-style delivery (002 §1.1.7): the recipient
     * receives one event per span observation (N=3), every intermediate
     * observation materialized — NOT collapsed. The proof is the count (3, vs.
     * `net`'s 1) and that all three distinct endpoint states are present as
     * separate events, so no intermediate churn was discarded.
     *
     * Note: each event still carries its own non-empty diff (its state changed
     * from the prior point), but the exact prior-snapshot each diffed against is
     * not asserted — within a sub-second span the shared snapshot store ties on
     * its one-second `createdAt`, so the precise diff base is not deterministic.
     * The spec's incremental guarantee is "N ordered deltas delivered as N
     * events", which is what is asserted here.
     */
    function expectIncrementalChain(events: MonitorEventRecord[]): void {
      const spanEvents = events.filter((event) => event.title !== 'baseline');
      // 002 §1.1.7: N=3 deltas, play-by-play (one event per step, nothing
      // collapsed).
      expect(spanEvents).toHaveLength(3);
      const byTitle = new Map(spanEvents.map((event) => [event.title, event]));
      expect([...byTitle.keys()].sort()).toEqual([
        'edit 1',
        'edit 2',
        'edit 3',
      ]);

      // Every intermediate observation survived as its own event with its own
      // endpoint snapshot — the play-by-play, not a single net delta.
      expect(byTitle.get('edit 1')?.snapshotText).toBe(SPAN_STATES[0]);
      expect(byTitle.get('edit 2')?.snapshotText).toBe(SPAN_STATES[1]);
      expect(byTitle.get('edit 3')?.snapshotText).toBe(SPAN_STATES[2]);

      // Each step is a real, non-empty delta (the state changed at each point).
      for (const title of ['edit 1', 'edit 2', 'edit 3']) {
        expect(byTitle.get(title)?.diffText).toBeTruthy();
      }
    }

    // Criterion (c): an `incremental` recipient in the same scenario receives N
    // ordered deltas (002 §1.1.7).
    it('incremental: a recipient that missed N observations receives N ordered deltas', async () => {
      const { events } = await deliverSpan(
        'baseline-strategy: incremental\n',
        'claude-g13-incremental',
      );
      // Tick 1 baseline (1 event) + the 3-observation span delivered as 3 deltas.
      expect(events).toHaveLength(4);
      expectIncrementalChain(events);
    });

    // Criterion (d): omitting `baseline-strategy` defaults to `net` (2026-06-19
    // decision, Refs #110 / 001 §3.7 / 002 §1.1.7). The omitted-field case
    // must behave identically to an explicit `baseline-strategy: net` — the
    // recipient is delivered ONE net delta for a catch-up span of N observations.
    it('omitting baseline-strategy defaults to net (one net delta per object)', async () => {
      const { runtime, monitorsDir, rootDir, sessionId, events } =
        await deliverSpan('', 'claude-g13-omitted');

      // Baseline (1 event) + 3 span observations on the SHARED chain (the
      // incremental substrate is unchanged regardless of strategy).
      expect(events).toHaveLength(4);

      // Per-recipient delivery under the net default: claim the catch-up span;
      // exactly ONE delivered event for the single object (the newest of the 3).
      runtime.claimDelivery(sessionId, 'turn-interruptible');
      const report = await runtime.explainMonitor({
        monitorId: 'span-monitor',
        monitorsDir,
        workspacePath: rootDir,
      });
      const spanEvents = events.filter((e) => e.title !== 'baseline');
      const spanIds = new Set(spanEvents.map((e) => e.id));
      const spanProjections = report.projections.filter(
        (p) => p.sessionId === sessionId && spanIds.has(p.eventId),
      );
      // ONE delivered (not net-suppressed) — identical behavior to explicit `net`.
      const delivered = spanProjections.filter((p) => !p.netSuppressed);
      const suppressed = spanProjections.filter((p) => p.netSuppressed);
      expect(delivered).toHaveLength(1);
      expect(suppressed).toHaveLength(2);
      // The surviving event is the endpoint (edit 3, where things stand now).
      const survivor = events.find((e) => e.id === delivered[0]?.eventId);
      expect(survivor?.title).toBe('edit 3');
    });
  });

  // --- Scheduled-rollup Pace mode (G12) ------------------------------------
  //
  // Contract (001 §3.6, 002 §4.4): a `notify.strategy: rollup` monitor
  // accumulates every observation in durable `notifyState.pendingRollup` and
  // delivers nothing until the author's `window` cron fires. On the window
  // opening the whole accumulated batch is flushed as one composite delivery
  // and the accumulation state is cleared; an empty window produces no delivery.
  // The batch MUST survive a daemon restart (restart-safety, BP1).
  //
  // The window cron is evaluated against the injected `now` (fake timers), so
  // these tests are fully deterministic. A short `interval` makes the monitor
  // due every tick; time is advanced past the interval between ticks.
  describe('rollup Pace mode (G12, 002 §4.4)', () => {
    // A source that hands out one queued observation per tick (or none when the
    // queue is exhausted), so a test can drive accumulation tick by tick.
    function queuedSource(
      name: string,
      queue: { title: string }[],
    ): ObservationSource {
      return {
        name,
        scopeSchema: { type: 'object', properties: {} },
        stateful: true,
        async observe(): Promise<ObservationResult> {
          const next = queue.shift();
          return {
            observations: next
              ? [{ title: next.title, summary: next.title }]
              : [],
            nextState: {},
          };
        },
      };
    }

    // Window opens at 09:00 UTC daily; 08:00 UTC is firmly outside it.
    const WINDOW = '0 9 * * *';
    const OUTSIDE_WINDOW = new Date('2026-03-20T08:00:00.000Z');
    const AT_WINDOW = new Date('2026-03-20T09:00:00.000Z');

    function rollupMonitorDir(rootDir: string, sourceName: string): string {
      return createMonitorFile(
        rootDir,
        sourceName,
        'normal',
        'Daily digest.',
        `  interval: '1s'\nnotify:\n  strategy: rollup\n  window: '${WINDOW}'\n`,
      );
    }

    // (b) Observations accumulate durably across ticks WITHOUT delivering
    //     between windows (002 §4.4 step 1 + step 6).
    it('accumulates observations across ticks without delivering between windows', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(OUTSIDE_WINDOW);
      try {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-rollup-'));
        tempDirs.push(rootDir);
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-accumulate');

        const db = createDb(':memory:');
        const registry = new SourceRegistry();
        registry.register(
          queuedSource('rollup-accumulate', [
            { title: 'Change A' },
            { title: 'Change B' },
          ]),
        );
        const store = new RuntimeStore(db);
        const runtime = new AgentMonitorRuntime(store, registry, [
          claudeCodeAdapter,
        ]);
        const session = runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-accumulate',
            workspacePath: rootDir,
          }),
        );

        // Tick 1 (08:00, outside the window): Change A is accumulated, not
        // delivered.
        const tick1 = await runtime.tick(monitorsDir, rootDir);
        expect(tick1.emittedEventIds).toHaveLength(0);

        // Advance past the 1s interval so the monitor is due again, still 08:00.
        vi.setSystemTime(new Date(OUTSIDE_WINDOW.getTime() + 2_000));

        // Tick 2 (still outside the window): Change B is accumulated, not
        // delivered.
        const tick2 = await runtime.tick(monitorsDir, rootDir);
        expect(tick2.emittedEventIds).toHaveLength(0);

        // Nothing has been delivered to the session.
        expect(
          runtime.listEvents({ sessionId: session.id, unreadOnly: true }),
        ).toHaveLength(0);

        // Both observations are held durably in notifyState.pendingRollup.
        const held =
          store.getMonitorState('test-monitor').notifyState.pendingRollup;
        expect(held?.observations).toHaveLength(2);
        expect(held?.observations.map((o) => o.observation.title)).toEqual([
          'Change A',
          'Change B',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    // (c) The window opening flushes the whole accumulated batch and clears the
    //     accumulation state (002 §4.4 step 2).
    it('flushes the accumulated batch and clears state when the window fires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(OUTSIDE_WINDOW);
      try {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-rollup-'));
        tempDirs.push(rootDir);
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-flush');

        const db = createDb(':memory:');
        const registry = new SourceRegistry();
        registry.register(
          queuedSource('rollup-flush', [
            { title: 'Change A' },
            { title: 'Change B' },
          ]),
        );
        const store = new RuntimeStore(db);
        const runtime = new AgentMonitorRuntime(store, registry, [
          claudeCodeAdapter,
        ]);
        const session = runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-flush',
            workspacePath: rootDir,
          }),
        );

        // Tick 1 (08:00): accumulate Change A, no delivery.
        const tick1 = await runtime.tick(monitorsDir, rootDir);
        expect(tick1.emittedEventIds).toHaveLength(0);

        // Tick 2 (09:00, window fires): Change B arrives this tick and the whole
        // batch (A + B) flushes as one composite delivery — two event rows
        // (002 §4.4 step 4: one row per accumulated observation).
        vi.setSystemTime(AT_WINDOW);
        const tick2 = await runtime.tick(monitorsDir, rootDir);
        expect(tick2.emittedEventIds).toHaveLength(2);

        const delivered = runtime.listEvents({
          sessionId: session.id,
          unreadOnly: true,
        });
        expect(delivered).toHaveLength(2);
        // Both accumulated observations are present (sorted for deterministic
        // assertion order, since listEvents returns newest-first by default).
        expect(delivered.map((e) => e.title).sort()).toEqual([
          'Change A',
          'Change B',
        ]);

        // The accumulation state is cleared after the flush.
        expect(
          store.getMonitorState('test-monitor').notifyState.pendingRollup,
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // (d) An empty window produces no delivery (002 §4.4 step 3 — no empty
    //     pings). The window opens but nothing accumulated since the last flush.
    it('produces no delivery when the window opens with an empty batch', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(AT_WINDOW);
      try {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-rollup-'));
        tempDirs.push(rootDir);
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-empty');

        const db = createDb(':memory:');
        const registry = new SourceRegistry();
        // Empty queue: the source never returns an observation.
        registry.register(queuedSource('rollup-empty', []));
        const store = new RuntimeStore(db);
        const runtime = new AgentMonitorRuntime(store, registry, [
          claudeCodeAdapter,
        ]);
        const session = runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-empty',
            workspacePath: rootDir,
          }),
        );

        // Tick at 09:00 (the window IS open) with nothing accumulated: no
        // delivery, and no pendingRollup state is created.
        const tick = await runtime.tick(monitorsDir, rootDir);
        expect(tick.emittedEventIds).toHaveLength(0);
        expect(
          runtime.listEvents({ sessionId: session.id, unreadOnly: true }),
        ).toHaveLength(0);
        expect(
          store.getMonitorState('test-monitor').notifyState.pendingRollup,
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // (e) Restart-safety (BP1, 002 §4.4 step 1): an accumulated batch persisted
    //     before a daemon restart survives the restart and flushes on the next
    //     window opening. Modeled with a file-backed DB and TWO independent
    //     runtime instances (the first is dropped entirely, simulating a daemon
    //     stop), so the batch is recovered only from durable persistence.
    it('survives a daemon restart and flushes the recovered batch on the next window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(OUTSIDE_WINDOW);
      try {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-rollup-'));
        tempDirs.push(rootDir);
        const dbPath = path.join(rootDir, 'agentmon.db');
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-restart');

        // --- Daemon instance #1: accumulate a batch, then "crash" (drop it). ---
        const runtimeA = createRuntime(
          dbPath,
          queuedSource('rollup-restart', [{ title: 'Pre-restart change' }]),
        );
        const session = runtimeA.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-restart',
            workspacePath: rootDir,
          }),
        );

        // Tick at 08:00 (outside window): the observation accumulates durably.
        const tickA = await runtimeA.tick(monitorsDir, rootDir);
        expect(tickA.emittedEventIds).toHaveLength(0);

        // Confirm the batch was persisted to disk before the restart.
        const persisted = new RuntimeStore(createDb(dbPath)).getMonitorState(
          'test-monitor',
        ).notifyState.pendingRollup;
        expect(persisted?.observations).toHaveLength(1);

        // --- Daemon instance #2: fresh runtime over the SAME on-disk DB. ---
        // The accumulated batch exists only in durable persistence now; the
        // source queue is empty so the only thing that can flush is the
        // recovered batch.
        vi.setSystemTime(AT_WINDOW);
        const runtimeB = createRuntime(
          dbPath,
          queuedSource('rollup-restart', []),
        );

        // Tick at 09:00 (window fires): the recovered pre-restart batch flushes.
        const tickB = await runtimeB.tick(monitorsDir, rootDir);
        expect(tickB.emittedEventIds).toHaveLength(1);

        const delivered = runtimeB.listEvents({
          sessionId: session.id,
          unreadOnly: true,
        });
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.title).toBe('Pre-restart change');
        // A valid urgency was materialized for the restart-recovered envelope
        // (hydration backfill, 002 §3 / §4.4 step 1), never `undefined`.
        expect(delivered[0]?.urgency).toBe('normal');

        // The accumulation state is cleared after the post-restart flush.
        expect(
          new RuntimeStore(createDb(dbPath)).getMonitorState('test-monitor')
            .notifyState.pendingRollup,
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // (f) Once-per-minute guard (002 §4.4 step 2): two ticks within the same
    //     calendar minute must produce exactly ONE flush, not two.
    //     `cronMatchesDate` returns true for any timestamp within the matching
    //     minute, so without the `rollupLastFiredMinute` guard a sub-minute tick
    //     interval would emit the batch twice. This is a regression test for
    //     the guard introduced alongside G12.
    it('fires the window at most once per minute even when ticked twice in the same window minute', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(OUTSIDE_WINDOW);
      try {
        const rootDir = mkdtempSync(
          path.join(tmpdir(), 'agentmon-rollup-once-'),
        );
        tempDirs.push(rootDir);
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-once');

        const db = createDb(':memory:');
        const registry = new SourceRegistry();
        // One observation to accumulate, then empty thereafter.
        registry.register(
          queuedSource('rollup-once', [{ title: 'Single Change' }]),
        );
        const store = new RuntimeStore(db);
        const runtime = new AgentMonitorRuntime(store, registry, [
          claudeCodeAdapter,
        ]);
        runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-once',
            workspacePath: rootDir,
          }),
        );

        // Tick 1 (08:00): accumulate the observation, window not open yet.
        const tick1 = await runtime.tick(monitorsDir, rootDir);
        expect(tick1.emittedEventIds).toHaveLength(0);

        // Advance to the window minute (09:00:05 — still minute 09:00).
        vi.setSystemTime(AT_WINDOW);

        // Tick 2 (09:00:05): window fires, batch flushes — ONE event emitted.
        const tick2 = await runtime.tick(monitorsDir, rootDir);
        expect(tick2.emittedEventIds).toHaveLength(1);

        // Advance 30 seconds — still within the 09:00 minute.
        vi.setSystemTime(new Date(AT_WINDOW.getTime() + 30_000));

        // Tick 3 (09:00:35, same calendar minute as tick 2): the window cron
        // still matches this timestamp. The once-per-minute guard MUST prevent
        // a second flush. The batch was already cleared so nothing is emitted.
        const tick3 = await runtime.tick(monitorsDir, rootDir);
        expect(tick3.emittedEventIds).toHaveLength(0);

        // rollupLastFiredMinute is persisted so it survives to guard tick 3.
        const state = store.getMonitorState('test-monitor');
        expect(state.notifyState.rollupLastFiredMinute).toBe(
          Math.floor(AT_WINDOW.getTime() / 60_000),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // (g) Explain path treats pendingRollup as a pending hold (002 §4.4 step 6):
    //     when observations are accumulated between windows, `monitor explain`
    //     must surface the notify stage as 'pending' and describe the hold —
    //     consistent with how the debounce strategy reports its held batch.
    it('explain shows notify stage as pending when rollup is accumulating', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(OUTSIDE_WINDOW);
      try {
        const rootDir = mkdtempSync(
          path.join(tmpdir(), 'agentmon-rollup-explain-'),
        );
        tempDirs.push(rootDir);
        const monitorsDir = rollupMonitorDir(rootDir, 'rollup-explain');

        const db = createDb(':memory:');
        const registry = new SourceRegistry();
        // One observation to accumulate; the window is closed so it stays held.
        registry.register(
          queuedSource('rollup-explain', [{ title: 'Queued Change' }]),
        );
        const store = new RuntimeStore(db);
        const runtime = new AgentMonitorRuntime(store, registry, [
          claudeCodeAdapter,
        ]);
        runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'claude-rollup-explain',
            workspacePath: rootDir,
          }),
        );

        // Tick at 08:00 (outside window): observation accumulates, not flushed.
        const tick = await runtime.tick(monitorsDir, rootDir);
        expect(tick.emittedEventIds).toHaveLength(0);

        // explain() must report the notify stage as 'pending' with a message
        // describing the rollup hold, and materialization must also be 'pending'
        // (not 'failure') since the batch will flush on the next window.
        const report = await runtime.explainMonitor({
          monitorId: 'test-monitor',
          monitorsDir,
          workspacePath: rootDir,
          now: OUTSIDE_WINDOW,
        });

        const notifyStage = report.stages.find((s) => s.id === 'notify');
        expect(notifyStage?.status).toBe('pending');
        expect(notifyStage?.reason).toMatch(/rollup is holding 1 observation/);
        expect(notifyStage?.reason).toMatch(/0 9 \* \* \*/);

        const materializationStage = report.stages.find(
          (s) => s.id === 'materialization',
        );
        expect(materializationStage?.status).toBe('pending');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- Rollup not-due flush composition (issue #180, G12 × G13) -------------
  //
  // Bug: tick() flushes a rollup batch via two paths. The DUE path goes through
  // ingest() (which applies `net` collapse — 002 §1.1.7 — AND records a
  // `triggered` observation_history row — 002 §10.7). The NOT-DUE path (the
  // source poll interval has NOT elapsed but the delivery window opens) is the
  // *normal* operating mode for a rollup monitor whose `watch.interval` is
  // relaxed to match the window (002 §4.4), and it had drifted: it applied
  // neither behavior. Both paths now route through the shared materializeSpan().
  //
  // Expected delta/history counts below are written BY HAND from the spec, not
  // captured from program output.
  describe('rollup not-due flush composition (issue #180, 002 §1.1.7 / §10.7)', () => {
    const NET_OBJECT_KEY = 'doc-1';
    // Three successive states of one object accumulated across three ticks.
    // Distinct text per state so each transition is a real diff and the net
    // collapse vs. the play-by-play are unambiguously distinguishable.
    const STATES = [
      'line-a EDIT-1\nline-b\nline-c\n',
      'line-a EDIT-1\nline-b EDIT-2\nline-c\n',
      'line-a EDIT-1\nline-b EDIT-2\nline-c EDIT-3\n',
    ] as const;

    // Window opens at 09:00 UTC daily; the accumulation ticks run at 08:00.
    const WINDOW = '0 9 * * *';
    const ACCUM_BASE = new Date('2026-03-20T08:00:00.000Z');
    const WINDOW_AT = new Date('2026-03-20T09:00:00.000Z');

    /**
     * A rollup source that emits, on each of its first three observe() calls,
     * one observation for the shared `NET_OBJECT_KEY` carrying the next state in
     * `STATES` (title/summary `edit 1..3`). Subsequent calls emit nothing. This
     * accumulates a 3-observation single-object catch-up span into the durable
     * `pendingRollup` batch before the window fires.
     */
    function netRollupSource(name: string): ObservationSource {
      let call = 0;
      return {
        name,
        scopeSchema: { type: 'object', properties: {} },
        stateful: true,
        observe(): Promise<ObservationResult> {
          const index = call;
          call += 1;
          if (index < STATES.length) {
            return Promise.resolve({
              observations: [
                {
                  title: `edit ${String(index + 1)}`,
                  summary: `edit ${String(index + 1)}`,
                  objectKey: NET_OBJECT_KEY,
                  snapshotText: STATES[index],
                },
              ],
              nextState: {},
            });
          }
          return Promise.resolve({ observations: [], nextState: {} });
        },
      };
    }

    /**
     * Write a rollup MONITOR.md with the given source, the given
     * `baseline-strategy` line, `interval: '2s'`, and the daily 09:00 window.
     */
    function writeNetRollupMonitor(
      rootDir: string,
      sourceName: string,
      baselineStrategyLine: string,
    ): string {
      const monitorsDir = path.join(
        rootDir,
        '.claude',
        'monitors',
        'test-monitor',
      );
      mkdirSync(monitorsDir, { recursive: true });
      writeFileSync(
        path.join(monitorsDir, 'MONITOR.md'),
        `---
name: Net rollup monitor
watch:
  type: ${sourceName}
  interval: '2s'
urgency: normal
notify:
  strategy: rollup
  window: '${WINDOW}'
${baselineStrategyLine}---
Daily digest.
`,
        'utf-8',
      );
      return path.join(rootDir, '.claude', 'monitors');
    }

    /**
     * Accumulate the three `STATES` observations across three DUE ticks at
     * 08:00:00/02/04 (interval 2s, so each tick is due), then flush via the
     * NOT-DUE path: set `lastObservationAt` to exactly the window minus 1s so
     * elapsed = 1000ms < 2000ms (not due), and tick at 09:00:00. The window
     * fires on this not-due tick — the path under test. Returns the runtime,
     * store, and session so each test can assert on events + history.
     */
    function setupNotDueFlush(
      sourceName: string,
      baselineStrategyLine: string,
    ): {
      runtime: AgentMonitorRuntime;
      store: RuntimeStore;
      sessionId: string;
      monitorsDir: string;
      rootDir: string;
    } {
      const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-180-'));
      tempDirs.push(rootDir);
      const monitorsDir = writeNetRollupMonitor(
        rootDir,
        sourceName,
        baselineStrategyLine,
      );
      const db = createDb(':memory:');
      const registry = new SourceRegistry();
      registry.register(netRollupSource(sourceName));
      const store = new RuntimeStore(db);
      const runtime = new AgentMonitorRuntime(store, registry, [
        claudeCodeAdapter,
      ]);
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: `claude-180-${sourceName}`,
          workspacePath: rootDir,
        }),
      );
      return {
        runtime,
        store,
        sessionId: session.id,
        monitorsDir,
        rootDir,
      };
    }

    /**
     * Drive the three accumulation ticks at 08:00:00/02/04 then the not-due
     * window tick at 09:00:00. Returns the tick result of the flush tick.
     */
    async function driveNotDueFlush(ctx: {
      runtime: AgentMonitorRuntime;
      store: RuntimeStore;
      monitorsDir: string;
      rootDir: string;
    }): Promise<RuntimeTickResult> {
      // Three DUE ticks at 08:00:00, 08:00:02, 08:00:04 (interval 2s → each due
      // after the prior tick set lastObservationAt). Each accumulates one
      // observation into pendingRollup; the window is closed, so nothing is
      // delivered.
      for (let i = 0; i < STATES.length; i += 1) {
        vi.setSystemTime(new Date(ACCUM_BASE.getTime() + i * 2_000));
        const tick = await ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);
        expect(tick.emittedEventIds).toHaveLength(0);
      }

      // Confirm the full 3-observation span is held durably before the flush.
      const held =
        ctx.store.getMonitorState('test-monitor').notifyState.pendingRollup;
      expect(held?.observations).toHaveLength(STATES.length);

      // Force the NOT-DUE condition at the window: lastObservationAt = window −
      // 1s. The integer 'timestamp' column truncates to whole seconds, so
      // elapsed = 1000ms < 2000ms (interval 2s) → the monitor is NOT due, yet
      // the 09:00 window opens. This is the not-due rollup branch (the bug).
      ctx.store.setMonitorState('test-monitor', {
        sourceState: ctx.store.getMonitorState('test-monitor').sourceState,
        notifyState: ctx.store.getMonitorState('test-monitor').notifyState,
        lastObservationAt: new Date(WINDOW_AT.getTime() - 1_000),
      });

      vi.setSystemTime(WINDOW_AT);
      return ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);
    }

    /**
     * Claim the not-due/due flush as the recipient and assert the per-recipient
     * `net` collapse (G10 PR-B, 002 §1.1.7): the shared chain materialized all
     * three rollup edits, but the recipient is delivered exactly ONE net delta
     * (the newest, edit 3, against its baseline) with the two intermediates
     * recorded claimed-but-suppressed and explainable.
     */
    async function expectNetDeliveryCollapsedToOne(ctx: {
      runtime: AgentMonitorRuntime;
      sessionId: string;
      monitorsDir: string;
      rootDir: string;
    }): Promise<void> {
      ctx.runtime.claimDelivery(ctx.sessionId, 'turn-interruptible');
      const report = await ctx.runtime.explainMonitor({
        monitorId: 'test-monitor',
        monitorsDir: ctx.monitorsDir,
        workspacePath: ctx.rootDir,
        now: WINDOW_AT,
      });
      const mine = report.projections.filter(
        (p) => p.sessionId === ctx.sessionId,
      );
      const delivered = mine.filter((p) => !p.netSuppressed);
      const suppressed = mine.filter((p) => p.netSuppressed);
      expect(delivered).toHaveLength(1);
      expect(suppressed).toHaveLength(2);
      // The delivered survivor is the newest event (edit 3, endpoint state).
      const survivor = report.events.find(
        (e) => e.id === delivered[0]?.eventId,
      );
      expect(survivor?.title).toBe('edit 3');
      expect(survivor?.snapshotText).toBe(STATES[2]);
    }

    // Criterion 1 (P1, 002 §1.1.7) + G10 PR-B: rollup + net, window fires on a
    // NOT-DUE tick after 3 accumulated edits to one objectKey. The SHARED chain
    // now records all three (the incremental substrate, Decision Q3); the
    // per-recipient DELIVERY collapses to ONE net delta at claim. (Pre-PR-B the
    // collapse was applied on the shared chain — issue #180; now it is moved to
    // claim-time, so both flush paths keep parity by recording all three.)
    it('net: not-due window flush records all three on the shared chain; the recipient gets one net delta', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setupNotDueFlush(
          'rollup-180-net',
          'baseline-strategy: net\n',
        );
        const flush = await driveNotDueFlush(ctx);

        // Shared chain: all three rollup edits materialized (no shared collapse).
        expect(flush.emittedEventIds).toHaveLength(STATES.length);
        const shared = ctx.runtime.listEvents({ sessionId: ctx.sessionId });
        expect(shared).toHaveLength(STATES.length);

        // Per-recipient delivery collapses to one net delta at claim.
        await expectNetDeliveryCollapsedToOne(ctx);
      } finally {
        vi.useRealTimers();
      }
    });

    // Criterion 1 control (002 §1.1.7): the DUE path (via ingest()) records the
    // same three shared events and the same single per-recipient net delivery.
    // Asserting both paths agree proves the shared helper kept the not-due path
    // matching the due path — no drift (issue #180 invariant, PR-B form).
    it('net: due-path flush agrees with the not-due path (both record three shared events, deliver one net delta)', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setupNotDueFlush(
          'rollup-180-net-due',
          'baseline-strategy: net\n',
        );

        // Accumulate the three edits across due ticks (window closed).
        for (let i = 0; i < STATES.length; i += 1) {
          vi.setSystemTime(new Date(ACCUM_BASE.getTime() + i * 2_000));
          const tick = await ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);
          expect(tick.emittedEventIds).toHaveLength(0);
        }

        // DUE flush: lastObservationAt is 08:00:04, the window is 09:00:00, so
        // elapsed ≫ 2s → the monitor IS due and the window opens → ingest()
        // path. No setMonitorState override.
        vi.setSystemTime(WINDOW_AT);
        const flush = await ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);

        expect(flush.emittedEventIds).toHaveLength(STATES.length);
        const shared = ctx.runtime.listEvents({ sessionId: ctx.sessionId });
        expect(shared).toHaveLength(STATES.length);

        await expectNetDeliveryCollapsedToOne(ctx);
      } finally {
        vi.useRealTimers();
      }
    });

    // Criterion 2 (P2, 002 §10.7 / §1.1.6): the not-due flush records a
    // `triggered` observation_history row retrievable via listObservationHistory
    // and surfaced by monitor explain. Before the fix the not-due branch wrote
    // NO history row, so a real daily-digest delivery was invisible to the audit
    // trail (it appeared as "nothing triggered").
    it('records a triggered observation_history row for the not-due flush (audit trail)', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setupNotDueFlush(
          'rollup-180-history',
          'baseline-strategy: net\n',
        );
        const flush = await driveNotDueFlush(ctx);
        // G10 PR-B: the shared chain records all three (per-recipient collapse
        // happens at claim, not on the shared chain).
        expect(flush.emittedEventIds).toHaveLength(STATES.length);

        const history = ctx.runtime.listObservationHistory({
          monitorId: 'test-monitor',
        });
        // The most-recent row (newest-first) is the flush. It MUST be
        // `triggered` — a real delivery happened — not the prior `suppressed`
        // accumulation rows.
        expect(history[0]?.result).toBe('triggered');
        // The audit row counts what was *dispatched* into the flush (the whole
        // accumulated span of 3), not what survived the net collapse — matching
        // ingest()'s due-path behavior, where the row reflects dispatch, not
        // materialization (002 §10.7). The `triggered` result is the contract;
        // this count assertion just pins the row to the due-path semantics.
        expect(history[0]?.observationData['emitted']).toBe(STATES.length);
        expect(history[0]?.observationData['observed']).toBe(0);

        // The audit row is surfaced by `monitor explain` (002 §10.7): the
        // report's observation history carries the `triggered` row.
        const report = await ctx.runtime.explainMonitor({
          monitorId: 'test-monitor',
          monitorsDir: ctx.monitorsDir,
          workspacePath: ctx.rootDir,
          now: WINDOW_AT,
        });
        expect(report.observations[0]?.result).toBe('triggered');
      } finally {
        vi.useRealTimers();
      }
    });

    // Criterion 3 (no regression, 002 §1.1.7): rollup + explicit `incremental`
    // on the not-due path still delivers N ordered deltas — the play-by-play is
    // preserved, not collapsed. The shared helper must leave the incremental
    // span untouched.
    it('incremental: not-due window flush still delivers N ordered deltas (no regression)', async () => {
      vi.useFakeTimers();
      try {
        const ctx = setupNotDueFlush(
          'rollup-180-incremental',
          'baseline-strategy: incremental\n',
        );
        const flush = await driveNotDueFlush(ctx);

        // All three edits delivered as their own events — the play-by-play.
        expect(flush.emittedEventIds).toHaveLength(STATES.length);

        // listEvents() returns newest-first; reverse to get chronological order
        // so we can assert delivery sequence directly without sorting (sorting
        // would discard ordering and miss a regression that reorders events).
        const delivered = ctx.runtime
          .listEvents({ sessionId: ctx.sessionId })
          .slice()
          .reverse();
        expect(delivered).toHaveLength(STATES.length);
        // 002 §1.1.7: N=3 ordered deltas — edit 1 before edit 2 before edit 3.
        expect(delivered.map((e) => e.title)).toEqual([
          'edit 1',
          'edit 2',
          'edit 3',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    // No regression for the empty not-due tick: the window check runs on EVERY
    // not-due tick, but an empty flush (window closed, or nothing accumulated)
    // must NOT write a `no-change` audit row each tick — only a real flush is
    // recorded. (The call site guards materializeSpan on emitted.length > 0.)
    it('does not record an audit row for a not-due tick that flushes nothing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(ACCUM_BASE);
      try {
        const ctx = setupNotDueFlush(
          'rollup-180-empty',
          'baseline-strategy: net\n',
        );

        // First due tick at 08:00:00 accumulates edit 1 (suppressed: held in the
        // closed window) and writes its own audit row via ingest().
        await ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);
        const afterAccum = ctx.runtime.listObservationHistory({
          monitorId: 'test-monitor',
        }).length;

        // Force NOT-DUE but window still CLOSED (08:00:00 + 1s lastObservationAt,
        // tick at 08:00:00.5 → elapsed < 2s, window not open). Several not-due
        // ticks must not append audit rows.
        ctx.store.setMonitorState('test-monitor', {
          sourceState: ctx.store.getMonitorState('test-monitor').sourceState,
          notifyState: ctx.store.getMonitorState('test-monitor').notifyState,
          lastObservationAt: ACCUM_BASE,
        });
        vi.setSystemTime(new Date(ACCUM_BASE.getTime() + 500));
        const notDue = await ctx.runtime.tick(ctx.monitorsDir, ctx.rootDir);
        expect(notDue.emittedEventIds).toHaveLength(0);

        // No new audit row was written for the empty not-due window check.
        expect(
          ctx.runtime.listObservationHistory({ monitorId: 'test-monitor' })
            .length,
        ).toBe(afterAccum);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
