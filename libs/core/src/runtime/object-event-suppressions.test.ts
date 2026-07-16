/**
 * Object-event suppression tombstones (issue #414).
 *
 * `verify --use-workspace-daemon` must clean up the events its throwaway scratch
 * file produced against the PERSISTENT workspace daemon WITHOUT blocking a full
 * poll interval for the file's deletion to re-materialize (the #407 approach that
 * doubled verify's runtime). It does this by retracting the delivered create event
 * and installing a durable, self-expiring suppression keyed to the synthetic
 * scratch object; the daemon then sweeps the pending deletion on the tick it
 * materializes. These tests exercise that mechanism at the runtime/store layer.
 *
 * @see docs/specs/005-cli-reference.md §16 (step 9, "Suppress")
 * @see docs/specs/spec-changelog.md 2026-07-16 (Refs #414)
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord } from './types.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp workspace with an (empty) monitors dir so `tick()` can scan it. */
function makeWorkspace(): { rootDir: string; monitorsDir: string } {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-suppress-'));
  tempDirs.push(rootDir);
  const monitorsDir = path.join(rootDir, '.claude', 'monitors');
  mkdirSync(monitorsDir, { recursive: true });
  return { rootDir, monitorsDir };
}

const MONITOR_ID = 'docs-watch';

/** A monitor-event template for a synthetic or real object in `rootDir`. */
function eventBase(
  rootDir: string,
): Omit<
  MonitorEventRecord,
  'id' | 'title' | 'summary' | 'objectKey' | 'createdAt'
> {
  return {
    workspacePath: rootDir,
    monitorId: MONITOR_ID,
    sourceName: 'file-fingerprint',
    urgency: 'normal',
    body: '',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    baselineStrategy: null,
    queryScope: {},
    tags: [],
  };
}

describe('object-event suppressions (issue #414)', () => {
  it('suppressObjectEvents retracts the already-materialized create immediately', () => {
    const { rootDir } = makeWorkspace();
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'suppress-immediate',
        workspacePath: rootDir,
      }),
    );
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-abc123def456.md',
    );
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(),
    });
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(1);

    const removed = runtime.suppressObjectEvents({
      workspacePath: rootDir,
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
      ttlMs: 60_000,
    });

    // The create is gone at once — verify need not wait for anything.
    expect(removed).toBe(1);
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(0);
  });

  it('a tick sweeps a scratch deletion that materializes AFTER the suppression, without verify waiting', async () => {
    const { rootDir, monitorsDir } = makeWorkspace();
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'suppress-sweep',
        workspacePath: rootDir,
      }),
    );
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-0a1b2c3d4e5f.md',
    );

    // Delivery already happened + verify suppressed the object (no create left).
    runtime.suppressObjectEvents({
      workspacePath: rootDir,
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
      ttlMs: 60_000,
    });

    // The daemon later observes the scratch file's deletion and materializes its
    // event — this is exactly the event #407 must keep out of a later session.
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File deleted: ${scratchKey}`,
      summary: `File deleted: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(),
    });
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(1);

    // The very next tick's suppression sweep retracts it.
    await runtime.tick(monitorsDir, rootDir);
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(0);
    expect(
      runtime.listEvents({
        monitorId: MONITOR_ID,
        objectKey: scratchKey,
        workspacePath: rootDir,
      }),
    ).toHaveLength(0);
  });

  it('a later session never sees the scratch events, but a real change afterward IS delivered (#407 guarantee preserved)', async () => {
    const { rootDir, monitorsDir } = makeWorkspace();
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-112233445566.md',
    );

    // A completed --use-workspace-daemon run: create delivered+retracted, tombstone
    // installed, then the deletion materializes and is swept on a tick.
    runtime.suppressObjectEvents({
      workspacePath: rootDir,
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
      ttlMs: 60_000,
    });
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File deleted: ${scratchKey}`,
      summary: `File deleted: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(),
    });
    await runtime.tick(monitorsDir, rootDir);

    // A session that opens AFTERWARD sees NO verify scratch event.
    const later = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'later-session',
        workspacePath: rootDir,
      }),
    );
    expect(runtime.listEvents({ sessionId: later.id })).toHaveLength(0);

    // But the user's real change afterward IS delivered — suppression is scoped to
    // the synthetic scratch key alone, never a real object.
    const realKey = path.join(rootDir, 'src', 'app.ts');
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File changed: ${realKey}`,
      summary: `File changed: ${realKey}`,
      objectKey: realKey,
      createdAt: new Date(),
    });
    const delivered = runtime.listEvents({ sessionId: later.id });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.objectKey).toBe(realKey);
  });

  it('retractObjectEventsByKey erases every event for the key across sessions and leaves a real object intact', () => {
    const { rootDir } = makeWorkspace();
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    const sessionA = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'bykey-a',
        workspacePath: rootDir,
      }),
    );
    const sessionB = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'bykey-b',
        workspacePath: rootDir,
      }),
    );
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-778899aabbcc.md',
    );
    const realKey = path.join(rootDir, 'readme.md');
    // Two events for the scratch key (create + delete) and one real event.
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(Date.now() - 2_000),
    });
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File deleted: ${scratchKey}`,
      summary: `File deleted: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(Date.now() - 1_000),
    });
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File changed: ${realKey}`,
      summary: `File changed: ${realKey}`,
      objectKey: realKey,
      createdAt: new Date(),
    });

    const result = store.retractObjectEventsByKey({
      workspacePath: rootDir,
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
    });
    expect(result.removedEventIds).toHaveLength(2);

    for (const session of [sessionA, sessionB]) {
      const events = runtime.listEvents({ sessionId: session.id });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectKey).toBe(realKey);
    }
  });

  it('purgeExpiredObjectSuppressions removes only expired tombstones', () => {
    const db = createDb(':memory:');
    const store = new RuntimeStore(db);
    const t0 = new Date('2026-07-16T00:00:00.000Z');
    store.upsertObjectSuppression({
      monitorId: MONITOR_ID,
      objectKey: '/ws/agentmonitors-verify-ddeeff001122.md',
      workspacePath: '/ws',
      createdAt: t0,
      expiresAt: new Date(t0.getTime() + 30_000),
    });
    // Active at +10s.
    expect(
      store.activeObjectSuppressions('/ws', new Date(t0.getTime() + 10_000)),
    ).toHaveLength(1);
    // Expired at +60s: no longer active, and purge deletes the row.
    expect(
      store.activeObjectSuppressions('/ws', new Date(t0.getTime() + 60_000)),
    ).toHaveLength(0);
    store.purgeExpiredObjectSuppressions(new Date(t0.getTime() + 60_000));
    expect(
      store.activeObjectSuppressions('/ws', new Date(t0.getTime() + 5_000)),
    ).toHaveLength(0);
  });

  it('reap backstop: an orphaned verify session is reaped AND its scratch events retracted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    const { rootDir, monitorsDir } = makeWorkspace();
    const db = createDb(':memory:');
    // Small dormancy so a single tick after advancing the clock reaps the session.
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
      undefined,
      { sessionDormancyMs: 60_000 },
    );
    const store = new RuntimeStore(db);
    // A verify run that was killed uncatchably: an active verify-tagged session
    // plus its scratch events, never cleaned up.
    const orphan = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'agentmonitors-verify-abcabcabcabc',
        workspacePath: rootDir,
      }),
    );
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-abcabcabcabc.md',
    );
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(),
    });
    expect(runtime.listEvents({ sessionId: orphan.id })).toHaveLength(1);

    // Advance past the dormancy window and tick.
    vi.setSystemTime(new Date('2026-07-16T00:05:00.000Z'));
    await runtime.tick(monitorsDir, rootDir);

    // The session is no longer active AND its scratch events are gone.
    const reaped = runtime.listSessions().find((s) => s.id === orphan.id);
    expect(reaped?.status).not.toBe('active');
    expect(
      runtime.listEvents({
        monitorId: MONITOR_ID,
        objectKey: scratchKey,
        workspacePath: rootDir,
      }),
    ).toHaveLength(0);
  });
});
