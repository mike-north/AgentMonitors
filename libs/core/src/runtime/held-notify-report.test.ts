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
