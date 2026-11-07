/**
 * Retry diagnostics cross the real JSONL socket and built CLI boundaries. The
 * owned static server supplies distinctive metadata, so SQLite fallback cannot
 * accidentally satisfy wire-date, compatibility, privacy, or rendering checks.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MaterializationRetrySummary,
  MonitorDoctorReport,
  MonitorExplainReport,
} from '@agentmonitors/core';
import { createDb, RuntimeStore } from '@agentmonitors/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { doctorReportClient, explainMonitorClient } from './runtime-client.js';
import { writeLocalState } from './local-state.js';

/** Deliberately different times detect swapped/missing revival fields. */
const created = new Date('2026-10-01T01:02:03Z');
const updated = new Date('2026-10-02T04:05:06Z');
const next = new Date('2026-10-03T07:08:09Z');
const unsafeError =
  'legacy\u001b\r\n\t\u007f\u0085\u2028\u2029' + 'x'.repeat(1200);
const safeError = 'legacy' + ' '.repeat(8) + 'x'.repeat(1010);
/** The contract admits these metadata keys, never captured observation data. */
const recordKeys = [
  'attemptCount',
  'createdAt',
  'id',
  'lastError',
  'nextAttemptAt',
  'status',
  'updatedAt',
];
/** Nx completes the package build before this suite consumes the shared bundle. */
const cli = path.resolve(import.meta.dirname, '../dist/index.cjs');
const execute = promisify(execFile);
let root: string;
let socketPath: string;
let requests: { method: string; params: Record<string, unknown> }[];
let server: net.Server | undefined;

beforeEach(() => {
  // A short owned path respects macOS's Unix socket pathname limit.
  root = mkdtempSync('/tmp/am-retry-cli-');
  socketPath = path.join(root, 'daemon.sock');
  requests = [];
  writeLocalState(root, { enabled: true });
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Old daemons may retain unsafe error strings or accidentally include extra fields. */
function summary(prefix: string): MaterializationRetrySummary {
  const privateRecord = {
    envelope: 'PRIVATE-ENVELOPE',
    payload: 'PRIVATE-PAYLOAD',
  };
  return {
    pending: 1,
    terminal: 1,
    bytes: 321,
    records: [
      {
        ...privateRecord,
        id: `${prefix}-pending`,
        status: 'pending',
        attemptCount: 2,
        nextAttemptAt: next,
        createdAt: created,
        updatedAt: updated,
        lastError: unsafeError,
      },
      {
        ...privateRecord,
        id: `${prefix}-terminal`,
        status: 'terminal',
        attemptCount: 5,
        nextAttemptAt: null,
        createdAt: created,
        updatedAt: updated,
        lastError: unsafeError,
      },
    ],
  };
}

/** Reports intentionally have no recipient sessions, so no delivery RPC is needed. */
function reports(): {
  explain: MonitorExplainReport;
  doctor: MonitorDoctorReport;
} {
  return {
    explain: {
      monitorId: 'wire-monitor',
      generatedAt: updated,
      stages: [
        {
          id: 'definition',
          label: 'Definition',
          status: 'failure',
          reason: 'wire definition missing',
        },
      ],
      verdict: {
        stage: 'definition',
        status: 'failure',
        reason: 'wire definition missing',
      },
      observations: [],
      events: [],
      projections: [],
      leadSessions: [],
      materializationRetries: summary('explain'),
    },
    doctor: {
      generatedAt: updated,
      workspacePath: root,
      monitorsDir: path.join(root, 'monitors'),
      monitorsDirExists: true,
      monitors: [
        {
          id: 'wire-monitor',
          displayName: 'Wire',
          sourceName: 'schedule',
          urgency: 'normal',
          valid: true,
          neverObserved: false,
          due: false,
          cadence: 'every 30s',
          delivery: { unread: 0, claimed: 0, acknowledged: 0 },
          materializationRetries: summary('attached'),
        },
      ],
      invalidCount: 0,
      parseErrors: [{ id: 'removed', error: 'wire parse failure' }],
      duplicateIds: [],
      leadSessions: [],
      hasLeadSession: false,
      orphanedMaterializationRetries: [
        { monitorId: 'removed', summary: summary('orphan') },
      ],
    },
  };
}

/** A real owned socket records every requested method and serializes Dates naturally. */
async function serve(fixture: ReturnType<typeof reports>): Promise<void> {
  server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      requests.push(request);
      const result =
        request.method === 'monitor.explain' ? fixture.explain : fixture.doctor;
      socket.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(socketPath, resolve);
  });
}

/** Execute asynchronously so the in-process static socket can answer the CLI. */
async function run(
  command: 'explain' | 'doctor',
  format: 'json' | 'text',
  db = ':memory:',
  id = 'wire-monitor',
): Promise<{ stdout: string; code: number }> {
  const args = command === 'explain' ? ['monitor', 'explain', id] : ['doctor'];
  try {
    const result = await execute(
      process.execPath,
      [
        cli,
        ...args,
        '--dir',
        path.join(root, 'monitors'),
        '--workspace',
        root,
        '--socket',
        socketPath,
        '--format',
        format,
      ],
      {
        cwd: root,
        timeout: 15000,
        env: {
          ...process.env,
          HOME: root,
          XDG_DATA_HOME: path.join(root, 'data'),
          AGENTMONITORS_DB: db,
          AGENTMONITORS_SOCKET: socketPath,
        },
      },
    );
    return { stdout: result.stdout, code: 0 };
  } catch (error) {
    // execFile failures carry output and the process status; retain both so
    // expected doctor health failures do not hide crashes or parse failures.
    if (
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      'code' in error &&
      typeof error.stdout === 'string' &&
      typeof error.code === 'number'
    ) {
      if (error.stdout.length === 0) {
        throw new Error(
          `CLI exited without a diagnostic report: ${'stderr' in error ? String(error.stderr) : String(error)}`,
          { cause: error },
        );
      }
      return { stdout: error.stdout, code: error.code };
    }
    throw error;
  }
}

it('revives every attached and orphan retry date through real socket requests', async () => {
  await serve(reports());
  const input = {
    monitorId: 'wire-monitor',
    monitorsDir: path.join(root, 'monitors'),
    workspacePath: root,
  };
  const explain = await explainMonitorClient(input, socketPath);
  const doctor = await doctorReportClient(input, socketPath);
  for (const value of [
    explain.materializationRetries,
    doctor.monitors[0]?.materializationRetries,
    doctor.orphanedMaterializationRetries?.[0]?.summary,
  ]) {
    expect(value).toBeDefined();
    expect(value?.records).toHaveLength(2);
    for (const record of value?.records ?? []) {
      expect(record.createdAt).toBeInstanceOf(Date);
      expect(record.createdAt.getTime()).toBe(created.getTime());
      expect(record.updatedAt).toBeInstanceOf(Date);
      expect(record.updatedAt.getTime()).toBe(updated.getTime());
      if (record.status === 'pending') {
        expect(record.nextAttemptAt).toBeInstanceOf(Date);
        expect(record.nextAttemptAt?.getTime()).toBe(next.getTime());
      } else expect(record.nextAttemptAt).toBeNull();
    }
  }
  expect(requests.map((r) => r.method)).toEqual([
    'monitor.explain',
    'doctor.report',
  ]);
  expect(requests.every((r) => r.params.workspacePath === root)).toBe(true);
});

it('bounds legacy socket errors and exposes only safe retry metadata', async () => {
  await serve(reports());
  const input = {
    monitorId: 'wire-monitor',
    monitorsDir: root,
    workspacePath: root,
  };
  const explain = await explainMonitorClient(input, socketPath);
  const doctor = await doctorReportClient(input, socketPath);
  for (const value of [
    explain.materializationRetries,
    doctor.monitors[0]?.materializationRetries,
    doctor.orphanedMaterializationRetries?.[0]?.summary,
  ]) {
    for (const record of value?.records ?? []) {
      expect(record.lastError).toBe(safeError);
      expect(Object.keys(record).sort()).toEqual(recordKeys);
    }
  }
  expect(JSON.stringify({ explain, doctor })).not.toContain('PRIVATE');
});

it.each(['json', 'text'] as const)(
  'renders live attached and orphan work safely in %s',
  async (format) => {
    await serve(reports());
    const explain = await run('explain', format);
    const doctor = await run('doctor', format);
    expect(explain.code).toBe(0);
    expect(doctor.code).toBe(1);
    expect(explain.stdout).toContain('explain-pending');
    expect(explain.stdout).toContain('explain-terminal');
    if (format === 'text') {
      for (const output of [explain.stdout, doctor.stdout]) {
        expect(output).toContain('status=pending  attempts=2');
        expect(output).toContain('status=terminal  attempts=5');
        expect(output).toContain(`updated-at=${updated.toISOString()}`);
        const errorLines = output
          .split('\n')
          .filter((line) => line.includes('Last error:'));
        expect(errorLines.length).toBeGreaterThan(0);
        expect(
          errorLines.every((line) => line === `    Last error: ${safeError}`),
        ).toBe(true);
      }
    }
    expect(doctor.stdout).toContain('orphan-pending');
    expect(doctor.stdout).toContain('orphan-terminal');
    expect(doctor.stdout).toContain('wire parse failure');
    for (const output of [explain.stdout, doctor.stdout]) {
      expect(output).not.toContain('PRIVATE');
      expect(output).not.toContain('\u2028');
      expect(output).not.toContain('\u2029');
      expect(output).toContain(safeError);
    }
    if (format === 'json') {
      const value = JSON.parse(doctor.stdout);
      expect(value.orphanedMaterializationRetries[0].monitorId).toBe('removed');
      expect(
        value.orphanedMaterializationRetries[0].summary.records[0],
      ).toMatchObject({
        createdAt: created.toISOString(),
        updatedAt: updated.toISOString(),
        nextAttemptAt: next.toISOString(),
      });
      expect(
        value.orphanedMaterializationRetries[0].summary.records.every(
          (record: { lastError: string }) => record.lastError === safeError,
        ),
      ).toBe(true);
      expect(value.checks).toContainEqual(
        expect.objectContaining({
          name: 'retry-outbox:removed',
          status: 'fail',
        }),
      );
    } else {
      expect(explain.stdout).toContain(`next-at=${next.toISOString()}`);
      expect(doctor.stdout).toContain('retry-outbox=1/1');
      expect(doctor.stdout).toContain('bytes=321');
      expect(doctor.stdout).not.toContain('explicitly re-arm');
    }
    expect(requests.map((r) => r.method)).toEqual([
      'monitor.explain',
      'doctor.report',
    ]);
  },
);

it.each(['all-omitted', 'orphans-omitted'] as const)(
  'supports older daemon fields: %s for both clients and CLI formats',
  async (omission) => {
    const fixture = reports();
    delete fixture.doctor.orphanedMaterializationRetries;
    fixture.doctor.parseErrors = [];
    if (omission === 'all-omitted') {
      delete fixture.explain.materializationRetries;
      delete fixture.doctor.monitors[0]?.materializationRetries;
    }
    await serve(fixture);
    const input = {
      monitorId: 'wire-monitor',
      monitorsDir: root,
      workspacePath: root,
    };
    const explain = await explainMonitorClient(input, socketPath);
    const doctor = await doctorReportClient(input, socketPath);
    expect(doctor.orphanedMaterializationRetries).toBeUndefined();
    if (omission === 'all-omitted')
      expect(explain.materializationRetries).toBeUndefined();
    for (const format of ['text', 'json'] as const) {
      expect((await run('explain', format)).code).toBe(0);
      const result = await run('doctor', format);
      expect(result.code).toBe(omission === 'all-omitted' ? 0 : 1);
      expect(result.stdout).not.toContain('orphan-pending');
      if (format === 'json') {
        const value = JSON.parse(result.stdout);
        expect(value.orphanedMaterializationRetries).toEqual([]);
        if (omission === 'all-omitted')
          expect(value.monitors[0].materializationRetries).toEqual({
            pending: 0,
            terminal: 0,
            bytes: 0,
            records: [],
          });
      }
    }
    expect(requests).toHaveLength(6);
  },
);

it.each([
  'missing',
  'invalid',
  'duplicate',
  'invalid-source',
  'invalid-schedule',
  'valid',
] as const)(
  'keeps local retained work visible exactly once for %s definitions without mutations',
  async (kind) => {
    const monitors = path.join(root, 'monitors');
    const definition =
      '---\nwatch:\n  type: schedule\n  cron: "* * * * *"\n  timezone: UTC\nurgency: normal\n---\nCurrent instruction';
    if (kind !== 'missing') {
      mkdirSync(path.join(monitors, 'retained'), { recursive: true });
      writeFileSync(
        path.join(monitors, 'retained', 'MONITOR.md'),
        kind === 'invalid'
          ? '---\nwatch: [\n---\n'
          : kind === 'invalid-source'
            ? definition.replace('type: schedule', 'type: absent-source')
            : kind === 'invalid-schedule'
              ? definition.replace('timezone: UTC', 'timezone: Not/AZone')
              : definition,
      );
      if (kind === 'duplicate')
        writeFileSync(path.join(monitors, 'retained.md'), definition);
    }
    const dbPath = path.join(root, 'state.db');
    const db = createDb(dbPath);
    // Native access simulates old persisted rows, bypassing current write sanitation.
    const client = (db as unknown as { $client: Database }).$client;
    const store = new RuntimeStore(db);
    try {
      const rows = [root, root, path.join(root, 'other')].map(
        (workspacePath) =>
          store.enqueueMaterializationRetries(
            [
              {
                workspacePath,
                monitorId: 'retained',
                sourceName: 'schedule',
                error: 'initial',
                envelope: {
                  monitor: {
                    id: 'retained',
                    displayName: 'PRIVATE-NAME',
                    filePath: '/PRIVATE/PATH',
                    instructions: 'PRIVATE-INSTRUCTIONS',
                    frontmatter: {
                      watch: { type: 'schedule' },
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
                  observedAt: created,
                  effectiveUrgency: 'normal',
                },
              },
            ],
            created,
          )[0],
      );
      const [pending, terminal, other] = rows;
      expect(pending && terminal && other).toBeTruthy();
      if (!pending || !terminal || !other)
        throw new Error('fixture admission failed');
      for (let attempt = 0; attempt < 5; attempt++)
        store.markMaterializationRetryFailed(terminal.id, 'failed', updated);
      client
        .prepare('UPDATE materialization_retry_outbox SET last_error=?')
        .run(unsafeError);
      // Diagnostics must leave every durable state surface untouched, including
      // private envelopes, observation checkpoints, and recipient work.
      const snapshot = () =>
        Object.fromEntries(
          [
            'materialization_retry_outbox',
            'monitor_events',
            'monitor_snapshots',
            'monitor_state',
            'observation_history',
            'session_event_state',
            'session_object_cursor',
          ].map((table) => [
            table,
            client.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
          ]),
        );
      const before = snapshot();
      for (const format of ['text', 'json'] as const) {
        const explain = await run('explain', format, dbPath, 'retained');
        const doctor = await run('doctor', format, dbPath);
        expect(explain.code).toBe(0);
        expect(doctor.code).toBe(1);
        for (const output of [explain.stdout, doctor.stdout]) {
          expect(output).toContain(pending.id);
          expect(output).toContain(terminal.id);
          expect(output).not.toContain(other.id);
          expect(output).not.toContain('PRIVATE');
          expect(output).toContain(safeError);
          expect(output).not.toContain('no persisted state to show');
        }
        if (format === 'json') {
          const value = JSON.parse(doctor.stdout);
          const summaries = [
            ...value.monitors.flatMap(
              (m: { materializationRetries?: MaterializationRetrySummary }) =>
                m.materializationRetries ? [m.materializationRetries] : [],
            ),
            ...value.orphanedMaterializationRetries.map(
              (g: { summary: MaterializationRetrySummary }) => g.summary,
            ),
          ];
          expect(
            summaries
              .flatMap((s) => s.records.map((r: { id: string }) => r.id))
              .sort(),
          ).toEqual([pending.id, terminal.id].sort());
          const report = JSON.parse(explain.stdout);
          if (kind !== 'valid') expect(report.verdict.status).toBe('failure');
          else expect(report.notice).toContain('No daemon running');
          for (const s of summaries)
            for (const record of s.records)
              expect(Object.keys(record).sort()).toEqual(recordKeys);
        }
        expect(snapshot()).toEqual(before);
        expect(store.listEvents()).toEqual([]);
      }
    } finally {
      client.close();
    }
  },
);
