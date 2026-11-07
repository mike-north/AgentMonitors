/**
 * Retained-work diagnostics remain actionable when definitions disappear or
 * break. Reports are workspace-isolated metadata reads, never recovery actions.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { createDb } from '../inbox/db.js';
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
