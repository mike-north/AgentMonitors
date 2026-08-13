import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

function openLead(store: RuntimeStore, workspacePath: string) {
  return store.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'transaction-lead',
      workspacePath,
    }),
  );
}

function createStore<T extends RuntimeStore>(
  Store: new (db: ReturnType<typeof createDb>) => T,
): { store: T; workspacePath: string } {
  const workspacePath = mkdtempSync(
    path.join(tmpdir(), 'agentmon-materialization-'),
  );
  tempDirs.push(workspacePath);
  const store = new Store(createDb(path.join(workspacePath, 'agentmon.db')));
  return { store, workspacePath };
}

describe('transactional event materialization', () => {
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

    expect(() =>
      store.insertEvent(eventInput(workspacePath), undefined, {
        snapshot: { content: '{"status":"passed"}' },
      }),
    ).toThrow('simulated cursor failure');

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

    expect(() =>
      store.insertEvent(eventInput(workspacePath), undefined, {
        snapshot: { content: '{"status":"passed"}' },
      }),
    ).toThrow('simulated snapshot failure');

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
});
