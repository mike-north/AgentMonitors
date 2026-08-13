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
  workspacePath = '/workspace',
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

describe('materialization retry outbox', () => {
  it('persists ordered envelopes and routing metadata across a database reopen', () => {
    const dbPath = scratchDb();
    const firstStore = new RuntimeStore(createDb(dbPath));
    const inserted = firstStore.enqueueMaterializationRetries(
      [input('monitor-a', 'object-1'), input('monitor-a', 'object-2')],
      NOW,
    );

    expect(inserted).toHaveLength(2);
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
});
