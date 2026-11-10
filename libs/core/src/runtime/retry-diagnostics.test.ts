/**
 * Retained-work diagnostics remain actionable when definitions disappear or
 * break. Reports are workspace-isolated metadata reads, never recovery actions.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { createDb } from '../inbox/db.js';
import * as monitorScanning from '../parser/scan-monitors.js';
import { SourceRegistry } from '../observation/registry.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type { EnqueueMaterializationRetryInput } from './types.js';

/** Exact seconds make persisted lifecycle timestamps independently predictable. */
const NOW = new Date('2026-10-31T12:00:00Z');
const directories: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The source cannot run during diagnosis; an accidental observation fails loudly. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'retry-diagnostics-'));
  directories.push(root);
  const monitorsDir = path.join(root, 'monitors');
  const db = createDb(':memory:');
  // The branded public DB hides its native client; this test owns its lifetime.
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  cleanups.push(() => client.close());
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  for (const name of ['test-source', 'schedule']) {
    registry.register({
      name,
      scopeSchema: {
        type: 'object',
        properties: { requiredValue: { type: 'string' } },
        required: ['requiredValue'],
      },
      async observe() {
        throw new Error('Diagnostics must never observe');
      },
    });
  }
  return {
    root,
    monitorsDir,
    store,
    client,
    runtime: new AgentMonitorRuntime(store, registry, []),
  };
}

/** Private sentinels must never be copied from captured input into diagnostic output. */
function input(
  workspacePath: string | null,
  monitorId = 'retained',
  error = 'safe error',
): EnqueueMaterializationRetryInput {
  return {
    workspacePath,
    monitorId,
    sourceName: 'test-source',
    error,
    envelope: {
      monitor: {
        id: monitorId,
        displayName: 'PRIVATE-DISPLAY',
        filePath: '/PRIVATE/PATH',
        instructions: 'PRIVATE-INSTRUCTIONS',
        frontmatter: {
          watch: { type: 'test-source' },
          urgency: 'normal',
          urgencyMax: 'normal',
          baselineStrategy: 'incremental',
        },
      },
      observation: {
        title: 'PRIVATE-TITLE',
        payload: { secret: 'PRIVATE-PAYLOAD' },
        snapshotText: 'PRIVATE-SNAPSHOT',
      },
      observedAt: NOW,
      effectiveUrgency: 'normal',
    },
  };
}

/** All transitions use the public store API, keeping test state valid and durable. */
function seed(
  store: RuntimeStore,
  workspace: string | null,
  terminal: boolean,
  id = 'retained',
  error = 'safe error',
) {
  let row = store.enqueueMaterializationRetries(
    [input(workspace, id, error)],
    NOW,
  )[0];
  if (!row) throw new Error('Expected retained observation');
  if (terminal) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      row = store.markMaterializationRetryFailed(
        row.id,
        error,
        new Date(NOW.getTime() + attempt * 1000),
      );
    }
  }
  return row;
}

/** These fixtures reach each distinct definition/scheduling refusal boundary. */
type Definition =
  | 'valid'
  | 'missing'
  | 'parse'
  | 'duplicate'
  | 'unknown'
  | 'scope'
  | 'schedule';
function definition(
  monitorsDir: string,
  kind: Definition,
  id = 'retained',
): void {
  if (kind === 'missing') return;
  const directory = path.join(monitorsDir, id);
  mkdirSync(directory, { recursive: true });
  const source =
    kind === 'unknown'
      ? 'unregistered'
      : kind === 'schedule'
        ? 'schedule'
        : 'test-source';
  const content =
    kind === 'parse'
      ? '---\nwatch: [\n---\n'
      : [
          '---',
          'watch:',
          `  type: ${source}`,
          ...(kind === 'scope' ? [] : ['  requiredValue: supplied']),
          ...(kind === 'schedule'
            ? ['  cron: "* * * * *"', '  timezone: Not/AZone']
            : []),
          'urgency: normal',
          '---',
          'Current instructions.',
        ].join('\n');
  writeFileSync(path.join(directory, 'MONITOR.md'), content);
  if (kind === 'duplicate')
    writeFileSync(path.join(monitorsDir, `${id}.md`), content);
}

describe('retained-work diagnostics', () => {
  for (const kind of [
    'missing',
    'parse',
    'duplicate',
    'unknown',
    'scope',
    'schedule',
  ] as const) {
    for (const terminal of [false, true]) {
      it(`explains ${terminal ? 'terminal' : 'pending'} work despite ${kind} definition`, async () => {
        const { root, monitorsDir, store, runtime } = fixture();
        definition(monitorsDir, kind);
        const row = seed(store, root, terminal);
        const before = store.getMaterializationRetry(row.id);
        const report = await runtime.explainMonitor({
          monitorId: 'retained',
          monitorsDir,
          workspacePath: root,
          now: NOW,
        });
        expect(report.materializationRetries).toEqual({
          pending: terminal ? 0 : 1,
          terminal: terminal ? 1 : 0,
          bytes: row.envelopeBytes,
          records: [
            {
              id: row.id,
              status: row.status,
              attemptCount: row.attemptCount,
              nextAttemptAt: row.nextAttemptAt,
              lastError: row.lastError,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          ],
        });
        expect(report.verdict.status).toBe('failure');
        expect(report.verdict.stage).toBe(
          kind === 'schedule' ? 'observation' : 'definition',
        );
        expect(JSON.stringify(report)).not.toContain('PRIVATE');
        expect(store.getMaterializationRetry(row.id)).toEqual(before);
        expect(store.listEvents()).toEqual([]);
      });
    }
  }

  it('shows missing, unparseable and ambiguous outboxes once without fabricated definitions', async () => {
    const { root, monitorsDir, store, runtime } = fixture();
    for (const kind of [
      'valid',
      'missing',
      'parse',
      'duplicate',
      'scope',
      'schedule',
    ] as const) {
      definition(monitorsDir, kind, kind);
      seed(store, root, true, kind);
    }
    const before = store.listMaterializationRetries({ workspacePath: root });
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });
    expect(
      report.orphanedMaterializationRetries?.map((group) => group.monitorId),
    ).toEqual(['duplicate', 'missing', 'parse']);
    for (const group of report.orphanedMaterializationRetries ?? []) {
      expect(Object.keys(group).sort()).toEqual(['monitorId', 'summary']);
      expect(group.summary.terminal).toBe(1);
    }
    const summaries = [
      ...report.monitors.flatMap((monitor) =>
        monitor.materializationRetries ? [monitor.materializationRetries] : [],
      ),
      ...(report.orphanedMaterializationRetries ?? []).map(
        (group) => group.summary,
      ),
    ];
    const ids = summaries.flatMap((summary) =>
      summary.records.map((row) => row.id),
    );
    expect(ids.sort()).toEqual(before.map((row) => row.id).sort());
    expect(
      report.monitors.some(
        (monitor) => monitor.id === 'missing' || monitor.id === 'parse',
      ),
    ).toBe(false);
    expect(report.parseErrors).toHaveLength(1);
    expect(report.duplicateIds).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    await runtime.doctorReport({ monitorsDir, workspacePath: root, now: NOW });
    expect(store.listMaterializationRetries({ workspacePath: root })).toEqual(
      before,
    );
  });

  for (const kind of ['valid', 'missing'] as const) {
    it(`isolates same-id ${kind} summaries by exact workspace`, async () => {
      const { root, monitorsDir, store, runtime } = fixture();
      definition(monitorsDir, kind);
      const second = path.join(root, 'second');
      const one = seed(store, root, false, 'retained', 'first-workspace');
      const two = seed(
        store,
        second,
        true,
        'retained',
        'second-workspace-longer',
      );
      seed(store, null, true, 'retained', 'NULL-scope');
      for (const [workspace, row] of [
        [root, one],
        [second, two],
      ] as const) {
        const report = await runtime.explainMonitor({
          monitorId: 'retained',
          monitorsDir,
          workspacePath: workspace,
          now: NOW,
        });
        const doctor = await runtime.doctorReport({
          monitorsDir,
          workspacePath: workspace,
          now: NOW,
        });
        const summary =
          kind === 'valid'
            ? doctor.monitors[0]?.materializationRetries
            : doctor.orphanedMaterializationRetries?.[0]?.summary;
        for (const found of [report.materializationRetries, summary]) {
          expect(found).toMatchObject({
            pending: row.status === 'pending' ? 1 : 0,
            terminal: row.status === 'terminal' ? 1 : 0,
            bytes: row.envelopeBytes,
          });
          expect(found?.records.map((record) => record.id)).toEqual([row.id]);
          expect(found?.records[0]?.lastError).toBe(row.lastError);
        }
      }
      const fallback = seed(
        store,
        monitorsDir,
        false,
        'retained',
        'fallback-only',
      );
      const report = await runtime.explainMonitor({
        monitorId: 'retained',
        monitorsDir,
        now: NOW,
      });
      expect(
        report.materializationRetries?.records.map((record) => record.id),
      ).toEqual([fallback.id]);
    });
  }

  it('normalizes legacy failure text at the diagnostic boundary without rewriting it', async () => {
    const { root, monitorsDir, store, client, runtime } = fixture();
    const row = seed(store, root, true);
    const legacyError = `legacy\u001b\u0085\u2028\u2029${'x'.repeat(1100)}`;
    // Simulate a row written by an older version before Unicode controls and
    // length were consistently bounded on every failure-update path.
    client
      .prepare(
        'UPDATE materialization_retry_outbox SET last_error = ? WHERE id = ?',
      )
      .run(legacyError, row.id);
    const expected = `legacy    ${'x'.repeat(1100)}`.slice(0, 1024);
    const explain = await runtime.explainMonitor({
      monitorId: 'retained',
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });
    const doctor = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });
    expect(explain.materializationRetries?.records[0]?.lastError).toBe(
      expected,
    );
    expect(
      doctor.orphanedMaterializationRetries?.[0]?.summary.records[0]?.lastError,
    ).toBe(expected);
    expect(store.getMaterializationRetry(row.id).lastError).toBe(legacyError);
  });

  it('discovers every outbox beyond the per-monitor row bound with no definitions directory', async () => {
    const { root, monitorsDir, store, runtime } = fixture();
    const rows = store.enqueueMaterializationRetries(
      Array.from({ length: 256 }, () => input(root, 'first')),
      NOW,
    );
    const last = seed(store, root, true, 'second');
    const report = await runtime.doctorReport({
      monitorsDir,
      workspacePath: root,
      now: NOW,
    });
    expect(report.monitorsDirExists).toBe(false);
    expect(report.monitors).toEqual([]);
    expect(
      report.orphanedMaterializationRetries?.map((group) => group.monitorId),
    ).toEqual(['first', 'second']);
    expect(
      report.orphanedMaterializationRetries?.[0]?.summary.records.map(
        (row) => row.id,
      ),
    ).toEqual(rows.map((row) => row.id));
    expect(
      report.orphanedMaterializationRetries?.[1]?.summary.records.map(
        (row) => row.id,
      ),
    ).toEqual([last.id]);
  });
});

/**
 * Persisted TEXT is outside the lifecycle type's runtime guarantees. These
 * owned on-disk fixtures model status-only corruption, never supported writes.
 * Spec 002 requires exact route totals and non-mutating metadata diagnostics;
 * the bounded corruption boundary rejects an unsupported status explicitly.
 */
describe('#495 malformed persisted retry status', () => {
  /** Own every connection and directory, including connections opened after reopen. */
  function diskFixture() {
    const directory = mkdtempSync(path.join(tmpdir(), 'retry-status-owned-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'status.sqlite');
    const reopen = () => {
      const db = createDb(databasePath);
      // The public DB brand intentionally hides native SQL; this fixture alone
      // owns the connection used to inject unsupported persisted state.
      const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
      cleanups.push(() => {
        if (client.open) client.close();
      });
      return { client, store: new RuntimeStore(db) };
    };
    return { ...reopen(), reopen };
  }

  /** Include raw envelope/error bytes as well as every durable column. */
  function durableRows(client: BetterSQLiteClient) {
    return client
      .prepare(
        'SELECT *, hex(envelope) AS envelope_hex, hex(last_error) AS error_hex FROM materialization_retry_outbox ORDER BY id',
      )
      .all();
  }

  for (const status of ['records', 'bytes', 'blocked']) {
    it(`rejects persisted ${status} without changing retained rows across reopen`, () => {
      const { client, store, reopen } = diskFixture();
      seed(store, '/workspace', false);
      const damaged = seed(store, '/workspace', true);
      const other = seed(store, '/other', false);
      const global = seed(store, null, true);
      client
        .prepare(
          'UPDATE materialization_retry_outbox SET status = ? WHERE id = ?',
        )
        .run(status, damaged.id);
      const before = durableRows(client);
      console.info(
        'persisted-status durable before',
        JSON.stringify({ status, rows: before }),
      );
      let observed: unknown;
      try {
        observed = store.materializationRetrySummary('retained', '/workspace');
      } catch (error) {
        observed = error instanceof Error ? error.message : String(error);
      }
      // Record actual pre-fix outcomes without turning them into expectations.
      console.info('persisted-status repro', { status, observed });
      expect(durableRows(client)).toEqual(before);
      expect(
        store.materializationRetrySummary('retained', '/other'),
      ).toMatchObject({
        pending: 1,
        terminal: 0,
        bytes: other.envelopeBytes,
        records: [{ id: other.id, status: 'pending' }],
      });
      expect(store.materializationRetrySummary('retained', null)).toMatchObject(
        {
          pending: 0,
          terminal: 1,
          bytes: global.envelopeBytes,
          records: [{ id: global.id, status: 'terminal' }],
        },
      );
      client.close();
      const reopened = reopen();
      expect(durableRows(reopened.client)).toEqual(before);
      try {
        expect(() =>
          reopened.store.materializationRetrySummary('retained', '/workspace'),
        ).toThrow(
          'Cannot summarize materialization retries: unsupported persisted status.',
        );
      } finally {
        // Even a failing rejection assertion must check retained evidence.
        const after = durableRows(reopened.client);
        console.info(
          'persisted-status durable after reopen',
          JSON.stringify({ status, rows: after }),
        );
        expect(after).toEqual(before);
      }
      expect(observed).toBe(
        'Cannot summarize materialization retries: unsupported persisted status.',
      );
    });
  }

  it('keeps pending/terminal totals, exact route isolation, and useful error text', () => {
    const { store, client } = diskFixture();
    const pending = seed(
      store,
      '/workspace',
      false,
      'retained',
      'token=useful\ncontext',
    );
    const terminal = seed(store, '/workspace', true);
    const damaged = seed(store, '/other', false);
    const global = seed(store, null, false);
    const sibling = seed(store, '/workspace', false, 'sibling');
    for (const row of [damaged, global, sibling]) {
      client
        .prepare(
          'UPDATE materialization_retry_outbox SET status = ? WHERE id = ?',
        )
        .run('blocked', row.id);
    }
    const before = durableRows(client);
    const summary = store.materializationRetrySummary('retained', '/workspace');
    expect(summary).toEqual({
      pending: 1,
      terminal: 1,
      bytes: pending.envelopeBytes + terminal.envelopeBytes,
      records: [
        {
          id: pending.id,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: new Date('2026-10-31T12:00:01Z'),
          lastError: 'token=useful context',
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: terminal.id,
          status: 'terminal',
          attemptCount: 5,
          nextAttemptAt: null,
          lastError: 'safe error',
          createdAt: NOW,
          updatedAt: new Date('2026-10-31T12:00:05Z'),
        },
      ],
    });
    expect(durableRows(client)).toEqual(before);
  });
});

/**
 * Spec 002's exact retry summaries must describe retained work committed while
 * the same runtime awaits definition discovery. This tests one event-loop
 * interleaving, not a cross-process or multi-connection snapshot guarantee.
 */
describe('#495 explain scan/admission coherence', () => {
  /** A manually released scheduling boundary preserves real parser results. */
  function barrier() {
    let resolveBarrier: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    return {
      promise,
      release() {
        if (!resolveBarrier) throw new Error('Barrier was not initialized');
        resolveBarrier();
      },
    };
  }

  /** Capture native durable evidence without reconstructing opaque retry data. */
  function rawEvidence(client: BetterSQLiteClient) {
    return {
      retries: client
        .prepare(
          'SELECT *, hex(envelope) AS envelope_hex, hex(last_error) AS error_hex FROM materialization_retry_outbox ORDER BY id',
        )
        .all(),
      states: client.prepare('SELECT * FROM monitor_state ORDER BY id').all(),
      history: client
        .prepare('SELECT * FROM observation_history ORDER BY id')
        .all(),
      events: client.prepare('SELECT * FROM monitor_events ORDER BY id').all(),
    };
  }

  for (const kind of [
    'valid',
    'missing',
    'parse',
    'duplicate',
    'schedule',
  ] as const) {
    for (const interleaved of [false, true]) {
      it(`retains committed suffix metadata with ${kind} definition, ${interleaved ? 'admission during scan' : 'no interleaving'}`, async () => {
        const root = mkdtempSync(
          path.join(tmpdir(), 'explain-admission-owned-'),
        );
        directories.push(root);
        const monitorsDir = path.join(root, 'explained');
        const producerDir = path.join(root, 'producer');
        definition(producerDir, 'valid');
        definition(monitorsDir, kind);
        const db = createDb(path.join(root, 'owned.sqlite'));
        // Only this fixture owns the native connection used for independent
        // persistence evidence; all writes below use supported public APIs.
        const client = (db as unknown as { $client: BetterSQLiteClient })
          .$client;
        cleanups.push(() => client.close());
        const store = new RuntimeStore(db);
        const registry = new SourceRegistry();
        let sourceCalls = 0;
        registry.register({
          name: 'test-source',
          scopeSchema: { type: 'object' },
          async observe() {
            sourceCalls += 1;
            return {
              observations: [
                {
                  objectKey: 'prefix',
                  title: 'Committed prefix',
                  snapshotText: 'prefix',
                },
              ],
              nextState: { opaque: { cursor: 'OPAQUE-SOURCE-STATE' } },
            };
          },
        });
        registry.register({
          name: 'schedule',
          scopeSchema: { type: 'object' },
          async observe() {
            throw new Error('Invalid-schedule diagnosis must not observe');
          },
        });
        const runtime = new AgentMonitorRuntime(store, registry, []);
        const realScan = monitorScanning.scanMonitors;
        const captured = (await realScan(producerDir)).monitors[0]?.monitor;
        if (!captured)
          throw new Error('Expected a real parsed producer definition');
        const entered = barrier();
        const resume = barrier();
        let scanHeld = false;
        let prefixIds: string[] = [];
        let retryId = '';
        let expectedBytes = 0;
        const admit = async () => {
          const tick = await runtime.tick(producerDir, root);
          expect(tick.emittedEventIds).toHaveLength(1);
          expect(tick.erroredObservations).toEqual([]);
          prefixIds = tick.emittedEventIds;
          const row = store.enqueueMaterializationRetries(
            [
              {
                workspacePath: root,
                monitorId: captured.id,
                sourceName: 'test-source',
                error: 'retained suffix',
                envelope: {
                  monitor: captured,
                  observation: {
                    objectKey: 'suffix',
                    title: 'Retained suffix',
                    payload: { opaque: 'PRIVATE-RETRY-PAYLOAD' },
                  },
                  observedAt: NOW,
                  effectiveUrgency: 'normal',
                },
              },
            ],
            NOW,
          )[0];
          if (!row)
            throw new Error('Expected supported durable retry admission');
          retryId = row.id;
          expectedBytes = row.envelopeBytes;
        };
        if (!interleaved) await admit();
        const scanSpy = vi
          .spyOn(monitorScanning, 'scanMonitors')
          .mockImplementationOnce(async (directory) => {
            const parsed = await realScan(directory);
            scanHeld = true;
            entered.release();
            await resume.promise;
            return parsed;
          });
        try {
          const explaining = runtime.explainMonitor({
            monitorId: 'retained',
            monitorsDir,
            workspacePath: root,
            now: NOW,
          });
          await entered.promise;
          expect(scanHeld).toBe(true);
          if (interleaved) await admit();
          expect(sourceCalls).toBe(1);
          const before = rawEvidence(client);
          console.info(
            'explain/admission durable before',
            JSON.stringify({
              kind,
              interleaved,
              retryId,
              prefixIds,
              rows: before,
            }),
          );
          resume.release();
          const report = await explaining;
          const after = rawEvidence(client);
          console.info(
            'explain/admission result',
            JSON.stringify({
              kind,
              interleaved,
              retryId,
              prefixIds,
              report,
              rowsAfter: after,
            }),
          );
          expect(after).toEqual(before);
          expect(sourceCalls).toBe(1);
          expect(JSON.stringify(report)).not.toContain('PRIVATE-RETRY-PAYLOAD');
          expect.soft(report.materializationRetries).toMatchObject({
            pending: 1,
            terminal: 0,
            bytes: expectedBytes,
          });
          expect
            .soft(report.materializationRetries?.records.map((row) => row.id))
            .toEqual([retryId]);
          if (kind === 'valid') {
            expect(report.events.map((event) => event.id)).toEqual(prefixIds);
            expect(report.observations).toHaveLength(1);
            expect
              .soft(
                report.stages.find((stage) => stage.id === 'materialization'),
              )
              .toMatchObject({
                status: 'pending',
                details: { pending: 1, records: [{ id: retryId }] },
              });
          } else {
            expect(report.events).toEqual([]);
            expect(report.verdict).toMatchObject({
              status: 'failure',
              stage: kind === 'schedule' ? 'observation' : 'definition',
            });
          }
        } finally {
          resume.release();
          scanSpy.mockRestore();
        }
      });
    }
  }
});
