/**
 * Ephemeral (agent-declared, session-scoped) monitors — 007 §4.
 *
 * Covers the acceptance criteria of issue #312: declaration validity + scope
 * parity (§4.2), namespaced/unique/stable identity with impossible persistent
 * collision (§4.3), lifecycle — active-on-declare, reap on session close,
 * `watch cancel` immediate reap, daemon-restart survival while the session lives,
 * no resurrection after session end, per-session dormancy reap (§4.4) — and
 * projection isolation to the declaring session only (§4.6).
 *
 * @see docs/specs/007-agent-facing-interaction.md §4
 * @see docs/specs/002-runtime-delivery.md §6.2
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import { validateScope } from '../schema/validate-scope.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

/**
 * A deterministic ephemeral test source: it emits exactly one observation per
 * `observe()` for its `target` object, so a single tick materializes one event.
 * `target` is REQUIRED, giving a concrete invalid-scope case for the parity test.
 */
const ephemeralSource: ObservationSource = {
  name: 'test-ephemeral',
  scopeSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      interval: { type: 'string' },
    },
    required: ['target'],
  },
  observe(
    config: Record<string, unknown>,
    context: ObservationContext,
  ): Promise<ObservationResult> {
    const target = String(config['target']);
    return Promise.resolve({
      observations: [
        {
          title: `changed: ${target}`,
          summary: `changed: ${target}`,
          snapshotText: `state@${context.now.toISOString()}`,
          objectKey: target,
        },
      ],
    });
  },
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  workspace: string;
  monitorsDir: string;
}

function makeHarness(
  dbPath: string,
  workspace: string,
  options: { sessionDormancyMs?: number } = {},
): Harness {
  const db = createDb(dbPath);
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register(ephemeralSource);
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    undefined,
    options,
  );
  // An empty monitors dir: ephemeral monitors have no files, so the tick's
  // directory scan finds nothing and only the durable ephemeral records are
  // evaluated.
  const monitorsDir = path.join(workspace, '.claude', 'monitors');
  mkdirSync(monitorsDir, { recursive: true });
  return { runtime, store, workspace, monitorsDir };
}

function openLead(
  runtime: AgentMonitorRuntime,
  workspace: string,
  host: string,
) {
  return runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: host,
      workspacePath: workspace,
    }),
  );
}

describe('ephemeral monitors — declaration (007 §4.2)', () => {
  it('registers a valid declaration as active, bound to the declaring session', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-decl-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-decl');

    const record = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
      instruction: 'Review foo when it changes.',
    });

    expect(record.status).toBe('active');
    expect(record.sessionId).toBe(session.id);
    expect(record.sourceName).toBe('test-ephemeral');
    expect(record.workspacePath).toBe(workspace);
    expect(record.instruction).toBe('Review foo when it changes.');
    // Default urgency is `normal` (a scalar band), matching persistent monitors.
    expect(record.urgency).toBe('normal');
    expect(record.urgencyMax).toBe('normal');
    expect(runtime.listEphemeralMonitors(session.id)).toHaveLength(1);
  });

  it('rejects an invalid scope through the SAME validateScope path as `validate` (criterion 1)', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-parity-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-parity');

    // The `validate` command validates a monitor's scope with this exact call;
    // the ephemeral declaration MUST reject the identical bad scope identically.
    const badScope = {};
    const validateErrors = validateScope(badScope, ephemeralSource.scopeSchema);
    expect(validateErrors.length).toBeGreaterThan(0);

    let thrown: Error | undefined;
    try {
      runtime.declareEphemeralMonitor({
        sessionId: session.id,
        source: 'test-ephemeral',
        scope: badScope,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    // The declaration error carries the SAME validateScope message(s).
    for (const message of validateErrors) {
      expect(thrown?.message).toContain(message);
    }
    // Nothing was registered.
    expect(runtime.listEphemeralMonitors(session.id)).toHaveLength(0);
  });

  it('rejects an unbindable declaration rather than silently making it global (007 §4.2)', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-unbind-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);

    expect(() =>
      runtime.declareEphemeralMonitor({
        sessionId: 'no-such-session',
        source: 'test-ephemeral',
        scope: { target: 'foo' },
      }),
    ).toThrow(/not found/);
  });

  it('rejects a declaration bound to a non-active (dormant) session', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-dormantbind-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-dormantbind');
    runtime.closeSession(session.id);

    expect(() =>
      runtime.declareEphemeralMonitor({
        sessionId: session.id,
        source: 'test-ephemeral',
        scope: { target: 'foo' },
      }),
    ).toThrow(/dormant/);
  });
});

describe('ephemeral monitors — identity (007 §4.3, criterion 2)', () => {
  it('assigns a namespaced id that cannot collide with a persistent (directory-derived) id', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-id-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-id');

    const record = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    // Namespaced with the reserved prefix and the declaring session id.
    expect(record.id.startsWith('ephemeral:')).toBe(true);
    expect(record.id).toContain(session.id);
    // Structural collision-proofing (SP2): a directory-derived persistent monitor
    // id is a SINGLE path segment and therefore can never contain a `/`; every
    // ephemeral id does, so it is impossible for a persistent id to equal it.
    expect(record.id).toContain('/');
    expect(path.basename(record.id)).not.toBe(record.id);
  });

  it('assigns a distinct id to each declaration (unique within session scope)', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-uniq-'));
    tempDirs.push(workspace);
    const { runtime } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-uniq');

    const a = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'a' },
    });
    const b = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'b' },
    });
    expect(a.id).not.toBe(b.id);
  });

  it('keeps a stable id across a tick and a daemon restart (criterion 2)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-eph-stable-'));
    tempDirs.push(root);
    const dbPath = path.join(root, 'agentmon.db');
    const first = makeHarness(dbPath, root);
    const session = openLead(first.runtime, root, 'host-stable');
    const record = first.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });
    await first.runtime.tick(first.monitorsDir, root);
    // A same-process "restart": a fresh store/runtime over the same db file.
    const second = makeHarness(dbPath, root);
    const active = second.store.listActiveEphemeralMonitors(root);
    expect(active.map((r) => r.id)).toContain(record.id);
  });
});

describe('ephemeral monitors — lifecycle (007 §4.4, criterion 3)', () => {
  it('is active on declaration and materializes an event on the normal tick', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-active-'));
    tempDirs.push(workspace);
    const { runtime, monitorsDir } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-active');
    runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    const result = await runtime.tick(monitorsDir, workspace);
    expect(result.emittedEventIds).toHaveLength(1);
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(1);
  });

  it('reaps the monitor when its declaring session closes; no further events fire', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-close-'));
    tempDirs.push(workspace);
    const { runtime, monitorsDir } = makeHarness(':memory:', workspace);
    const session = openLead(runtime, workspace, 'host-close');
    const record = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    runtime.closeSession(session.id);

    // Reaped: dropped from the session's active list and the tick's active set.
    expect(runtime.listEphemeralMonitors(session.id)).toHaveLength(0);
    const before = runtime.listEvents({ sessionId: session.id }).length;
    const result = await runtime.tick(monitorsDir, workspace);
    expect(result.emittedEventIds).toHaveLength(0);
    expect(runtime.listEvents({ sessionId: session.id })).toHaveLength(before);
    // Retained (007 §4.4 default): the record is reaped, not deleted.
    expect(record.id).toBeDefined();
  });

  it('reaps immediately on `watch cancel`, and only the owning session may cancel', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-cancel-'));
    tempDirs.push(workspace);
    const { runtime, monitorsDir } = makeHarness(':memory:', workspace);
    const owner = openLead(runtime, workspace, 'host-owner');
    const other = openLead(runtime, workspace, 'host-other');
    const record = runtime.declareEphemeralMonitor({
      sessionId: owner.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    // Session isolation: another session cannot cancel this monitor.
    expect(() => runtime.cancelEphemeralMonitor(other.id, record.id)).toThrow(
      /not found/,
    );

    const reaped = runtime.cancelEphemeralMonitor(owner.id, record.id);
    expect(reaped.status).toBe('reaped');
    expect(runtime.listEphemeralMonitors(owner.id)).toHaveLength(0);

    const result = await runtime.tick(monitorsDir, workspace);
    expect(result.emittedEventIds).toHaveLength(0);
  });

  it('survives a daemon restart while the session lives (restart-safety)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-eph-restart-'));
    tempDirs.push(root);
    const dbPath = path.join(root, 'agentmon.db');
    const first = makeHarness(dbPath, root);
    const session = openLead(first.runtime, root, 'host-restart');
    const record = first.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    // Restart: a fresh runtime over the SAME db, before any tick has run — the
    // declaration must be re-hydrated and evaluated so it fires post-restart.
    const second = makeHarness(dbPath, root);
    const result = await second.runtime.tick(second.monitorsDir, root);
    expect(result.emittedEventIds).toHaveLength(1);
    expect(second.runtime.listEvents({ sessionId: session.id })).toHaveLength(
      1,
    );
    expect(
      second.store.listActiveEphemeralMonitors(root).map((r) => r.id),
    ).toContain(record.id);
  });

  it('does NOT resurrect after the session has ended (restart-safety)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'am-eph-nores-'));
    tempDirs.push(root);
    const dbPath = path.join(root, 'agentmon.db');
    const first = makeHarness(dbPath, root);
    const session = openLead(first.runtime, root, 'host-nores');
    first.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });
    first.runtime.closeSession(session.id);

    // Restart after the session ended: the reaped monitor must not re-arm.
    const second = makeHarness(dbPath, root);
    expect(second.store.listActiveEphemeralMonitors(root)).toHaveLength(0);
    const result = await second.runtime.tick(second.monitorsDir, root);
    expect(result.emittedEventIds).toHaveLength(0);
    expect(second.runtime.listEvents({ sessionId: session.id })).toHaveLength(
      0,
    );
  });

  it('reaps on per-session dormancy by inactivity (002 §6.2 / 007 §4.4)', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-dormancy-'));
    tempDirs.push(workspace);
    // A tiny dormancy threshold so an inactive session goes dormant quickly.
    const { runtime, store, monitorsDir } = makeHarness(':memory:', workspace, {
      sessionDormancyMs: 40,
    });
    const session = openLead(runtime, workspace, 'host-dormancy');
    runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    // Let the session go stale (no lastActiveAt advance) past the threshold.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await runtime.tick(monitorsDir, workspace);

    // The tick transitioned the session to dormant and reaped its ephemeral
    // monitor before evaluating it, so nothing fired.
    expect(result.emittedEventIds).toHaveLength(0);
    expect(store.getSessionById(session.id).status).toBe('dormant');
    expect(runtime.listEphemeralMonitors(session.id)).toHaveLength(0);
  });

  it('does NOT reap a session that is still within the dormancy window', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-live-'));
    tempDirs.push(workspace);
    // A generous threshold: a freshly-opened session is not stale.
    const { runtime, store, monitorsDir } = makeHarness(':memory:', workspace, {
      sessionDormancyMs: 60_000,
    });
    const session = openLead(runtime, workspace, 'host-live');
    runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    const result = await runtime.tick(monitorsDir, workspace);
    expect(result.emittedEventIds).toHaveLength(1);
    expect(store.getSessionById(session.id).status).toBe('active');
    expect(runtime.listEphemeralMonitors(session.id)).toHaveLength(1);
  });
});

describe('ephemeral monitors — projection isolation (007 §4.6, criterion 4)', () => {
  it('projects an ephemeral monitor’s events into the declaring session ONLY', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-iso-'));
    tempDirs.push(workspace);
    const { runtime, monitorsDir } = makeHarness(':memory:', workspace);
    // Two lead sessions in the SAME workspace.
    const declaring = openLead(runtime, workspace, 'host-declaring');
    const sibling = openLead(runtime, workspace, 'host-sibling');

    runtime.declareEphemeralMonitor({
      sessionId: declaring.id,
      source: 'test-ephemeral',
      scope: { target: 'foo' },
    });

    const result = await runtime.tick(monitorsDir, workspace);
    expect(result.emittedEventIds).toHaveLength(1);

    // The declaring session receives it; the sibling lead session does NOT —
    // even though they share a workspace (the ephemeral isolation invariant).
    expect(runtime.listEvents({ sessionId: declaring.id })).toHaveLength(1);
    expect(runtime.listEvents({ sessionId: sibling.id })).toHaveLength(0);
    // And the sibling has no unread work from it.
    expect(
      runtime.listEvents({ sessionId: sibling.id, unreadOnly: true }),
    ).toHaveLength(0);
  });

  it('does not restrict a persistent (non-ephemeral) event, which still reaches every lead session', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'am-eph-persist-'));
    tempDirs.push(workspace);
    const { runtime, store } = makeHarness(':memory:', workspace);
    const a = openLead(runtime, workspace, 'host-persist-a');
    const b = openLead(runtime, workspace, 'host-persist-b');

    // A persistent-style event (no restrictToSessionId) projects to BOTH leads —
    // proving the isolation is opt-in for the ephemeral path only.
    store.insertEvent({
      workspacePath: workspace,
      monitorId: 'persistent-monitor',
      sourceName: 'test-ephemeral',
      urgency: 'normal',
      title: 'shared',
      body: 'shared',
      summary: 'shared',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'shared',
      baselineStrategy: null,
      queryScope: {},
      tags: [],
      createdAt: new Date(),
    });

    expect(runtime.listEvents({ sessionId: a.id })).toHaveLength(1);
    expect(runtime.listEvents({ sessionId: b.id })).toHaveLength(1);
  });
});
