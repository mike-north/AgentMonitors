/** Workspace claim policy must agree across the real daemon IPC and in-process readers (002 §7.1). */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  claudeCodeAdapter,
  createDb,
  RuntimeStore,
  type DeliveryClaim,
  type MonitorEventRecord,
} from '@agentmonitors/core';
import { afterEach, expect, it, vi } from 'vitest';
import { runLoop } from './commands/daemon.js';
import { callDaemon, daemonAvailable } from './daemon-ipc.js';
import { createRuntime } from './runtime.js';
import {
  daemonTickClient,
  explainMonitorInProcess,
  doctorReportInProcess,
  listObservationHistoryInProcess,
  rearmRetryInProcess,
  skipRetryInProcess,
} from './runtime-client.js';

const START = Date.UTC(2026, 0, 1) + 123;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('uses workspace TTL through daemon claims, daemon once and offline readers from another cwd', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'claim-policy-'));
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, 'ttl'), { recursive: true });
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(
    path.join(root, '.claude', 'agentmonitors.local.md'),
    '---\nenabled: true\nclaim-ttl-ms: 60000\n---\n',
  );
  writeFileSync(
    path.join(monitorsDir, 'ttl', 'MONITOR.md'),
    `---\nwatch:\n  type: file-fingerprint\n  globs: [never.txt]\n  cwd: ${JSON.stringify(root)}\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
  );
  const dbPath = path.join(root, 'state.db');
  const socketPath = path.join(root, 'daemon.sock');
  const db = createDb(dbPath);
  // The public database handle hides native close; this fixture owns its connection across daemon shutdown.
  const client = (db as unknown as { $client: Database.Database }).$client;
  const store = new RuntimeStore(db);
  const session = store.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'ttl',
      workspacePath: root,
    }),
  );
  const event = store.insertEvent({
    workspacePath: root,
    monitorId: 'ttl',
    sourceName: 'file-fingerprint',
    urgency: 'normal',
    title: 'change',
    summary: '',
    body: '',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey: 'file',
    queryScope: {},
    tags: [],
    createdAt: new Date(START),
  });
  const loop = runLoop(monitorsDir, root, 20, socketPath, 0, dbPath);
  let stopped = false;
  try {
    await vi.waitFor(async () =>
      expect(await daemonAvailable(socketPath)).toBe(true),
    );
    // Readiness polling may advance Vitest's clock; the claim starts at the specified instant.
    vi.setSystemTime(START);
    const claim = () =>
      callDaemon<DeliveryClaim | null>(
        'hook.claim',
        { sessionId: session.id, lifecycle: 'turn-interruptible' },
        { socketPath },
      );
    const state = async () =>
      (
        await callDaemon<MonitorEventRecord[]>(
          'events.list',
          { sessionId: session.id },
          { socketPath },
        )
      ).find((e) => e.id === event.id)?.deliveryState;
    expect((await claim())?.urgency).toBe('normal');
    vi.setSystemTime(START + 59999);
    expect(await state()).toBe('claimed');
    expect(await claim()).toBeNull();
    vi.setSystemTime(START + 60000);
    expect(await state()).toBe('unread');
    expect((await claim())?.urgency).toBe('normal');
    await callDaemon('stop', {}, { socketPath });
    await loop;
    stopped = true;
    vi.setSystemTime(START + 120000);
    await daemonTickClient(monitorsDir, root, dbPath);
    expect(
      JSON.parse(readFileSync(session.hookStatePath, 'utf8')),
    ).toMatchObject({ hasPendingNormal: true });
    expect(
      createRuntime(dbPath, undefined, undefined, root)
        .listEvents({ sessionId: session.id })
        .find((e) => e.id === event.id)?.deliveryState,
    ).toBe('unread');
    const explanation = await explainMonitorInProcess(
      { monitorId: 'ttl', monitorsDir, workspacePath: root },
      dbPath,
    );
    expect(
      explanation.projections.find((p) => p.eventId === event.id)
        ?.deliveryState,
    ).toBe('unread');
    const doctor = await doctorReportInProcess(
      { monitorsDir, workspacePath: root },
      dbPath,
    );
    expect(doctor.monitors.find((m) => m.id === 'ttl')?.delivery.claimed).toBe(
      0,
    );
  } finally {
    if (!stopped) {
      await callDaemon('stop', {}, { socketPath });
      await loop;
    }
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it('rejects a bad workspace claim TTL before daemon once opens the store', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claim-bad-'));
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(
    path.join(root, '.claude', 'agentmonitors.local.md'),
    '---\nenabled: true\nclaim-ttl-ms: nope\n---\n',
  );
  try {
    await expect(
      daemonTickClient(
        path.join(root, 'monitors'),
        root,
        path.join(root, 'state.db'),
      ),
    ).rejects.toThrow(
      'claim-ttl-ms must be a positive safe integer in milliseconds',
    );
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../dist/index.cjs'),
        'daemon',
        'once',
        path.join(root, 'monitors'),
        '--workspace',
        root,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'claim-ttl-ms must be a positive safe integer in milliseconds',
    );
    expect(result.stderr).not.toContain(' at ');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every offline construction must use its explicit target, even outside that workspace. */
it.each(['doctor', 'explain', 'history', 'rearm', 'skip'] as const)(
  '%s rejects the target workspace policy rather than defaulting to the caller cwd',
  async (reader) => {
    const root = mkdtempSync(path.join(tmpdir(), 'claim-reader-'));
    mkdirSync(path.join(root, '.claude'));
    writeFileSync(
      path.join(root, '.claude', 'agentmonitors.local.md'),
      '---\nenabled: true\nclaim-ttl-ms: 0\n---\n',
    );
    const dbPath = path.join(root, 'state.db');
    const input = { monitorId: 'ttl', retryId: 'retry', workspacePath: root };
    try {
      await expect(
        Promise.resolve().then(() => {
          switch (reader) {
            case 'doctor':
              return doctorReportInProcess(
                { workspacePath: root, monitorsDir: root },
                dbPath,
              );
            case 'explain':
              return explainMonitorInProcess(
                { ...input, monitorsDir: root },
                dbPath,
              );
            case 'history':
              return listObservationHistoryInProcess(input, dbPath, root);
            case 'rearm':
              return rearmRetryInProcess(input, dbPath);
            case 'skip':
              return skipRetryInProcess(input, dbPath);
          }
        }),
      ).rejects.toThrow(
        'claim-ttl-ms must be a positive safe integer in milliseconds',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
