/**
 * Validator failures are per-monitor preflight diagnostics, not authority to
 * observe a source or abort sibling work. Real source effects, SQLite, retained
 * notify work, and cursors make these execution boundaries observable.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { JsonSchema, ObservationSource } from '../observation/types.js';
import { validateWatchScope } from '../schema/validate-scope.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type SchemaKind = 'pattern' | 'frozen' | 'valid';
/** Each caller owns its schema, including its choice to freeze it. */
function schemaFor(kind: SchemaKind): JsonSchema {
  const value = {
    type: 'string',
    ...(kind === 'pattern' ? { pattern: '[' } : {}),
  };
  const properties = { value, interval: { type: 'string' } };
  const required = ['value'];
  const schema = { type: 'object', properties, required };
  if (kind === 'frozen') {
    Object.freeze(value);
    Object.freeze(properties.interval);
    Object.freeze(properties);
    Object.freeze(required);
    Object.freeze(schema);
  }
  return schema;
}

/** Two actual registered sources write separate observation/watch marker files. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'am-validator-boundary-'));
  roots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(monitorsDir);
  const write = (id: string, value: string | number, notify = '') => {
    const dir = path.join(monitorsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'MONITOR.md'),
      `---\nwatch:\n  type: ${id}\n  value: ${JSON.stringify(value)}\n  interval: 1s\nurgency: normal\n${notify}\n---\nHandle it.\n`,
    );
  };
  const marker = (id: string, mode: string) => path.join(root, `${id}-${mode}`);
  const makeSource = (
    name: string,
    scopeSchema: JsonSchema,
  ): ObservationSource => ({
    name,
    scopeSchema,
    async observe(config, context) {
      appendFileSync(
        marker(name, 'observe'),
        `${JSON.stringify(context.previousState)}\n`,
      );
      const value = String(config['value']);
      return {
        observations:
          context.previousState === value
            ? []
            : [
                {
                  title: value,
                  summary: value,
                  objectKey: name,
                  snapshotText: value,
                },
              ],
        nextState: value,
      };
    },
    async *watch(config, context) {
      appendFileSync(marker(name, 'watch'), 'started\n');
      const value = String(config['value']);
      if (context.previousState !== value) {
        yield {
          title: value,
          summary: value,
          objectKey: name,
          snapshotText: value,
        };
      }
    },
  });
  const open = (kind: SchemaKind) => {
    const registry = new SourceRegistry();
    const schema = schemaFor(kind);
    registry.register(makeSource('aaa-source', schema));
    registry.register(makeSource('zzz-source', schemaFor('valid')));
    const db = createDb(path.join(root, 'state.db'));
    const store = new RuntimeStore(db);
    return {
      schema,
      store,
      runtime: new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]),
      // InboxDb hides its driver; only this owned restart harness closes it.
      close: () =>
        (db as unknown as { $client: { close(): void } }).$client.close(),
    };
  };
  return { root, monitorsDir, write, marker, open };
}

const cases: {
  name: string;
  kind: SchemaKind;
  value: string | number;
  accepted: boolean;
}[] = [
  {
    name: 'malformed pattern',
    kind: 'pattern',
    value: 'okay',
    accepted: false,
  },
  {
    name: 'frozen valid schema',
    kind: 'frozen',
    value: 'okay',
    accepted: true,
  },
  { name: 'ordinary invalid scope', kind: 'valid', value: 42, accepted: false },
  {
    name: 'ordinary valid scope',
    kind: 'valid',
    value: 'okay',
    accepted: true,
  },
];

describe('source validator exception isolation', () => {
  it.each(cases)(
    'persistent tick isolates $name and retains healthy sibling execution',
    async ({ kind, value, accepted }) => {
      const f = fixture();
      f.write('aaa-source', value);
      f.write('zzz-source', 'healthy');
      const current = f.open(kind);
      try {
        const tick = await current.runtime.tick(f.monitorsDir, f.root);
        expect(tick.evaluatedMonitors).toEqual(
          accepted ? ['aaa-source', 'zzz-source'] : ['zzz-source'],
        );
        expect(tick.emittedEventIds).toHaveLength(accepted ? 2 : 1);
        expect(existsSync(f.marker('aaa-source', 'observe'))).toBe(accepted);
        expect(existsSync(f.marker('zzz-source', 'observe'))).toBe(true);
        if (!accepted) {
          const diagnostic = tick.skippedMonitors[0]?.validationError;
          expect(diagnostic).toBe(
            validateWatchScope({ value, interval: '1s' }, current.schema).join(
              '; ',
            ),
          );
          if (kind === 'pattern') {
            expect(diagnostic).toMatch(
              /^Source schema validation failed: .*Invalid regular expression/,
            );
          }
          const explain = await current.runtime.explainMonitor({
            monitorId: 'aaa-source',
            monitorsDir: f.monitorsDir,
            workspacePath: f.root,
          });
          expect(explain.stages[0]?.reason).toBe(
            `Monitor definition is invalid: ${diagnostic}`,
          );
          const doctor = await current.runtime.doctorReport({
            monitorsDir: f.monitorsDir,
            workspacePath: f.root,
          });
          expect(
            doctor.monitors.find((monitor) => monitor.id === 'aaa-source'),
          ).toMatchObject({
            valid: false,
            validationError: diagnostic,
            due: false,
          });
          expect(
            doctor.monitors.find((monitor) => monitor.id === 'zzz-source')
              ?.valid,
          ).toBe(true);
        } else {
          expect(tick.skippedMonitors).toEqual([]);
        }
      } finally {
        current.close();
      }
    },
  );

  it.each(cases)(
    'watcher startup isolates $name before source effects or slot reservation',
    async ({ kind, value, accepted }) => {
      const f = fixture();
      f.write('aaa-source', value);
      f.write('zzz-source', 'healthy');
      const current = f.open(kind);
      const errors: { id: string; message: string }[] = [];
      try {
        const handle = await current.runtime.watchMonitors(
          f.monitorsDir,
          f.root,
          {
            onError: (id, error) => errors.push({ id, message: error.message }),
          },
        );
        await handle.stop();
        expect(handle.monitorIds).toEqual(
          accepted ? ['aaa-source', 'zzz-source'] : ['zzz-source'],
        );
        expect(existsSync(f.marker('aaa-source', 'watch'))).toBe(accepted);
        expect(existsSync(f.marker('zzz-source', 'watch'))).toBe(true);
        expect(errors).toEqual(
          accepted
            ? []
            : [
                {
                  id: 'aaa-source',
                  message: validateWatchScope(
                    { value, interval: '1s' },
                    current.schema,
                  ).join('; '),
                },
              ],
        );
      } finally {
        current.close();
      }
    },
  );

  it.each(['tick', 'watch'] as const)(
    'preserves baseline, cursor and overdue held work on %s validation failure, then resumes after schema correction',
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
      const f = fixture();
      f.write('aaa-source', 'baseline');
      f.write('zzz-source', 'healthy baseline');
      let current = f.open('valid');
      try {
        const session = current.runtime.openSession(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: 'validation-owner',
            workspacePath: f.root,
          }),
        );
        const initial = await current.runtime.tick(f.monitorsDir, f.root);
        current.store.markClaimed(
          session.id,
          initial.emittedEventIds,
          'turn-interruptible',
        );
        current.runtime.acknowledgeSession(session.id, initial.emittedEventIds);
        expect(
          JSON.parse(readFileSync(session.hookStatePath, 'utf8'))
            .hasPendingNormal,
        ).toBe(false);
        const cursor = current.store.getSessionObjectCursor(
          session.id,
          'aaa-source',
          'aaa-source',
          f.root,
        );
        expect(cursor?.baselineContent).toBe('baseline');
        f.write(
          'aaa-source',
          'held',
          'notify:\n  strategy: debounce\n  settle-for: 5s',
        );
        vi.advanceTimersByTime(1000);
        await current.runtime.tick(f.monitorsDir, f.root);
        const retained = current.store.getMonitorState('aaa-source', f.root);
        expect(retained.sourceState).toBe('held');
        expect(retained.notifyState.pendingDebounce?.observations).toHaveLength(
          1,
        );
        const history = current.runtime.listObservationHistory({
          monitorId: 'aaa-source',
          workspacePath: f.root,
        });
        const events = current.runtime.listEvents({
          monitorId: 'aaa-source',
          workspacePath: f.root,
        });
        const effects = readFileSync(f.marker('aaa-source', 'observe'), 'utf8');
        current.close();
        current = f.open('pattern');
        vi.advanceTimersByTime(10000);
        f.write('zzz-source', 'healthy progressed');
        if (mode === 'tick') {
          // A pending suppressed deletion models the tick's final sweep. One
          // validator exception must not strand it or skip hook-state refresh.
          const scratchKey = path.join(
            f.root,
            'agentmonitors-verify-aabbccddeeff.md',
          );
          current.runtime.suppressObjectEvents({
            monitorId: 'cleanup',
            objectKey: scratchKey,
            workspacePath: f.root,
            ttlMs: 60000,
          });
          const template = events[0];
          if (!template) {
            throw new Error('Expected a real baseline event');
          }
          current.store.insertEvent({
            ...template,
            monitorId: 'cleanup',
            objectKey: scratchKey,
            createdAt: new Date(),
          });
          expect(
            current.runtime.listEvents({
              workspacePath: f.root,
              objectKey: scratchKey,
            }),
          ).toHaveLength(1);
          const failed = await current.runtime.tick(f.monitorsDir, f.root);
          expect(failed.evaluatedMonitors).toEqual(['zzz-source']);
          expect(failed.emittedEventIds).toHaveLength(1);
          expect(
            current.runtime.listEvents({
              workspacePath: f.root,
              objectKey: scratchKey,
            }),
          ).toEqual([]);
          expect(
            JSON.parse(readFileSync(session.hookStatePath, 'utf8'))
              .hasPendingNormal,
          ).toBe(true);
          expect(failed.skippedMonitors[0]?.validationError).toMatch(
            /^Source schema validation failed:/,
          );
        } else {
          const errors: string[] = [];
          const handle = await current.runtime.watchMonitors(
            f.monitorsDir,
            f.root,
            { onError: (id, error) => errors.push(`${id}: ${error.message}`) },
          );
          await handle.stop();
          expect(handle.monitorIds).toEqual(['zzz-source']);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatch(
            /^aaa-source: Source schema validation failed:/,
          );
          expect(existsSync(f.marker('aaa-source', 'watch'))).toBe(false);
        }
        expect(current.store.getMonitorState('aaa-source', f.root)).toEqual(
          retained,
        );
        expect(
          current.store.getSessionObjectCursor(
            session.id,
            'aaa-source',
            'aaa-source',
            f.root,
          ),
        ).toEqual(cursor);
        expect(
          current.runtime.listObservationHistory({
            monitorId: 'aaa-source',
            workspacePath: f.root,
          }),
        ).toEqual(history);
        expect(
          current.runtime.listEvents({
            monitorId: 'aaa-source',
            workspacePath: f.root,
          }),
        ).toEqual(events);
        expect(readFileSync(f.marker('aaa-source', 'observe'), 'utf8')).toBe(
          effects,
        );
        current.close();
        // Correction is a fresh plugin registration after restart. Frozen valid
        // schemas must resume normally rather than being treated as invalid config.
        current = f.open('frozen');
        if (mode === 'watch') {
          const handle = await current.runtime.watchMonitors(
            f.monitorsDir,
            f.root,
          );
          await handle.stop();
          expect(handle.monitorIds).toContain('aaa-source');
          expect(existsSync(f.marker('aaa-source', 'watch'))).toBe(true);
        }
        const recovered = await current.runtime.tick(f.monitorsDir, f.root);
        expect(
          recovered.skippedMonitors.filter(
            (entry) => entry.monitorId === 'aaa-source',
          ),
        ).toEqual([]);
        expect(recovered.evaluatedMonitors).toContain('aaa-source');
        expect(
          current.runtime
            .listEvents({ monitorId: 'aaa-source', workspacePath: f.root })
            .some((event) => event.snapshotText === 'held'),
        ).toBe(true);
        expect(
          current.store.getMonitorState('aaa-source', f.root).notifyState
            .pendingDebounce,
        ).toBeUndefined();
      } finally {
        current.close();
      }
    },
  );
});
