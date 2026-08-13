import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { MaterializationRetryCapacityError, RuntimeStore } from './store.js';
import { MaterializationRetrySerializationError } from './retry-envelope.js';
import {
  MATERIALIZATION_RETRY_DELAYS_MS,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  MATERIALIZATION_RETRY_MAX_BYTES,
  MATERIALIZATION_RETRY_MAX_RECORDS,
} from './types.js';
import type {
  EnqueueMaterializationRetryInput,
  StoredObservationEnvelope,
} from './types.js';

const NOW = new Date('2026-08-13T18:00:00.000Z');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-outbox-'));
  tempDirs.push(dir);
  return path.join(dir, 'agentmon.db');
}

function envelope(
  monitorId: string,
  objectKey: string,
  snapshotText = '{"status":"pending"}',
): StoredObservationEnvelope {
  return {
    monitor: {
      id: monitorId,
      displayName: 'Retry monitor',
      filePath: `/workspace/.claude/monitors/${monitorId}/MONITOR.md`,
      instructions: 'Inspect the failure.',
      frontmatter: {
        watch: { type: 'test-source' },
        urgency: 'normal',
        urgencyMax: 'normal',
        baselineStrategy: 'incremental',
      },
    },
    observation: {
      title: `${objectKey} changed`,
      objectKey,
      snapshotText,
    },
    observedAt: NOW,
    effectiveUrgency: 'normal',
  };
}

function input(
  monitorId: string,
  objectKey: string,
  workspacePath: string | null = '/workspace',
  snapshotText?: string,
): EnqueueMaterializationRetryInput {
  return {
    workspacePath,
    monitorId,
    sourceName: 'test-source',
    envelope: envelope(monitorId, objectKey, snapshotText),
    error: 'disk\nwrite\u001b failure',
  };
}

function inputWithEnvelopeBytes(
  targetBytes: number,
): EnqueueMaterializationRetryInput {
  const candidate = input('byte-boundary', 'byte-object', '/workspace', '');
  const baseBytes = Buffer.byteLength(
    JSON.stringify(candidate.envelope),
    'utf8',
  );
  const remaining = targetBytes - baseBytes;
  candidate.envelope.observation.snapshotText =
    'é'.repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? '' : 'x');
  return candidate;
}

function nextAttempt(record: { nextAttemptAt: Date | null }): Date {
  if (!record.nextAttemptAt) throw new Error('expected a pending retry');
  return record.nextAttemptAt;
}

describe('materialization retry outbox', () => {
  it('persists ordered envelopes and routing metadata across a database reopen', () => {
    const dbPath = scratchDb();
    const firstStore = new RuntimeStore(createDb(dbPath));
    const inserted = firstStore.enqueueMaterializationRetries(
      [input('monitor-a', 'object-1'), input('monitor-a', 'object-2')],
      NOW,
    );

    expect(inserted).toHaveLength(2);
    expect(firstStore.hasDatabaseCompatibilityMarker('/workspace')).toBe(true);
    expect(inserted[0]?.nextAttemptAt?.getTime()).toBe(
      NOW.getTime() + MATERIALIZATION_RETRY_DELAYS_MS[0],
    );
    expect(inserted[0]?.lastError).toBe('disk write  failure');

    const reopened = new RuntimeStore(createDb(dbPath));
    const records = reopened.listMaterializationRetries({
      monitorId: 'monitor-a',
      workspacePath: '/workspace',
    });
    expect(
      records.map((record) => record.envelope.observation.objectKey),
    ).toEqual(['object-1', 'object-2']);
    expect(records[0]?.envelope.observedAt).toEqual(NOW);
    expect(
      reopened.listMaterializationRetries({
        monitorId: 'monitor-a',
        workspacePath: '/other-workspace',
      }),
    ).toEqual([]);
  });

  it('marks named and global retry routes but not an empty admission', () => {
    const store = new RuntimeStore(createDb(':memory:'));

    expect(store.enqueueMaterializationRetries([], NOW)).toEqual([]);
    expect(store.hasDatabaseCompatibilityMarker('/workspace')).toBe(false);
    expect(store.hasDatabaseCompatibilityMarker(null)).toBe(false);

    store.enqueueMaterializationRetries(
      [
        input('named-monitor', 'named-object'),
        input('global-monitor', 'global-object', null),
      ],
      NOW,
    );
    expect(store.hasDatabaseCompatibilityMarker('/workspace')).toBe(true);
    expect(store.hasDatabaseCompatibilityMarker(null)).toBe(true);
  });

  it('serializes competing connections at the exact 256-row boundary', () => {
    const dbPath = scratchDb();
    const firstDb = createDb(dbPath);
    const secondDb = createDb(dbPath);
    const firstStore = new RuntimeStore(firstDb);
    const secondStore = new RuntimeStore(secondDb);
    const firstClient = (firstDb as unknown as { $client: BetterSQLiteClient })
      .$client;
    const secondClient = (
      secondDb as unknown as { $client: BetterSQLiteClient }
    ).$client;
    secondClient.pragma('busy_timeout = 1');
    const existing = Array.from(
      { length: MATERIALIZATION_RETRY_MAX_RECORDS - 1 },
      (_, index) => input('monitor-a', `existing-${String(index)}`),
    );
    firstStore.enqueueMaterializationRetries(existing, NOW);

    firstClient
      .transaction(() => {
        expect(
          firstStore.enqueueMaterializationRetries(
            [input('monitor-a', 'exact-boundary')],
            NOW,
          ),
        ).toHaveLength(1);

        expect(() =>
          secondStore.enqueueMaterializationRetries(
            [input('monitor-a', 'competing-boundary')],
            NOW,
          ),
        ).toThrow(/database is locked/iu);
      })
      .immediate();

    expect(() =>
      secondStore.enqueueMaterializationRetries(
        [input('monitor-a', 'overflow')],
        NOW,
      ),
    ).toThrow(MaterializationRetryCapacityError);
    expect(
      secondStore.listMaterializationRetries({
        monitorId: 'monitor-a',
        workspacePath: '/workspace',
      }),
    ).toHaveLength(MATERIALIZATION_RETRY_MAX_RECORDS);

    // Capacity is scoped by both workspace and monitor.
    expect(
      secondStore.enqueueMaterializationRetries(
        [input('monitor-a', 'other-workspace', '/other-workspace')],
        NOW,
      ),
    ).toHaveLength(1);
    expect(
      secondStore.enqueueMaterializationRetries(
        [input('monitor-b', 'other-monitor')],
        NOW,
      ),
    ).toHaveLength(1);
  });

  it('admits exactly 8 MiB of serialized UTF-8 and rejects one byte over', () => {
    const exactStore = new RuntimeStore(createDb(':memory:'));
    const exact = exactStore.enqueueMaterializationRetries(
      [inputWithEnvelopeBytes(MATERIALIZATION_RETRY_MAX_BYTES)],
      NOW,
    );
    expect(exact[0]?.envelopeBytes).toBe(MATERIALIZATION_RETRY_MAX_BYTES);

    const overflowStore = new RuntimeStore(createDb(':memory:'));
    expect(() =>
      overflowStore.enqueueMaterializationRetries(
        [inputWithEnvelopeBytes(MATERIALIZATION_RETRY_MAX_BYTES + 1)],
        NOW,
      ),
    ).toThrow(MaterializationRetryCapacityError);
    expect(overflowStore.listMaterializationRetries()).toEqual([]);
  });

  it('rejects trusted-route mismatches before writing any sibling', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const wrongMonitor = input('monitor-a', 'wrong-monitor');
    wrongMonitor.envelope.monitor.id = 'monitor-b';
    const wrongSource = input('monitor-a', 'wrong-source');
    wrongSource.envelope.monitor.frontmatter.watch.type = 'other-source';

    for (const invalid of [wrongMonitor, wrongSource]) {
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(/does not match its route/u);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
  });

  it('rejects non-JSON envelope values with a domain error before mutation', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const bigintPayload = input('monitor-a', 'bigint');
    bigintPayload.envelope.observation.payload = { value: 1n };
    const datePayload = input('monitor-a', 'date');
    datePayload.envelope.observation.payload = { value: NOW };
    const accessorPayload = input('monitor-a', 'accessor');
    accessorPayload.envelope.observation.payload = Object.defineProperty(
      {},
      'value',
      { enumerable: true, get: () => 'secret' },
    );

    for (const invalid of [bigintPayload, datePayload, accessorPayload]) {
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(MaterializationRetrySerializationError);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
  });

  it('strips terminal controls and bounds persisted errors to 1,024 characters', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const unsafe = input('monitor-a', 'unsafe-error');
    unsafe.error = `start\u0000\u001f\u007f\n\u001b${'x'.repeat(2_000)}`;

    const record = store.enqueueMaterializationRetries([unsafe], NOW)[0];

    expect(record?.lastError).toHaveLength(1_024);
    expect(
      [...(record?.lastError ?? '')].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
    ).toBe(false);
    expect(record?.lastError?.startsWith(`start${' '.repeat(5)}x`)).toBe(true);
  });

  it('backs off, terminalizes, re-arms, and completes transactionally', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    let record = store.enqueueMaterializationRetries(
      [input('monitor-a', 'object-1')],
      NOW,
    )[0];
    if (!record) throw new Error('expected retry record');

    expect(
      store.listMaterializationRetries({
        dueAt: new Date(nextAttempt(record).getTime() - 1),
      }),
    ).toEqual([]);
    expect(
      store.listMaterializationRetries({ dueAt: nextAttempt(record) }),
    ).toHaveLength(1);

    for (const [index, delay] of MATERIALIZATION_RETRY_DELAYS_MS.slice(
      1,
    ).entries()) {
      const failedAt = nextAttempt(record);
      record = store.markMaterializationRetryFailed(
        record.id,
        `attempt ${String(index + 1)} failed`,
        failedAt,
      );
      expect(record).toMatchObject({
        attemptCount: index + 1,
        status: 'pending',
      });
      expect(record.nextAttemptAt?.getTime()).toBe(failedAt.getTime() + delay);
    }

    record = store.markMaterializationRetryFailed(
      record.id,
      'fifth retry failed',
      nextAttempt(record),
    );
    expect(record).toMatchObject({
      attemptCount: MATERIALIZATION_RETRY_MAX_ATTEMPTS,
      status: 'terminal',
      nextAttemptAt: null,
    });
    const summary = store.materializationRetrySummary(
      'monitor-a',
      '/workspace',
    );
    expect(summary).toMatchObject({
      pending: 0,
      terminal: 1,
      bytes: record.envelopeBytes,
      records: [
        {
          id: record.id,
          status: 'terminal',
          attemptCount: MATERIALIZATION_RETRY_MAX_ATTEMPTS,
          lastError: 'fifth retry failed',
          nextAttemptAt: null,
        },
      ],
    });
    expect(summary.records[0]).not.toHaveProperty('envelope');
    expect(JSON.stringify(summary)).not.toContain('object-1 changed');
    expect(
      store.listMaterializationRetries({
        monitorId: 'monitor-a',
        dueAt: new Date('2126-08-14T18:00:00.000Z'),
      }),
    ).toEqual([]);
    expect(() =>
      store.markMaterializationRetryFailed(record.id, 'must stay terminal'),
    ).toThrow(`Materialization retry record is terminal: ${record.id}`);

    const pending = store.enqueueMaterializationRetries(
      [input('monitor-b', 'pending')],
      NOW,
    )[0];
    expect(() =>
      store.rearmMaterializationRetry(pending?.id ?? 'missing'),
    ).toThrow('Materialization retry record is not terminal');

    const rearmedAt = new Date('2026-08-14T18:00:00.000Z');
    record = store.rearmMaterializationRetry(record.id, rearmedAt);
    expect(record).toMatchObject({
      attemptCount: 0,
      status: 'pending',
      lastError: null,
    });
    expect(record.nextAttemptAt?.getTime()).toBe(
      rearmedAt.getTime() + MATERIALIZATION_RETRY_DELAYS_MS[0],
    );

    expect(() =>
      store.completeMaterializationRetry(record.id, () => {
        throw new Error('materialization still failed');
      }),
    ).toThrow('materialization still failed');
    expect(store.getMaterializationRetry(record.id).id).toBe(record.id);
    expect(
      store.completeMaterializationRetry(record.id, () => 'materialized'),
    ).toBe('materialized');
    expect(() => store.getMaterializationRetry(record.id)).toThrow(
      `Materialization retry record not found: ${record.id}`,
    );
  });
});
