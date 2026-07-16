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
 * The two-mechanism split the by-KEY tombstone is HALF of (issue #418): it is safe
 * ONLY for a synthetic scratch key no real file shares. `suppressObjectEvents`
 * therefore rejects a non-synthetic key at the trust boundary, and a literal watched
 * file verify created is cleaned up by the id-scoped `retractObjectEvents` instead.
 *
 * @see docs/specs/005-cli-reference.md §16 (step 9, "Clean up")
 * @see docs/specs/spec-changelog.md 2026-07-16 (Refs #414, #418)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord } from './types.js';
import { AgentMonitorRuntime, isVerifyScratchObjectKey } from './service.js';

/**
 * A no-op source registered under `file-fingerprint` so `tick()` can scan and
 * evaluate an authored monitor without pulling in the real source plugin (which
 * depends on core — a circular import). It observes nothing; these tests drive
 * events into the store directly.
 */
const noopFileFingerprintSource: ObservationSource = {
  name: 'file-fingerprint',
  scopeSchema: { type: 'object', properties: {} },
  async observe(): Promise<ObservationResult> {
    return { observations: [] };
  },
};

function registryWithNoopSource(): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(noopFileFingerprintSource);
  return registry;
}

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

describe('object-event suppression safety guards (issue #418)', () => {
  it('isVerifyScratchObjectKey accepts synthetic scratch keys (POSIX AND Windows) and rejects real paths', () => {
    // POSIX absolute scratch key.
    expect(
      isVerifyScratchObjectKey('/ws/logs/agentmonitors-verify-0a1b2c3d4e5f.md'),
    ).toBe(true);
    // Windows absolute scratch key (backslash separators) — the reviewed bug:
    // `verify` builds objectKey with `path.join`, so on Windows the separators are
    // `\`; a split on `/` alone failed to find the basename (issue #418 review).
    expect(
      isVerifyScratchObjectKey(
        'C:\\ws\\logs\\agentmonitors-verify-0a1b2c3d4e5f.md',
      ),
    ).toBe(true);
    // Extensionless scratch key still matches.
    expect(
      isVerifyScratchObjectKey('/ws/agentmonitors-verify-aabbccddeeff'),
    ).toBe(true);
    // A real watched file never matches — even one that merely mentions the token.
    expect(isVerifyScratchObjectKey('/ws/src/app.ts')).toBe(false);
    expect(
      isVerifyScratchObjectKey('/ws/notes-agentmonitors-verify-notes.md'),
    ).toBe(false);
    // A wrong-length / non-hex token is rejected.
    expect(isVerifyScratchObjectKey('/ws/agentmonitors-verify-xyz.md')).toBe(
      false,
    );
  });

  it('suppressObjectEvents REFUSES a non-synthetic object key and leaves its real event intact', () => {
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
        hostSessionId: 'guard-real-key',
        workspacePath: rootDir,
      }),
    );
    // A REAL watched file (a literal single-file glob verify created). Tombstoning
    // it by key would eat a later genuine create at this same path — exactly the
    // event loss #418 forbids — so the runtime must reject it outright.
    const realKey = path.join(rootDir, 'watched.txt');
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File created: ${realKey}`,
      summary: `File created: ${realKey}`,
      objectKey: realKey,
      createdAt: new Date(),
    });

    expect(() =>
      runtime.suppressObjectEvents({
        workspacePath: rootDir,
        monitorId: MONITOR_ID,
        objectKey: realKey,
        ttlMs: 60_000,
      }),
    ).toThrow(/non-synthetic object key/i);

    // The real event is untouched — the guard fires before any deletion.
    const events = runtime.listEvents({ sessionId: session.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.objectKey).toBe(realKey);
  });

  it('suppressObjectEvents with an omitted workspacePath does NOT sweep another workspace’s events at the same scratch key', () => {
    // Copilot review (r3597013923): pre-fix, an omitted workspacePath normalized
    // the tombstone to the NULL scope but retracted UNSCOPED (across every
    // workspace), so the initial deletion was broader than the tombstone and could
    // erase another workspace's events. Post-fix, the omitted scope normalizes to
    // NULL for BOTH the upsert and the retraction, so only NULL-scoped events are
    // swept — never a workspace-scoped event.
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    const store = new RuntimeStore(db);
    // The same scratch key materialized under two distinct workspaces.
    const scratchKey = '/shared/agentmonitors-verify-abcdef012345.md';
    for (const ws of ['/ws-a', '/ws-b']) {
      store.insertEvent({
        ...eventBase(ws),
        workspacePath: ws,
        title: `File deleted: ${scratchKey}`,
        summary: `File deleted: ${scratchKey}`,
        objectKey: scratchKey,
        createdAt: new Date(),
      });
    }

    // Omit workspacePath entirely → the NULL scope. Neither workspace-scoped event
    // is touched (removed count is 0); pre-fix this swept BOTH.
    const removed = runtime.suppressObjectEvents({
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
      ttlMs: 60_000,
    });
    expect(removed).toBe(0);
    for (const ws of ['/ws-a', '/ws-b']) {
      expect(
        runtime.listEvents({
          monitorId: MONITOR_ID,
          objectKey: scratchKey,
          workspacePath: ws,
        }),
      ).toHaveLength(1);
    }

    // A workspace-scoped suppress still cleans up exactly its own workspace.
    const removedA = runtime.suppressObjectEvents({
      workspacePath: '/ws-a',
      monitorId: MONITOR_ID,
      objectKey: scratchKey,
      ttlMs: 60_000,
    });
    expect(removedA).toBe(1);
    expect(
      runtime.listEvents({
        monitorId: MONITOR_ID,
        objectKey: scratchKey,
        workspacePath: '/ws-b',
      }),
    ).toHaveLength(1);
  });

  it('the reap backstop sizes the orphan tombstone from the monitor cadence, so a long-interval monitor outlives the 5-min floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    const { rootDir, monitorsDir } = makeWorkspace();
    // Author a long-interval + long-settle monitor so its derived tombstone TTL
    // (max(5min, interval + settle + 1min margin) = max(5min, 10+2+1min) = 13min)
    // exceeds the fixed 5-minute floor. Pre-fix the reap used the flat floor, so a
    // deletion re-materializing after 5min would linger.
    const monitorDir = path.join(monitorsDir, MONITOR_ID);
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---\nname: Docs watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: '10m'\nnotify:\n  strategy: debounce\n  settle-for: '2m'\nurgency: normal\n---\nReview it.\n`,
      'utf-8',
    );
    const db = createDb(':memory:');
    const runtime = new AgentMonitorRuntime(
      new RuntimeStore(db),
      registryWithNoopSource(),
      [claudeCodeAdapter],
      undefined,
      { sessionDormancyMs: 60_000 },
    );
    const store = new RuntimeStore(db);
    // Open the orphaned verify session (its presence is what the reap acts on).
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'agentmonitors-verify-fedcba987654',
        workspacePath: rootDir,
      }),
    );
    const scratchKey = path.join(
      rootDir,
      'agentmonitors-verify-fedcba987654.md',
    );
    store.insertEvent({
      ...eventBase(rootDir),
      title: `File created: ${scratchKey}`,
      summary: `File created: ${scratchKey}`,
      objectKey: scratchKey,
      createdAt: new Date(),
    });

    // Advance past dormancy and tick: the reap installs the tombstone now (00:02).
    vi.setSystemTime(new Date('2026-07-16T00:02:00.000Z'));
    await runtime.tick(monitorsDir, rootDir);

    // At 00:08 the flat 5-min floor (would expire ~00:07) is already gone, but the
    // cadence-derived 13-min window is still active — the tombstone survives.
    expect(
      store.activeObjectSuppressions(
        rootDir,
        new Date('2026-07-16T00:08:00.000Z'),
      ),
    ).toHaveLength(1);
    // And it does eventually expire (past 00:15).
    expect(
      store.activeObjectSuppressions(
        rootDir,
        new Date('2026-07-16T00:16:00.000Z'),
      ),
    ).toHaveLength(0);
  });
});
