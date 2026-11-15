/**
 * Held-work diagnosis follows workspace routes, independently of definition
 * discovery. Rejected files must preserve accepted envelopes byte-for-byte;
 * neither diagnostics nor same-id work in another workspace can consume them.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { parseMonitor } from '../parser/parse-monitor.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type { StoredObservationEnvelope } from './types.js';
import {
  describeHeldNotifyWork,
  heldNotifyStage,
} from './held-notify-diagnosis.js';

/** A deterministic diagnosis clock, before the batch's settle deadline. */
const now = new Date('2026-11-14T12:00:00Z');

for (const rejection of [
  'missing',
  'parse',
  'duplicate',
  'source',
  'scope',
] as const) {
  it(`reports a ${rejection} definition's hold once without changing or leaking scoped work`, async () => {
    const workspace = path.join(process.env.HOME ?? '', 'workspace');
    const dir = path.join(workspace, 'monitors');
    const file = path.join(dir, 'held/MONITOR.md');
    mkdirSync(path.dirname(file), { recursive: true });
    const definition = `---
name: Held work
watch:
  type: test-held
  required: yes
urgency: normal
notify:
  strategy: debounce
  settle-for: 1h
---
Inspect the change.
`;
    writeFileSync(file, definition);
    const store = new RuntimeStore(createDb(':memory:'));
    const registry = new SourceRegistry();
    registry.register({
      name: 'test-held',
      scopeSchema: {
        type: 'object',
        required: ['required'],
        properties: { required: { type: 'string' } },
      },
      async observe() {
        return {
          observations: [{ title: 'Accepted change', summary: 'One change' }],
        };
      },
    });
    const runtime = new AgentMonitorRuntime(store, registry, []);
    await runtime.tick(dir, workspace);
    const accepted = store.getMonitorState('held', workspace);
    expect(accepted.notifyState.pendingDebounce?.observations).toHaveLength(1);
    // A foreign route has a distinct count, making an unscoped read observable.
    store.setMonitorState('held', `${workspace}-foreign`, {
      notifyState: {
        pendingDebounce: { dueAt: now.toISOString(), observations: [] },
      },
    });
    store.setMonitorState('foreign-only', `${workspace}-foreign`, accepted);
    if (rejection === 'missing') {
      renameSync(file, path.join(workspace, 'saved.md'));
    }
    if (rejection === 'parse') {
      writeFileSync(file, '---\nwatch: [\n---\n');
    }
    if (rejection === 'duplicate') {
      const duplicate = path.join(dir, 'nested/held/MONITOR.md');
      mkdirSync(path.dirname(duplicate), { recursive: true });
      writeFileSync(duplicate, definition);
    }
    if (rejection === 'source') {
      writeFileSync(file, definition.replace('test-held', 'unknown-held'));
    }
    if (rejection === 'scope') {
      writeFileSync(file, definition.replace('required: yes', 'required: []'));
    }
    const input = { monitorsDir: dir, workspacePath: workspace, now };
    const explain = await runtime.explainMonitor({
      ...input,
      monitorId: 'held',
    });
    expect(explain.verdict).toMatchObject({
      stage: 'definition',
      status: 'failure',
    });
    expect(explain.stages.find((stage) => stage.id === 'notify')).toMatchObject(
      {
        status: 'pending',
        details: {
          strategy: 'debounce',
          observations: 1,
          blockedByDefinition: true,
          releaseBarrier:
            rejection === 'source'
              ? 'source-unavailable'
              : 'definition-rejected',
        },
      },
    );
    const doctor = await runtime.doctorReport(input);
    expect(doctor.heldNotifyWork).toEqual([
      expect.objectContaining({
        monitorId: 'held',
        strategy: 'debounce',
        observations: 1,
        blockedByDefinition: true,
      }),
    ]);
    expect(store.getMonitorState('held', workspace)).toEqual(accepted);
  });
}

/** Live admission can make a separately scanned same-id definition ambiguous. */
for (const method of ['doctorReport', 'explainMonitor'] as const) {
  it(`preserves ${method} across admitted-path ambiguity`, async () => {
    const workspace = path.join(process.env.HOME ?? '', 'ambiguity');
    const admittedDir = path.join(workspace, 'admitted');
    const candidateDir = path.join(workspace, 'candidate');
    for (const dir of [admittedDir, candidateDir]) {
      mkdirSync(path.join(dir, 'held'), { recursive: true });
      writeFileSync(
        path.join(dir, 'held/MONITOR.md'),
        `---
name: Held
watch:
  type: test-held
urgency: normal
notify:
  strategy: debounce
  settle-for: 1h
---
Inspect.
`,
      );
    }
    const db = createDb(':memory:');
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register({
      name: 'test-held',
      scopeSchema: { type: 'object' },
      async observe() {
        return { observations: [] };
      },
      async *watch(_config, { signal }) {
        yield { observations: [{ title: 'Accepted' }] };
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
        }
      },
    });
    const runtime = new AgentMonitorRuntime(store, registry, []);
    const errors: Error[] = [];
    const handle = await runtime.watchMonitors(admittedDir, workspace, {
      onError: (_id, error) => errors.push(error),
    });
    try {
      for (
        let i = 0;
        i < 100 &&
        !store.getMonitorState('held', workspace).notifyState.pendingDebounce;
        i++
      ) {
        await setImmediate();
      }
      const accepted = store.getMonitorState('held', workspace);
      expect(accepted.notifyState.pendingDebounce?.observations).toHaveLength(
        1,
      );
      // Discovery in either tree is unique; only the live admitted path makes
      // the candidate ambiguous. Reporting must not consume or repair its hold.
      for (const dir of [admittedDir, candidateDir]) {
        const before = db.$client.serialize();
        const report = await runtime[method]({
          monitorsDir: dir,
          workspacePath: workspace,
          monitorId: 'held',
        });
        const hold =
          'stages' in report
            ? report.stages.find((stage) => stage.id === 'notify')?.details
            : report.heldNotifyWork?.[0];
        expect(hold).toMatchObject({
          monitorId: 'held',
          observations: 1,
          strategy: 'debounce',
          releaseBarrier: dir === candidateDir ? 'definition-rejected' : 'none',
          blockedByDefinition: dir === candidateDir,
        });
        expect(
          'stages' in report ? report.stages.length : report.monitors.length,
        ).toBeGreaterThan(0);
        expect(db.$client.serialize()).toEqual(before);
      }
      // Diagnosis handles the barrier, while tick keeps its existing refusal.
      await expect(runtime.tick(candidateDir, workspace)).rejects.toThrow(
        'Duplicate monitor ids',
      );
      expect(store.getMonitorState('held', workspace)).toEqual(accepted);
      expect(errors).toEqual([]);
    } finally {
      await handle.stop();
      db.$client.close();
    }
  });
}

it('ignores empty batches and throttle suppression because neither contains accepted work', () => {
  expect(
    describeHeldNotifyWork(
      'held',
      {
        suppressedUntil: '2099-01-01T00:00:00Z',
        pendingDebounce: { dueAt: now.toISOString(), observations: [] },
        pendingRollup: { observations: [] },
      },
      'none',
      now,
    ),
  ).toEqual([]);
  expect(heldNotifyStage([])).toBeUndefined();
});

it('accounts for both legacy batches using captured pacing rather than a current definition', () => {
  const parsed = parseMonitor(
    `---
name: Captured rollup
watch:
  type: test-held
urgency: normal
notify:
  strategy: rollup
  window: '0 9 * * 1-5'
  timezone: America/Los_Angeles
---
Inspect the change.
`,
    '/workspace/held/MONITOR.md',
  );
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const envelope = {
    monitor: parsed.monitor,
    observation: { title: 'Accepted change', summary: 'One change' },
    observedAt: now,
    effectiveUrgency: 'normal' as const,
  };
  const holds = describeHeldNotifyWork(
    'held',
    {
      pendingDebounce: { dueAt: now.toISOString(), observations: [envelope] },
      pendingRollup: { observations: [envelope, envelope] },
    },
    'definition-rejected',
    now,
  );
  expect(holds).toMatchObject([
    {
      strategy: 'debounce',
      observations: 1,
      dueAt: now.toISOString(),
      overdue: true,
    },
    {
      strategy: 'rollup',
      observations: 2,
      window: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
    },
  ]);
  expect(heldNotifyStage(holds)).toMatchObject({
    status: 'pending',
    details: { observations: 3, holds },
  });
  // A rejected definition must not promise that an elapsed deadline alone
  // releases work; repair is still required before any runtime flush.
  expect(holds[0]?.reason).toContain('Fix the definition');
  expect(holds[0]?.reason).not.toContain(
    'will be flushed on the next daemon tick',
  );
});

it('does not prescribe definition repair for a live ephemeral monitor that has no file by design', async () => {
  const workspace = path.join(process.env.HOME ?? '', 'workspace');
  const dir = path.join(workspace, 'monitors');
  mkdirSync(dir, { recursive: true });
  const store = new RuntimeStore(createDb(':memory:'));
  const registry = new SourceRegistry();
  registry.register({
    name: 'test-held',
    scopeSchema: { type: 'object', properties: {} },
    async observe() {
      return {
        observations: [{ title: 'Accepted change', summary: 'One change' }],
      };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'held-owner',
      workspacePath: workspace,
    }),
  );
  const monitor = runtime.declareEphemeralMonitor({
    sessionId: session.id,
    source: 'test-held',
    scope: {},
    urgency: 'high',
  });
  await runtime.tick(dir, workspace);
  const input = { monitorsDir: dir, workspacePath: workspace };
  const doctor = await runtime.doctorReport(input);
  expect(doctor.heldNotifyWork).toEqual([
    expect.objectContaining({
      monitorId: monitor.id,
      strategy: 'debounce',
      observations: 1,
      blockedByDefinition: false,
    }),
  ]);
  const explain = await runtime.explainMonitor({
    ...input,
    monitorId: monitor.id,
  });
  expect(
    explain.stages.find((stage) => stage.id === 'notify')?.reason,
  ).not.toContain('Fix the definition');
});

/**
 * Persisted envelopes can predate complete capture. Diagnostics must preserve
 * the batch count even when release correctly refuses its incomplete semantics.
 */
for (const metadata of [
  {},
  { monitor: {} },
  { monitor: null },
  { monitor: { frontmatter: null } },
]) {
  for (const definition of ['valid', 'rejected', 'missing'] as const) {
    for (const method of ['explainMonitor', 'doctorReport'] as const) {
      it(`reports incomplete rollup ${JSON.stringify(metadata)} with ${definition} definition via ${method}`, async () => {
        const workspace = path.join(process.env.HOME ?? '', 'workspace');
        const dir = path.join(workspace, 'monitors');
        const file = path.join(dir, 'held/MONITOR.md');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          definition === 'valid'
            ? `---
name: Held rollup
watch:
  type: test-held
urgency: normal
notify:
  strategy: rollup
  window: '0 9 * * *'
  timezone: America/Los_Angeles
---
Inspect.
`
            : '---\nwatch: [\n---\n',
        );
        const db = createDb(':memory:');
        const store = new RuntimeStore(db);
        const registry = new SourceRegistry();
        registry.register({
          name: 'test-held',
          scopeSchema: { type: 'object', properties: {} },
          async observe() {
            return { observations: [] };
          },
        });
        const runtime = new AgentMonitorRuntime(store, registry, []);
        // Deliberately violate the write-time type to represent legacy persisted
        // data, which the runtime retains rather than discarding on validation.
        const envelope = {
          ...metadata,
          observation: { title: 'Retained' },
          observedAt: now,
        } as unknown as StoredObservationEnvelope;
        store.setMonitorState('held', workspace, {
          notifyState: { pendingRollup: { observations: [envelope] } },
        });
        const before = store.getMonitorState('held', workspace);
        try {
          const input = {
            monitorsDir:
              definition === 'missing' ? path.join(workspace, 'absent') : dir,
            workspacePath: workspace,
            monitorId: 'held',
            now,
          };
          const report = await runtime[method](input);
          const hold =
            'stages' in report
              ? report.stages.find((stage) => stage.id === 'notify')?.details
              : report.heldNotifyWork?.[0];
          expect(hold).toMatchObject({
            monitorId: 'held',
            strategy: 'rollup',
            observations: 1,
            blockedByDefinition: definition !== 'valid',
            releaseBarrier:
              definition === 'valid'
                ? 'capture-invalid'
                : 'definition-rejected',
            window: 'unknown',
            timezone: 'unknown',
          });
          expect(store.getMonitorState('held', workspace)).toEqual(before);
        } finally {
          db.$client.close();
        }
      });
    }
  }
}

/** Create a genuine tick-admitted hold, optionally owned by a global session. */
async function ephemeralHold(global: boolean, databasePath = ':memory:') {
  const workspace = path.join(process.env.HOME ?? '', 'workspace');
  const dir = path.join(workspace, 'monitors');
  mkdirSync(dir, { recursive: true });
  const db = createDb(databasePath);
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  let observed = false;
  registry.register({
    name: 'test-held',
    scopeSchema: { type: 'object', properties: {} },
    async observe() {
      if (observed) {
        return { observations: [] };
      }
      observed = true;
      return {
        observations: [{ title: 'Accepted change', summary: 'One change' }],
      };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'held-owner',
      ...(global ? {} : { workspacePath: workspace }),
    }),
  );
  const monitor = runtime.declareEphemeralMonitor({
    sessionId: session.id,
    source: 'test-held',
    scope: {},
    urgency: 'high',
  });
  await runtime.tick(dir, workspace);
  const state = store.getMonitorState(monitor.id, workspace);
  expect(state.notifyState.pendingDebounce?.observations).toHaveLength(1);
  if (!state.notifyState.pendingDebounce) {
    throw new Error('Missing tick-admitted hold');
  }
  // Make only the timing due; the accepted envelope remains exactly tick-produced.
  store.setMonitorState(monitor.id, workspace, {
    ...state,
    lastObservationAt: new Date('2000-01-01T00:00:00Z'),
    notifyState: {
      ...state.notifyState,
      pendingDebounce: {
        ...state.notifyState.pendingDebounce,
        dueAt: '2000-01-01T00:00:00Z',
      },
    },
  });
  return { db, store, registry, runtime, session, monitor, workspace, dir };
}

it('diagnoses global ephemeral holds as eligible and releases them on a real tick without repair', async () => {
  const { db, store, runtime, monitor, workspace, dir } =
    await ephemeralHold(true);
  try {
    expect(monitor.workspacePath).toBeNull();
    expect(
      store.listActiveEphemeralMonitors(workspace).map((record) => record.id),
    ).toContain(monitor.id);
    const input = {
      monitorsDir: dir,
      workspacePath: workspace,
      monitorId: monitor.id,
    };
    const doctor = await runtime.doctorReport(input);
    const explain = await runtime.explainMonitor(input);
    expect(doctor.heldNotifyWork?.[0]).toMatchObject({
      observations: 1,
      blockedByDefinition: false,
    });
    const notify = explain.stages.find((stage) => stage.id === 'notify');
    expect(notify?.details).toMatchObject({
      observations: 1,
      blockedByDefinition: false,
    });
    expect(notify?.reason).not.toContain('Fix the definition');
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toHaveLength(
      1,
    );
    expect((await runtime.doctorReport(input)).heldNotifyWork).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it('diagnoses retired ephemeral holds as stranded without offering nonexistent definition repair', async () => {
  const { db, store, runtime, session, monitor, workspace, dir } =
    await ephemeralHold(false);
  try {
    runtime.cancelEphemeralMonitor(session.id, monitor.id);
    const before = store.getMonitorState(monitor.id, workspace);
    expect(store.listActiveEphemeralMonitors(workspace)).toEqual([]);
    const input = {
      monitorsDir: dir,
      workspacePath: workspace,
      monitorId: monitor.id,
    };
    const doctor = await runtime.doctorReport(input);
    const explain = await runtime.explainMonitor(input);
    const hold = doctor.heldNotifyWork?.[0];
    expect(hold).toMatchObject({ observations: 1, blockedByDefinition: false });
    expect(hold?.reason).toContain('declaration is retired');
    expect(hold?.reason).toContain('no future tick will release this work');
    expect(hold?.reason).toContain('no definition file to edit');
    expect(hold?.reason).not.toContain('Fix the definition');
    expect(hold?.reason).not.toContain(
      'will be flushed on the next daemon tick',
    );
    expect(explain.stages.find((stage) => stage.id === 'notify')?.reason).toBe(
      hold?.reason,
    );
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getMonitorState(monitor.id, workspace)).toEqual(before);
  } finally {
    db.$client.close();
  }
});

/** Both read-only surfaces must name the same barrier without rewriting accepted work. */
async function expectEphemeralBarrier(
  fixture: Awaited<ReturnType<typeof ephemeralHold>>,
  runtime: AgentMonitorRuntime,
  barrier: string,
  remedy: string,
) {
  const { db, monitor, workspace, dir } = fixture;
  const before = db.$client.serialize();
  const input = {
    monitorsDir: dir,
    workspacePath: workspace,
    monitorId: monitor.id,
  };
  const doctor = await runtime.doctorReport(input);
  const explain = await runtime.explainMonitor(input);
  const hold = doctor.heldNotifyWork?.[0];
  expect(hold?.reason).toContain(remedy);
  expect(hold?.reason).not.toContain('Fix the definition');
  expect(hold?.reason).not.toContain('will be flushed on the next daemon tick');
  expect(hold).toMatchObject({
    observations: 1,
    blockedByDefinition: false,
    releaseBarrier: barrier,
  });
  expect(
    explain.stages.find((stage) => stage.id === 'notify')?.details,
  ).toEqual(hold);
  expect(explain.stages.find((stage) => stage.id === 'notify')?.reason).toBe(
    hold?.reason,
  );
  expect(db.$client.serialize()).toEqual(before);
}

it('diagnoses an already stale owner before the next tick reaps its declaration', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const fixture = await ephemeralHold(false);
  const { db, runtime, store, session, monitor, workspace, dir } = fixture;
  try {
    // Both the last owner activity and declaration precede the full dormancy window.
    vi.setSystemTime(new Date(now.getTime() + 48 * 60 * 60 * 1000));
    expect(store.getSessionById(session.id).status).toBe('active');
    expect(store.getEphemeralMonitorById(monitor.id).status).toBe('active');
    await expectEphemeralBarrier(
      fixture,
      runtime,
      'owner-inactive',
      'owner is inactive',
    );
    const held = store.getMonitorState(monitor.id, workspace).notifyState;
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getEphemeralMonitorById(monitor.id).status).toBe('reaped');
    expect(store.getMonitorState(monitor.id, workspace).notifyState).toEqual(
      held,
    );
  } finally {
    db.$client.close();
    vi.useRealTimers();
  }
});

it('restores a missing ephemeral source registration without editing a definition', async () => {
  const fixture = await ephemeralHold(false);
  const { db, store, registry, monitor, workspace, dir } = fixture;
  const restoredRegistry = new SourceRegistry();
  const reopened = new AgentMonitorRuntime(store, restoredRegistry);
  try {
    await expectEphemeralBarrier(
      fixture,
      reopened,
      'source-unavailable',
      'Restore the source registration',
    );
    const held = store.getMonitorState(monitor.id, workspace).notifyState;
    expect((await reopened.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getMonitorState(monitor.id, workspace).notifyState).toEqual(
      held,
    );
    const source = registry.get('test-held');
    if (!source) {
      throw new Error('Missing fixture source');
    }
    restoredRegistry.register(source);
    expect((await reopened.tick(dir, workspace)).emittedEventIds).toHaveLength(
      1,
    );
    expect(
      (
        await reopened.doctorReport({
          monitorsDir: dir,
          workspacePath: workspace,
        })
      ).heldNotifyWork,
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it('diagnoses a durably inactive owner after an interrupted close and database reopen', async () => {
  const databasePath = path.join(process.env.HOME ?? '', 'interrupted.sqlite');
  const fixture = await ephemeralHold(false, databasePath);
  const { runtime, store, session, monitor, workspace, dir, registry } =
    fixture;
  // A crash can commit owner dormancy before declaration retirement. Reopening
  // must diagnose that durable lifecycle state rather than a file error.
  const reap = vi
    .spyOn(store, 'reapEphemeralMonitorsForSession')
    .mockImplementation(() => {
      throw new Error('Interrupted before declaration reap');
    });
  expect(() => runtime.closeSession(session.id)).toThrow(
    'Interrupted before declaration reap',
  );
  reap.mockRestore();
  fixture.db.$client.close();
  const db = createDb(databasePath);
  const reopenedStore = new RuntimeStore(db);
  const reopened = new AgentMonitorRuntime(reopenedStore, registry);
  try {
    expect(reopenedStore.getSessionById(session.id).status).toBe('dormant');
    expect(reopenedStore.getEphemeralMonitorById(monitor.id).status).toBe(
      'active',
    );
    await expectEphemeralBarrier(
      { ...fixture, db, store: reopenedStore },
      reopened,
      'owner-inactive',
      'owner is inactive',
    );
    const held = reopenedStore.getMonitorState(
      monitor.id,
      workspace,
    ).notifyState;
    expect((await reopened.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(reopenedStore.getEphemeralMonitorById(monitor.id).status).toBe(
      'active',
    );
    expect(
      reopenedStore.getMonitorState(monitor.id, workspace).notifyState,
    ).toEqual(held);
  } finally {
    db.$client.close();
  }
});

it('honors the recent-declaration dormancy exemption in reports and the next tick', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const fixture = await ephemeralHold(false);
  const { db, runtime, store, session, monitor, workspace, dir } = fixture;
  try {
    vi.setSystemTime(new Date(now.getTime() + 31 * 60 * 1000));
    const recent = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'test-held',
      scope: {},
      urgency: 'high',
    });
    // Declaration also touches its owner. Backdate activity independently to
    // model an interrupted activity update, so only the durable declaration
    // exemption can keep this stale owner active. Native SQLite uses seconds.
    db.$client
      .prepare('UPDATE agent_sessions SET last_active_at = ? WHERE id = ?')
      .run(now.getTime() / 1000, session.id);
    const owner = store.getSessionById(session.id);
    expect(owner.status).toBe('active');
    expect(owner.lastActiveAt.getTime()).toBe(now.getTime());
    expect(Date.now() - owner.lastActiveAt.getTime()).toBeGreaterThan(
      30 * 60 * 1000,
    );
    expect(recent.createdAt.getTime()).toBe(Date.now());
    const before = db.$client.serialize();
    const input = {
      monitorsDir: dir,
      workspacePath: workspace,
      monitorId: monitor.id,
    };
    const doctor = await runtime.doctorReport(input);
    const explain = await runtime.explainMonitor(input);
    expect(doctor.heldNotifyWork?.[0]).toMatchObject({
      releaseBarrier: 'none',
      blockedByDefinition: false,
    });
    expect(
      explain.stages.find((stage) => stage.id === 'notify')?.details,
    ).toEqual(doctor.heldNotifyWork?.[0]);
    expect(db.$client.serialize()).toEqual(before);
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toHaveLength(
      1,
    );
    expect(store.getSessionById(session.id).status).toBe('active');
    expect(store.getEphemeralMonitorById(monitor.id).status).toBe('active');
    expect(
      store.getMonitorState(monitor.id, workspace).notifyState.pendingDebounce,
    ).toBeUndefined();
  } finally {
    db.$client.close();
    vi.useRealTimers();
  }
});

it('names source schema rejection as an invalid declaration instead of an editable file', async () => {
  const fixture = await ephemeralHold(false);
  const { db, store, monitor, workspace, dir } = fixture;
  const registry = new SourceRegistry();
  registry.register({
    name: 'test-held',
    scopeSchema: { type: 'object', required: ['required'] },
    async observe() {
      throw new Error('Rejected scope must not observe');
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry);
  try {
    await expectEphemeralBarrier(
      fixture,
      runtime,
      'declaration-invalid',
      'declaration cannot be edited',
    );
    const held = store.getMonitorState(monitor.id, workspace).notifyState;
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getMonitorState(monitor.id, workspace).notifyState).toEqual(
      held,
    );
  } finally {
    db.$client.close();
  }
});

it('keeps a terminal retry ahead of an otherwise eligible held batch', async () => {
  const fixture = await ephemeralHold(false);
  const { db, runtime, store, monitor, workspace, dir } = fixture;
  try {
    const envelope = store.getMonitorState(monitor.id, workspace).notifyState
      .pendingDebounce?.observations[0];
    if (!envelope) {
      throw new Error('Missing accepted envelope');
    }
    const retry = store.enqueueMaterializationRetries(
      [
        {
          monitorId: monitor.id,
          workspacePath: workspace,
          sourceName: 'test-held',
          envelope: { ...envelope, observedAt: new Date(envelope.observedAt) },
          error: 'materialization failed',
        },
      ],
      now,
    )[0];
    if (!retry) {
      throw new Error('Missing retained retry');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      store.markMaterializationRetryFailed(
        retry.id,
        'materialization failed',
        now,
      );
    }
    await expectEphemeralBarrier(
      fixture,
      runtime,
      'retained-work',
      'Earlier retained materialization work must complete first',
    );
    const held = store.getMonitorState(monitor.id, workspace).notifyState;
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getMonitorState(monitor.id, workspace).notifyState).toEqual(
      held,
    );
  } finally {
    db.$client.close();
  }
});

it('reports invalid captured pacing before the next tick refuses reconciliation', async () => {
  const fixture = await ephemeralHold(false);
  const { db, runtime, store, monitor, workspace, dir } = fixture;
  try {
    const state = store.getMonitorState(monitor.id, workspace);
    const batch = state.notifyState.pendingDebounce;
    if (!batch) {
      throw new Error('Missing accepted batch');
    }
    // Legacy data can satisfy the envelope's structural schema while violating
    // its semantic urgency-band invariant; tick checks both before any drain.
    store.setMonitorState(monitor.id, workspace, {
      ...state,
      notifyState: {
        ...state.notifyState,
        pendingDebounce: {
          ...batch,
          observations: batch.observations.map((envelope) => ({
            ...envelope,
            monitor: {
              ...envelope.monitor,
              frontmatter: {
                ...envelope.monitor.frontmatter,
                urgency: 'high',
                urgencyMax: 'low',
              },
            },
          })),
        },
      },
    });
    await expectEphemeralBarrier(
      fixture,
      runtime,
      'capture-invalid',
      'captured semantics',
    );
    const held = store.getMonitorState(monitor.id, workspace).notifyState;
    expect((await runtime.tick(dir, workspace)).emittedEventIds).toEqual([]);
    expect(store.getMonitorState(monitor.id, workspace).notifyState).toEqual(
      held,
    );
  } finally {
    db.$client.close();
  }
});

it('recognizes that a valid pacing edit drains held work before a scheduling error', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const workspace = path.join(process.env.HOME ?? '', 'workspace');
  const dir = path.join(workspace, 'monitors');
  const file = path.join(dir, 'held/MONITOR.md');
  mkdirSync(path.dirname(file), { recursive: true });
  const definition = `---
name: Scheduled hold
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
notify:
  strategy: debounce
  settle-for: 1h
---
Inspect.
`;
  writeFileSync(file, definition);
  const db = createDb(':memory:');
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register({
    name: 'schedule',
    scopeSchema: { type: 'object' },
    async observe() {
      return { observations: [{ title: 'Accepted change' }] };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, []);
  try {
    await runtime.tick(dir, workspace);
    expect(
      store.getMonitorState('held', workspace).notifyState.pendingDebounce
        ?.observations,
    ).toHaveLength(1);
    writeFileSync(
      file,
      definition
        .replace('timezone: UTC', 'timezone: Invalid/Zone')
        .replace('notify:\n  strategy: debounce\n  settle-for: 1h\n', ''),
    );
    const input = {
      monitorsDir: dir,
      workspacePath: workspace,
      monitorId: 'held',
    };
    const doctor = await runtime.doctorReport(input);
    const explain = await runtime.explainMonitor(input);
    const hold = doctor.heldNotifyWork?.[0];
    expect(hold).toMatchObject({
      observations: 1,
      blockedByDefinition: false,
      releaseBarrier: 'none',
    });
    expect(
      explain.stages.find((stage) => stage.id === 'notify')?.details,
    ).toEqual(hold);
    // Notify reconciliation commits the old batch before schedule evaluation.
    const tick = await runtime.tick(dir, workspace);
    expect(tick.emittedEventIds).toHaveLength(1);
    expect(tick.erroredObservations).toHaveLength(1);
    expect((await runtime.doctorReport(input)).heldNotifyWork).toEqual([]);
  } finally {
    db.$client.close();
    vi.useRealTimers();
  }
});
