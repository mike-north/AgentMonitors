import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { InboxService } from '../inbox/inbox-service.js';
import {
  computeHookState,
  readBridgeState,
  writeBridgeState,
} from './bridge.js';
import type { HookState } from './types.js';

const FIXED_STATE: HookState = {
  updatedAt: '2024-06-15T09:00:00.000Z',
  counts: { queued: 2, acked: 1, 'in-progress': 0, failed: 0 },
  urgent: [
    {
      id: '01HX0001',
      monitorId: 'test-monitor',
      title: 'High urgency item',
      createdAt: '2024-06-15T08:00:00.000Z',
    },
  ],
};

describe('bridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bridge-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeBridgeState / readBridgeState', () => {
    it('round-trips state through write and read', () => {
      const statePath = path.join(tmpDir, '.agentmonitors', 'hook-state.json');

      writeBridgeState(statePath, FIXED_STATE);
      const result = readBridgeState(statePath);

      expect(result).toEqual(FIXED_STATE);
    });

    it('creates parent directories if they do not exist', () => {
      const statePath = path.join(tmpDir, 'nested', 'deep', 'hook-state.json');

      writeBridgeState(statePath, FIXED_STATE);
      const content = readFileSync(statePath, 'utf-8');

      expect(JSON.parse(content)).toEqual(FIXED_STATE);
    });

    it('returns null when file does not exist', () => {
      const result = readBridgeState(
        path.join(tmpDir, 'nonexistent', 'hook-state.json'),
      );

      expect(result).toBeNull();
    });

    it('overwrites existing state file', () => {
      const statePath = path.join(tmpDir, 'hook-state.json');

      writeBridgeState(statePath, FIXED_STATE);

      const updated: HookState = {
        ...FIXED_STATE,
        updatedAt: '2024-06-15T10:00:00.000Z',
        counts: { queued: 0, acked: 0, 'in-progress': 0, failed: 0 },
        urgent: [],
      };
      writeBridgeState(statePath, updated);

      expect(readBridgeState(statePath)).toEqual(updated);
    });
  });

  describe('computeHookState', () => {
    it('computes counts from inbox items', () => {
      const db = createDb(':memory:');
      const inbox = new InboxService(db);

      inbox.enqueue({
        monitorId: 'mon-1',
        urgency: 'normal',
        eventKind: 'notification',
        title: 'Normal item',
      });
      inbox.enqueue({
        monitorId: 'mon-2',
        urgency: 'high',
        eventKind: 'alert',
        title: 'Urgent item',
      });

      const state = computeHookState(inbox);

      expect(state.counts.queued).toBe(2);
      expect(state.counts.acked).toBe(0);
      expect(state.counts['in-progress']).toBe(0);
      expect(state.counts.failed).toBe(0);
    });

    it('includes high-urgency queued items in urgent list', () => {
      const db = createDb(':memory:');
      const inbox = new InboxService(db);

      inbox.enqueue({
        monitorId: 'mon-1',
        urgency: 'normal',
        eventKind: 'notification',
        title: 'Normal item',
      });
      const urgentId = inbox.enqueue({
        monitorId: 'mon-2',
        urgency: 'high',
        eventKind: 'alert',
        title: 'Urgent item',
      });

      const state = computeHookState(inbox);

      expect(state.urgent).toHaveLength(1);
      expect(state.urgent[0]?.id).toBe(urgentId);
      expect(state.urgent[0]?.title).toBe('Urgent item');
    });

    it('excludes acked high-urgency items from urgent list', () => {
      const db = createDb(':memory:');
      const inbox = new InboxService(db);

      const id = inbox.enqueue({
        monitorId: 'mon-1',
        urgency: 'high',
        eventKind: 'alert',
        title: 'Urgent item',
      });
      inbox.ack(id);

      const state = computeHookState(inbox);

      expect(state.urgent).toHaveLength(0);
      expect(state.counts.queued).toBe(0);
      expect(state.counts.acked).toBe(1);
    });

    it('returns empty state for empty inbox', () => {
      const db = createDb(':memory:');
      const inbox = new InboxService(db);

      const state = computeHookState(inbox);

      expect(state.counts.queued).toBe(0);
      expect(state.counts.acked).toBe(0);
      expect(state.counts['in-progress']).toBe(0);
      expect(state.counts.failed).toBe(0);
      expect(state.urgent).toHaveLength(0);
    });
  });
});
