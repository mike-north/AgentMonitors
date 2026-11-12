/**
 * Preserve the existing bounded scratch-cleanup window when unrelated source
 * config is rejected. This proves delayed repair within that window, not the
 * arbitrary-pause or held-only ownership guarantee tracked separately in #561.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import fileSource from '../../../../plugins/source-file-fingerprint/src/index.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { validateWatchScope } from '../schema/validate-scope.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

it('retains 665000ms of valid cadence protection through rejected globs, restart, repair and later claim', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'am-cadence-window-'));
  const workspace = path.join(root, 'a');
  const foreign = path.join(root, 'b');
  const monitorsDir = path.join(workspace, 'monitors');
  const foreignDir = path.join(foreign, 'monitors');
  const monitorId = 'watched';
  for (const dir of [monitorsDir, foreignDir]) {
    mkdirSync(path.join(dir, monitorId), { recursive: true });
  }
  const scratch = path.join(workspace, 'agentmonitors-verify-abcdef012345.md');
  const watched = path.join(workspace, 'watched.txt');
  const sibling = path.join(workspace, 'sibling.txt');
  const registry = new SourceRegistry();
  registry.register(fileSource);
  const open = () => {
    const db = createDb(path.join(root, 'state.db'));
    const store = new RuntimeStore(db);
    return {
      store,
      runtime: new AgentMonitorRuntime(
        store,
        registry,
        [claudeCodeAdapter],
        undefined,
        { sessionDormancyMs: 60000 },
      ),
      // InboxDb hides the driver; this harness closes only its owned connection
      // to prove durable pause/recovery without adding a production API.
      close: () =>
        (db as unknown as { $client: { close(): void } }).$client.close(),
    };
  };
  const write = (invalid = false, settle = '5s') =>
    writeFileSync(
      path.join(monitorsDir, monitorId, 'MONITOR.md'),
      `---\nname: Watched\nwatch:\n  type: file-fingerprint\n  globs: ${invalid ? '42' : "['watched.txt', 'agentmonitors-verify-*.md']"}\n  interval: ${invalid ? '10m' : '1s'}\nurgency: high\nnotify:\n  strategy: debounce\n  settle-for: ${settle}\n---\nKeep legitimate work.\n`,
    );
  const lead = (
    runtime: AgentMonitorRuntime,
    hostSessionId: string,
    workspacePath: string,
  ) =>
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
    );
  let current = open();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  try {
    write(false, '0s');
    writeFileSync(
      path.join(foreignDir, monitorId, 'MONITOR.md'),
      `---\nwatch:\n  type: file-fingerprint\n  globs: [${JSON.stringify(scratch)}]\n  interval: 1s\nurgency: high\nnotify:\n  strategy: debounce\n  settle-for: 0s\n---\nForeign workspace work.\n`,
    );
    const siblingDir = path.join(monitorsDir, 'zzz-sibling');
    mkdirSync(siblingDir);
    writeFileSync(
      path.join(siblingDir, 'MONITOR.md'),
      `---\nwatch:\n  type: file-fingerprint\n  globs: ['sibling.txt']\n  interval: 1s\nurgency: normal\n---\nHandle sibling work.\n`,
    );
    writeFileSync(watched, 'baseline');
    writeFileSync(sibling, 'baseline');
    const owner = lead(
      current.runtime,
      'agentmonitors-verify-abcdef012345',
      workspace,
    );
    const foreignLead = lead(current.runtime, 'foreign-lead', foreign);
    await current.runtime.tick(monitorsDir, workspace);
    await current.runtime.tick(foreignDir, foreign);
    vi.advanceTimersByTime(1000);
    writeFileSync(scratch, 'synthetic scratch');
    writeFileSync(watched, 'legitimate emitted');
    await current.runtime.tick(monitorsDir, workspace);
    await current.runtime.tick(foreignDir, foreign);
    vi.advanceTimersByTime(1000);
    await current.runtime.tick(monitorsDir, workspace);
    await current.runtime.tick(foreignDir, foreign);
    expect(
      current.runtime.listEvents({ sessionId: owner.id, objectKey: scratch }),
    ).toHaveLength(1);
    const foreignEvents = current.runtime.listEvents({
      workspacePath: foreign,
    });
    expect(foreignEvents).toHaveLength(1);
    expect(foreignEvents[0]?.objectKey).toBe(scratch);
    const foreignState = current.store.getMonitorState(monitorId, foreign);
    const realEvents = current.runtime.listEvents({
      workspacePath: workspace,
      objectKey: watched,
    });
    expect(realEvents).toHaveLength(1);
    write();
    vi.advanceTimersByTime(1000);
    writeFileSync(watched, 'held legitimate');
    await current.runtime.tick(monitorsDir, workspace);
    const retained = current.store.getMonitorState(monitorId, workspace);
    expect(retained.notifyState.pendingDebounce?.observations).toHaveLength(1);
    const history = current.runtime.listObservationHistory({
      monitorId,
      workspacePath: workspace,
    });
    write(true);
    rmSync(scratch);
    writeFileSync(sibling, 'healthy progress');
    const reapAt = new Date('2026-11-05T12:02:00Z');
    vi.setSystemTime(reapAt);
    const rejected = await current.runtime.tick(monitorsDir, workspace);
    expect(rejected.skippedMonitors).toEqual([
      {
        monitorId,
        validationError: validateWatchScope(
          { globs: 42, interval: '10m' },
          fileSource.scopeSchema,
        ).join('; '),
      },
    ]);
    expect(rejected.evaluatedMonitors).toEqual(['zzz-sibling']);
    expect(rejected.emittedEventIds).toHaveLength(1);
    expect(current.store.getSessionById(owner.id).status).toBe('dormant');
    expect(
      current.runtime.listEvents({
        workspacePath: workspace,
        objectKey: scratch,
      }),
    ).toEqual([]);
    expect(
      current.runtime.listEvents({
        workspacePath: workspace,
        objectKey: watched,
      }),
    ).toEqual(realEvents);
    expect(current.store.getMonitorState(monitorId, workspace)).toEqual(
      retained,
    );
    expect
      .soft(
        current.store.activeObjectSuppressions(
          workspace,
          new Date(reapAt.getTime() + 664999),
        ),
      )
      .toHaveLength(1);
    expect
      .soft(
        current.store.activeObjectSuppressions(
          workspace,
          new Date(reapAt.getTime() + 665000),
        ),
      )
      .toEqual([]);
    current.close();
    current = open();
    vi.setSystemTime(new Date('2026-11-05T12:08:00Z'));
    await current.runtime.tick(monitorsDir, workspace);
    expect(current.store.getMonitorState(monitorId, workspace)).toEqual(
      retained,
    );
    expect(
      current.runtime.listObservationHistory({
        monitorId,
        workspacePath: workspace,
      }),
    ).toEqual(history);
    const later = lead(current.runtime, 'later-real-lead', workspace);
    write();
    await current.runtime.tick(monitorsDir, workspace);
    vi.advanceTimersByTime(6000);
    await current.runtime.tick(monitorsDir, workspace);
    const recoveredReal = current.runtime.listEvents({
      workspacePath: workspace,
      objectKey: watched,
    });
    expect(
      recoveredReal.some((event) => event.snapshotText === 'held legitimate'),
    ).toBe(true);
    vi.advanceTimersByTime(16000);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');
    expect(claim).not.toBeNull();
    const scratchEvents = current.runtime.listEvents({
      workspacePath: workspace,
      objectKey: scratch,
    });
    // Both the durable result and the actual later claim must exclude scratch;
    // expiry alone is insufficient evidence that the bounded repair works.
    expect.soft(scratchEvents).toEqual([]);
    expect(
      claim?.events.every(
        (event) =>
          !scratchEvents.some(
            (scratchEvent) => scratchEvent.id === event.eventId,
          ),
      ),
    ).toBe(true);
    expect(
      claim?.events.some((event) =>
        recoveredReal.some(
          (real) =>
            real.id === event.eventId &&
            real.snapshotText === 'held legitimate',
        ),
      ),
    ).toBe(true);
    expect(current.store.getMonitorState(monitorId, foreign)).toEqual(
      foreignState,
    );
    expect(current.runtime.listEvents({ workspacePath: foreign })).toEqual(
      foreignEvents,
    );
    const foreignClaim = current.runtime.claimDelivery(
      foreignLead.id,
      'turn-interruptible',
    );
    expect(foreignClaim?.events.map((event) => event.eventId)).toContain(
      foreignEvents[0]?.id,
    );
    expect(
      current.store.activeObjectSuppressions(
        workspace,
        new Date(reapAt.getTime() + 664999),
      ),
    ).toHaveLength(1);
    expect(
      current.store.activeObjectSuppressions(
        workspace,
        new Date(reapAt.getTime() + 665000),
      ),
    ).toEqual([]);
  } finally {
    current.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
