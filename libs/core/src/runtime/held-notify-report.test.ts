/**
 * Held-work diagnosis follows workspace routes, independently of definition
 * discovery. Rejected files must preserve accepted envelopes byte-for-byte;
 * neither diagnostics nor same-id work in another workspace can consume them.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
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

it('ignores empty batches and throttle suppression because neither contains accepted work', () => {
  expect(
    describeHeldNotifyWork(
      'held',
      {
        suppressedUntil: '2099-01-01T00:00:00Z',
        pendingDebounce: { dueAt: now.toISOString(), observations: [] },
        pendingRollup: { observations: [] },
      },
      false,
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
    true,
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
async function ephemeralHold(global: boolean) {
  const workspace = path.join(process.env.HOME ?? '', 'workspace');
  const dir = path.join(workspace, 'monitors');
  mkdirSync(dir, { recursive: true });
  const db = createDb(':memory:');
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
  return { db, store, runtime, session, monitor, workspace, dir };
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
