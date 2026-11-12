/**
 * Durable verify-artifact ownership (issue #562). `verify --use-workspace-daemon`
 * registers exact ownership of its synthetic scratch file before creating it.
 * Once the owner requests cleanup or is no longer active, the runtime filters
 * that exact key at the incoming-observation and held-emission boundaries, with
 * no wall-clock expiry, so the artifact never reaches a later lead session.
 *
 * Every scenario drives the real file-fingerprint source against real files,
 * closes and reopens the SQLite database across an arbitrary pause, and checks
 * both the durable event table and an actual later-lead claim. Legitimate work
 * in the same batches, a foreign workspace with the same key and a real watched
 * path are controls that must keep delivering.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2.6 (verify artifact ownership)
 * @see ../../../../docs/specs/005-cli-reference.md §16 step 9
 * @see ../../../../docs/specs/004-validation-testing.md §2.5
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fileSource from '../../../../plugins/source-file-fingerprint/src/index.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type {
  ObservationContext,
  ObservationSource,
} from '../observation/types.js';
import type { AgentSessionRecord, DeliveryClaim } from './types.js';

const MONITOR_ID = 'watched';
const RUN = 'abcdef012345';
const OTHER_RUN = '0123456789ab';
/** An arbitrary pause far beyond any finite suppression window. */
const LONG_PAUSE_MS = 6 * 60 * 60 * 1_000;
/** High urgency defaults to a 15s claim settle; claims wait past it. */
const CLAIM_SETTLE_MS = 16_000;

/**
 * What `verify` does to own and later clean up its scratch artifact. Kept in one
 * place so the scenarios below read as the verify lifecycle.
 */
const ownership = {
  register(
    runtime: AgentMonitorRuntime,
    input: {
      runId: string;
      ownerSessionId: string;
      workspacePath: string;
      objectKey: string;
    },
  ) {
    return runtime.registerVerifyArtifact({ monitorId: MONITOR_ID, ...input });
  },
  requestCleanup(runtime: AgentMonitorRuntime, runId: string) {
    return runtime.requestVerifyArtifactCleanup({ runId });
  },
};

const roots: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

interface MonitorOptions {
  invalid?: boolean;
  settle?: string;
  rollupWindow?: string;
  throttle?: string;
}

/** One workspace plus a foreign workspace on a single durable database file. */
function harness() {
  const root = mkdtempSync(path.join(tmpdir(), 'am-verify-ownership-'));
  roots.push(root);
  const workspace = path.join(root, 'a');
  const foreign = path.join(root, 'b');
  const monitorsDir = path.join(workspace, 'monitors');
  const foreignDir = path.join(foreign, 'monitors');
  for (const dir of [monitorsDir, foreignDir]) {
    mkdirSync(path.join(dir, MONITOR_ID), { recursive: true });
  }
  const scratch = path.join(workspace, `agentmonitors-verify-${RUN}.md`);
  const watched = path.join(workspace, 'watched.txt');
  const registry = new SourceRegistry();
  registry.register(fileSource);

  const open = () => {
    const db = createDb(path.join(root, 'state.db'));
    const store = new RuntimeStore(db);
    // InboxDb hides the driver; the harness closes only its own connection to
    // model a daemon stop and a later restart on the same database file.
    const client = (
      db as unknown as { $client: { close(): void; open: boolean } }
    ).$client;
    const close = () => {
      if (client.open) client.close();
    };
    closers.push(close);
    return {
      store,
      runtime: new AgentMonitorRuntime(
        store,
        registry,
        [claudeCodeAdapter],
        undefined,
        { sessionDormancyMs: 60_000 },
      ),
      close,
    };
  };

  const notifyBlock = (options: MonitorOptions) =>
    options.rollupWindow !== undefined
      ? `notify:\n  strategy: rollup\n  window: '${options.rollupWindow}'\n`
      : options.throttle !== undefined
        ? `notify:\n  strategy: throttle\n  suppress-for: ${options.throttle}\n`
        : `notify:\n  strategy: debounce\n  settle-for: ${options.settle ?? '0s'}\n`;

  const writeMonitor = (options: MonitorOptions = {}) =>
    writeFileSync(
      path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
      `---\nname: Watched\nwatch:\n  type: file-fingerprint\n  globs: ${options.invalid ? '42' : "['watched.txt', 'agentmonitors-verify-*.md']"}\n  interval: 1s\nurgency: high\n${notifyBlock(options)}---\nKeep legitimate work.\n`,
    );

  const writeForeignMonitor = () =>
    writeFileSync(
      path.join(foreignDir, MONITOR_ID, 'MONITOR.md'),
      `---\nwatch:\n  type: file-fingerprint\n  globs: [${JSON.stringify(scratch)}]\n  interval: 1s\nurgency: high\nnotify:\n  strategy: debounce\n  settle-for: 0s\n---\nForeign workspace work.\n`,
    );

  const lead = (
    runtime: AgentMonitorRuntime,
    hostSessionId: string,
    workspacePath = workspace,
  ): AgentSessionRecord =>
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
    );

  return {
    root,
    workspace,
    foreign,
    monitorsDir,
    foreignDir,
    scratch,
    watched,
    open,
    writeMonitor,
    writeForeignMonitor,
    lead,
  };
}

/** Advance the fake clock, then tick the workspace. */
async function tickAfter(
  runtime: AgentMonitorRuntime,
  ms: number,
  monitorsDir: string,
  workspacePath: string,
) {
  vi.advanceTimersByTime(ms);
  return runtime.tick(monitorsDir, workspacePath);
}

/** The ids a real later-lead claim surfaced. */
function claimedIds(claim: DeliveryClaim | null): string[] {
  return claim?.events.map((event) => event.eventId) ?? [];
}

function startClock(at = '2026-11-12T12:00:00Z'): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
}

describe('verify artifact ownership through delayed recovery (#562)', () => {
  it('a baseline-retained scratch deletion never reaches a later lead after delayed repair and restart', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    // Registration precedes creation; the proof reaches the owner.
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const proof = current.runtime.claimDelivery(owner.id, 'turn-interruptible');
    const proofEvents = current.runtime.listEvents({
      sessionId: owner.id,
      objectKey: h.scratch,
    });
    expect(proofEvents).toHaveLength(1);
    expect(claimedIds(proof)).toEqual(proofEvents.map((event) => event.id));

    // The config breaks before the deletion is observed, so the source keeps
    // the deleted key in its baseline. Verify reverts, cleans up and closes.
    h.writeMonitor({ invalid: true });
    rmSync(h.scratch);
    writeFileSync(h.watched, 'legitimate during pause');
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);
    const rejected = await tickAfter(
      current.runtime,
      1_000,
      h.monitorsDir,
      h.workspace,
    );
    expect(rejected.skippedMonitors.map((m) => m.monitorId)).toEqual([
      MONITOR_ID,
    ]);
    current.close();

    // Arbitrary pause, restart, a later lead, then repair.
    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    h.writeMonitor();
    await current.runtime.tick(h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    // The legitimate change from the same recovered batch still arrives.
    const real = current.runtime.listEvents({
      workspacePath: h.workspace,
      objectKey: h.watched,
    });
    const legit = real.find(
      (event) => event.snapshotText === 'legitimate during pause',
    );
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('an already-held scratch deletion never reaches a later lead after delayed repair and restart', async () => {
    startClock();
    const h = harness();
    h.writeMonitor({ settle: '30s' });
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 31_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    expect(
      claimedIds(current.runtime.claimDelivery(owner.id, 'turn-interruptible')),
    ).toHaveLength(1);

    // The deletion and a legitimate change are held together; the source
    // baseline has already forgotten the scratch file.
    rmSync(h.scratch);
    writeFileSync(h.watched, 'held legitimate');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    const held = current.store.getMonitorState(MONITOR_ID, h.workspace);
    expect(
      held.notifyState.pendingDebounce?.observations.map(
        (envelope) => envelope.observation.objectKey,
      ),
    ).toEqual(expect.arrayContaining([h.scratch, h.watched]));
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);
    h.writeMonitor({ invalid: true, settle: '30s' });
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    h.writeMonitor({ settle: '30s' });
    await current.runtime.tick(h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'held legitimate');
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('a held-only scratch create left by a killed run never reaches a later lead after stale-owner reaping and restart', async () => {
    startClock();
    const h = harness();
    h.writeMonitor({ settle: '30s' });
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    writeFileSync(h.watched, 'held beside scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    // Nothing projected: the create is only held when the run is killed, so no
    // cleanup request and no session close ever happen.
    expect(current.runtime.listEvents({ workspacePath: h.workspace })).toEqual(
      [],
    );
    h.writeMonitor({ invalid: true, settle: '30s' });

    // The stale owner is reaped while the monitor stays invalid.
    await tickAfter(current.runtime, 120_000, h.monitorsDir, h.workspace);
    expect(current.store.getSessionById(owner.id).status).toBe('dormant');
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    h.writeMonitor({ settle: '30s' });
    await current.runtime.tick(h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'held beside scratch');
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('a held scratch envelope drained by a notify-policy edit never reaches a later lead', async () => {
    startClock();
    const h = harness();
    h.writeMonitor({ settle: '10m' });
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    writeFileSync(h.watched, 'held for edit');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    // An effective edit drains the captured batch under the old policy.
    h.writeMonitor({ settle: '20m' });
    await current.runtime.tick(h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'held for edit');
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('a scratch create held in a rollup window never reaches a later lead when the window fires after the owner is reaped', async () => {
    startClock('2026-11-12T12:57:00Z');
    const h = harness();
    h.writeMonitor({ rollupWindow: '0 * * * *' });
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    writeFileSync(h.watched, 'rolled up');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    expect(
      current.store.getMonitorState(MONITOR_ID, h.workspace).notifyState
        .pendingRollup?.observations,
    ).toHaveLength(2);
    // The run dies; the owner is reaped before the window opens.
    await tickAfter(current.runtime, 90_000, h.monitorsDir, h.workspace);
    expect(current.store.getSessionById(owner.id).status).toBe('dormant');
    current.close();

    // Restart inside the 13:00 window with a later lead.
    vi.setSystemTime(new Date('2026-11-12T13:00:10Z'));
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    await current.runtime.tick(h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'rolled up');
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('cleanup authority has no wall-clock expiry and successful polls never retire it', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    rmSync(h.scratch);
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);
    // Many successful polls, including the deletion and plain no-change scans.
    for (let i = 0; i < 5; i++) {
      await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    }
    current.close();

    // Years later, after a restart, the same key reappears beside real work.
    vi.advanceTimersByTime(3 * 365 * 24 * 60 * 60 * 1_000);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    await current.runtime.tick(h.monitorsDir, h.workspace);
    writeFileSync(h.scratch, 'reappeared');
    writeFileSync(h.watched, 'years later');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    rmSync(h.scratch);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'years later');
    expect(legit).toBeDefined();
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });
});

describe('verify artifact ownership at the incoming-observation boundary (#562)', () => {
  it('a filtered artifact observation never consumes a throttle window that a later legitimate change needs', async () => {
    startClock();
    const h = harness();
    h.writeMonitor({ throttle: '1m' });
    writeFileSync(h.watched, 'baseline');
    const current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);

    // After the proof's throttle window, verify's deletion is observed first.
    vi.advanceTimersByTime(120_000);
    const later = h.lead(current.runtime, 'later-real-lead');
    rmSync(h.scratch);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    writeFileSync(h.watched, 'right after the artifact');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);

    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'right after the artifact');
    expect(legit).toBeDefined();
    expect(
      claimedIds(current.runtime.claimDelivery(later.id, 'turn-interruptible')),
    ).toEqual([legit?.id]);
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('a watcher batch admitted after restart, before any tick, already treats an ended owner as cleanup authority', async () => {
    const h = harness();
    const watchDir = path.join(h.root, 'watch-monitors');
    mkdirSync(path.join(watchDir, MONITOR_ID), { recursive: true });
    writeFileSync(
      path.join(watchDir, MONITOR_ID, 'MONITOR.md'),
      `---\nwatch:\n  type: watch-batch\nurgency: normal\n---\nHandle it.\n`,
    );
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    const later = h.lead(current.runtime, 'later-real-lead');
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    // A crash inside session close: the session row ended, but the process
    // stopped before the runtime recorded the owner's cleanup.
    current.store.closeSession(owner.id);
    current.close();

    current = h.open();
    const idle = (context: ObservationContext) =>
      new Promise<void>((resolve) => {
        if (context.signal?.aborted) resolve();
        else
          context.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    const watcher: ObservationSource = {
      name: 'watch-batch',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context) {
        yield {
          observations: [
            {
              title: 'File deleted',
              summary: `File deleted: ${h.scratch}`,
              objectKey: h.scratch,
            },
            {
              title: 'File modified',
              summary: `File modified: ${h.watched}`,
              objectKey: h.watched,
            },
          ],
          nextState: 'advanced',
        };
        await idle(context);
      },
    };
    const registry = new SourceRegistry();
    registry.register(watcher);
    const runtime = new AgentMonitorRuntime(current.store, registry, [
      claudeCodeAdapter,
    ]);
    const handle = await runtime.watchMonitors(watchDir, h.workspace);
    try {
      await vi.waitFor(() =>
        expect(
          current.store.getMonitorState(MONITOR_ID, h.workspace).sourceState,
        ).toBe('advanced'),
      );
    } finally {
      await handle.stop();
    }
    expect(
      runtime.listEvents({ workspacePath: h.workspace, objectKey: h.scratch }),
    ).toEqual([]);
    const legit = runtime.listEvents({
      workspacePath: h.workspace,
      objectKey: h.watched,
    });
    expect(legit).toHaveLength(1);
    expect(claimedIds(runtime.claimDelivery(later.id, 'post-compact'))).toEqual(
      legit.map((event) => event.id),
    );
  });
});

describe('verify artifact ownership exactness (#562)', () => {
  it('a foreign workspace with the same monitor id and object key keeps delivering', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    h.writeForeignMonitor();
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    const foreignLead = h.lead(current.runtime, 'foreign-lead', h.foreign);
    await current.runtime.tick(h.monitorsDir, h.workspace);
    await current.runtime.tick(h.foreignDir, h.foreign);

    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    ownership.requestCleanup(current.runtime, RUN);
    current.runtime.closeSession(owner.id);
    current.close();
    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    await current.runtime.tick(h.monitorsDir, h.workspace);
    await current.runtime.tick(h.foreignDir, h.foreign);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await current.runtime.tick(h.foreignDir, h.foreign);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);

    // Control: the foreign workspace's identical key is never filtered.
    const foreignEvents = current.runtime.listEvents({
      workspacePath: h.foreign,
      objectKey: h.scratch,
    });
    expect(foreignEvents).toHaveLength(1);
    expect(
      claimedIds(
        current.runtime.claimDelivery(foreignLead.id, 'turn-interruptible'),
      ),
    ).toEqual(foreignEvents.map((event) => event.id));
    // The owned key in this workspace is filtered after the pause.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('an unregistered scratch-looking path supplies no cleanup authority, even under a reaped verify-named session', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    const unregistered = path.join(
      h.workspace,
      `agentmonitors-verify-${OTHER_RUN}.md`,
    );
    let current = h.open();
    const stale = h.lead(current.runtime, `agentmonitors-verify-${OTHER_RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);
    writeFileSync(unregistered, 'looks like scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    const created = current.runtime.listEvents({
      workspacePath: h.workspace,
      objectKey: unregistered,
    });
    expect(created).toHaveLength(1);

    // The verify-named session goes stale and is reaped.
    await tickAfter(current.runtime, 120_000, h.monitorsDir, h.workspace);
    expect(current.store.getSessionById(stale.id).status).toBe('dormant');
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: unregistered,
      }),
    ).toEqual(created);
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    await current.runtime.tick(h.monitorsDir, h.workspace);
    rmSync(unregistered);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const deletion = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: unregistered })
      .filter((event) => !created.some((c) => c.id === event.id));
    expect(deletion).toHaveLength(1);
    expect(
      claimedIds(current.runtime.claimDelivery(later.id, 'turn-interruptible')),
    ).toEqual(deletion.map((event) => event.id));
  });

  it('a real watched path never acquires by-key cleanup authority', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    const current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);

    expect(() =>
      ownership.register(current.runtime, {
        runId: RUN,
        ownerSessionId: owner.id,
        workspacePath: h.workspace,
        objectKey: h.watched,
      }),
    ).toThrow(/verify scratch/);
    current.runtime.closeSession(owner.id);
    const later = h.lead(current.runtime, 'later-real-lead');
    writeFileSync(h.watched, 'real edit');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const real = current.runtime.listEvents({
      workspacePath: h.workspace,
      objectKey: h.watched,
    });
    expect(real.map((event) => event.snapshotText)).toEqual(['real edit']);
    expect(
      claimedIds(current.runtime.claimDelivery(later.id, 'turn-interruptible')),
    ).toEqual(real.map((event) => event.id));
  });

  it('refuses a key owned by another run, a key without the run identity, and an owner that is not active', () => {
    const h = harness();
    const current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    const other = h.lead(current.runtime, `agentmonitors-verify-${OTHER_RUN}`);
    // Another run cannot take over this run's key.
    expect(() =>
      ownership.register(current.runtime, {
        runId: OTHER_RUN,
        ownerSessionId: other.id,
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toThrow(/run identity|another verify run/);
    // A scratch-looking key must carry this run's own identity.
    expect(() =>
      ownership.register(current.runtime, {
        runId: OTHER_RUN,
        ownerSessionId: other.id,
        workspacePath: h.workspace,
        objectKey: path.join(h.workspace, `agentmonitors-verify-${RUN}.txt`),
      }),
    ).toThrow(/run identity/);
    current.runtime.closeSession(other.id);
    expect(() =>
      ownership.register(current.runtime, {
        runId: OTHER_RUN,
        ownerSessionId: other.id,
        workspacePath: h.workspace,
        objectKey: path.join(
          h.workspace,
          `agentmonitors-verify-${OTHER_RUN}.md`,
        ),
      }),
    ).toThrow(/not active/);
    expect(() =>
      ownership.register(current.runtime, {
        runId: OTHER_RUN,
        ownerSessionId: 'missing-session',
        workspacePath: h.workspace,
        objectKey: path.join(
          h.workspace,
          `agentmonitors-verify-${OTHER_RUN}.md`,
        ),
      }),
    ).toThrow(/not found/);
    expect(current.store.listVerifyArtifacts(h.workspace)).toHaveLength(1);
  });
});

describe('verify artifact ownership across crashes (#562)', () => {
  it('a retried registration, before and after restart, keeps exactly one record per run', () => {
    startClock();
    const h = harness();
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    const input = {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    };
    const first = ownership.register(current.runtime, input);
    vi.advanceTimersByTime(5_000);
    expect(ownership.register(current.runtime, input)).toEqual(first);
    current.close();
    current = h.open();
    expect(ownership.register(current.runtime, input)).toEqual(first);
    expect(current.store.listVerifyArtifacts(h.workspace)).toEqual([first]);
  });

  it('a run killed after registration but before creation is reaped to cleanup once, idempotently across restarts', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    current.close();

    vi.advanceTimersByTime(120_000);
    current = h.open();
    await current.runtime.tick(h.monitorsDir, h.workspace);
    const [reaped] = current.store.listVerifyArtifacts(h.workspace);
    expect(reaped?.cleanupRequestedAt).toEqual(
      new Date('2026-11-12T12:02:00Z'),
    );
    expect(reaped?.cleanupCause).toBe('owner-inactive');
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    await current.runtime.tick(h.monitorsDir, h.workspace);
    expect(current.store.listVerifyArtifacts(h.workspace)).toEqual([reaped]);
  });

  it('a retried cleanup request is idempotent and keeps the first request time', () => {
    startClock();
    const h = harness();
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    const first = ownership.requestCleanup(current.runtime, RUN);
    expect(first.artifact.cleanupCause).toBe('owner-request');
    current.close();
    vi.advanceTimersByTime(10_000);
    current = h.open();
    const retried = ownership.requestCleanup(current.runtime, RUN);
    expect(retried.artifact).toEqual(first.artifact);
    expect(retried.retractedEventCount).toBe(0);
    current.runtime.closeSession(owner.id);
    expect(current.store.listVerifyArtifacts(h.workspace)).toEqual([
      first.artifact,
    ]);
    expect(() => ownership.requestCleanup(current.runtime, OTHER_RUN)).toThrow(
      /not registered/,
    );
  });

  it('a killed run whose immediate proof event was projected is retracted at stale-owner reaping, and its later deletion is filtered', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    let current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    await current.runtime.tick(h.monitorsDir, h.workspace);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    expect(
      current.runtime.listEvents({ sessionId: owner.id, objectKey: h.scratch }),
    ).toHaveLength(1);
    // The run is killed: its session simply goes stale.
    await tickAfter(current.runtime, 120_000, h.monitorsDir, h.workspace);
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
    current.close();

    vi.advanceTimersByTime(LONG_PAUSE_MS);
    current = h.open();
    const later = h.lead(current.runtime, 'later-real-lead');
    await current.runtime.tick(h.monitorsDir, h.workspace);
    // Someone finally removes the leftover file beside a real change.
    rmSync(h.scratch);
    writeFileSync(h.watched, 'after the leftover');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    const claim = current.runtime.claimDelivery(later.id, 'turn-interruptible');
    const legit = current.runtime
      .listEvents({ workspacePath: h.workspace, objectKey: h.watched })
      .find((event) => event.snapshotText === 'after the leftover');
    expect(claimedIds(claim)).toEqual([legit?.id]);
    // The durable table, not only this claim, holds no scratch event.
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
  });

  it('an owner that ended before its cleanup was recorded already supplies authority, and the next tick records it', async () => {
    startClock();
    const h = harness();
    h.writeMonitor();
    writeFileSync(h.watched, 'baseline');
    const current = h.open();
    const owner = h.lead(current.runtime, `agentmonitors-verify-${RUN}`);
    const later = h.lead(current.runtime, 'later-real-lead');
    await current.runtime.tick(h.monitorsDir, h.workspace);
    ownership.register(current.runtime, {
      runId: RUN,
      ownerSessionId: owner.id,
      workspacePath: h.workspace,
      objectKey: h.scratch,
    });
    // The session row went dormant, but the process stopped before the runtime
    // recorded the owner's cleanup (a crash inside session close).
    current.store.closeSession(owner.id);
    writeFileSync(h.scratch, 'synthetic scratch');
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    await tickAfter(current.runtime, 1_000, h.monitorsDir, h.workspace);
    vi.advanceTimersByTime(CLAIM_SETTLE_MS);
    expect(
      current.runtime.listEvents({
        workspacePath: h.workspace,
        objectKey: h.scratch,
      }),
    ).toEqual([]);
    expect(
      current.runtime.claimDelivery(later.id, 'turn-interruptible'),
    ).toBeNull();
    const [artifact] = current.store.listVerifyArtifacts(h.workspace);
    expect(artifact?.cleanupCause).toBe('owner-inactive');
  });
});
