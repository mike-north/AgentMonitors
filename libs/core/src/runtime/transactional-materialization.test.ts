import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function eventInput(workspacePath: string): Omit<MonitorEventRecord, 'id'> {
  return {
    workspacePath,
    monitorId: 'transaction-monitor',
    sourceName: 'test-source',
    urgency: 'normal',
    title: 'State changed',
    body: 'Inspect the change.',
    summary: 'object-1 changed',
    payload: { status: 'passed' },
    snapshotMetadata: {},
    snapshotText: '{"status":"passed"}',
    diffText: null,
    objectKey: 'object-1',
    baselineStrategy: 'incremental',
    queryScope: {},
    tags: [],
    createdAt: new Date('2026-08-13T18:00:00.000Z'),
  };
}

function openLead(
  store: RuntimeStore,
  workspacePath: string,
  hostSessionId = 'transaction-lead',
) {
  return store.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId,
      workspacePath,
    }),
  );
}

function createStore<T extends RuntimeStore>(
  Store: new (db: ReturnType<typeof createDb>) => T,
): { store: T; workspacePath: string; client: BetterSQLiteClient } {
  const workspacePath = mkdtempSync(
    path.join(tmpdir(), 'agentmon-materialization-'),
  );
  tempDirs.push(workspacePath);
  const db = createDb(path.join(workspacePath, 'agentmon.db'));
  const store = new Store(db);
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  return { store, workspacePath, client };
}

describe('transactional event materialization', () => {
  it('persists the event snapshot text as the single snapshot source of truth', () => {
    const { store, workspacePath } = createStore(RuntimeStore);

    const event = store.insertEvent(eventInput(workspacePath));

    const snapshot = store.latestSnapshot(
      'transaction-monitor',
      'object-1',
      workspacePath,
    );
    expect(snapshot).toEqual({ content: '{"status":"passed"}' });
    expect(snapshot?.content).toBe(event.snapshotText);
  });

  it('rolls back the event and cursor when cursor seeding fails', () => {
    class CursorFailingStore extends RuntimeStore {
      override seedSessionObjectCursor(
        input: Parameters<RuntimeStore['seedSessionObjectCursor']>[0],
      ): void {
        super.seedSessionObjectCursor(input);
        throw new Error('simulated cursor failure');
      }
    }

    const { store, workspacePath } = createStore(CursorFailingStore);
    const session = openLead(store, workspacePath);

    expect(() => store.insertEvent(eventInput(workspacePath))).toThrow(
      'simulated cursor failure',
    );

    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ sessionId: session.id })).toEqual([]);
    expect(
      store.getSessionObjectCursor(
        session.id,
        'transaction-monitor',
        'object-1',
        workspacePath,
      ),
    ).toBeNull();
    expect(
      store.latestSnapshot('transaction-monitor', 'object-1', workspacePath),
    ).toBeNull();
  });

  it('rolls back the event, projection, and cursor when snapshot persistence fails', () => {
    class SnapshotFailingStore extends RuntimeStore {
      override saveSnapshot(
        _input: Parameters<RuntimeStore['saveSnapshot']>[0],
      ): void {
        throw new Error('simulated snapshot failure');
      }
    }

    const { store, workspacePath } = createStore(SnapshotFailingStore);
    const session = openLead(store, workspacePath);

    expect(() => store.insertEvent(eventInput(workspacePath))).toThrow(
      'simulated snapshot failure',
    );

    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ sessionId: session.id })).toEqual([]);
    expect(
      store.getSessionObjectCursor(
        session.id,
        'transaction-monitor',
        'object-1',
        workspacePath,
      ),
    ).toBeNull();
    expect(
      store.latestSnapshot('transaction-monitor', 'object-1', workspacePath),
    ).toBeNull();
  });

  it('rolls back an earlier recipient when a later projection insert fails', () => {
    const { store, workspacePath, client } = createStore(RuntimeStore);
    const first = openLead(store, workspacePath, 'transaction-lead-1');
    const second = openLead(store, workspacePath, 'transaction-lead-2');
    client.exec(`
      CREATE TRIGGER fail_second_projection
      BEFORE INSERT ON session_event_state
      WHEN NEW.session_id = '${second.id}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated projection failure');
      END;
    `);

    expect(() => store.insertEvent(eventInput(workspacePath))).toThrow(
      'simulated projection failure',
    );

    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ sessionId: first.id })).toEqual([]);
    expect(store.listEvents({ sessionId: second.id })).toEqual([]);
    for (const session of [first, second]) {
      expect(
        store.getSessionObjectCursor(
          session.id,
          'transaction-monitor',
          'object-1',
          workspacePath,
        ),
      ).toBeNull();
    }
    expect(
      store.latestSnapshot('transaction-monitor', 'object-1', workspacePath),
    ).toBeNull();
  });
});
