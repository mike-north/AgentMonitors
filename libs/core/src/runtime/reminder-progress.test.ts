/**
 * Fresh work must not wait for acknowledgment of an earlier reminder. These
 * scenarios exercise the common decision boundary used by hook claims and
 * channel reservations, including the temporary exclusion of in-flight pushes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { Urgency } from '../schema/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.useRealTimers();
});

/** Independent lead sessions share observations, never their claim state. */
function harness() {
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'reminder-progress-'));
  cleanup.push(() => rmSync(workspacePath, { recursive: true, force: true }));
  const db = createDb(':memory:');
  const store = new RuntimeStore(db);
  const runtime = new AgentMonitorRuntime(
    store,
    new SourceRegistry(),
    [claudeCodeAdapter],
    undefined,
    { deliveryReservationTtlMs: 1000 },
  );
  const open = (hostSessionId: string) =>
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
    ).id;
  const sessionId = open('receiver');
  const insert = (urgency: Urgency, objectKey: string, ageMs = 0) =>
    store.insertEvent({
      workspacePath,
      monitorId: objectKey,
      sourceName: 'manual',
      urgency,
      title: objectKey,
      body: objectKey,
      summary: objectKey,
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey,
      queryScope: {},
      tags: [],
      createdAt: new Date(Date.now() - ageMs),
    }).id;
  return { runtime, store, sessionId, insert, open };
}

for (const urgency of ['normal', 'low'] as const) {
  const lifecycle = urgency === 'normal' ? 'turn-interruptible' : 'turn-idle';
  describe(`${urgency} reminder forward progress`, () => {
    it.each(['hook', 'channel'] as const)(
      '%s surfaces B while A remains unacknowledged, without repeating A or touching another session',
      (transport) => {
        const h = harness();
        const other = h.open('other');
        const a = h.insert(urgency, 'A');
        h.runtime.claimDelivery(h.sessionId, lifecycle);
        expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
        const b = h.insert(urgency, 'B');
        expect(
          h.runtime.diagnoseHookDelivery(h.sessionId, lifecycle).holds,
        ).toEqual([]);
        if (transport === 'hook') {
          expect(h.runtime.claimDelivery(h.sessionId, lifecycle)?.urgency).toBe(
            urgency,
          );
        } else {
          const reserved = h.runtime.reserveDelivery(h.sessionId, lifecycle);
          expect(reserved?.claim.urgency).toBe(urgency);
          expect(
            h.store.pendingEventsForSession(h.sessionId).map((e) => e.id),
          ).toEqual([b]);
          expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
          if (!reserved) throw new Error('Expected reservation');
          h.runtime.commitDelivery(reserved.reservationId);
        }
        expect(h.store.pendingEventsForSession(h.sessionId)).toEqual([]);
        expect(
          h.store
            .unreadEventsForSession(h.sessionId)
            .map((e) => e.id)
            .sort(),
        ).toEqual([a, b].sort());
        expect(h.store.pendingEventsForSession(other)).toHaveLength(2);
        expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
      },
    );

    it.each(['release', 'expiry', 'commit'] as const)(
      'keeps B held only until the in-flight A reservation resolves by %s',
      (resolution) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
        const h = harness();
        h.insert(urgency, 'A');
        const reserved = h.runtime.reserveDelivery(h.sessionId, lifecycle);
        if (!reserved) throw new Error('Expected reservation');
        h.insert(urgency, 'B');
        expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
        expect(
          h.runtime.diagnoseHookDelivery(h.sessionId, lifecycle).holds[0]
            ?.reason,
        ).toBe('reserved-in-flight');
        if (resolution === 'release')
          h.runtime.releaseDelivery(reserved.reservationId);
        else if (resolution === 'commit')
          h.runtime.commitDelivery(reserved.reservationId);
        else vi.advanceTimersByTime(1001);
        expect(h.runtime.claimDelivery(h.sessionId, lifecycle)?.urgency).toBe(
          urgency,
        );
        expect(h.store.unreadEventsForSession(h.sessionId)).toHaveLength(2);
        expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
      },
    );
  });
}

it('coalesces fresh normal work with settled high work even after an earlier normal claim', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const h = harness();
  h.insert('normal', 'A');
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  h.insert('normal', 'B');
  const high = h.insert('high', 'H');
  expect(h.runtime.claimDelivery(h.sessionId, 'turn-interruptible')).toBeNull();
  expect(
    h.runtime
      .diagnoseHookDelivery(h.sessionId, 'turn-interruptible')
      .holds.filter((hold) => hold.urgency === 'normal')[0]?.reason,
  ).toBe('settle-window');
  vi.advanceTimersByTime(15_000);
  expect(h.runtime.previewCoalescedReminder(h.sessionId)).toBeTruthy();
  const delivered = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  expect(delivered?.events.map((event) => event.eventId)).toEqual([high]);
  expect(delivered?.coalescedNormalCount).toBe(1);
  expect(h.store.unreadEventsForSession(h.sessionId)).toHaveLength(3);
});
