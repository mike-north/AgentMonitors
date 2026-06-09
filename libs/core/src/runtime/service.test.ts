import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord } from './types.js';
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
  urgency: 'low' | 'normal' | 'high' = 'normal',
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

    await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.result).toBe('errored');
    // String(error) of a plain string is the string itself
    expect(history[0]?.observationData).toEqual({
      error: 'string failure value',
    });
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
});
