/**
 * Empty snapshots represent an observed empty object, not absence of observation.
 * Their deletion delta and baseline must survive materialization and late joining
 * recipients (spec: runtime/event-materialization — "Empty snapshot text is a present snapshot"), including transitions back to nonempty content.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('preserves nonempty-to-empty deletion deltas for shared history and a late recipient, then diffs from empty', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-empty-'));
  roots.push(root);
  const monitors = path.join(root, 'monitors');
  mkdirSync(path.join(monitors, 'changes'), { recursive: true });
  writeFileSync(
    path.join(monitors, 'changes', 'MONITOR.md'),
    `---
watch:
  type: snapshots
  interval: 1s
urgency: normal
baseline-strategy: incremental
---
Report content changes.
`,
  );
  let content = 'one';
  const registry = new SourceRegistry();
  registry.register({
    name: 'snapshots',
    scopeSchema: { type: 'object' },
    observe: () =>
      Promise.resolve({
        observations: [
          { title: 'content', objectKey: 'object', snapshotText: content },
        ],
      }),
  });
  const store = new RuntimeStore(createDb(path.join(root, 'state.db')));
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  await runtime.tick(monitors, root);
  const late = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'late',
      workspacePath: root,
    }),
  );
  content = '';
  vi.advanceTimersByTime(1000);
  const deletionTick = await runtime.tick(monitors, root);
  const deletionId = deletionTick.emittedEventIds[0];
  expect(deletionId).toBeDefined();
  const deletion = store.listEvents().find((event) => event.id === deletionId);
  expect(deletion?.snapshotText).toBe('');
  expect(deletion?.diffText).toContain('- 1: one');
  expect(store.latestSnapshot('changes', 'object', root)).toEqual({
    content: '',
  });
  const recipientEvent = store
    .listEvents({ sessionId: late.id })
    .find((event) => event.id === deletionId);
  expect(recipientEvent?.diffText).toContain('- 1: one');
  expect(
    store.getSessionObjectCursor(late.id, 'changes', 'object', root)
      ?.baselineContent,
  ).toBe('one');
  content = 'two';
  vi.advanceTimersByTime(1000);
  const additionTick = await runtime.tick(monitors, root);
  const addition = store
    .listEvents()
    .find((event) => event.id === additionTick.emittedEventIds[0]);
  expect(addition?.diffText).toContain('+ 1: two');
  expect(addition?.diffText).not.toContain('- 1: one');
});
