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
  extraScope = '',
): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors', 'test-monitor');
  const monitorFile = path.join(monitorsDir, 'MONITOR.md');
  mkdirSync(monitorsDir, { recursive: true });
  writeFileSync(
    monitorFile,
    `---
name: Test monitor
source: ${sourceName}
urgency: ${urgency}
event-kind: mutation
scope:
  filePath: ${JSON.stringify(path.join(rootDir, 'watched.txt'))}
${extraScope}
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
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs: ["*.ts"]
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
      eventKind: 'alert',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
      eventKind: 'notification',
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
});
