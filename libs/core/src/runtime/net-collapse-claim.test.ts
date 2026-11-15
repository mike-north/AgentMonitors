/**
 * A delivery may consume net intermediates only for an endpoint represented on
 * its surface. Urgency edits, shared object keys and recap caps must never make
 * an unseen endpoint permanently unclaimable (002 §9).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import type { Urgency } from '../schema/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type { DeliveryLifecycle } from './types.js';

/** Close every native connection, including after failed assertions. */
const connections: Database.Database[] = [];
afterEach(() => {
  for (const client of connections.splice(0)) {
    if (client.open) client.close();
  }
  vi.useRealTimers();
});

/**
 * Real MONITOR.md edits and ticks materialize immutable urgency snapshots. The
 * scripted source owns acquisition alone; timing and delivery use the runtime.
 * Fixtures retain their database so failed durable state can be inspected.
 */
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'net-collapse-claim-'));
  const dbPath = path.join(workspace, 'runtime.db');
  const monitorsDir = path.join(workspace, 'monitors');
  let snapshot: string | undefined;
  const source: ObservationSource = {
    name: 'versioned-object',
    stateful: true,
    scopeSchema: { type: 'object', properties: {}, additionalProperties: true },
    observe: () =>
      Promise.resolve({
        observations:
          snapshot === undefined
            ? []
            : [
                {
                  objectKey: 'shared-object',
                  snapshotText: snapshot,
                  title: snapshot,
                  summary: snapshot,
                },
              ],
        nextState: {},
      }),
  };
  const registry = new SourceRegistry();
  registry.register(source);
  const open = () => {
    const db = createDb(dbPath);
    // InboxDb hides the native connection; tests own it to model a full close
    // and reopen rather than merely replacing the runtime around a live store.
    const client = (db as unknown as { $client: Database.Database }).$client;
    connections.push(client);
    const store = new RuntimeStore(db);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'net-claim',
        workspacePath: workspace,
      }),
    );
    return { client, store, runtime, sessionId: session.id };
  };
  return {
    workspace,
    open,
    edit(monitorId: string, urgency: Urgency) {
      const dir = path.join(monitorsDir, monitorId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        `---
name: ${monitorId}
watch:
  type: versioned-object
  interval: 1s
urgency: ${urgency}
notify:
  strategy: debounce
  settle-for: 1s
baseline-strategy: net
---
Handle ${monitorId} changes.
`,
      );
    },
    async emit(
      runtime: AgentMonitorRuntime,
      version: string,
      flushAfterMs = 60_000,
    ) {
      vi.advanceTimersByTime(60_000);
      snapshot = version;
      expect(
        (await runtime.tick(monitorsDir, workspace)).erroredObservations,
      ).toEqual([]);
      snapshot = undefined;
      vi.advanceTimersByTime(flushAfterMs);
      expect(
        (await runtime.tick(monitorsDir, workspace)).erroredObservations,
      ).toEqual([]);
    },
  };
}

/** Direct hooks and successful channel reservations must commit the same set. */
const paths = ['claim', 'reserve/commit'] as const;
function deliver(
  runtime: AgentMonitorRuntime,
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  transport: (typeof paths)[number],
) {
  if (transport === 'claim') return runtime.claimDelivery(sessionId, lifecycle);
  const reservation = runtime.reserveDelivery(sessionId, lifecycle);
  if (!reservation) return null;
  expect(runtime.commitDelivery(reservation.reservationId)).toEqual(
    reservation.claim,
  );
  return reservation.claim;
}

describe.each(paths)('net claim surface and durable state: %s', (transport) => {
  it('does not let an unsettled high endpoint consume a normal version beyond the rendered high endpoint', async () => {
    const fixture = setup();
    const first = fixture.open();
    fixture.edit('monitor-a', 'high');
    await fixture.emit(first.runtime, 'v1');
    fixture.edit('monitor-a', 'normal');
    await fixture.emit(first.runtime, 'v2');
    fixture.edit('monitor-a', 'high');
    // Flush debounce before the high claim-time settle window expires. v3 is
    // durable but cannot authorize consumption by a claim that renders v1.
    await fixture.emit(first.runtime, 'v3', 1_001);
    const events = first.store.unreadEventsForSession(first.sessionId);
    expect(events.map((event) => event.urgency)).toEqual([
      'high',
      'normal',
      'high',
    ]);
    const claim = deliver(
      first.runtime,
      first.sessionId,
      'turn-interruptible',
      transport,
    );
    expect(claim?.events.map((event) => event.summary)).toEqual(['v1']);
    const pending = first.store.pendingEventsForSession(first.sessionId);
    expect(pending.map((event) => event.summary)).toEqual(['v2', 'v3']);
    for (const projection of first.store.listDeliveryProjectionsForMonitor(
      'monitor-a',
      fixture.workspace,
    )) {
      expect(projection.acknowledgedAt).toBeUndefined();
      expect(projection.netSuppressed).toBeUndefined();
      expect(projection.deliveryState).toBe(
        events.find((event) => event.id === projection.eventId)?.summary ===
          'v1'
          ? 'claimed'
          : 'unread',
      );
    }
    expect(claim?.coalescedReminder).toBeUndefined();

    first.client.close();
    const restarted = fixture.open();
    expect(
      restarted.store
        .pendingEventsForSession(restarted.sessionId)
        .map((event) => event.id),
    ).toEqual(pending.map((event) => event.id));
    vi.advanceTimersByTime(60_000);
    const next = deliver(
      restarted.runtime,
      restarted.sessionId,
      'turn-interruptible',
      transport,
    );
    expect(next?.events.map((event) => event.summary)).toEqual(['v3']);
    expect(next?.coalescedNormalCount).toBe(1);
    expect(
      restarted.store.pendingEventsForSession(restarted.sessionId),
    ).toEqual([]);
    expect(
      restarted.store.getSessionObjectCursor(
        restarted.sessionId,
        'monitor-a',
        'shared-object',
        fixture.workspace,
      )?.baselineContent,
    ).toBe('v3');
  });

  it("coalesces an independent monitor reminder while leaving the rendered object's newer version unread", async () => {
    const fixture = setup();
    const first = fixture.open();
    fixture.edit('monitor-a', 'high');
    fixture.edit('monitor-b', 'normal');
    await fixture.emit(first.runtime, 'v1');
    fixture.edit('monitor-a', 'normal');
    await fixture.emit(first.runtime, 'v2');

    const events = first.store.unreadEventsForSession(first.sessionId);
    // Both monitors use shared-object. Only monitor-a's normal endpoint
    // conflicts with the concrete high version this interrupt will render.
    expect(
      first.runtime.previewCoalescedReminder(first.sessionId),
    ).toBeDefined();
    const claim = deliver(
      first.runtime,
      first.sessionId,
      'turn-interruptible',
      transport,
    );
    expect(
      claim?.events.map((event) => [event.monitorId, event.summary]),
    ).toEqual([['monitor-a', 'v1']]);
    expect(claim?.coalescedReminder).toBeDefined();
    expect(claim?.coalescedNormalCount).toBe(2);
    const pending = first.store.pendingEventsForSession(first.sessionId);
    expect(pending.map((event) => [event.monitorId, event.summary])).toEqual([
      ['monitor-a', 'v2'],
    ]);
    for (const monitorId of ['monitor-a', 'monitor-b']) {
      const projections = first.store.listDeliveryProjectionsForMonitor(
        monitorId,
        fixture.workspace,
      );
      for (const projection of projections) {
        expect(projection.acknowledgedAt).toBeUndefined();
        expect(Boolean(projection.firstNotifiedAt)).toBe(
          !pending.some((event) => event.id === projection.eventId),
        );
        expect(projection.netSuppressed ?? false).toBe(
          monitorId === 'monitor-b' &&
            events.find((event) => event.id === projection.eventId)?.summary ===
              'v1',
        );
      }
    }

    first.client.close();
    const restarted = fixture.open();
    expect(
      restarted.store
        .pendingEventsForSession(restarted.sessionId)
        .map((event) => event.id),
    ).toEqual(pending.map((event) => event.id));
    const next = deliver(
      restarted.runtime,
      restarted.sessionId,
      'turn-interruptible',
      transport,
    );
    expect(next?.urgency).toBe('normal');
    expect(
      restarted.store.pendingEventsForSession(restarted.sessionId),
    ).toEqual([]);
  });

  describe.each(['turn-interruptible', 'turn-idle', 'post-compact'] as const)(
    '%s',
    (lifecycle) => {
      it.each([1, 2])(
        'preserves unseen versions after urgency edits across %i monitor(s) sharing an object key',
        async (monitorCount) => {
          const fixture = setup();
          const first = fixture.open();
          const monitorIds = ['monitor-a', 'monitor-b'].slice(0, monitorCount);
          const initialUrgency = lifecycle === 'turn-idle' ? 'low' : 'high';
          for (const id of monitorIds) fixture.edit(id, initialUrgency);
          await fixture.emit(first.runtime, 'v1');
          for (const id of monitorIds) fixture.edit(id, 'normal');
          await fixture.emit(first.runtime, 'v2');
          const events = first.store.unreadEventsForSession(first.sessionId);
          expect(events).toHaveLength(monitorCount * 2);
          expect(
            events.filter((e) => e.summary === 'v1').map((e) => e.urgency),
          ).toEqual(monitorIds.map(() => initialUrgency));
          expect(
            events.filter((e) => e.summary === 'v2').map((e) => e.urgency),
          ).toEqual(monitorIds.map(() => 'normal'));

          if (lifecycle === 'turn-interruptible') {
            expect(
              first.runtime.previewCoalescedReminder(first.sessionId),
            ).toBeUndefined();
            expect(
              first.runtime
                .previewSettledHighDelivery(first.sessionId)
                .map((e) => e.summary),
            ).toEqual(monitorIds.map(() => 'v1'));
          }
          const claim = deliver(
            first.runtime,
            first.sessionId,
            lifecycle,
            transport,
          );
          expect(claim).not.toBeNull();
          if (lifecycle === 'turn-interruptible') {
            expect(claim?.events.map((e) => e.summary)).toEqual(
              monitorIds.map(() => 'v1'),
            );
          } else if (lifecycle === 'post-compact') {
            expect(claim?.events.map((e) => e.summary)).toEqual(
              monitorIds.map(() => 'v2'),
            );
          } else {
            expect(claim?.urgency).toBe('low');
            expect(claim?.events).toEqual([]);
          }
          for (const id of monitorIds) {
            const projections = first.store.listDeliveryProjectionsForMonitor(
              id,
              fixture.workspace,
            );
            expect(projections).toHaveLength(2);
            expect(
              first.store.getSessionObjectCursor(
                first.sessionId,
                id,
                'shared-object',
                fixture.workspace,
              )?.baselineContent,
            ).toBe(lifecycle === 'post-compact' ? 'v2' : 'v1');
            for (const projection of projections) {
              const event = events.find((e) => e.id === projection.eventId);
              expect(event).toBeDefined();
              expect(projection.acknowledgedAt).toBeUndefined();
              if (lifecycle === 'post-compact') {
                // Only the older net intermediate may be consumed without its own
                // event block: the recap actually surfaces its v2 endpoint.
                expect(projection.firstNotifiedAt).toBeDefined();
                expect(projection.netSuppressed ?? false).toBe(
                  event?.summary === 'v1',
                );
              } else {
                expect(projection.netSuppressed).toBeUndefined();
                expect(projection.deliveryState).toBe(
                  event?.summary === 'v1' ? 'claimed' : 'unread',
                );
                expect(Boolean(projection.firstNotifiedAt)).toBe(
                  event?.summary === 'v1',
                );
              }
            }
          }

          if (lifecycle === 'turn-interruptible') {
            expect(claim?.coalescedReminder).toBeUndefined();
          }

          first.client.close();
          const restarted = fixture.open();
          expect(restarted.sessionId).toBe(first.sessionId);
          const pending = restarted.store.pendingEventsForSession(
            restarted.sessionId,
          );
          expect(pending.map((e) => e.summary)).toEqual(
            lifecycle === 'post-compact' ? [] : monitorIds.map(() => 'v2'),
          );
          const next = deliver(
            restarted.runtime,
            restarted.sessionId,
            'turn-interruptible',
            transport,
          );
          if (lifecycle === 'post-compact') {
            expect(next).toBeNull();
          } else {
            expect(next?.urgency).toBe('normal');
            expect(
              restarted.store.pendingEventsForSession(restarted.sessionId),
            ).toEqual([]);
            expect(
              restarted.store.unreadEventsForSession(restarted.sessionId),
            ).toHaveLength(monitorCount * 2);
          }
        },
      );
    },
  );

  it('leaves net groups outside the recap cap pending across restart', async () => {
    const fixture = setup();
    const first = fixture.open();
    for (let i = 0; i < 12; i += 1)
      fixture.edit(`monitor-${String(i).padStart(2, '0')}`, 'high');
    await fixture.emit(first.runtime, 'v1');
    await fixture.emit(first.runtime, 'v2');
    const claim = deliver(
      first.runtime,
      first.sessionId,
      'post-compact',
      transport,
    );
    expect(claim?.events).toHaveLength(10);
    const rendered = new Set(claim?.events.map((e) => e.monitorId));
    const pending = first.store.pendingEventsForSession(first.sessionId);
    expect(pending).toHaveLength(4);
    for (const event of first.store.listEvents({
      workspacePath: fixture.workspace,
    })) {
      const projection = first.store
        .listDeliveryProjectionsForMonitor(event.monitorId, fixture.workspace)
        .find((p) => p.eventId === event.id);
      expect(projection?.acknowledgedAt).toBeUndefined();
      expect(Boolean(projection?.firstNotifiedAt)).toBe(
        rendered.has(event.monitorId),
      );
      expect(projection?.netSuppressed ?? false).toBe(
        rendered.has(event.monitorId) && event.summary === 'v1',
      );
    }
    first.client.close();
    const restarted = fixture.open();
    const next = deliver(
      restarted.runtime,
      restarted.sessionId,
      'turn-interruptible',
      transport,
    );
    expect(next?.events).toHaveLength(2);
    expect(
      next?.events.every(
        (e) => e.summary === 'v2' && !rendered.has(e.monitorId),
      ),
    ).toBe(true);
  });
});
