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
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord, RuntimeTickResult } from './types.js';
import type { ReminderSuppressionFinding } from './reminder-diagnosis.js';
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

/**
 * Like {@link createRuntime} but also returns the underlying {@link RuntimeStore}
 * so a test can read back persisted monitor state (e.g. the durably-written
 * `sourceState` after a watch-mode checkpoint, 002 §2.4).
 */
function createRuntimeWithStore(
  dbPath: string,
  source: ObservationSource,
): { runtime: AgentMonitorRuntime; store: RuntimeStore } {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registry.register(source);
  const store = new RuntimeStore(db);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  return { runtime, store };
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

  // Issue #407: `verify --use-workspace-daemon` must retract the events its own
  // scratch file produced against the persistent workspace daemon (a create AND
  // a delete), so a later session never sees them. The retraction removes ONE
  // object's events across EVERY session they projected into, and leaves every
  // OTHER object's events untouched.
  it('retractObjectEvents removes only the target object, across all sessions', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );

    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-a',
        workspacePath: rootDir,
      }),
    );
    const sessionB = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-b',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    const scratchKey = path.join(rootDir, 'agentmonitors-verify-abc123.md');
    const realKey = path.join(rootDir, 'readme.md');
    const base = {
      workspacePath: rootDir,
      monitorId: 'docs-watch',
      sourceName: 'file-fingerprint',
      urgency: 'normal' as const,
      body: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      queryScope: {},
      tags: [],
    };
    // The synthetic scratch object: a create THEN a delete event (the exact
    // pair verify's own trigger produces), both projecting to A and B. Capture
    // their ids — retraction deletes by the exact ids verify observed.
    const created = store.insertEvent({
      ...base,
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(Date.now() - 3_000),
    });
    const deleted = store.insertEvent({
      ...base,
      title: `File deleted: ${scratchKey}`,
      summary: `File deleted: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(Date.now() - 2_000),
    });
    // A real object's event that must SURVIVE the retraction.
    store.insertEvent({
      ...base,
      title: `File changed: ${realKey}`,
      summary: `File changed: ${realKey}`,
      objectKey: realKey,
      createdAt: new Date(Date.now() - 1_000),
    });

    // Both sessions see all three before retraction.
    expect(runtime.listEvents({ sessionId: sessionA.id })).toHaveLength(3);
    expect(runtime.listEvents({ sessionId: sessionB.id })).toHaveLength(3);

    const removed = runtime.retractObjectEvents({
      workspacePath: rootDir,
      monitorId: 'docs-watch',
      objectKey: scratchKey,
      eventIds: [created.id, deleted.id],
    });
    // Exactly the create + the delete were removed.
    expect(removed).toBe(2);

    // Both sessions now see ONLY the real object's event — no scratch events.
    for (const session of [sessionA, sessionB]) {
      const events = runtime.listEvents({ sessionId: session.id });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectKey).toBe(realKey);
      expect(events.some((e) => e.objectKey === scratchKey)).toBe(false);
    }

    // The session-less shared stream has no scratch events left either.
    expect(
      runtime.listEvents({
        monitorId: 'docs-watch',
        objectKey: scratchKey,
        workspacePath: rootDir,
      }),
    ).toHaveLength(0);
  });

  // Negative: `monitorId` is a defense-in-depth guard on the id set. Even when a
  // DIFFERENT monitor's event id is passed alongside the target's — and its
  // object shares the same key — retraction must delete ONLY the ids that belong
  // to the named monitor, never over-reaching across monitors.
  it('retractObjectEvents is scoped to the monitor id (a namesake object of another monitor is untouched even if its id is passed)', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-scope',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    const sharedKey = path.join(rootDir, 'shared.md');
    const base = {
      workspacePath: rootDir,
      sourceName: 'file-fingerprint',
      urgency: 'normal' as const,
      body: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: sharedKey,
      queryScope: {},
      tags: [],
      createdAt: new Date(),
    };
    const one = store.insertEvent({
      ...base,
      monitorId: 'monitor-one',
      title: `File changed: ${sharedKey} (one)`,
      summary: `File changed: ${sharedKey} (one)`,
    });
    const two = store.insertEvent({
      ...base,
      monitorId: 'monitor-two',
      title: `File changed: ${sharedKey} (two)`,
      summary: `File changed: ${sharedKey} (two)`,
    });

    // Pass BOTH ids but name only monitor-one: the guard must drop monitor-two's
    // id, deleting exactly one row.
    const removed = runtime.retractObjectEvents({
      workspacePath: rootDir,
      monitorId: 'monitor-one',
      objectKey: sharedKey,
      eventIds: [one.id, two.id],
    });
    expect(removed).toBe(1);

    // monitor-two's event with the SAME object key survives.
    const survivors = runtime.listEvents({ sessionId: session.id });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.monitorId).toBe('monitor-two');
  });

  // Issue #407 review (event-loss): the literal-glob branch of verify's trigger
  // watches a REAL path, and `synthetic` there means only "the file did not
  // exist when verify started" — that path can still carry PRIOR history, e.g. an
  // earlier unacked delete event a user has not yet seen. A `(monitorId,
  // objectKey)` sweep would take that real event down with verify's own pair.
  // Deleting by the exact ids verify observed must leave the pre-existing event
  // intact. (Pre-fix: the sweep deletes all three, so `historical` vanishes.)
  it('retractObjectEvents by id leaves a pre-existing event at the same watched path intact (literal-glob)', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-literal',
        workspacePath: rootDir,
      }),
    );

    const store = new RuntimeStore(db);
    // A literal watched file (the objectKey the literal-glob branch acts on).
    const watchedKey = path.join(rootDir, 'notes.md');
    const base = {
      workspacePath: rootDir,
      monitorId: 'notes-watch',
      sourceName: 'file-fingerprint',
      urgency: 'normal' as const,
      body: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: watchedKey,
      queryScope: {},
      tags: [],
    };
    // Prior REAL history at that path: an earlier delete the user has not acked.
    const historical = store.insertEvent({
      ...base,
      title: `File deleted: ${watchedKey}`,
      summary: `File deleted: ${watchedKey}`,
      createdAt: new Date(Date.now() - 5_000),
    });
    // verify then creates the (now-absent) file and deletes it again on teardown.
    const verifyCreate = store.insertEvent({
      ...base,
      title: `File created: ${watchedKey}`,
      summary: `File created: ${watchedKey}`,
      createdAt: new Date(Date.now() - 2_000),
    });
    const verifyDelete = store.insertEvent({
      ...base,
      title: `File deleted: ${watchedKey}`,
      summary: `File deleted: ${watchedKey}`,
      createdAt: new Date(Date.now() - 1_000),
    });

    // Retract ONLY the two ids verify itself observed for its own create/delete.
    const removed = runtime.retractObjectEvents({
      workspacePath: rootDir,
      monitorId: 'notes-watch',
      objectKey: watchedKey,
      eventIds: [verifyCreate.id, verifyDelete.id],
    });
    expect(removed).toBe(2);

    // The pre-existing historical event SURVIVES; verify's pair is gone.
    const survivors = runtime.listEvents({ sessionId: session.id });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(historical.id);
  });

  // Issue #407 review (session isolation): the cursor cleanup must not wipe
  // OTHER sessions' baselines for a literal path. A second session (here, in a
  // different workspace) holding a cursor at the SAME objectKey — but which never
  // received the retracted events — must keep its cursor, or its next observation
  // spuriously re-fires from a lost baseline. (Pre-fix: the cursor delete filters
  // only `(monitorId, objectKey)`, so session B's cursor is wiped too.)
  it('retractObjectEvents preserves an unaffected session cursor at the same object key', () => {
    const workspaceA = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-a-'));
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-b-'));
    tempDirs.push(workspaceA, workspaceB);
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );

    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-cursor-a',
        workspacePath: workspaceA,
      }),
    );
    const sessionB = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'retract-cursor-b',
        workspacePath: workspaceB,
      }),
    );

    const store = new RuntimeStore(db);
    // The same literal path watched by 'watch' in two workspaces (an absolute
    // glob target is identical across them).
    const literalKey = '/etc/agentmonitors-literal.md';
    // Session B's real baseline for that path, in ITS workspace — must survive.
    store.seedSessionObjectCursor({
      sessionId: sessionB.id,
      monitorId: 'watch',
      objectKey: literalKey,
      workspacePath: workspaceB,
      baselineSnapshotId: null,
      baselineContent: 'B real baseline',
    });

    // verify's synthetic create+delete land in workspace A only (they project to
    // session A and seed A's cursor there).
    const base = {
      monitorId: 'watch',
      sourceName: 'file-fingerprint',
      urgency: 'normal' as const,
      body: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: 'artifact',
      diffText: null,
      objectKey: literalKey,
      queryScope: {},
      tags: [],
    };
    const createA = store.insertEvent({
      ...base,
      workspacePath: workspaceA,
      title: `File created: ${literalKey}`,
      summary: `File created: ${literalKey}`,
      createdAt: new Date(Date.now() - 2_000),
    });
    const deleteA = store.insertEvent({
      ...base,
      workspacePath: workspaceA,
      title: `File deleted: ${literalKey}`,
      summary: `File deleted: ${literalKey}`,
      createdAt: new Date(Date.now() - 1_000),
    });
    // Sanity: A now has a seeded cursor for the object, B has its own.
    expect(
      store.getSessionObjectCursor(
        sessionA.id,
        'watch',
        literalKey,
        workspaceA,
      ),
    ).not.toBeNull();
    expect(
      store.getSessionObjectCursor(
        sessionB.id,
        'watch',
        literalKey,
        workspaceB,
      ),
    ).not.toBeNull();

    runtime.retractObjectEvents({
      workspacePath: workspaceA,
      monitorId: 'watch',
      objectKey: literalKey,
      eventIds: [createA.id, deleteA.id],
    });

    // Session B (unaffected — it never received the retracted events) keeps its
    // baseline; session A's seeded cursor is cleaned up.
    expect(
      store.getSessionObjectCursor(
        sessionB.id,
        'watch',
        literalKey,
        workspaceB,
      ),
    ).not.toBeNull();
    expect(
      store.getSessionObjectCursor(
        sessionA.id,
        'watch',
        literalKey,
        workspaceA,
      ),
    ).toBeNull();
  });

  // Issue #407 review (Copilot thread 3596229810): verify's retraction wait loop
  // decides the scratch object's delete has landed by counting its events (create
  // THEN delete => 2). That count MUST be scoped to verify's own monitor: a
  // second, broader monitor watching the same path also produces a create for it,
  // so an unscoped count reaches 2 from two CREATES (both monitors) before
  // verify's own delete lands — retracting early and stranding verify's delete
  // event. This proves the scoping the wait loop relies on: an objectKey listing
  // scoped by monitorId counts only that monitor's events. (Pre-fix the wait
  // query omitted monitorId, so the equivalent listing returned both monitors'.)
  it('listEvents scoped by monitorId does not count a second monitor’s event at the same object key', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    const scratchKey = path.join(rootDir, 'agentmonitors-verify-deadbeef.md');
    const base = {
      workspacePath: rootDir,
      sourceName: 'file-fingerprint',
      urgency: 'normal' as const,
      body: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: scratchKey,
      queryScope: {},
      tags: [],
    };
    // verify's own monitor has ONLY produced its create so far (delete pending).
    store.insertEvent({
      ...base,
      monitorId: 'verify-target',
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      createdAt: new Date(Date.now() - 2_000),
    });
    // A second broad monitor watching the same path also saw the create.
    store.insertEvent({
      ...base,
      monitorId: 'broad-watch',
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      createdAt: new Date(Date.now() - 1_500),
    });

    // Unscoped, two events exist for the path — the trap the wait loop must avoid.
    expect(
      runtime.listEvents({ objectKey: scratchKey, workspacePath: rootDir }),
    ).toHaveLength(2);
    // Scoped to verify's monitor, only its single (create) event counts, so the
    // wait loop keeps waiting for verify's own delete rather than retracting now.
    expect(
      runtime.listEvents({
        monitorId: 'verify-target',
        objectKey: scratchKey,
        workspacePath: rootDir,
      }),
    ).toHaveLength(1);
  });

  // Issue #338 (item 1): `events list --unread` filters on `acknowledgedAt IS
  // NULL` (002 §7), so it INCLUDES claimed-but-unacknowledged events — a
  // surprise for a debugger reading "unread" as "never seen". `listEvents()`
  // must report each session-scoped event's `deliveryState` so a caller can
  // tell the two apart, and that state must track claim/ack transitions.
  it('reports deliveryState on session-scoped listEvents, tracking unread -> claimed -> acknowledged', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-delivery-state',
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

    // Before any claim: unread, and --unread correctly includes it.
    const beforeClaim = runtime.listEvents({ sessionId: session.id });
    expect(beforeClaim).toHaveLength(1);
    expect(beforeClaim[0]?.deliveryState).toBe('unread');
    const beforeClaimUnread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(beforeClaimUnread[0]?.deliveryState).toBe('unread');

    // After a claim (but no ack): the event is claimed, NOT acknowledged —
    // --unread must still surface it (it's the "surprise" this test guards).
    runtime.claimDelivery(session.id, 'turn-interruptible');
    const afterClaim = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(afterClaim).toHaveLength(1);
    expect(afterClaim[0]?.deliveryState).toBe('claimed');

    // After acknowledgment: --unread excludes it, and an unfiltered query
    // reports it as acknowledged.
    runtime.acknowledgeSession(session.id, undefined);
    const afterAckUnread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(afterAckUnread).toHaveLength(0);
    const afterAck = runtime.listEvents({ sessionId: session.id });
    expect(afterAck[0]?.deliveryState).toBe('acknowledged');

    // A global (non-session-scoped) query has no single session's delivery
    // state to report.
    const unscoped = runtime.listEvents({});
    expect(unscoped[0]?.deliveryState).toBeUndefined();
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
      // Discriminated by `summary`, not `title`: since issue #449 the title of
      // every event from a NAMED monitor is that monitor's authored name, and
      // the source's own per-observation text is carried by `summary`.
      const summaries = unread
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((event) => event.summary);
      expect(summaries).toContain('Held normal item');
      expect(summaries).toContain('Escalated item');
      // The escalated event carries the escalated effective urgency.
      const escalated = unread.find(
        (event) => event.summary === 'Escalated item',
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

      store.setMonitorState('test-monitor', rootDir, {
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

  // REGRESSION (issue #437 review, comment 3609314737): the json-diff wiring
  // suite (json-diff-wiring.test.ts) drives RuntimeStore.insertEvent directly
  // with an already-rendered structural diffText — it never routes through
  // AgentMonitorRuntime.processObservation, so reverting service.ts's
  // buildDiff(..., strategy) call back to a bare buildTextDiff would leave
  // every existing test green. This drives a REAL observation through the
  // actual runtime tick (source -> processObservation -> materialized shared
  // event), with the object's `snapshot.strategy` declared as `json-diff`,
  // and asserts the persisted diffText is structural (a `~ changed` entry),
  // not the line-diff `-/+ 1:` output buildTextDiff would produce for a
  // single-line compact-JSON snapshot.
  it('renders a structural json-diff diffText for a real observation routed through processObservation', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'json-snap-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    let content = JSON.stringify({ id: 1, status: 'open' });
    const source: ObservationSource = {
      name: 'json-snap-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [
            {
              title: 'snapshot',
              objectKey: 'obj-1',
              snapshotText: content,
              snapshot: { strategy: 'json-diff' },
            },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, source);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-json-snap',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // v1 — no prior snapshot, no diff
    content = JSON.stringify({ id: 1, status: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDir, rootDir); // v2 — diffs against v1

    const events = runtime.listEvents({ sessionId: session.id });
    expect(events).toHaveLength(2);
    const withDiff = events.filter((event) => event.diffText);
    expect(withDiff).toHaveLength(1);
    // Structural json-diff rendering (`~ changed`), never a line-diff
    // `-/+ 1:` remove-all/add-all of the single-line compact JSON.
    expect(withDiff[0]?.diffText).toContain('~ changed');
    expect(withDiff[0]?.diffText).not.toMatch(/^- 1:/m);
    expect(withDiff[0]?.diffText).not.toMatch(/^\+ 1:/m);
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

  // Issue #297: scheduleForMonitor() never throws — an invalid IANA timezone on
  // a `schedule` monitor surfaces as `PollingDecision.error` instead. explain
  // MUST NOT crash (it is a read-only diagnostic surface, 002 §10.7) and must
  // report the failure as an OBSERVATION-stage diagnostic — the same shape a
  // real observe() error would produce — rather than a raw thrown RangeError.
  it('explains an invalid schedule timezone as an observation-stage failure, not a crash (issue #297)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsDir, 'bad-timezone-monitor');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Bad timezone monitor
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
      'utf-8',
    );

    const runtime = createRuntime(dbPath, {
      name: 'schedule',
      scopeSchema: { type: 'object', properties: {} },
      observe: () => Promise.resolve({ observations: [] }),
    });

    // No prior tick — explain is exercised cold, proving it never depends on the
    // tick loop's own isolation to avoid crashing.
    const report = await runtime.explainMonitor({
      monitorId: 'bad-timezone-monitor',
      monitorsDir,
      workspacePath: rootDir,
    });

    expect(report.verdict).toMatchObject({
      stage: 'observation',
      status: 'failure',
    });
    const observationStage = report.stages.find(
      (stage) => stage.id === 'observation',
    );
    expect(observationStage?.status).toBe('failure');
    // The message must state the TRUE cause — scheduling/timezone evaluation
    // failed, not "the source observation errored" (PR #433 review,
    // discussion_r3608549689) — and surface the bad value inline, since text
    // output only renders `reason`, never `details`.
    expect(observationStage?.reason).toContain(
      'schedule could not be evaluated',
    );
    expect(observationStage?.reason).toContain('Not/AZone');
    expect(String(observationStage?.details?.['error'] ?? '')).toContain(
      'Not/AZone',
    );
    // No 'scheduling' stage output — the decision itself could not be computed.
    expect(report.stages.some((stage) => stage.id === 'scheduling')).toBe(
      false,
    );
    // explainMonitor MUST NOT mutate runtime state (002 §10.7): asking again
    // must not have written an observation_history row as a side effect.
    expect(
      runtime.listObservationHistory({ monitorId: 'bad-timezone-monitor' }),
    ).toHaveLength(0);
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

  it('defaults an omitted workspacePath to monitorsDir so every explain stage reads ONE consistent scope (issue #345 / #307 review)', async () => {
    // `monitor.explain` leaves `workspacePath` optional on the wire. When it is
    // omitted the report MUST default to the SAME workspace the tick loop uses
    // when IT is called without one (`tick(monitorsDir)` defaults workspacePath
    // to `monitorsDir`), so the scheduling/monitor-state stage and the
    // observation/event stages agree. Pre-fix, scheduling read a NULL scope no
    // write path populates ("never ticked") while events/history read UNSCOPED
    // across all workspaces — a self-contradictory report plus a cross-workspace
    // history leak.
    const dbRoot = mkdtempSync(
      path.join(tmpdir(), 'agentmon-explain-default-'),
    );
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

    const workspaceA = mkdtempSync(path.join(tmpdir(), 'agentmon-def-a-'));
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'agentmon-def-b-'));
    tempDirs.push(workspaceA, workspaceB);
    const monitorsDirA = writeSharedMonitor(workspaceA);
    const monitorsDirB = writeSharedMonitor(workspaceB);

    const source: ObservationSource = {
      name: 'shared-source',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({
          observations: [{ title: 'shared change', objectKey: 'obj-shared' }],
        }),
    };
    const runtime = createRuntime(dbPath, source);

    // Workspace A ticks WITHOUT an explicit workspacePath (defaults to
    // monitorsDirA). Workspace B ticks under its own explicit workspace with the
    // SAME monitor id — a foreign scope whose events/history must not leak into
    // A's report.
    await runtime.tick(monitorsDirA);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDirB, workspaceB);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runtime.tick(monitorsDirB, workspaceB);

    // Explain A WITHOUT a workspacePath — the regression surface.
    const report = await runtime.explainMonitor({
      monitorId: 'shared-monitor',
      monitorsDir: monitorsDirA,
    });

    // Scheduling stage read the state the omitted-workspace tick wrote (NOT a
    // NULL "never ticked" scope).
    const scheduling = report.stages.find((stage) => stage.id === 'scheduling');
    expect(scheduling?.reason).toContain('Last tick completed');
    expect(scheduling?.reason).not.toContain('No completed tick');

    // Observation stage found A's history — consistent with the scheduling stage
    // (it did not report "No observation history").
    const observation = report.stages.find(
      (stage) => stage.id === 'observation',
    );
    expect(observation?.reason).not.toContain('No observation history');

    // Events are scoped to A's workspace: exactly A's single event, never B's
    // two — no cross-workspace leak through the omitted scope.
    expect(report.events).toHaveLength(1);
    expect(
      report.events.every((event) => event.workspacePath === monitorsDirA),
    ).toBe(true);
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
    const state = store.getMonitorState('test-monitor', rootDir);
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

  // Issue #297: an invalid IANA timezone on a `schedule` monitor made
  // Intl.DateTimeFormat throw inside cronFieldValuesForDate(), and
  // scheduleForMonitor() was called OUTSIDE the per-monitor observe/ingest
  // try/catches — so the throw escaped evaluateMonitorOnTick() and aborted the
  // ENTIRE tick, preventing every other (valid) monitor from running. This is a
  // two-monitor regression test that must FAIL pre-fix (the second monitor never
  // gets a chance to emit because tick() rejects before reaching it).
  //
  // `watch: { type: 'schedule' }` scope is NOT validated by parseMonitor/scan —
  // only `validateWatchScope` (called by `validate`/`watch declare`/`monitor
  // test`, never by the tick loop itself) catches a bad timezone at authoring
  // time — so a hand-edited MONITOR.md with a bad timezone reaches tick()
  // unfiltered, exactly like this test constructs it.
  it('isolates an invalid schedule timezone so a sibling monitor still emits (issue #297)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');

    // aaa-bad-timezone sorts first: proves the failure doesn't even need to be
    // the last monitor evaluated to isolate correctly.
    const badTimezoneDir = path.join(monitorsDir, 'aaa-bad-timezone');
    mkdirSync(badTimezoneDir, { recursive: true });
    writeFileSync(
      path.join(badTimezoneDir, 'MONITOR.md'),
      `---
name: Bad timezone
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
      'utf-8',
    );

    // zzz-works sorts last: a schedule monitor with a valid timezone that fires
    // on every tick (cron '* * * * *').
    const workingDir = path.join(monitorsDir, 'zzz-works');
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(
      path.join(workingDir, 'MONITOR.md'),
      `---
name: Works fine
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`,
      'utf-8',
    );

    const scheduleSource: ObservationSource = {
      name: 'schedule',
      scopeSchema: { type: 'object', properties: {} },
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [
            {
              title: 'Scheduled trigger',
              summary: 'Scheduled trigger',
              objectKey: 'sched-trigger',
            },
          ],
        }),
    };

    const runtime = createRuntime(dbPath, scheduleSource);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-session-297',
        workspacePath: rootDir,
      }),
    );

    // The tick must resolve, NOT reject, even though aaa-bad-timezone's
    // scheduling computation throws internally.
    const result = await runtime.tick(monitorsDir, rootDir);

    // The valid sibling monitor still emitted its event.
    expect(result.emittedEventIds.length).toBeGreaterThan(0);
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events.some((e) => e.monitorId === 'zzz-works')).toBe(true);
    expect(
      runtime.listObservationHistory({ monitorId: 'zzz-works' })[0]?.result,
    ).toBe('triggered');

    // The invalid monitor is isolated: no event, an 'errored' history row
    // naming the timezone, and it never appears in evaluatedMonitors (it failed
    // before reaching observe()).
    expect(events.some((e) => e.monitorId === 'aaa-bad-timezone')).toBe(false);
    const badHistory = runtime.listObservationHistory({
      monitorId: 'aaa-bad-timezone',
    });
    expect(badHistory).toHaveLength(1);
    expect(badHistory[0]?.result).toBe('errored');
    expect(String(badHistory[0]?.observationData?.['error'])).toContain(
      'Not/AZone',
    );

    // The tick result surfaces the failure by monitor id + message (same
    // mechanism as an observe() error, issue #117).
    expect(result.erroredObservations).toEqual([
      {
        monitorId: 'aaa-bad-timezone',
        message: expect.stringContaining('Not/AZone') as unknown as string,
      },
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
        // Keyed on `summary`: the materialized `title` is the monitor's
        // authored name since issue #449, so the source's sentinel text — which
        // this fault injection targets — now arrives as `summary`.
        if (input.summary === 'boom') {
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
    expect(events.some((e) => e.summary === 'ok')).toBe(true);

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

  it('passes workspacePath to observe context so sources can resolve project-relative scope (issue #193)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'workspace-aware-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    let observedWorkspacePath: string | undefined;
    const source: ObservationSource = {
      name: 'workspace-aware-source',
      scopeSchema: { type: 'object' },
      observe: (_config, context): Promise<ObservationResult> => {
        observedWorkspacePath = context.workspacePath;
        return Promise.resolve({ observations: [] });
      },
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    expect(observedWorkspacePath).toBe(rootDir);
  });

  it('records no-files-matched history when source sets outcome:no-files-matched (issue #193)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'no-files-matched-source',
      'normal',
      'Handle it.',
      "  interval: '1s'\n",
    );

    const source: ObservationSource = {
      name: 'no-files-matched-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: (): Promise<ObservationResult> =>
        Promise.resolve({
          observations: [],
          nextState: { fingerprints: {} },
          outcome: 'no-files-matched',
        }),
    };

    const runtime = createRuntime(dbPath, source);
    await runtime.tick(monitorsDir, rootDir);

    const history = runtime.listObservationHistory({
      monitorId: 'test-monitor',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.result).toBe('no-files-matched');
    expect(history[0]?.observationData).toEqual({ observed: 0, emitted: 0 });
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
        // Sentinel keyed on `summary` (see the note above; issue #449).
        if (input.summary === 'bad-obs') {
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
    expect(events[0]?.summary).toBe('good-obs');
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
      const spanEvents = events.filter((event) => event.summary !== 'baseline');
      expect(spanEvents).toHaveLength(3);
      // The three span events share a sub-second tick timestamp, so listEvents'
      // createdAt ordering ties; assert the SET of titles + each title's own
      // endpoint snapshot (nothing folded), not a strict order.
      const bySummary = new Map(
        spanEvents.map((event) => [event.summary, event]),
      );
      expect([...bySummary.keys()].sort()).toEqual([
        'edit 1',
        'edit 2',
        'edit 3',
      ]);
      expect(bySummary.get('edit 1')?.snapshotText).toBe(SPAN_STATES[0]);
      expect(bySummary.get('edit 2')?.snapshotText).toBe(SPAN_STATES[1]);
      expect(bySummary.get('edit 3')?.snapshotText).toBe(SPAN_STATES[2]);

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
      expect(survivor?.summary).toBe('edit 3');
      expect(survivor?.snapshotText).toBe(SPAN_STATES[2]);
      const netDelta = delivered[0]?.diffText;
      expect(netDelta).toContain('EDIT-1');
      expect(netDelta).toContain('EDIT-2');
      expect(netDelta).toContain('EDIT-3');

      // The two suppressed intermediates are edits 1 and 2 — recorded, retrievable
      // via explain, never delivered.
      const suppressedTitles = suppressed
        .map((p) => events.find((e) => e.id === p.eventId)?.summary)
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
      const spanEvents = events.filter((event) => event.summary !== 'baseline');
      // 002 §1.1.7: N=3 deltas, play-by-play (one event per step, nothing
      // collapsed).
      expect(spanEvents).toHaveLength(3);
      const bySummary = new Map(
        spanEvents.map((event) => [event.summary, event]),
      );
      expect([...bySummary.keys()].sort()).toEqual([
        'edit 1',
        'edit 2',
        'edit 3',
      ]);

      // Every intermediate observation survived as its own event with its own
      // endpoint snapshot — the play-by-play, not a single net delta.
      expect(bySummary.get('edit 1')?.snapshotText).toBe(SPAN_STATES[0]);
      expect(bySummary.get('edit 2')?.snapshotText).toBe(SPAN_STATES[1]);
      expect(bySummary.get('edit 3')?.snapshotText).toBe(SPAN_STATES[2]);

      // Each step is a real, non-empty delta (the state changed at each point).
      for (const title of ['edit 1', 'edit 2', 'edit 3']) {
        expect(bySummary.get(title)?.diffText).toBeTruthy();
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
      const spanEvents = events.filter((e) => e.summary !== 'baseline');
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
      expect(survivor?.summary).toBe('edit 3');
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
        const held = store.getMonitorState('test-monitor', rootDir).notifyState
          .pendingRollup;
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
        expect(delivered.map((e) => e.summary).sort()).toEqual([
          'Change A',
          'Change B',
        ]);

        // The accumulation state is cleared after the flush.
        expect(
          store.getMonitorState('test-monitor', rootDir).notifyState
            .pendingRollup,
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
          store.getMonitorState('test-monitor', rootDir).notifyState
            .pendingRollup,
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
          rootDir,
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
        expect(delivered[0]?.summary).toBe('Pre-restart change');
        // A valid urgency was materialized for the restart-recovered envelope
        // (hydration backfill, 002 §3 / §4.4 step 1), never `undefined`.
        expect(delivered[0]?.urgency).toBe('normal');

        // The accumulation state is cleared after the post-restart flush.
        expect(
          new RuntimeStore(createDb(dbPath)).getMonitorState(
            'test-monitor',
            rootDir,
          ).notifyState.pendingRollup,
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
        const state = store.getMonitorState('test-monitor', rootDir);
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
      const held = ctx.store.getMonitorState('test-monitor', ctx.rootDir)
        .notifyState.pendingRollup;
      expect(held?.observations).toHaveLength(STATES.length);

      // Force the NOT-DUE condition at the window: lastObservationAt = window −
      // 1s. The integer 'timestamp' column truncates to whole seconds, so
      // elapsed = 1000ms < 2000ms (interval 2s) → the monitor is NOT due, yet
      // the 09:00 window opens. This is the not-due rollup branch (the bug).
      ctx.store.setMonitorState('test-monitor', ctx.rootDir, {
        sourceState: ctx.store.getMonitorState('test-monitor', ctx.rootDir)
          .sourceState,
        notifyState: ctx.store.getMonitorState('test-monitor', ctx.rootDir)
          .notifyState,
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
      expect(survivor?.summary).toBe('edit 3');
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
        expect(delivered.map((e) => e.summary)).toEqual([
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
        ctx.store.setMonitorState('test-monitor', ctx.rootDir, {
          sourceState: ctx.store.getMonitorState('test-monitor', ctx.rootDir)
            .sourceState,
          notifyState: ctx.store.getMonitorState('test-monitor', ctx.rootDir)
            .notifyState,
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

// Issue #333: a blind study subject saw a durable, unread `urgency: normal`
// event produce NO surfacing at any lifecycle — `hook claim --lifecycle
// turn-interruptible` returned null, `turn-idle` returned "No pending
// delivery." Per 002 §9.2 the normal reminder should surface at
// turn-interruptible while all unread normal events are unclaimed. The verdict:
// NOT a first-claim bug. The subject had ALREADY run a turn-interruptible claim
// earlier (S3 phase 11), which surfaced the reminder AND CLAIMED the normal
// event; the second identical claim was then correctly suppressed (the reminder
// coalesces until acknowledgment, so a claimed-but-unacknowledged event holds it
// back). The defect was the SILENCE — no way to discover why. This test pins the
// refutation (first claim DOES surface the reminder) and proves the suppression
// is now explainable via `monitor explain` (criterion 1 + 2).
//
// @see ../../../../docs/specs/002-runtime-delivery.md §9.2 (normal reminder,
//   coalesced-until-unclaimed)
// @see ../../../../docs/specs/002-runtime-delivery.md §10.7 (monitor explain
//   projection-and-delivery diagnosis)
describe('normal-urgency reminder suppression is explainable (issue #333)', () => {
  // 002 §9.2: the generic reminder message for the normal band.
  const NORMAL_INBOX_PROMPT =
    'AgentMon messages are available. Read the inbox.';

  function stubStatefulSource(name: string): ObservationSource {
    return {
      name,
      scopeSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      stateful: true,
      // Emits a single observation only once the watched file's content differs
      // from the previously-persisted state (i.e. on the tick AFTER the baseline).
      // eslint-disable-next-line @typescript-eslint/require-await
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
  }

  it('first turn-interruptible claim surfaces the coalesced normal reminder; a prior claim then suppresses it, and monitor explain names why', async () => {
    vi.useFakeTimers();
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-333-'));
    tempDirs.push(rootDir);
    try {
      const T0 = new Date('2026-07-14T12:00:00.000Z').getTime();
      vi.setSystemTime(T0);

      const dbPath = path.join(rootDir, 'agentmon.db');
      const watchedFile = path.join(rootDir, 'watched.txt');
      writeFileSync(watchedFile, 'initial content', 'utf-8');
      // The monitor folder name is the monitor id (`test-monitor`, from
      // createMonitorFile); the `sourceName` arg only sets the watch `type`.
      const monitorsDir = createMonitorFile(
        rootDir,
        'stateful-333',
        'normal', // the guide's own default urgency — the study's exact case
        'When files change, review them.',
        "  interval: '1s'\n",
      );
      const runtime = createRuntime(dbPath, stubStatefulSource('stateful-333'));

      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'claude-333',
          workspacePath: rootDir,
        }),
      );

      // A real daemon tick materializes the event (no prior ack): baseline tick,
      // then a change + a due tick that emits exactly one durable normal event.
      const baseline = await runtime.tick(monitorsDir, rootDir);
      expect(baseline.emittedEventIds).toHaveLength(0);
      writeFileSync(watchedFile, 'changed: added eval()', 'utf-8');
      vi.setSystemTime(T0 + 1_100); // past the 1s interval → the monitor is due
      const emit = await runtime.tick(monitorsDir, rootDir);
      expect(emit.emittedEventIds).toHaveLength(1);

      // Criterion 1 (refute the first-claim bug): with the normal event unread
      // and UNCLAIMED, the FIRST turn-interruptible claim surfaces the coalesced
      // generic reminder — exactly what 002 §9.2 requires.
      const first = runtime.claimDelivery(session.id, 'turn-interruptible');
      expect(first?.mode).toBe('delivery');
      expect(first?.urgency).toBe('normal');
      expect(first?.message).toBe(NORMAL_INBOX_PROMPT);
      expect(first?.events).toEqual([]); // §9.2: no per-event payloads

      // The divergent precondition from the study: that first claim marked the
      // event CLAIMED (firstNotifiedAt) but NOT acknowledged. A second identical
      // claim is now correctly suppressed — this reproduces the study's `null`.
      expect(
        runtime.claimDelivery(session.id, 'turn-interruptible'),
      ).toBeNull();
      // turn-idle likewise surfaces nothing (there is no low-urgency work).
      expect(runtime.claimDelivery(session.id, 'turn-idle')).toBeNull();

      // Claiming never acknowledges (BP2 / SP4): the event is still unread and
      // re-discoverable, so no signal was lost — only the reminder is paused.
      expect(
        runtime.listEvents({ sessionId: session.id, unreadOnly: true }),
      ).toHaveLength(1);

      // Criterion 2: the silence is now discoverable. `monitor explain`'s
      // projection-and-delivery stage NAMES the suppression reason rather than
      // presenting a dead end.
      const report = await runtime.explainMonitor({
        monitorId: 'test-monitor',
        monitorsDir,
        workspacePath: rootDir,
        now: new Date(T0 + 1_200),
      });
      const delivery = report.stages.find((stage) => stage.id === 'delivery');
      expect(delivery).toBeDefined();
      // Suppression is EXPECTED behavior, not a fault — the stage stays ok.
      expect(delivery?.status).toBe('ok');
      expect(delivery?.reason).toContain('already claimed');
      expect(delivery?.reason).toContain('coalesced-until-ack');

      const findings = delivery?.details?.['reminderSuppression'] as
        | ReminderSuppressionFinding[]
        | undefined;
      expect(findings).toHaveLength(1);
      expect(findings?.[0]).toMatchObject({
        sessionId: session.id,
        urgency: 'normal',
        lifecycle: 'turn-interruptible',
        unreadCount: 1,
        claimedCount: 1,
        reason: 'already-claimed',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Watch-mode source-state checkpointing (002 §2.4). A long-lived watch() source
// durably advances its persisted `sourceState` out of band via
// `context.checkpoint`, serialized with observation ingestion per-watcher (the
// G14 durable-write-before-ingest ordering) so a mid-watch crash reconciles from
// the checkpointed baseline instead of re-emitting already-delivered changes.
describe('watch-mode source-state checkpointing (002 §2.4)', () => {
  const checkpointTmpDirs: string[] = [];

  afterEach(() => {
    while (checkpointTmpDirs.length > 0) {
      const dir = checkpointTmpDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function scratch(): { rootDir: string; dbPath: string; monitorsDir: string } {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-checkpoint-'));
    checkpointTmpDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const monitorsDir = createMonitorFile(
      rootDir,
      'checkpoint-source',
      'normal',
    );
    return { rootDir, dbPath, monitorsDir };
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Robust to an already-aborted signal: if stop() fired before the watcher
  // reached this point, resolve immediately rather than registering a listener
  // on a signal whose 'abort' event has already dispatched (which would never
  // fire again). This is how a real watch() source must handle teardown.
  const waitForAbort = (context: ObservationContext): Promise<void> =>
    new Promise((resolve) => {
      if (context.signal?.aborted) {
        resolve();
        return;
      }
      context.signal?.addEventListener('abort', () => resolve(), {
        once: true,
      });
    });

  async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 1_000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitUntil: predicate never became true');
      }
      await sleep(5);
    }
  }

  function openLeadSession(
    runtime: AgentMonitorRuntime,
    rootDir: string,
    hostSessionId: string,
  ): string {
    return runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId,
        workspacePath: rootDir,
      }),
    ).id;
  }

  // Criterion 2 (part a): the runtime supplies `context.checkpoint` on the
  // watch() path (never observe()); awaiting it durably writes the updated source
  // state into monitorState.sourceState BEFORE the promise resolves, and a
  // subsequently-yielded observation still flows through the normal pipeline.
  it('supplies checkpoint on watch() and persists the updated state before resolving', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    // Mutable holder so the watch() closure can read back the store the runtime
    // was built with (assigned below, before the watcher starts).
    const storeRef: { current?: RuntimeStore } = {};
    let checkpointSupplied = false;
    let stateVisibleWhenCheckpointResolved: unknown;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context: ObservationContext) {
        checkpointSupplied = typeof context.checkpoint === 'function';
        await context.checkpoint?.({ fingerprint: 'v2' });
        // The durable write MUST already be visible once the promise resolves.
        stateVisibleWhenCheckpointResolved = storeRef.current?.getMonitorState(
          'test-monitor',
          rootDir,
        ).sourceState;
        yield { title: 'live', summary: 'live', objectKey: 'obj-live' };
        await waitForAbort(context);
      },
    };

    const { runtime, store } = createRuntimeWithStore(dbPath, source);
    storeRef.current = store;
    const sessionId = openLeadSession(runtime, rootDir, 'claude-ckpt-a');

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(
      () => runtime.listEvents({ sessionId, unreadOnly: true }).length === 1,
    );

    expect(checkpointSupplied).toBe(true);
    // checkpoint resolved only after the durable write landed:
    expect(stateVisibleWhenCheckpointResolved).toEqual({ fingerprint: 'v2' });
    // and it stayed persisted (the following ingest did not clobber it):
    expect(store.getMonitorState('test-monitor', rootDir).sourceState).toEqual({
      fingerprint: 'v2',
    });

    await handle.stop();
  });

  // Criterion 1: the checkpoint callback is supplied ONLY on the watch() path;
  // the one-shot observe() tick path never receives it (observe() advances state
  // via ObservationResult.nextState instead).
  it('does not supply checkpoint to the observe() tick path', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    let observeContextHadCheckpoint: boolean | undefined;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: (_config, context: ObservationContext) => {
        observeContextHadCheckpoint = 'checkpoint' in context;
        return Promise.resolve({ observations: [], nextState: { v: 1 } });
      },
    };

    const { runtime } = createRuntimeWithStore(dbPath, source);
    openLeadSession(runtime, rootDir, 'claude-ckpt-observe');

    await runtime.tick(monitorsDir, rootDir);

    expect(observeContextHadCheckpoint).toBe(false);
  });

  // Criterion 2 (part b): an in-flight (un-awaited) checkpoint immediately
  // followed by a yielded observation asserts await-before-ingest — the runtime
  // serializes the two per-watcher so the checkpoint's durable write completes
  // before the observation is ingested, and the ingest observes (and preserves)
  // the checkpointed baseline rather than a stale one.
  //
  // The checkpoint persistence is wrapped with a GENUINELY delayed async write
  // (a timer) so this test detects a regression that splits checkpoint onto its
  // own promise chain: with a synchronous store write, both an in-flight
  // checkpoint and the following ingest would land in the same microtask turn and
  // the checkpoint-first ordering could hold on scheduling luck even if the two
  // were NOT serialized. By delaying the checkpoint's durable write and recording
  // the observable order of the checkpoint vs. ingest writes, the ingest can only
  // land after the delayed checkpoint if it is on the SAME per-watcher chain —
  // an independent chain would let the (undelayed) ingest write run first and
  // fail the assertion.
  it('orders an in-flight, genuinely-delayed checkpoint before a following ingest (G14 serialization)', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context: ObservationContext) {
        // Fire the checkpoint WITHOUT awaiting it, then immediately yield.
        void context.checkpoint?.({ fingerprint: 'v2' });
        yield { title: 'live', summary: 'live', objectKey: 'obj-live' };
        await waitForAbort(context);
      },
    };

    const { runtime, store } = createRuntimeWithStore(dbPath, source);
    const sessionId = openLeadSession(runtime, rootDir, 'claude-ckpt-b');

    // Record the observable order of durable writes, tagging each as a checkpoint
    // write vs. an ingest write. The checkpoint write is distinguished by an
    // `inCheckpoint` flag the delayed checkpoint wrapper sets around the real
    // persistence, since the ingest PRESERVES the checkpointed sourceState (both
    // write `{ fingerprint: 'v2' }`, so the value alone cannot tell them apart).
    const writeOrder: ('checkpoint' | 'ingest')[] = [];
    let inCheckpoint = false;
    const originalSet = store.setMonitorState.bind(store);
    vi.spyOn(store, 'setMonitorState').mockImplementation((id, ws, state) => {
      writeOrder.push(inCheckpoint ? 'checkpoint' : 'ingest');
      originalSet(id, ws, state);
    });

    // Wrap the checkpoint persistence with a genuine async delay BEFORE the
    // durable write. An independent-chain regression would let the ingest's write
    // run during this delay (ingest-before-checkpoint); the correct single-chain
    // implementation forces the ingest to wait for this delayed write.
    const runtimeInternals = runtime as unknown as {
      writeCheckpoint: (
        monitorId: string,
        workspacePath: string,
        nextState: unknown,
      ) => Promise<void>;
    };
    const realWriteCheckpoint =
      runtimeInternals.writeCheckpoint.bind(runtimeInternals);
    vi.spyOn(runtimeInternals, 'writeCheckpoint').mockImplementation(
      async (monitorId, workspacePath, nextState) => {
        await sleep(40);
        inCheckpoint = true;
        try {
          await realWriteCheckpoint(monitorId, workspacePath, nextState);
        } finally {
          inCheckpoint = false;
        }
      },
    );

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(
      () => runtime.listEvents({ sessionId, unreadOnly: true }).length === 1,
    );

    // The (delayed) checkpoint write is observably FIRST; the ingest's own
    // read-modify-write only runs after it, proving the two share one chain and
    // the ingest awaited the in-flight checkpoint rather than racing it.
    const firstCheckpoint = writeOrder.indexOf('checkpoint');
    const firstIngest = writeOrder.indexOf('ingest');
    expect(firstCheckpoint).toBeGreaterThanOrEqual(0);
    expect(firstIngest).toBeGreaterThanOrEqual(0);
    expect(firstCheckpoint).toBeLessThan(firstIngest);
    // And the ingest preserved the checkpointed baseline (never a stale {}).
    expect(store.getMonitorState('test-monitor', rootDir).sourceState).toEqual({
      fingerprint: 'v2',
    });

    await handle.stop();
  });

  // Criterion 3: a checkpoint is a state write ONLY — it never materializes or
  // delivers an observation as a side effect (no new monitor_events rows).
  it('writes state without materializing any monitor_events', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield -- checkpoint-only watcher never yields
      async *watch(_config, context: ObservationContext) {
        await context.checkpoint?.({ fingerprint: 'v3' });
        // never yield an observation — this exercises the checkpoint-only path.
        await waitForAbort(context);
      },
    };

    const { runtime, store } = createRuntimeWithStore(dbPath, source);
    const sessionId = openLeadSession(runtime, rootDir, 'claude-ckpt-c');

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(
      () =>
        store.getMonitorState('test-monitor', rootDir).sourceState !==
          undefined &&
        JSON.stringify(
          store.getMonitorState('test-monitor', rootDir).sourceState,
        ) === JSON.stringify({ fingerprint: 'v3' }),
    );

    // The state write happened, but no event was materialized or delivered.
    expect(store.getMonitorState('test-monitor', rootDir).sourceState).toEqual({
      fingerprint: 'v3',
    });
    expect(store.listEvents({ monitorId: 'test-monitor' })).toHaveLength(0);
    expect(runtime.listEvents({ sessionId, unreadOnly: true })).toHaveLength(0);

    await handle.stop();
  });

  // Criterion 4 (negative): a checkpoint whose durable write rejects MUST NOT
  // abort the watcher — a warning is logged and subsequent observations still
  // flow. Even a source that AWAITS the checkpoint keeps watching (the callback
  // resolves rather than rejecting).
  it('does not abort the watcher when a checkpoint write fails', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context: ObservationContext) {
        // Awaiting a failing checkpoint MUST resolve (not reject) so an
        // unguarded source keeps running.
        await context.checkpoint?.({ fingerprint: 'boom' });
        yield { title: 'after-1', summary: 'after-1', objectKey: 'obj-1' };
        yield { title: 'after-2', summary: 'after-2', objectKey: 'obj-2' };
        await waitForAbort(context);
      },
    };

    const { runtime, store } = createRuntimeWithStore(dbPath, source);
    const sessionId = openLeadSession(runtime, rootDir, 'claude-ckpt-d');

    // Fail only the checkpoint write (tagged 'boom'); let ingest's own writes
    // (which preserve the untouched default sourceState) succeed.
    const originalSet = store.setMonitorState.bind(store);
    vi.spyOn(store, 'setMonitorState').mockImplementation((id, ws, state) => {
      const sourceState = state.sourceState as
        | { fingerprint?: string }
        | undefined;
      if (sourceState?.fingerprint === 'boom') {
        throw new Error('simulated disk failure');
      }
      originalSet(id, ws, state);
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );

    const onError = vi.fn();
    const handle = await runtime.watchMonitors(monitorsDir, rootDir, {
      onError,
    });
    await waitUntil(
      () => runtime.listEvents({ sessionId, unreadOnly: true }).length === 2,
    );

    // Both post-checkpoint observations were delivered — the watcher survived.
    expect(store.listEvents({ monitorId: 'test-monitor' })).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    // A warning naming the monitor was logged for the failed checkpoint.
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some(
        (line) => line.includes('checkpoint') && line.includes('test-monitor'),
      ),
    ).toBe(true);

    await handle.stop();
  });

  // Criterion 5: restart-safety. A checkpointed baseline survives a daemon
  // restart — a fresh runtime opened against the SAME on-disk database
  // reconciles a re-established watcher from the checkpointed sourceState, not
  // the stale pre-watch baseline (real SQLite round-trip).
  it('reconciles a restarted watcher from the checkpointed baseline', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    // --- Daemon "A": establish and checkpoint a baseline, then shut down. ---
    let checkpointedByA = false;
    const sourceA: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield -- checkpoint-then-idle, never yields
      async *watch(_config, context: ObservationContext) {
        await context.checkpoint?.({ fingerprint: 'persisted-v2' });
        checkpointedByA = true;
        await waitForAbort(context);
      },
    };
    const daemonA = createRuntimeWithStore(dbPath, sourceA);
    const handleA = await daemonA.runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(() => checkpointedByA);
    await handleA.stop();

    // The checkpointed state is durable in SQLite.
    expect(
      daemonA.store.getMonitorState('test-monitor', rootDir).sourceState,
    ).toEqual({
      fingerprint: 'persisted-v2',
    });

    // --- Daemon "B": a fresh runtime against the SAME db (a restart). ---
    let previousStateSeenByB: unknown = 'unset';
    const sourceB: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield -- observes previousState only, never yields
      async *watch(_config, context: ObservationContext) {
        previousStateSeenByB = context.previousState;
        await waitForAbort(context);
      },
    };
    const daemonB = createRuntimeWithStore(dbPath, sourceB);
    const handleB = await daemonB.runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(() => previousStateSeenByB !== 'unset');

    // The re-established watcher reconciles from the checkpointed baseline,
    // NOT the empty pre-watch state — no duplicate deliveries on restart.
    expect(previousStateSeenByB).toEqual({ fingerprint: 'persisted-v2' });

    await handleB.stop();
  });

  // A checkpoint must land in the watcher's OWN (monitorId, workspacePath) state
  // row (002 §3, #345/#307): the persistence DB is global and the same monitor id
  // can exist in unrelated workspaces, so a checkpoint written to the wrong scope
  // would either miss the watcher's own row or clobber another workspace's
  // change-detection baseline. This asserts both directions at once.
  it("checkpoints only the watcher's own workspace row, never a same-id monitor in another workspace", async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();
    const workspaceA = rootDir;
    // A distinct workspace path string sharing the SAME monitor id.
    const workspaceB = path.join(rootDir, 'other-workspace');

    let checkpointedByA = false;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield -- checkpoint-then-idle, never yields
      async *watch(_config, context: ObservationContext) {
        await context.checkpoint?.({ fingerprint: 'A2' });
        checkpointedByA = true;
        await waitForAbort(context);
      },
    };
    const { runtime, store } = createRuntimeWithStore(dbPath, source);

    // Pre-seed workspace B's row for the SAME monitor id with a distinct baseline
    // the watcher (scoped to workspace A) must never touch.
    store.setMonitorState('test-monitor', workspaceB, {
      sourceState: { fingerprint: 'B1' },
      notifyState: {},
    });

    const handle = await runtime.watchMonitors(monitorsDir, workspaceA);
    // checkpoint() resolves only after its durable write lands, so this implies
    // workspace A's row is written.
    await waitUntil(() => checkpointedByA);

    // Workspace A's row got the checkpoint; workspace B's row is untouched. If
    // `writeCheckpoint` ignored workspace scope (e.g. wrote a global/null row),
    // workspace A's row would be empty here — failing the first assertion.
    expect(
      store.getMonitorState('test-monitor', workspaceA).sourceState,
    ).toEqual({ fingerprint: 'A2' });
    expect(
      store.getMonitorState('test-monitor', workspaceB).sourceState,
    ).toEqual({ fingerprint: 'B1' });

    await handle.stop();
  });

  // A checkpoint delivered AFTER the watcher is stopped (its AbortSignal aborted
  // by stop(), and the watcher no longer the current active watcher for its id)
  // must be REJECTED: it writes nothing and logs one warning, so a straggling
  // `checkpoint(staleState)` can never clobber a newer baseline (002 §2.4).
  it('rejects a checkpoint delivered after the watcher is stopped (no write, one warning)', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    let capturedCheckpoint: ((nextState: unknown) => Promise<void>) | undefined;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // eslint-disable-next-line require-yield -- captures checkpoint, then idles
      async *watch(_config, context: ObservationContext) {
        capturedCheckpoint = context.checkpoint;
        await waitForAbort(context);
      },
    };
    const { runtime, store } = createRuntimeWithStore(dbPath, source);

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);
    await waitUntil(() => capturedCheckpoint !== undefined);
    await handle.stop();

    // Only observe writes AFTER stop(), so the setup path can't pollute the count.
    const postStopWrites: unknown[] = [];
    const originalSet = store.setMonitorState.bind(store);
    vi.spyOn(store, 'setMonitorState').mockImplementation((id, ws, state) => {
      postStopWrites.push(state.sourceState);
      originalSet(id, ws, state);
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );

    // Invoke the stale checkpoint captured before stop(). It MUST resolve (never
    // reject) but perform no write.
    await capturedCheckpoint?.({ fingerprint: 'stale' });

    expect(postStopWrites).toHaveLength(0);
    expect(
      store.getMonitorState('test-monitor', rootDir).sourceState,
    ).toBeUndefined();
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some(
        (line) => line.includes('checkpoint') && line.includes('test-monitor'),
      ),
    ).toBe(true);
  });

  // A watch() iterable that completes NORMALLY (not via stop()/abort or an error)
  // must release its active-watcher slot so the tick loop resumes driving the
  // monitor via observe(); otherwise the id stays pinned in `activeWatchers`
  // forever, permanently starving observe() and blocking any watcher restart.
  it('releases the active-watcher slot when watch() completes normally, so observe() resumes', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    let observeCalls = 0;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => {
        observeCalls += 1;
        return Promise.resolve({ observations: [] });
      },
      // Completes immediately with no yield: a finite watch() that ends normally.
      // (An empty generator body needs no require-yield disable — ESLint exempts it.)
      async *watch() {
        // no observations; the iterable finishes as soon as it is driven
      },
    };
    const { runtime } = createRuntimeWithStore(dbPath, source);

    const handle = await runtime.watchMonitors(monitorsDir, rootDir);

    // Once the (finite) watcher has finished and released its slot, a tick drives
    // observe() again. Poll: pre-fix, the id stays in activeWatchers and observe()
    // is skipped forever, so observeCalls never advances and this times out.
    let released = false;
    for (let i = 0; i < 200 && !released; i += 1) {
      await runtime.tick(monitorsDir, rootDir);
      if (observeCalls > 0) {
        released = true;
        break;
      }
      await sleep(5);
    }

    expect(released).toBe(true);
    expect(observeCalls).toBeGreaterThan(0);

    await handle.stop();
  });

  // SEVERE regression test. `getMonitorState`, `watchConfig`, and the `watch()`
  // invocation itself used to run BEFORE `consumeWatch`'s `try`, so a
  // synchronous throw there (SQLITE_BUSY, or a source whose `watch()`
  // validates its config and throws before ever returning an iterable — legal
  // per the `ObservationSource.watch` type, which only constrains the
  // RETURNED value to `AsyncIterable<Observation>`) rejected the watcher
  // task's promise without ever reaching the `finally`. `watchMonitors`
  // already recorded the active-watcher slot and never catches the task, so
  // the slot leaked FOREVER: the tick loop and any future `watchMonitors()`
  // would keep skipping the id, `onError` would never fire, and the monitor
  // would go silently dark.
  it('releases the active-watcher slot when watch() throws synchronously before returning an iterable', async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    let observeCalls = 0;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => {
        observeCalls += 1;
        return Promise.resolve({ observations: [] });
      },
      // A plain (non-generator) function is a legal `watch()` implementation
      // — the type only constrains the RETURNED value. Throwing before ever
      // returning simulates a source whose config validation fails
      // synchronously (or a `getMonitorState` read hitting SQLITE_BUSY).
      watch(): AsyncIterable<Observation> {
        throw new Error('simulated synchronous config validation failure');
      },
    };
    const { runtime } = createRuntimeWithStore(dbPath, source);

    const onError = vi.fn();
    const handle = await runtime.watchMonitors(monitorsDir, rootDir, {
      onError,
    });

    // The synchronous throw is still reported via onError (the daemon does
    // not crash)...
    await waitUntil(() => onError.mock.calls.length > 0);
    expect(onError).toHaveBeenCalledWith(
      'test-monitor',
      expect.objectContaining({
        message: expect.stringContaining(
          'simulated synchronous config validation failure',
        ),
      }),
    );

    // ...and, critically, the active-watcher slot is released rather than
    // leaked: a subsequent tick drives observe() again. Pre-fix, the id
    // stayed pinned forever and this polling loop would time out.
    let released = false;
    for (let i = 0; i < 200 && !released; i += 1) {
      await runtime.tick(monitorsDir, rootDir);
      if (observeCalls > 0) {
        released = true;
        break;
      }
      await sleep(5);
    }

    expect(released).toBe(true);
    expect(observeCalls).toBeGreaterThan(0);

    await handle.stop();
  });

  // Regression test for the token-supersession branch specifically (not the
  // stop()/abort branch, which the earlier "rejects a checkpoint delivered
  // after the watcher is stopped" test already covers): watcher A's watch()
  // completes NORMALLY — signal never aborted — so its slot is released via
  // the `finally`'s token match, not via `signal.aborted`. A leaked closure
  // keeps A's own `checkpoint` reference. `watchMonitors()` then
  // re-establishes watcher B (a NEW token) for the SAME monitor id. A's
  // straggling `checkpoint(staleState)` must be REJECTED — by the token
  // comparison alone, since `signal.aborted` is false for A — leaving B's
  // persisted baseline untouched. Deleting the
  // `this.activeWatchers.get(monitor.id) !== watcherToken` check (keeping
  // only `signal.aborted`) would leave this suite red only here.
  it("rejects a superseded (non-aborted) watcher's stale checkpoint without touching its successor's baseline (token supersession)", async () => {
    const { rootDir, dbPath, monitorsDir } = scratch();

    let watchCallCount = 0;
    let capturedCheckpointA:
      | ((nextState: unknown) => Promise<void>)
      | undefined;
    const source: ObservationSource = {
      name: 'checkpoint-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      watch(_config, context: ObservationContext): AsyncIterable<Observation> {
        watchCallCount += 1;
        if (watchCallCount === 1) {
          // Watcher A: captures its OWN checkpoint reference, writes a
          // baseline, then completes NORMALLY (no yield, no abort wait) — a
          // finite watch() releasing its slot via the finally's token match.
          // eslint-disable-next-line require-yield -- checkpoints once, then finishes
          return (async function* (): AsyncGenerator<Observation> {
            capturedCheckpointA = context.checkpoint;
            await context.checkpoint?.({ fingerprint: 'A1' });
          })();
        }
        // Watcher B: re-established for the SAME monitor id after A released
        // its slot. Writes its own baseline, then idles until aborted.
        // eslint-disable-next-line require-yield -- checkpoints once, then idles until aborted
        return (async function* (): AsyncGenerator<Observation> {
          await context.checkpoint?.({ fingerprint: 'B1' });
          await waitForAbort(context);
        })();
      },
    };
    const { runtime, store } = createRuntimeWithStore(dbPath, source);

    await runtime.watchMonitors(monitorsDir, rootDir);
    // checkpoint() resolves only after its durable write lands, so this
    // implies A's baseline is persisted (and, since the generator has no
    // further statements after the checkpoint, that A's finally has run or is
    // about to — the retry loop below tolerates the small remaining race).
    await waitUntil(() => capturedCheckpointA !== undefined);
    await waitUntil(
      () =>
        JSON.stringify(
          store.getMonitorState('test-monitor', rootDir).sourceState,
        ) === JSON.stringify({ fingerprint: 'A1' }),
    );

    // Re-establish watcher B for the SAME monitor id. Retry the establishment
    // call itself: if A's `finally` has not yet deleted its slot, `
    // watchMonitors` silently skips the id (by design — the tick loop must
    // never double-drive a monitor), so `handleB.monitorIds` would omit it.
    let handleB: Awaited<ReturnType<typeof runtime.watchMonitors>> | undefined;
    for (let i = 0; i < 200; i += 1) {
      const attempt = await runtime.watchMonitors(monitorsDir, rootDir);
      if (attempt.monitorIds.includes('test-monitor')) {
        handleB = attempt;
        break;
      }
      await sleep(5);
    }
    if (!handleB) throw new Error('watcher B was never established');
    await waitUntil(
      () =>
        JSON.stringify(
          store.getMonitorState('test-monitor', rootDir).sourceState,
        ) === JSON.stringify({ fingerprint: 'B1' }),
    );

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );

    // A's own captured checkpoint is now stale: A's signal was NEVER aborted
    // (it completed normally, and we never called any `stop()` on it), so
    // only the token-supersession comparison protects B's baseline here.
    await capturedCheckpointA?.({ fingerprint: 'stale-from-A' });

    // B's baseline must be intact — A's stale checkpoint must not have
    // clobbered it.
    expect(store.getMonitorState('test-monitor', rootDir).sourceState).toEqual({
      fingerprint: 'B1',
    });
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some(
        (line) => line.includes('checkpoint') && line.includes('test-monitor'),
      ),
    ).toBe(true);

    await handleB.stop();
  });
});
