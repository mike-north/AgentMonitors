/**
 * Retry diagnostics cross the real JSONL socket and built CLI boundaries. The
 * owned static server supplies distinctive metadata, so SQLite fallback cannot
 * accidentally satisfy wire-date, compatibility, privacy, or rendering checks.
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MaterializationRetrySummary,
  MonitorDoctorReport,
  MonitorExplainReport,
} from '@agentmonitors/core';
import {
  AgentMonitorRuntime,
  claudeCodeAdapter,
  createDb,
  RuntimeStore,
  SourceRegistry,
} from '@agentmonitors/core';
import type { Database } from 'better-sqlite3';
import fileFingerprintSource from '@agentmonitors/source-file-fingerprint';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeUnretainedObservationLoss } from './retry-diagnostics.js';
import { doctorReportClient, explainMonitorClient } from './runtime-client.js';
import { writeLocalState } from './local-state.js';
import { decodeToon } from './toon-format.js';

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
      orphanedMonitorWork: [
        {
          monitorId: 'removed',
          monitorKind: 'persistent',
          materializationRetries: summary('orphan'),
        },
      ],
      ephemeralMonitorWork: [
        {
          monitorId: 'ephemeral:session-1/01K0000000000000000000000',
          sessionId: 'session-1',
          materializationRetries: summary('ephemeral'),
        },
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
  format: 'json' | 'toon' | 'text',
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

/**
 * Valid definitions expose retained work twice: at report level and directly in
 * materialization details. Ordinary details may also contain payload/records
 * keys; only the recognized materialization retry summary has a projection contract.
 */
function materializationReports(
  status: 'pending' | 'terminal',
): ReturnType<typeof reports> {
  const fixture = reports();
  const retained = summary('stage');
  retained.pending = status === 'pending' ? 1 : 0;
  retained.terminal = status === 'terminal' ? 1 : 0;
  retained.records = retained.records.filter(
    (record) => record.status === status,
  );
  const reason =
    status === 'pending'
      ? '1 observation(s) are durably queued for materialization retry.'
      : '1 observation(s) exhausted automatic materialization retries and require operator repair.';
  fixture.explain.materializationRetries = retained;
  fixture.explain.stages = [
    {
      id: 'definition',
      label: 'Definition',
      status: 'ok',
      reason: 'Definition parsed.',
      details: {
        payload: 'ORDINARY-DEFINITION',
        records: ['definition-record'],
      },
    },
    {
      id: 'observation',
      label: 'Observation',
      status: 'ok',
      reason: 'Observation recorded.',
      details: {
        pending: 1,
        terminal: 0,
        bytes: 7,
        records: [],
        payload: 'ORDINARY-OBSERVATION',
      },
    },
    {
      id: 'materialization',
      label: 'Materialization',
      status: status === 'pending' ? 'pending' : 'failure',
      reason,
      details: { ...retained },
    },
  ];
  fixture.explain.verdict = {
    stage: 'materialization',
    status: status === 'pending' ? 'pending' : 'failure',
    reason,
  };
  return fixture;
}

/** Expected metadata is handwritten from 002's safe fields and fixed retry fixture values. */
function expectedStageSummary(
  status: 'pending' | 'terminal',
  serialized: boolean,
) {
  return {
    pending: status === 'pending' ? 1 : 0,
    terminal: status === 'terminal' ? 1 : 0,
    bytes: 321,
    records: [
      {
        id: `stage-${status}`,
        status,
        attemptCount: status === 'pending' ? 2 : 5,
        createdAt: serialized ? created.toISOString() : created,
        updatedAt: serialized ? updated.toISOString() : updated,
        nextAttemptAt:
          status === 'pending'
            ? serialized
              ? next.toISOString()
              : next
            : null,
        lastError: safeError,
      },
    ],
  };
}

it.each(['pending', 'terminal'] as const)(
  'normalizes both %s retry copies and revives nested Dates over the real socket',
  async (status) => {
    const fixture = materializationReports(status);
    await serve(fixture);
    const report = await explainMonitorClient(
      {
        monitorId: 'wire-monitor',
        monitorsDir: root,
        workspacePath: root,
      },
      socketPath,
    );
    const stage = report.stages.find((value) => value.id === 'materialization');
    expect(report.materializationRetries).toEqual(
      expectedStageSummary(status, false),
    );
    expect(stage?.details).toEqual(expectedStageSummary(status, false));
    // Serialized ISO equality cannot establish the client-object Date contract.
    expect(stage?.details?.records).toEqual([
      expect.objectContaining({
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        nextAttemptAt: status === 'pending' ? expect.any(Date) : null,
      }),
    ]);
    expect(report.stages.slice(0, 2)).toEqual(
      fixture.explain.stages.slice(0, 2),
    );
    expect(stage).toMatchObject({
      id: 'materialization',
      label: 'Materialization',
      status: fixture.explain.stages[2]?.status,
      reason: fixture.explain.stages[2]?.reason,
    });
    expect(report.verdict).toEqual(fixture.explain.verdict);
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
    ]);
  },
);

it.each([
  ['pending', 'json'],
  ['pending', 'toon'],
  ['pending', 'text'],
  ['terminal', 'json'],
  ['terminal', 'toon'],
  ['terminal', 'text'],
] as const)(
  'renders both %s retry copies safely through the compiled CLI in %s',
  async (status, format) => {
    const fixture = materializationReports(status);
    await serve(fixture);
    const output = await run('explain', format);
    expect(output.code).toBe(0);
    if (format === 'text') {
      const errorLines = output.stdout
        .split('\n')
        .filter((line) => line.includes('Last error:'));
      expect(errorLines).toEqual([`    Last error: ${safeError}`]);
      expect(output.stdout).not.toContain('PRIVATE');
      expect(output.stdout).not.toContain('\u2028');
      expect(output.stdout).not.toContain('\u2029');
    } else {
      // TOON must be decoded: escaping a raw value does not project safe metadata.
      const value =
        format === 'json'
          ? JSON.parse(output.stdout)
          : decodeToon(output.stdout);
      expect(value).toMatchObject({
        materializationRetries: expectedStageSummary(status, true),
        verdict: fixture.explain.verdict,
      });
      expect(value.materializationRetries).toEqual(
        expectedStageSummary(status, true),
      );
      expect(value.stages).toEqual([
        ...fixture.explain.stages.slice(0, 2),
        {
          ...fixture.explain.stages[2],
          details: expectedStageSummary(status, true),
        },
      ]);
    }
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
    ]);
  },
);

it('normalizes recognized nested retries when an older report omits the top-level summary', async () => {
  const fixture = materializationReports('pending');
  delete fixture.explain.materializationRetries;
  await serve(fixture);
  const report = await explainMonitorClient(
    {
      monitorId: 'wire-monitor',
      monitorsDir: root,
      workspacePath: root,
    },
    socketPath,
  );
  expect(report.materializationRetries).toBeUndefined();
  expect(
    report.stages.find((stage) => stage.id === 'materialization')?.details,
  ).toEqual(expectedStageSummary('pending', false));
});

it.each([
  undefined,
  {
    eventIds: ['ordinary-event'],
    payload: 'ORDINARY-MATERIALIZATION',
    records: ['ordinary-record'],
  },
  { pending: 1, terminal: 0, records: [] },
  { pending: 1, terminal: 0, bytes: 7, records: 'ordinary-records' },
])(
  'preserves absent/ordinary materialization details %# with legacy summary omission',
  async (details) => {
    const fixture = materializationReports('pending');
    delete fixture.explain.materializationRetries;
    fixture.explain.stages[2] = {
      id: 'materialization',
      label: 'Materialization',
      status: 'ok',
      reason: 'Existing materialization diagnosis.',
      ...(details === undefined ? {} : { details }),
    };
    await serve(fixture);
    const report = await explainMonitorClient(
      {
        monitorId: 'wire-monitor',
        monitorsDir: root,
        workspacePath: root,
      },
      socketPath,
    );
    expect(report).toEqual({
      ...fixture.explain,
      generatedAt: updated.toISOString(),
    });
    for (const format of ['json', 'toon'] as const) {
      const output = await run('explain', format);
      expect(output.code).toBe(0);
      const value =
        format === 'json'
          ? JSON.parse(output.stdout)
          : decodeToon(output.stdout);
      expect(value).toEqual({
        ...fixture.explain,
        generatedAt: updated.toISOString(),
      });
    }
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
      'monitor.explain',
      'monitor.explain',
    ]);
  },
);

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
    doctor.orphanedMonitorWork?.[0]?.materializationRetries,
    doctor.ephemeralMonitorWork?.[0]?.materializationRetries,
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
    doctor.orphanedMonitorWork?.[0]?.materializationRetries,
    doctor.ephemeralMonitorWork?.[0]?.materializationRetries,
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
    expect(doctor.stdout).toContain('ephemeral-pending');
    expect(doctor.stdout).toContain('wire parse failure');
    for (const output of [explain.stdout, doctor.stdout]) {
      expect(output).not.toContain('PRIVATE');
      expect(output).not.toContain('\u2028');
      expect(output).not.toContain('\u2029');
      expect(output).toContain(safeError);
    }
    if (format === 'json') {
      const value = JSON.parse(doctor.stdout);
      expect(value.orphanedMonitorWork[0].monitorId).toBe('removed');
      expect(
        value.orphanedMonitorWork[0].materializationRetries.records[0],
      ).toMatchObject({
        createdAt: created.toISOString(),
        updatedAt: updated.toISOString(),
        nextAttemptAt: next.toISOString(),
      });
      expect(
        value.orphanedMonitorWork[0].materializationRetries.records.every(
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
    delete fixture.doctor.orphanedMonitorWork;
    delete fixture.doctor.ephemeralMonitorWork;
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
    expect(doctor.orphanedMonitorWork).toBeUndefined();
    expect(doctor.ephemeralMonitorWork).toBeUndefined();
    if (omission === 'all-omitted')
      expect(explain.materializationRetries).toBeUndefined();
    for (const format of ['text', 'json'] as const) {
      expect((await run('explain', format)).code).toBe(0);
      const result = await run('doctor', format);
      expect(result.code).toBe(omission === 'all-omitted' ? 0 : 1);
      expect(result.stdout).not.toContain('orphan-pending');
      if (format === 'json') {
        const value = JSON.parse(result.stdout);
        expect(value.orphanedMonitorWork).toEqual([]);
        expect(value.ephemeralMonitorWork).toEqual([]);
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

/**
 * @see docs/specs/005-cli-reference.md "Retained-work diagnostics (current)":
 * each outbox occurs once, attached to one monitor or in an orphan group.
 * A duplicated id's outbox lives in the orphan group, so neither duplicate row
 * may claim a count (bug: doctor invented `retry-outbox=0/0` for both rows).
 */
it.each(['text', 'json'] as const)(
  'does not invent an empty retry outbox on duplicate-id monitor rows (%s, daemon path)',
  async (format) => {
    const fixture = reports();
    const row = fixture.doctor.monitors[0];
    if (!row) throw new Error('fixture requires a monitor row');
    delete row.materializationRetries;
    row.id = 'dup';
    fixture.doctor.monitors = [row, { ...row }];
    fixture.doctor.duplicateIds = ['dup'];
    fixture.doctor.orphanedMonitorWork = [
      {
        monitorId: 'dup',
        monitorKind: 'persistent',
        materializationRetries: summary('dup-orphan'),
      },
    ];
    await serve(fixture);
    const result = await run('doctor', format);
    expect(result.code).toBe(1);
    if (format === 'json') {
      const value = JSON.parse(result.stdout);
      expect(value.monitors).toHaveLength(2);
      for (const monitor of value.monitors)
        expect(monitor).not.toHaveProperty('materializationRetries');
      expect(value.orphanedMonitorWork[0].monitorId).toBe('dup');
      expect(value.checks).toContainEqual(
        expect.objectContaining({ name: 'retry-outbox:dup', status: 'fail' }),
      );
    } else {
      const rows = result.stdout
        .split('\n')
        .filter((line) => line.includes('monitor:dup'));
      expect(rows).toHaveLength(2);
      for (const line of rows) {
        expect(line).toContain('retry-outbox=orphaned');
        expect(line).not.toContain('retry-outbox=0/0');
      }
      expect(result.stdout).toContain('retry-outbox:dup');
    }
  },
);

/**
 * @see docs/specs/005-cli-reference.md: remediation "names the exact … command".
 * Doctor run for another workspace must suggest an explain that reads that
 * workspace (bug: the bare command read the invoking workspace's record).
 */
it('carries doctor scope flags into retained-work explain remediation', async () => {
  const fixture = reports();
  const otherWorkspace = "/tmp/other ws's";
  fixture.doctor.workspacePath = otherWorkspace;
  fixture.doctor.monitorsDir = path.join(otherWorkspace, 'custom-monitors');
  await serve(fixture);
  const result = await run('doctor', 'text');
  expect(result.code).toBe(1);
  const scoped = `agentmonitors monitor explain wire-monitor --workspace '/tmp/other ws'\\''s' --dir '/tmp/other ws'\\''s/custom-monitors'`;
  expect(result.stdout).toContain(scoped);
  expect(result.stdout).toContain(
    `agentmonitors monitor explain removed --workspace '/tmp/other ws'\\''s'`,
  );
});

/**
 * The child's cwd is the real path (`/private/tmp/…` on macOS), so the
 * "invoking workspace" spelling is the realpath; `root` itself may be a symlink.
 */
it('keeps the explain remediation bare when doctor uses the invoking workspace defaults', async () => {
  const fixture = reports();
  fixture.doctor.workspacePath = realpathSync(root);
  fixture.doctor.monitorsDir = path.resolve(root, '.claude/monitors');
  await serve(fixture);
  const result = await run('doctor', 'text');
  expect(result.stdout).toContain(
    '`agentmonitors monitor explain wire-monitor`',
  );
  expect(result.stdout).not.toContain('monitor explain wire-monitor --');
});

/**
 * Bug (#496 re-review): a symlinked `--workspace` spelling was treated as the
 * invoking workspace, so the remediation was a bare `monitor explain` that
 * read the real-path record instead of the one doctor listed. Retry rows are
 * keyed by the `path.resolve()` spelling, so the link and real paths are
 * distinct workspaces.
 */
it('carries a symlinked --workspace into the explain remediation and the command shows the same records', async () => {
  const real = path.join(root, 'realc');
  const link = path.join(root, 'linkc');
  const monitors = path.join(real, 'monitors');
  mkdirSync(path.join(monitors, 'alpha'), { recursive: true });
  writeFileSync(
    path.join(monitors, 'alpha', 'MONITOR.md'),
    '---\nwatch:\n  type: schedule\n  cron: "* * * * *"\n  timezone: UTC\nurgency: normal\n---\nInstruction',
  );
  symlinkSync(real, link);
  const dbPath = path.join(root, 'state.db');
  const db = createDb(dbPath);
  const store = new RuntimeStore(db);
  const enqueue = (workspacePath: string) => {
    const [row] = store.enqueueMaterializationRetries(
      [
        {
          workspacePath,
          monitorId: 'alpha',
          sourceName: 'schedule',
          error: 'initial',
          envelope: {
            monitor: {
              id: 'alpha',
              displayName: 'alpha',
              filePath: path.join(monitors, 'alpha', 'MONITOR.md'),
              instructions: 'Instruction',
              frontmatter: {
                watch: { type: 'schedule' },
                urgency: 'normal',
                urgencyMax: 'normal',
                baselineStrategy: 'incremental',
              },
            },
            observation: { title: 't', payload: {}, snapshotText: 's' },
            observedAt: created,
            effectiveUrgency: 'normal',
          },
        },
      ],
      created,
    );
    if (!row) throw new Error('fixture admission failed');
    return row;
  };
  const pending = enqueue(link);
  const terminal = enqueue(real);
  for (let attempt = 0; attempt < 5; attempt++)
    store.markMaterializationRetryFailed(terminal.id, 'failed', updated);
  (db as unknown as { $client: Database }).$client.close();

  const env = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: path.join(root, 'data'),
    AGENTMONITORS_DB: dbPath,
    AGENTMONITORS_SOCKET: socketPath,
  };
  const cwd = realpathSync(real);
  const doctor = await execute(
    process.execPath,
    [
      cli,
      'doctor',
      '--dir',
      monitors,
      '--workspace',
      link,
      '--socket',
      socketPath,
      '--format',
      'text',
    ],
    { cwd, env, timeout: 15000 },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  expect(doctor.stdout).toContain(pending.id);
  expect(doctor.stdout).not.toContain(terminal.id);
  const suggested = /`agentmonitors (monitor explain alpha[^`]*)`/.exec(
    doctor.stdout,
  )?.[1];
  expect(suggested).toBeDefined();
  expect(suggested).toContain(`--workspace ${link}`);
  const explain = await execute(
    process.execPath,
    [cli, ...(suggested ?? '').split(' '), '--format', 'text'],
    { cwd, env, timeout: 15000 },
  );
  expect(explain.stdout).toContain(pending.id);
  expect(explain.stdout).not.toContain(terminal.id);
});

/**
 * Bug (#496 re-review): a duplicated id with no retained work printed
 * `retry-outbox=orphaned` (and JSON omitted its summary) although no orphan
 * group exists for that id. The report also carries an orphan group for a
 * different id, so only a per-id check (not "any orphan group exists") passes.
 */
it.each(['text', 'json'] as const)(
  'reports an empty retry outbox for a duplicated id with no orphan group while another id has one (%s)',
  async (format) => {
    const fixture = reports();
    const row = fixture.doctor.monitors[0];
    if (!row) throw new Error('fixture requires a monitor row');
    delete row.materializationRetries;
    row.id = 'dup2';
    fixture.doctor.monitors = [row, { ...row }];
    fixture.doctor.duplicateIds = ['dup2'];
    fixture.doctor.orphanedMonitorWork = [
      {
        monitorId: 'other',
        monitorKind: 'persistent',
        materializationRetries: summary('other-orphan'),
      },
    ];
    await serve(fixture);
    const result = await run('doctor', format);
    if (format === 'json') {
      const value = JSON.parse(result.stdout);
      expect(value.monitors).toHaveLength(2);
      for (const monitor of value.monitors)
        expect(monitor.materializationRetries).toEqual({
          pending: 0,
          terminal: 0,
          bytes: 0,
          records: [],
        });
    } else {
      const rows = result.stdout
        .split('\n')
        .filter((line) => line.includes('monitor:dup2'));
      expect(rows).toHaveLength(2);
      for (const line of rows) {
        expect(line).toContain('retry-outbox=0/0');
        expect(line).not.toContain('orphaned');
      }
      expect(result.stdout).not.toContain('retry-outbox:dup2');
    }
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
            ...value.orphanedMonitorWork.flatMap(
              (g: { materializationRetries?: MaterializationRetrySummary }) =>
                g.materializationRetries ? [g.materializationRetries] : [],
            ),
          ];
          expect(
            summaries
              .flatMap((s) => s.records.map((r: { id: string }) => r.id))
              .sort(),
          ).toEqual([pending.id, terminal.id].sort());
          if (kind === 'duplicate') {
            const dups = value.monitors.filter(
              (m: { id: string }) => m.id === 'retained',
            );
            expect(dups.length).toBeGreaterThan(0);
            for (const m of dups)
              expect(m).not.toHaveProperty('materializationRetries');
          }
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

/**
 * The text contract exposes one useful safe record, not every report copy.
 * These expectations spell out the published field layout and fixed fixture
 * values without using the formatter or captured output as an oracle.
 */
function expectedRetryTextLines(
  status: 'pending' | 'terminal',
  id: string,
): string[] {
  return [
    `  Retry ${id}: status=${status}  attempts=${status === 'pending' ? '2' : '5'}  next-at=${status === 'pending' ? '2026-10-03T07:08:09.000Z' : 'none'}  updated-at=2026-10-02T04:05:06.000Z`,
    `    Last error: ${safeError}`,
  ];
}

it.each([
  ['pending', 'text'],
  ['pending', 'json'],
  ['pending', 'toon'],
  ['terminal', 'text'],
  ['terminal', 'json'],
  ['terminal', 'toon'],
] as const)(
  'preserves nested-only %s record details and top omission in compiled %s',
  async (status, format) => {
    const fixture = materializationReports(status);
    delete fixture.explain.materializationRetries;
    await serve(fixture);
    const output = await run('explain', format);
    expect(output.code).toBe(0);
    if (format === 'text') {
      const recordLines = output.stdout
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('  Retry ') || line.startsWith('    Last error:'),
        );
      expect(recordLines).toEqual(
        expectedRetryTextLines(status, `stage-${status}`),
      );
      expect(output.stdout).toContain(fixture.explain.verdict.reason);
      expect(output.stdout).toContain(
        `Verdict: ${status === 'pending' ? 'pending' : 'failure'} at Materialization - ${fixture.explain.verdict.reason}`,
      );
      expect(output.stdout).not.toContain('PRIVATE');
      expect(output.stdout).not.toContain('\u2028');
      expect(output.stdout).not.toContain('\u2029');
    } else {
      const value =
        format === 'json'
          ? JSON.parse(output.stdout)
          : decodeToon(output.stdout);
      expect(value).not.toHaveProperty('materializationRetries');
      expect(value.stages).toEqual([
        ...fixture.explain.stages.slice(0, 2),
        {
          ...fixture.explain.stages[2],
          details: expectedStageSummary(status, true),
        },
      ]);
      expect(value.verdict).toEqual(fixture.explain.verdict);
    }
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
    ]);
  },
);

it.each(['pending', 'terminal'] as const)(
  'prefers existing top-level %s records and renders them once in text',
  async (status) => {
    const fixture = materializationReports(status);
    const top = fixture.explain.materializationRetries;
    if (top === undefined)
      throw new Error('fixture requires its canonical summary');
    // Distinct IDs make source preference observable independently of deduplication.
    fixture.explain.materializationRetries = {
      ...top,
      records: top.records.map((record) => ({
        ...record,
        id: `preferred-${status}`,
      })),
    };
    await serve(fixture);
    const output = await run('explain', 'text');
    expect(output.code).toBe(0);
    const recordLines = output.stdout
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('  Retry ') || line.startsWith('    Last error:'),
      );
    expect(recordLines).toEqual(
      expectedRetryTextLines(status, `preferred-${status}`),
    );
    expect(output.stdout).not.toContain(`stage-${status}`);
    expect(output.stdout).toContain(fixture.explain.verdict.reason);
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
    ]);
  },
);

it('keeps an explicitly empty top-level summary authoritative over nested text details', async () => {
  const fixture = materializationReports('pending');
  fixture.explain.materializationRetries = {
    pending: 0,
    terminal: 0,
    bytes: 0,
    records: [],
  };
  await serve(fixture);
  const output = await run('explain', 'text');
  expect(output.code).toBe(0);
  expect(output.stdout).not.toContain('  Retry ');
  expect(output.stdout).not.toContain('Last error:');
  expect(output.stdout).not.toContain('stage-pending');
  expect(output.stdout).toContain(fixture.explain.verdict.reason);
  expect(requests.map((request) => request.method)).toEqual([
    'monitor.explain',
  ]);
});

it.each(['absent', 'events', 'partial', 'ordinary'] as const)(
  'does not fabricate text retry records from %s materialization details',
  async (kind) => {
    const fixture = materializationReports('pending');
    delete fixture.explain.materializationRetries;
    const details =
      kind === 'absent'
        ? undefined
        : kind === 'events'
          ? {
              eventIds: ['ordinary-event'],
              payload: 'ORDINARY-MATERIALIZATION',
              records: ['ordinary-record'],
            }
          : kind === 'partial'
            ? { pending: 1, terminal: 0, records: [] }
            : {
                pending: 1,
                terminal: 0,
                bytes: 7,
                records: 'ordinary-records',
              };
    fixture.explain.stages[2] = {
      id: 'materialization',
      label: 'Materialization',
      status: 'ok',
      reason: 'Existing materialization diagnosis.',
      ...(details === undefined ? {} : { details }),
    };
    fixture.explain.verdict = {
      stage: 'materialization',
      status: 'ok',
      reason: 'Existing materialization diagnosis.',
    };
    await serve(fixture);
    const output = await run('explain', 'text');
    expect(output.code).toBe(0);
    expect(output.stdout).not.toContain('  Retry ');
    expect(output.stdout).not.toContain('Last error:');
    expect(output.stdout).not.toContain('stage-pending');
    expect(output.stdout).not.toContain('ordinary-record');
    expect(output.stdout).toContain('Existing materialization diagnosis.');
    expect(output.stdout).toContain(
      'Verdict: ok at Materialization - Existing materialization diagnosis.',
    );
    expect(requests.map((request) => request.method)).toEqual([
      'monitor.explain',
    ]);
  },
);

/**
 * Regression for PR #497 review at 784a468f: a permanently dropped observation
 * (its retry suffix could not be retained) left `doctor` reporting the monitor
 * healthy, because no retry row exists and the span's newer `triggered` row
 * hid the drop. Real ticks against a real store with a native SQLite fault;
 * expected text is written from 005's doctor per-monitor rollup rule.
 */
it('fails the doctor monitor check for a dropped observation until a later event for its object key, in text and JSON', async () => {
  // Native Date instances, not vitest's fake-timer subclass: retry envelopes
  // accept only unmodified Dates, and the fault must be decided on capacity.
  const tickAt = new Date('2026-11-01T12:00:00.000Z');
  let clockTime = tickAt.getTime();
  vi.stubGlobal(
    'Date',
    new Proxy(Date, {
      construct(target, args) {
        return Reflect.construct(
          target,
          args.length === 0 ? [clockTime] : args,
        );
      },
      get(target, key, receiver) {
        return key === 'now'
          ? () => clockTime
          : Reflect.get(target, key, receiver);
      },
    }),
  );
  try {
    const monitors = path.join(root, 'monitors');
    mkdirSync(path.join(monitors, 'dropper'), { recursive: true });
    writeFileSync(
      path.join(monitors, 'dropper', 'MONITOR.md'),
      '---\nwatch:\n  type: schedule\n  cron: "* * * * *"\n  timezone: UTC\nurgency: normal\nbaseline-strategy: incremental\n---\nInspect.\n',
    );
    const dbPath = path.join(root, 'state.db');
    const db = createDb(dbPath);
    // Native access installs the fault; it bypasses no store write path.
    const client = (db as unknown as { $client: Database }).$client;
    const registry = new SourceRegistry();
    let call = 0;
    // Stands in for the bundled `schedule` source so the CLI validates the
    // same definition; it emits 600 distinct observations, then 3 other
    // objects, then the dropped object again.
    registry.register({
      name: 'schedule',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe() {
        const batch = call++;
        const indexes =
          batch === 0
            ? Array.from({ length: 600 }, (_, index) => index)
            : batch === 1
              ? [0, 1, 2]
              : [299];
        return Promise.resolve({
          observations: indexes.map((index) => ({
            title: `b${String(batch)}-${String(index)}`,
            summary: `b${String(batch)}-${String(index)}`,
            objectKey: `object-${String(index)}`,
            snapshotText: `content-${String(batch)}-${String(index)}`,
          })),
          nextState: { batch },
        });
      },
    });
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    // A fault on the 300th observation leaves a 301-record suffix, more than
    // the 256-record outbox holds (002 §2), so it is dropped for good.
    client.exec(`CREATE TRIGGER fault BEFORE INSERT ON monitor_events
      WHEN NEW.summary = 'b0-299'
      BEGIN SELECT RAISE(ABORT, 'native fault on b0-299'); END;`);
    try {
      const first = await runtime.tick(monitors, root);
      expect(first.emittedEventIds).toHaveLength(599);

      const text = await run('doctor', 'text', dbPath);
      expect(text.code).toBe(1);
      const line = text.stdout
        .split('\n')
        .find((candidate) => candidate.startsWith('✗ monitor:dropper: '));
      expect(line).toBeDefined();
      expect(line).toContain(
        `observation dropped, not retained for retry (1 outstanding; newest: observation 300 of 600 (object-299, "b0-299") at ${tickAt.toISOString()}): native fault on b0-299 Not retained for retry: the retry outbox capacity is exhausted`,
      );
      expect(line).toContain('retry-outbox=0/0');
      expect(text.stdout).toContain(
        'A dropped observation cannot be retried. This check clears once a later event of this monitor materializes for each dropped object key; a drop without an object key clears once a later observation span of this monitor materializes an event and drops nothing.',
      );

      // Bug (#496/#497 merge): the drop remediation named a bare
      // `monitor explain` that read the invoking cwd's workspace. Run from
      // another directory, it must carry `--workspace` like the retry ones.
      const elsewhere = path.join(root, 'elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      const scoped = await execute(
        process.execPath,
        [
          cli,
          'doctor',
          '--dir',
          monitors,
          '--workspace',
          root,
          '--socket',
          socketPath,
          '--format',
          'text',
        ],
        {
          cwd: realpathSync(elsewhere),
          timeout: 15000,
          env: {
            ...process.env,
            HOME: root,
            XDG_DATA_HOME: path.join(root, 'data'),
            AGENTMONITORS_DB: dbPath,
            AGENTMONITORS_SOCKET: socketPath,
          },
        },
      ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
      expect(scoped.stdout).toContain(
        `\`agentmonitors monitor explain dropper --workspace ${root}`,
      );

      // Bug (#497 review, finding 4): the history suggestion was bare, so from
      // another directory it read the wrong workspace's rows. It must carry
      // `--workspace`, and running it must show this workspace's drop row.
      const suggestedHistory =
        /`agentmonitors (monitor history dropper[^`]*)`/.exec(
          scoped.stdout,
        )?.[1];
      expect(suggestedHistory).toBe(
        `monitor history dropper --workspace ${root}`,
      );
      const historyEnv = {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: path.join(root, 'data'),
        AGENTMONITORS_DB: dbPath,
        AGENTMONITORS_SOCKET: socketPath,
      };
      const history = await execute(
        process.execPath,
        [cli, ...(suggestedHistory ?? '').split(' '), '--format', 'json'],
        { cwd: realpathSync(elsewhere), timeout: 15000, env: historyEnv },
      );
      expect(history.stdout).toContain(`"workspacePath": "${root}"`);
      expect(history.stdout).toContain('"notRetainedCount": 1');

      const json = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
      expect(json.ok).toBe(false);
      expect(json.monitors[0].unretainedObservationLoss).toEqual({
        count: 1,
        recordedAt: tickAt.toISOString(),
        error: expect.stringMatching(
          /^native fault on b0-299 Not retained for retry: the retry outbox capacity is exhausted/,
        ),
        position: 300,
        spanSize: 600,
        objectKey: 'object-299',
        title: 'b0-299',
      });
      expect(json.checks).toContainEqual(
        expect.objectContaining({ name: 'monitor:dropper', status: 'fail' }),
      );

      // Regression (#497): a later tick that materializes only other objects
      // used to read as clean and clear the check. It must keep failing.
      clockTime += 120_000;
      const second = await runtime.tick(monitors, root);
      expect(second.emittedEventIds).toHaveLength(3);
      const kept = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
      expect(kept.monitors[0].unretainedObservationLoss).toMatchObject({
        count: 1,
        objectKey: 'object-299',
      });
      expect(kept.checks).toContainEqual(
        expect.objectContaining({ name: 'monitor:dropper', status: 'fail' }),
      );

      // A later event for `object-299` supersedes the drop and clears it.
      clockTime += 120_000;
      const third = await runtime.tick(monitors, root);
      expect(third.emittedEventIds).toHaveLength(1);
      const cleared = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
      expect(cleared.monitors[0].unretainedObservationLoss).toBeNull();
      expect(cleared.checks).toContainEqual(
        expect.objectContaining({ name: 'monitor:dropper', status: 'pass' }),
      );
    } finally {
      client.close();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}, 30_000);

/**
 * Bug (#497 review, finding 3): a skewed daemon's loss with a missing or
 * garbage `recordedAt`, or a non-positive-integer `count`, was kept (as an
 * Invalid Date / fractional count) and doctor's `recordedAt.toISOString()`
 * then threw `RangeError`. Such a loss must be treated as absent.
 */
const malformedLosses: [string, Record<string, unknown>][] = [
  ['missing recordedAt', { recordedAt: undefined }],
  ['garbage recordedAt', { recordedAt: 'not-a-date' }],
  ['non-ISO recordedAt object', { recordedAt: { when: 'yesterday' } }],
  ['null recordedAt', { recordedAt: null }],
  ['count 0', { count: 0 }],
  ['count 1.5', { count: 1.5 }],
  ['count -3', { count: -3 }],
  ['string count', { count: '2' }],
];
const validLoss = {
  count: 2,
  recordedAt: '2026-11-01T12:00:00.000Z',
  error: 'native fault',
};

it('keeps a well-formed unretained-observation loss with a revived Date', () => {
  const loss = normalizeUnretainedObservationLoss(
    validLoss as unknown as Parameters<
      typeof normalizeUnretainedObservationLoss
    >[0],
  );
  expect(loss?.count).toBe(2);
  expect(loss?.recordedAt.toISOString()).toBe('2026-11-01T12:00:00.000Z');
});

it.each(malformedLosses)(
  'drops a malformed unretained-observation loss (%s) so doctor renders normally',
  async (_name, override) => {
    const malformed = { ...validLoss, ...override };
    expect(
      normalizeUnretainedObservationLoss(
        malformed as unknown as Parameters<
          typeof normalizeUnretainedObservationLoss
        >[0],
      ),
    ).toBeUndefined();

    const fixture = reports();
    const monitor = fixture.doctor.monitors[0];
    if (!monitor) throw new Error('fixture has a monitor');
    (monitor as unknown as Record<string, unknown>).unretainedObservationLoss =
      malformed;
    await serve(fixture);

    const json = await run('doctor', 'json');
    const parsed = JSON.parse(json.stdout);
    expect(parsed.monitors[0].unretainedObservationLoss).toBeNull();
    const text = await run('doctor', 'text');
    expect(text.stdout).toContain('monitor:wire-monitor');
    expect(text.stdout).not.toContain('observation dropped');
  },
);

/** Commit one real drop of `object-1` (a BigInt payload the outbox cannot hold) for `dropper`. */
async function seedDrop(
  monitors: string,
  dbPath: string,
  source: Parameters<SourceRegistry['register']>[0],
): Promise<void> {
  const db = createDb(dbPath);
  const client = (db as unknown as { $client: Database }).$client;
  try {
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const tick = await runtime.tick(monitors, root);
    expect(tick.erroredObservations).toEqual([
      {
        monitorId: 'dropper',
        message: expect.stringContaining('Not retained for retry'),
      },
    ]);
  } finally {
    client.close();
  }
}

const DROPPER_SCHEDULE =
  '---\nwatch:\n  type: schedule\n  cron: "* * * * *"\n  timezone: UTC\nurgency: normal\nbaseline-strategy: incremental\n---\nInspect.\n';

/**
 * Regression for #497 (definition-less drops): the loss was computed only for
 * scanned monitors, so removing or breaking a definition made an outstanding
 * drop vanish from doctor. It must show in the orphan groups with a failing
 * check, like retained work for a missing definition (005 doctor).
 */
it.each([
  ['removed', (dir: string) => rmSync(dir, { recursive: true })],
  [
    'unparseable',
    (dir: string) =>
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        '---\nwatch: [unterminated\n---\n',
      ),
  ],
  [
    'invalid',
    (dir: string) =>
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        DROPPER_SCHEDULE.replace('type: schedule', 'type: no-such-source'),
      ),
  ],
] as const)(
  'keeps failing doctor for a drop whose definition is %s, in text and JSON',
  async (state, breakDefinition) => {
    const monitors = path.join(root, 'monitors');
    const dir = path.join(monitors, 'dropper');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'MONITOR.md'), DROPPER_SCHEDULE);
    const dbPath = path.join(root, 'state.db');
    await seedDrop(monitors, dbPath, droppingSource);
    breakDefinition(dir);

    const json = await run('doctor', 'json', dbPath);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.ok).toBe(false);
    const loss = {
      count: 1,
      recordedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      error: expect.stringContaining(
        'Not retained for retry: its envelope is not serializable for the retry outbox',
      ),
      position: 2,
      spanSize: 2,
      objectKey: 'object-1',
      title: 'd-1',
    };
    if (state === 'invalid') {
      // A parsed definition keeps its own rollup; its check is a skip, so the
      // loss needs its own failing check.
      expect(report.monitors[0].unretainedObservationLoss).toEqual(loss);
      expect(report.orphanedMonitorWork).toEqual([]);
    } else {
      expect(report.monitors).toEqual([]);
      // Only the loss: no retry summary is invented for an empty outbox.
      expect(report.orphanedMonitorWork).toEqual([
        {
          monitorId: 'dropper',
          monitorKind: 'persistent',
          unretainedObservationLoss: loss,
        },
      ]);
    }
    expect(report.checks).toContainEqual({
      name: 'dropped-observation:dropper',
      status: 'fail',
      detail: expect.stringMatching(
        /^observation dropped, not retained for retry \(1 outstanding; newest: observation 2 of 2 \(object-1, "d-1"\) at /,
      ),
      remediation: expect.stringMatching(
        /^Inspect it with `agentmonitors monitor history dropper[^`]*` and repair the definition or reported failure\. A dropped observation cannot be retried\./,
      ),
    });

    const text = await run('doctor', 'text', dbPath);
    expect(text.code).toBe(1);
    const line = text.stdout
      .split('\n')
      .find((candidate) =>
        candidate.startsWith('✗ dropped-observation:dropper: '),
      );
    expect(line).toContain(
      'observation dropped, not retained for retry (1 outstanding; newest: observation 2 of 2 (object-1, "d-1") at ',
    );
  },
);

/** A schedule-named source whose one span drops `object-1` (a BigInt payload). */
const droppingSource = {
  name: 'schedule',
  scopeSchema: { type: 'object' },
  stateful: true,
  observe: () =>
    Promise.resolve({
      observations: [
        { title: 'd-0', summary: 'd-0', objectKey: 'object-0' },
        {
          title: 'd-1',
          summary: 'd-1',
          objectKey: 'object-1',
          payload: { n: 1n },
        },
      ],
      nextState: { seeded: true },
    }),
} satisfies Parameters<SourceRegistry['register']>[0];

/**
 * Bug (#497): a duplicated id whose orphan group held only a drop
 * printed `retry-outbox=orphaned` on both rows although its outbox is empty.
 * The rollup must say what is orphaned: the drop, not retained work.
 */
it('names the orphaned drop, not an orphaned outbox, on duplicated-id rows with an empty outbox', async () => {
  const monitors = path.join(root, 'monitors');
  const dir = path.join(monitors, 'dropper');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'MONITOR.md'), DROPPER_SCHEDULE);
  const dbPath = path.join(root, 'state.db');
  await seedDrop(monitors, dbPath, droppingSource);
  mkdirSync(path.join(monitors, 'nested', 'dropper'), { recursive: true });
  writeFileSync(
    path.join(monitors, 'nested', 'dropper', 'MONITOR.md'),
    DROPPER_SCHEDULE,
  );

  const text = await run('doctor', 'text', dbPath);
  expect(text.code).toBe(1);
  const rows = text.stdout
    .split('\n')
    .filter((line) => line.includes(' monitor:dropper: '));
  expect(rows).toHaveLength(2);
  for (const line of rows) {
    expect(line).toContain('retry-outbox=0/0');
    expect(line).toContain('dropped-observation=orphaned');
    expect(line).not.toContain('retry-outbox=orphaned');
  }
  expect(text.stdout).not.toContain('retry-outbox:dropper');
  expect(text.stdout).toContain('✗ dropped-observation:dropper: ');

  const json = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
  expect(json.orphanedMonitorWork).toEqual([
    expect.not.objectContaining({ materializationRetries: expect.anything() }),
  ]);
  for (const monitor of json.monitors) {
    expect(monitor.materializationRetries).toEqual({
      pending: 0,
      terminal: 0,
      bytes: 0,
      records: [],
    });
  }
});

/**
 * Seed one drop for a live ephemeral monitor declared by a lead session in
 * `root`, with no MONITOR.md in the monitors directory. Returns the ids
 * needed to cancel it later.
 */
async function seedEphemeralDrop(
  dbPath: string,
): Promise<{ sessionId: string; monitorId: string }> {
  const db = createDb(dbPath);
  const client = (db as unknown as { $client: Database }).$client;
  try {
    const registry = new SourceRegistry();
    // A polling source: a `schedule`-typed declaration would need a cron.
    registry.register({ ...droppingSource, name: 'drop-source' });
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'lead-ephemeral',
        workspacePath: root,
      }),
    );
    const watch = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'drop-source',
      scope: {},
      instruction: 'Watch.',
    });
    const tick = await runtime.tick(path.join(root, 'monitors'), root);
    expect(tick.erroredObservations).toEqual([
      {
        monitorId: watch.id,
        message: expect.stringContaining('Not retained for retry'),
      },
    ]);
    return { sessionId: session.id, monitorId: watch.id };
  } finally {
    client.close();
  }
}

/**
 * Regression for #497: doctor scanned only MONITOR.md definitions,
 * so a live ephemeral monitor's drop showed as an orphaned definition and its
 * check said to "repair the definition", which never existed. Once the watch
 * is cancelled the drop stays visible as an orphan, named for what it is.
 */
it('attributes a live ephemeral drop to its monitor and reports a cancelled one as a retired ephemeral orphan, in text and JSON', async () => {
  mkdirSync(path.join(root, 'monitors'), { recursive: true });
  const dbPath = path.join(root, 'state.db');
  const { sessionId, monitorId } = await seedEphemeralDrop(dbPath);
  const checkName = `dropped-observation:${monitorId}`;

  const live = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
  expect(live.ok).toBe(false);
  expect(live.orphanedMonitorWork).toEqual([]);
  expect(live.ephemeralMonitorWork).toEqual([
    {
      monitorId,
      sessionId,
      unretainedObservationLoss: expect.objectContaining({
        count: 1,
        objectKey: 'object-1',
        title: 'd-1',
      }),
    },
  ]);
  const liveCheck = live.checks.find(
    (check: { name: string }) => check.name === checkName,
  );
  expect(liveCheck).toMatchObject({
    status: 'fail',
    detail: expect.stringMatching(
      new RegExp(
        `^ephemeral monitor of session ${sessionId}; observation dropped, not retained for retry \\(1 outstanding;`,
      ),
    ),
  });
  expect(liveCheck.remediation).toContain(
    'It is an ephemeral monitor declared by that session',
  );
  expect(liveCheck.remediation).toContain(
    'This check clears once a later event of this monitor materializes',
  );
  expect(liveCheck.remediation).not.toContain('repair the definition');
  const liveText = await run('doctor', 'text', dbPath);
  expect(liveText.code).toBe(1);
  expect(liveText.stdout).toContain(
    `✗ ${checkName}: ephemeral monitor of session ${sessionId}; observation dropped`,
  );
  expect(liveText.stdout).not.toContain('repair the definition');

  const db = createDb(dbPath);
  try {
    new AgentMonitorRuntime(new RuntimeStore(db), new SourceRegistry(), [
      claudeCodeAdapter,
    ]).cancelEphemeralMonitor(sessionId, monitorId);
  } finally {
    (db as unknown as { $client: Database }).$client.close();
  }

  const retired = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
  expect(retired.ok).toBe(false);
  expect(retired.ephemeralMonitorWork).toEqual([]);
  expect(retired.orphanedMonitorWork).toEqual([
    {
      monitorId,
      monitorKind: 'ephemeral',
      unretainedObservationLoss: expect.objectContaining({
        count: 1,
        objectKey: 'object-1',
      }),
    },
  ]);
  const retiredCheck = retired.checks.find(
    (check: { name: string }) => check.name === checkName,
  );
  expect(retiredCheck).toMatchObject({
    status: 'fail',
    detail: expect.stringMatching(
      /^retired ephemeral monitor; observation dropped, not retained for retry/,
    ),
    remediation: expect.stringContaining(
      'has since been cancelled or reaped: it never had a MONITOR.md definition, so there is nothing to repair',
    ),
  });
  expect(retiredCheck.remediation).not.toContain('repair the definition');
  expect(retiredCheck.remediation).not.toContain('This check clears');
  const retiredText = await run('doctor', 'text', dbPath);
  expect(retiredText.code).toBe(1);
  expect(retiredText.stdout).toContain(
    `✗ ${checkName}: retired ephemeral monitor; observation dropped`,
  );
  expect(retiredText.stdout).toContain('there is nothing to repair');
}, 30_000);

/**
 * Regression for #497 review: the retained-work remediation of an ephemeral
 * monitor claimed `monitor explain` cannot serve it and pointed at a heading
 * that exists only in text output. `monitor explain <id>` fails its
 * definition stage for an ephemeral id but still lists the retained record
 * IDs, in text and JSON, so the remediation must name it.
 */
it('points ephemeral retained-work remediation at a `monitor explain` that lists the record ids, in text and JSON', async () => {
  mkdirSync(path.join(root, 'monitors'), { recursive: true });
  const dbPath = path.join(root, 'state.db');
  const db = createDb(dbPath);
  const client = (db as unknown as { $client: Database }).$client;
  let monitorId: string;
  try {
    const registry = new SourceRegistry();
    registry.register({
      name: 'retain-source',
      scopeSchema: { type: 'object' },
      stateful: true,
      observe: () =>
        Promise.resolve({
          observations: ['r-0', 'r-1', 'r-2'].map((title, index) => ({
            title,
            summary: title,
            objectKey: `object-${String(index)}`,
          })),
          nextState: { seeded: true },
        }),
    });
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'lead-ephemeral-retained',
        workspacePath: root,
      }),
    );
    const watch = runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'retain-source',
      scope: {},
      instruction: 'Watch.',
    });
    monitorId = watch.id;
    // A native fault on the second observation retains it and its successor.
    client.exec(`CREATE TRIGGER fault BEFORE INSERT ON monitor_events
      WHEN NEW.summary = 'r-1'
      BEGIN SELECT RAISE(ABORT, 'native fault on r-1'); END;`);
    await runtime.tick(path.join(root, 'monitors'), root);
  } finally {
    client.close();
  }

  const checkName = `retry-outbox:${monitorId}`;
  const doctor = JSON.parse((await run('doctor', 'json', dbPath)).stdout);
  const check = doctor.checks.find(
    (candidate: { name: string }) => candidate.name === checkName,
  );
  expect(check.status).toBe('fail');
  expect(check.remediation).toContain(
    `\`agentmonitors monitor explain ${monitorId} --workspace ${root} --dir ${path.join(root, 'monitors')}\``,
  );
  expect(check.remediation).not.toContain('Retry outbox');
  const recordIds: string[] =
    doctor.ephemeralMonitorWork[0].materializationRetries.records.map(
      (record: { id: string }) => record.id,
    );
  expect(recordIds.length).toBeGreaterThan(0);

  // The suggested command (same flags, via the run helper) shows the retained record ids.
  const json = JSON.parse(
    (await run('explain', 'json', dbPath, monitorId)).stdout,
  );
  expect(
    json.materializationRetries.records.map(
      (record: { id: string }) => record.id,
    ),
  ).toEqual(recordIds);
  const text = (await run('explain', 'text', dbPath, monitorId)).stdout;
  for (const id of recordIds) expect(text).toContain(id);
}, 30_000);

/**
 * Regression for #497 through the built CLI and a real `daemon run`: the
 * daemon's next quiet scheduled tick wrote a `no-change` row, which cleared
 * the drop, so doctor and explain served by that daemon read healthy one poll
 * interval after a permanent loss.
 */
it('keeps reporting a drop through a real daemon socket after a quiet scheduled tick', async () => {
  const monitors = path.join(root, 'monitors');
  const dir = path.join(monitors, 'dropper');
  mkdirSync(dir, { recursive: true });
  const watched = path.join(root, 'watched.txt');
  writeFileSync(watched, 'unchanged');
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    [
      '---',
      'watch:',
      '  type: file-fingerprint',
      '  globs:',
      "    - 'watched.txt'",
      `  cwd: ${JSON.stringify(root)}`,
      "  interval: '1s'",
      'urgency: normal',
      '---',
      'Inspect.',
      '',
    ].join('\n'),
  );
  const dbPath = path.join(root, 'state.db');
  // The real source establishes its baseline; one extra observation for
  // `object-lost` carries a payload the retry outbox cannot hold.
  await seedDrop(monitors, dbPath, {
    ...fileFingerprintSource,
    async observe(config, context) {
      const result = await fileFingerprintSource.observe(config, context);
      return {
        ...result,
        observations: [
          ...result.observations,
          {
            title: 'lost',
            summary: 'lost',
            objectKey: 'object-lost',
            payload: { n: 1n },
          },
        ],
      };
    },
  });

  const env = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: path.join(root, 'data'),
    AGENTMONITORS_DB: dbPath,
    AGENTMONITORS_SOCKET: socketPath,
  };
  const daemon = spawn(
    process.execPath,
    [
      cli,
      'daemon',
      'run',
      monitors,
      '--workspace',
      root,
      '--poll-ms',
      '200',
      '--socket',
      socketPath,
      '--reap-after-ms',
      '0',
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk: string) => (output += chunk));
  daemon.stderr.on('data', (chunk: string) => (output += chunk));
  const exited = new Promise<void>((resolve) =>
    daemon.once('exit', () => resolve()),
  );
  try {
    // Wait (bounded) for the daemon's own quiet tick after the drop.
    const reader = createDb(dbPath);
    const readerClient = (reader as unknown as { $client: Database }).$client;
    try {
      const history = new RuntimeStore(reader);
      await vi.waitFor(
        () => {
          if (daemon.exitCode !== null) {
            throw new Error(`daemon exited early: ${output}`);
          }
          const rows = history.listObservationHistory({
            monitorId: 'dropper',
            workspacePath: root,
            limit: 10,
          });
          expect(rows[0]?.result).toBe('no-change');
          expect(
            rows.some(({ observationData }) => observationData['notRetained']),
          ).toBe(true);
          expect(existsSync(socketPath)).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );
    } finally {
      readerClient.close();
    }

    const doctor = await execute(
      process.execPath,
      [
        cli,
        'doctor',
        '--dir',
        monitors,
        '--workspace',
        root,
        '--socket',
        socketPath,
        '--format',
        'json',
      ],
      { cwd: root, timeout: 15000, env },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    const report = JSON.parse(doctor.stdout);
    expect(report.daemon.running).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'daemon-reachable', status: 'pass' }),
    );
    expect(report.monitors[0].unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: 'object-lost',
      title: 'lost',
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'monitor:dropper', status: 'fail' }),
    );

    const explained = await execute(
      process.execPath,
      [
        cli,
        'monitor',
        'explain',
        'dropper',
        '--dir',
        monitors,
        '--workspace',
        root,
        '--socket',
        socketPath,
        '--format',
        'json',
      ],
      { cwd: root, timeout: 15000, env },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    const explain = JSON.parse(explained.stdout) as MonitorExplainReport;
    expect(
      explain.stages.find(({ id }) => id === 'materialization'),
    ).toMatchObject({ status: 'failure' });
  } finally {
    daemon.kill('SIGTERM');
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!stopped) {
      daemon.kill('SIGKILL');
      await exited;
    }
  }
}, 30_000);
