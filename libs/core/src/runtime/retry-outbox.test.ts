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
    expect(records[0]?.envelope).toStrictEqual(
      envelope('monitor-a', 'object-1'),
    );
    expect(records[1]?.envelope).toStrictEqual(
      envelope('monitor-a', 'object-2'),
    );
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

  it('rejects a two-item row overflow without retaining either sibling or another route', () => {
    const store = new RuntimeStore(createDb(scratchDb()));
    const existing = store.enqueueMaterializationRetries(
      Array.from(
        { length: MATERIALIZATION_RETRY_MAX_RECORDS - 1 },
        (_, index) => input('monitor-a', `existing-${String(index)}`),
      ),
      NOW,
    );
    expect(() =>
      store.enqueueMaterializationRetries(
        [
          input('monitor-b', 'unrelated-route'),
          input('monitor-a', 'fits-alone'),
          input('monitor-a', 'overflows-together'),
        ],
        NOW,
      ),
    ).toThrow(MaterializationRetryCapacityError);
    expect(
      store.listMaterializationRetries().map((record) => record.id),
    ).toEqual(existing.map((record) => record.id));
  });

  it('rejects aggregate sibling bytes even when either sibling individually fits', () => {
    const dbPath = scratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const siblingBytes = 1024;
    const existing = store.enqueueMaterializationRetries(
      [
        inputWithEnvelopeBytes(
          MATERIALIZATION_RETRY_MAX_BYTES - 2 * siblingBytes + 1,
        ),
      ],
      NOW,
    );
    expect(() =>
      store.enqueueMaterializationRetries(
        [
          inputWithEnvelopeBytes(siblingBytes),
          inputWithEnvelopeBytes(siblingBytes),
        ],
        NOW,
      ),
    ).toThrow(MaterializationRetryCapacityError);
    const reopened = new RuntimeStore(createDb(dbPath));
    expect(
      reopened.listMaterializationRetries().map((record) => record.id),
    ).toEqual(existing.map((record) => record.id));
    // Exactly one sibling still fits, proving overflow was aggregate rather
    // than an individually invalid envelope or a pre-existing full outbox.
    expect(
      reopened.enqueueMaterializationRetries(
        [inputWithEnvelopeBytes(siblingBytes)],
        NOW,
      ),
    ).toHaveLength(1);
  });

  it('rejects negative zero before any sibling writes, rather than restoring positive zero', () => {
    const store = new RuntimeStore(createDb(scratchDb()));
    const invalid = input('monitor-a', 'negative-zero');
    invalid.envelope.observation.payload = { value: -0 };
    expect(() =>
      store.enqueueMaterializationRetries(
        [input('monitor-a', 'valid-sibling'), invalid],
        NOW,
      ),
    ).toThrow(MaterializationRetrySerializationError);
    expect(store.listMaterializationRetries()).toEqual([]);
  });

  it('rejects customized observedAt dates without invoking caller hooks or writing siblings', () => {
    const store = new RuntimeStore(createDb(scratchDb()));
    let hookCalls = 0;
    const hook = () => {
      hookCalls += 1;
      return '2020-01-01T00:00:00.000Z';
    };
    class CustomDate extends Date {
      toJSON(): string {
        return hook();
      }
    }
    const customized = [
      Object.defineProperty(new Date(NOW), 'toJSON', { value: hook }),
      Object.defineProperty(new Date(NOW), 'getTime', {
        value: () => {
          hookCalls += 1;
          return 0;
        },
      }),
      new CustomDate(NOW),
      Object.assign(new Date(NOW), { metadata: 'would be discarded' }),
    ];
    for (const observedAt of customized) {
      const invalid = input('monitor-a', 'custom-date');
      invalid.envelope.observedAt = observedAt;
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(MaterializationRetrySerializationError);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
    expect(hookCalls).toBe(0);
  });

  it('rejects a non-Date observedAt instead of changing its type when reopened', () => {
    const store = new RuntimeStore(createDb(scratchDb()));
    const invalid = input('monitor-a', 'string-date');
    // The public persistence boundary also serves JavaScript callers.
    Reflect.set(invalid.envelope, 'observedAt', NOW.toISOString());
    expect(() => store.enqueueMaterializationRetries([invalid], NOW)).toThrow(
      MaterializationRetrySerializationError,
    );
    expect(store.listMaterializationRetries()).toEqual([]);
  });

  it('rejects proxies at every envelope boundary without running traps or writing siblings', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    let trapCalls = 0;
    const trapHandler: ProxyHandler<object> = {
      get(target, key, receiver) {
        trapCalls += 1;
        if (key === 'toJSON') return () => ({ value: 'changed' });
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    };
    const nested = input('monitor-a', 'proxy-payload');
    nested.envelope.observation.payload = new Proxy(
      { value: 'original' },
      trapHandler,
    );
    const root = input('monitor-a', 'proxy-root');
    root.envelope = new Proxy(root.envelope, trapHandler);
    const route = input('monitor-a', 'proxy-route');
    route.envelope.monitor = new Proxy(route.envelope.monitor, trapHandler);
    const timestamp = input('monitor-a', 'proxy-date');
    timestamp.envelope.observedAt = new Proxy(new Date(NOW), trapHandler);
    const revoked = input('monitor-a', 'revoked-proxy');
    const revocable = Proxy.revocable({}, trapHandler);
    revocable.revoke();
    revoked.envelope.observation.payload = revocable.proxy;

    for (const invalid of [nested, root, route, timestamp, revoked]) {
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(MaterializationRetrySerializationError);
      expect(trapCalls).toBe(0);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
  });

  it('rejects proxy prototypes without traversing them or admitting changed data', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    let trapCalls = 0;
    // The object itself is not a proxy. A prototype-chain walk would execute
    // caller code that changes its data and disguises the unsupported prototype.
    function withProxyPrototype<T extends object>(value: T): T {
      const originalPrototype: object | null = Reflect.getPrototypeOf(value);
      const prototype = new Proxy(
        {},
        {
          getPrototypeOf() {
            trapCalls += 1;
            Reflect.setPrototypeOf(value, originalPrototype);
            if (Reflect.has(value, 'value'))
              Reflect.set(value, 'value', 'changed');
            return null;
          },
        },
      );
      Reflect.setPrototypeOf(value, prototype);
      return value;
    }
    const payload = input('monitor-a', 'proxy-prototype-payload');
    payload.envelope.observation.payload = withProxyPrototype({
      value: 'original',
    });
    const root = input('monitor-a', 'proxy-prototype-root');
    withProxyPrototype(root.envelope);
    const route = input('monitor-a', 'proxy-prototype-route');
    withProxyPrototype(route.envelope.monitor);
    const array = input('monitor-a', 'proxy-prototype-array');
    array.envelope.observation.payload = withProxyPrototype(['original']);
    const timestamp = input('monitor-a', 'proxy-prototype-date');
    timestamp.envelope.observedAt = withProxyPrototype(new Date(NOW));
    const revoked = input('monitor-a', 'revoked-prototype');
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    revoked.envelope.observation.payload = Object.create(revocable.proxy);
    const indirect = input('monitor-a', 'indirect-proxy-prototype');
    indirect.envelope.observation.payload = Object.create(
      Object.create(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              trapCalls += 1;
              return null;
            },
          },
        ),
      ),
    );
    for (const invalid of [
      payload,
      root,
      route,
      array,
      timestamp,
      revoked,
      indirect,
    ]) {
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(MaterializationRetrySerializationError);
      expect(trapCalls).toBe(0);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
  });

  it('rejects route accessors before reading them or writing siblings', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    let getterCalls = 0;
    const monitorAccessor = input('monitor-a', 'monitor-accessor');
    Object.defineProperty(monitorAccessor.envelope.monitor, 'id', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'monitor-a';
      },
    });
    const sourceAccessor = input('monitor-a', 'source-accessor');
    Object.defineProperty(
      sourceAccessor.envelope.monitor.frontmatter.watch,
      'type',
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return 'test-source';
        },
      },
    );
    for (const invalid of [monitorAccessor, sourceAccessor]) {
      expect(() =>
        store.enqueueMaterializationRetries(
          [input('monitor-a', 'valid-sibling'), invalid],
          NOW,
        ),
      ).toThrow(MaterializationRetrySerializationError);
      expect(getterCalls).toBe(0);
      expect(store.listMaterializationRetries()).toEqual([]);
    }
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
