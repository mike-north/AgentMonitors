/**
 * Recoverable source errors preserve durable ingress state while held notify
 * work keeps its timing; diagnosis is a read-only view.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Reopen the same on-disk database without extending the public opaque DB API. */
function open(dbPath: string, registry: SourceRegistry) {
  const db = createDb(dbPath);
  const client: unknown = Reflect.get(db, '$client');
  if (!(client instanceof Database))
    throw new Error('Expected owned SQLite connection');
  const store = new RuntimeStore(db);
  return {
    store,
    runtime: new AgentMonitorRuntime(store, registry, []),
    close: () => client.close(),
    auditBytes: () =>
      client
        .prepare(
          'SELECT id, observation_data FROM observation_history ORDER BY id',
        )
        .all(),
  };
}

function fixture(notify = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'source-error-state-'));
  roots.push(root);
  const dir = path.join(root, 'monitors', 'held');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\nname: Held\nwatch:\n  type: controlled\n  interval: 1s\nurgency: normal\n${notify}---\nHandle changes.\n`,
  );
  return {
    root,
    monitorsDir: path.dirname(dir),
    dbPath: path.join(root, 'state.db'),
  };
}

describe('source-error state and diagnosis', () => {
  it.each([
    ['debounce', 'notify:\n  strategy: debounce\n  settle-for: 2s\n'],
    ['rollup', "notify:\n  strategy: rollup\n  window: '* * * * *'\n"],
  ])(
    'flushes %s work on time across source failures and reopen without advancing scheduling',
    async (_kind, notify) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const { root, monitorsDir, dbPath } = fixture(notify);
      let mode: 'baseline' | 'change' | 'fail' | 'recover' = 'baseline';
      const registry = new SourceRegistry();
      const observe = vi.fn(async () => {
        if (mode === 'fail') throw new Error('source unavailable');
        return {
          observations:
            mode === 'change'
              ? [
                  {
                    title: 'Accepted change',
                    objectKey: 'a',
                    snapshotText: 'B',
                  },
                ]
              : [],
          nextState: { ref: mode === 'baseline' ? 'A' : 'B' },
        };
      });
      registry.register({
        name: 'controlled',
        scopeSchema: {},
        stateful: true,
        observe,
      });
      let owned = open(dbPath, registry);
      try {
        await owned.runtime.tick(monitorsDir, root);
        mode = 'change';
        vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
        expect(
          (await owned.runtime.tick(monitorsDir, root)).emittedEventIds,
        ).toEqual([]);
        const held = owned.store.getMonitorState('held', root);
        expect(held.sourceState).toEqual({ ref: 'B' });
        expect(held.notifyState).toHaveProperty(
          _kind === 'debounce' ? 'pendingDebounce' : 'pendingRollup',
        );
        // The debounce deadline and the next rollup window have both passed:
        // the held work flushes although observe rejects (#558). Only the
        // hold changes; the baseline and scheduling time stay as they were.
        mode = 'fail';
        vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
        const failed = await owned.runtime.tick(monitorsDir, root);
        expect(failed.erroredObservations).toEqual([
          { monitorId: 'held', message: 'source unavailable' },
        ]);
        expect(failed.emittedEventIds).toHaveLength(1);
        const flushed = owned.store.getMonitorState('held', root);
        expect(flushed.sourceState).toEqual(held.sourceState);
        expect(flushed.lastObservationAt).toEqual(held.lastObservationAt);
        expect(flushed.notifyState).not.toHaveProperty('pendingDebounce');
        expect(flushed.notifyState).not.toHaveProperty('pendingRollup');
        owned.close();
        owned = open(dbPath, registry);
        expect(owned.store.getMonitorState('held', root)).toEqual(flushed);
        // Current exception policy: even less than one polling interval later,
        // retry (#559). Nothing is held any more, so nothing is re-delivered.
        vi.setSystemTime(new Date('2026-01-01T00:01:00.100Z'));
        const retried = await owned.runtime.tick(monitorsDir, root);
        expect(observe).toHaveBeenCalledTimes(4);
        expect(retried.emittedEventIds).toEqual([]);
        expect(retried.erroredObservations).toEqual([
          { monitorId: 'held', message: 'source unavailable' },
        ]);
        expect(owned.store.getMonitorState('held', root)).toEqual(flushed);
        expect(
          owned.store
            .listObservationHistory({ monitorId: 'held', workspacePath: root })
            .slice(0, 3)
            .map((row) => ({ result: row.result, data: row.observationData })),
        ).toEqual([
          { result: 'errored', data: { error: 'source unavailable' } },
          { result: 'errored', data: { error: 'source unavailable' } },
          { result: 'triggered', data: { observed: 0, emitted: 1 } },
        ]);
        mode = 'recover';
        vi.setSystemTime(new Date('2026-01-01T00:01:00.200Z'));
        expect(
          (await owned.runtime.tick(monitorsDir, root)).emittedEventIds,
        ).toEqual([]);
        expect(owned.store.getMonitorState('held', root).sourceState).toEqual({
          ref: 'B',
        });
      } finally {
        owned.close();
      }
    },
  );

  it.each([
    ['plain failure', 'plain failure'],
    [
      '\u001b[31mfailed\u001b[0m\r\n  again\t\u0000\u007f\u0085',
      'failed again',
    ],
    ['😀'.repeat(512), '😀'.repeat(512)],
    ['😀'.repeat(513), `${'😀'.repeat(509)}...`],
  ])(
    'includes a safe legacy error in explain while preserving history bytes',
    async (raw, displayed) => {
      const { root, monitorsDir, dbPath } = fixture();
      const registry = new SourceRegistry();
      registry.register({
        name: 'controlled',
        scopeSchema: {},
        observe: async () => ({ observations: [] }),
      });
      const owned = open(dbPath, registry);
      try {
        owned.store.recordObservationHistory({
          monitorId: 'held',
          workspacePath: root,
          sourceName: 'controlled',
          result: 'errored',
          observationData: { error: raw },
        });
        const auditBefore = owned.auditBytes();
        const report = await owned.runtime.explainMonitor({
          monitorId: 'held',
          monitorsDir,
          workspacePath: root,
        });
        expect(
          report.stages.find((stage) => stage.id === 'observation'),
        ).toMatchObject({
          status: 'failure',
          reason: `Source observation failed: ${displayed}`,
          details: { error: raw },
        });
        expect(
          owned.store.listObservationHistory({
            monitorId: 'held',
            workspacePath: root,
          })[0]?.observationData,
        ).toEqual({ error: raw });
        expect(owned.auditBytes()).toEqual(auditBefore);
      } finally {
        owned.close();
      }
    },
  );
});
