/**
 * Source preflight is an execution boundary (002 §2): invalid author config must
 * have no source effects, and pausing it must preserve already captured work.
 * Real registered sources write a marker so rejection cannot pass by merely
 * changing tick accounting while still invoking the source.
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
import type { ObservationSource } from '../observation/types.js';
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

/** The marker records both config and prior baseline at the actual source boundary. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'source-preflight-'));
  roots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(monitorsDir);
  const marker = path.join(root, 'effects');
  const source: ObservationSource = {
    name: 'preflight',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        interval: { type: 'string' },
        timezone: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async observe(config, context) {
      appendFileSync(
        marker,
        `${JSON.stringify({ value: config['value'], previous: context.previousState })}\n`,
      );
      return {
        observations:
          context.previousState === undefined
            ? [
                {
                  title: 'Held change',
                  summary: 'Held change',
                  objectKey: 'object',
                  snapshotText: 'captured',
                },
              ]
            : [],
        nextState: { baseline: 'captured' },
      };
    },
  };
  const open = () => {
    const registry = new SourceRegistry();
    registry.register(source);
    const db = createDb(path.join(root, 'state.db'));
    const store = new RuntimeStore(db);
    return {
      runtime: new AgentMonitorRuntime(store, registry),
      store,
      // InboxDb intentionally hides its driver; only this restart harness needs
      // to close the owned SQLite handle, without adding a production API.
      close: () =>
        (db as unknown as { $client: { close(): void } }).$client.close(),
    };
  };
  const write = (id: string, config: string, notify = '') => {
    const dir = path.join(monitorsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'MONITOR.md'),
      `---\nname: ${id}\nwatch:\n  type: preflight\n${config}\nurgency: normal\n${notify}\n---\nHandle it.\n`,
    );
  };
  return { root, monitorsDir, marker, source, open, write };
}

describe('source config execution preflight', () => {
  it.each([
    ['wrong type', '  value: 42', { value: 42 }],
    [
      'invalid timezone',
      '  value: ok\n  timezone: Not/AZone',
      { value: 'ok', timezone: 'Not/AZone' },
    ],
    ['missing required value', '  interval: 1s', { interval: '1s' }],
    [
      'unknown property',
      '  value: ok\n  extra: true',
      { value: 'ok', extra: true },
    ],
    [
      'friendly collection error',
      '  value: ok\n  change-detection:\n    strategy: hash\n    collection: {}',
      { value: 'ok', 'change-detection': { strategy: 'hash', collection: {} } },
    ],
  ])(
    'skips %s before effects and shares validate diagnostics with explain/doctor',
    async (_label, config, scope) => {
      const f = fixture();
      f.write('aaa-invalid', config);
      const { runtime } = f.open();
      const diagnostic = validateWatchScope(scope, f.source.scopeSchema).join(
        '; ',
      );
      expect(diagnostic).not.toBe('');
      const result = await runtime.tick(f.monitorsDir, f.root);
      expect(existsSync(f.marker)).toBe(false);
      expect(result).toEqual({
        evaluatedMonitors: [],
        emittedEventIds: [],
        erroredObservations: [],
        skippedMonitors: [
          { monitorId: 'aaa-invalid', validationError: diagnostic },
        ],
      });
      const explain = await runtime.explainMonitor({
        monitorId: 'aaa-invalid',
        monitorsDir: f.monitorsDir,
        workspacePath: f.root,
      });
      expect(explain.verdict).toMatchObject({
        stage: 'definition',
        status: 'failure',
      });
      expect(explain.stages[0]?.reason).toBe(
        `Monitor definition is invalid: ${diagnostic}`,
      );
      const doctor = await runtime.doctorReport({
        monitorsDir: f.monitorsDir,
        workspacePath: f.root,
      });
      expect(doctor.monitors[0]).toMatchObject({
        valid: false,
        validationError: diagnostic,
      });
    },
  );

  it('preserves baseline and held notify work while invalid, across restart, and resumes with healthy siblings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const f = fixture();
    const notify = 'notify:\n  strategy: debounce\n  settle-for: 5s';
    f.write('aaa-paused', '  value: ok\n  interval: 1s', notify);
    const first = f.open();
    expect(
      (await first.runtime.tick(f.monitorsDir, f.root)).emittedEventIds,
    ).toEqual([]);
    const captured = first.store.getMonitorState('aaa-paused', f.root);
    expect(captured?.sourceState).toEqual({ baseline: 'captured' });
    expect(captured?.notifyState).toMatchObject({
      pendingDebounce: {
        observations: [
          expect.objectContaining({
            observation: expect.objectContaining({ title: 'Held change' }),
          }),
        ],
      },
    });
    const effects = readFileSync(f.marker, 'utf8');
    f.write('aaa-paused', '  value: 42\n  interval: 1s', notify);
    // Preflight takes precedence over both not-due scheduling and overdue flushes.
    expect(
      (await first.runtime.tick(f.monitorsDir, f.root)).skippedMonitors,
    ).toEqual([
      {
        monitorId: 'aaa-paused',
        validationError: validateWatchScope(
          { value: 42, interval: '1s' },
          f.source.scopeSchema,
        ).join('; '),
      },
    ]);
    expect(first.store.getMonitorState('aaa-paused', f.root)).toEqual(captured);
    first.close();
    vi.advanceTimersByTime(10_000);
    const restarted = f.open();
    f.write('zzz-healthy', '  value: sibling');
    const invalid = await restarted.runtime.tick(f.monitorsDir, f.root);
    expect(invalid.evaluatedMonitors).toEqual(['zzz-healthy']);
    expect(invalid.emittedEventIds).toHaveLength(1);
    expect(restarted.store.getMonitorState('aaa-paused', f.root)).toEqual(
      captured,
    );
    expect(readFileSync(f.marker, 'utf8')).toBe(
      effects + `${JSON.stringify({ value: 'sibling' })}\n`,
    );
    f.write('aaa-paused', '  value: fixed\n  interval: 1s', notify);
    const fixed = await restarted.runtime.tick(f.monitorsDir, f.root);
    expect(fixed.skippedMonitors).toEqual([
      { monitorId: 'zzz-healthy', nextDueAt: new Date('2026-11-05T12:00:40Z') },
    ]);
    expect(fixed.emittedEventIds).toHaveLength(1);
    expect(readFileSync(f.marker, 'utf8')).toContain(
      `${JSON.stringify({ value: 'fixed', previous: { baseline: 'captured' } })}\n`,
    );
    expect(
      restarted.runtime.listEvents({
        workspacePath: f.root,
        monitorId: 'aaa-paused',
      }),
    ).toMatchObject([
      { title: 'aaa-paused', summary: 'Held change', snapshotText: 'captured' },
    ]);
  });

  it('rechecks persisted ephemeral scopes against the currently registered schema before observing', async () => {
    const f = fixture();
    const { runtime } = f.open();
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'preflight-session',
        workspacePath: f.root,
      }),
    );
    const record = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'preflight',
      scope: { value: 'ok' },
      instruction: 'Watch it.',
    });
    // A source upgrade may tighten its contract after a declaration was persisted.
    f.source.scopeSchema['properties'] = { value: { type: 'number' } };
    const restarted = f.open();
    const result = await restarted.runtime.tick(f.monitorsDir, f.root);
    expect(existsSync(f.marker)).toBe(false);
    expect(result.evaluatedMonitors).toEqual([]);
    expect(result.skippedMonitors).toEqual([
      {
        monitorId: record.id,
        validationError: validateWatchScope(
          { value: 'ok' },
          f.source.scopeSchema,
        ).join('; '),
      },
    ]);
  });

  it('rejects invalid continuous watcher startup without effects, leaving a healthy sibling watchable', async () => {
    const f = fixture();
    f.source.watch = async function* (config) {
      appendFileSync(f.marker, String(config['value']));
      yield { title: 'Watch change', summary: 'Watch change' };
    };
    f.write('aaa-invalid', '  value: 42');
    f.write('zzz-healthy', '  value: healthy');
    const errors: string[] = [];
    const { runtime } = f.open();
    const handle = await runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (id, error) => errors.push(`${id}: ${error.message}`),
    });
    await handle.stop();
    expect(handle.monitorIds).toEqual(['zzz-healthy']);
    expect(readFileSync(f.marker, 'utf8')).toBe('healthy');
    expect(errors).toEqual([
      `aaa-invalid: ${validateWatchScope({ value: 42 }, f.source.scopeSchema).join('; ')}`,
    ]);
    f.write('aaa-invalid', '  value: repaired');
    const repaired = await runtime.watchMonitors(f.monitorsDir, f.root);
    await repaired.stop();
    expect(repaired.monitorIds).toContain('aaa-invalid');
    expect(readFileSync(f.marker, 'utf8')).toContain('repaired');
  });
});
