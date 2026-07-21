/**
 * Unit tests for `events list --format text`'s per-object detail line
 * (issue #449 review, PR #455).
 *
 * `buildEventBlock`'s (`delivery-event-render.ts`) detail line is suppressed
 * when the source summary equals the body, because that template ALSO
 * renders `event.body` on its own line below — an equal summary/body would
 * otherwise duplicate it. `events list --format text` never renders
 * `event.body` at all, so that same suppression would silently drop the
 * ONLY per-object detail a `{ title, body }`-only observation has: a named
 * monitor watching several objects would print one indistinguishable row per
 * object, sharing the monitor's name with no way to tell which object each
 * row is about. This pins that `events list --format text` keeps the detail
 * whenever it differs from `title`, regardless of whether it also equals
 * `body`.
 *
 * @see ../../../../docs/specs/005-cli-reference.md
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MonitorEventRecord } from '@agentmonitors/core';

vi.mock('../runtime-client.js', () => ({
  listEventsClient: vi.fn(),
}));

import { eventsCommand } from './events.js';
import { listEventsClient } from '../runtime-client.js';

const listEventsMock = vi.mocked(listEventsClient);

function makeEvent(overrides: Partial<MonitorEventRecord>): MonitorEventRecord {
  return {
    id: 'event-1',
    workspacePath: null,
    monitorId: 'pr-queue',
    sourceName: 'command-poll',
    urgency: 'normal',
    title: 'PR queue',
    body: 'Review it',
    summary: 'Review it',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey: 'obj-1',
    baselineStrategy: 'net',
    queryScope: {},
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deliveryState: 'unread',
    ...overrides,
  };
}

async function runEventsListText(): Promise<string[]> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await eventsCommand.parseAsync(
      ['list', '--session', 'session-1', '--format', 'text'],
      { from: 'user' },
    );
    return logSpy.mock.calls.map((call) => String(call[0]));
  } finally {
    logSpy.mockRestore();
  }
}

describe('events list --format text: per-object detail for a body-only named multi-object event', () => {
  beforeEach(() => {
    listEventsMock.mockReset();
  });

  it('keeps the per-object detail when summary equals body (a valid { title, body }-only observation materializes summary = body)', async () => {
    listEventsMock.mockResolvedValue([
      makeEvent({
        id: 'event-a',
        title: 'PR queue',
        summary: 'PR #101: needs review',
        body: 'PR #101: needs review',
      }),
    ]);

    const lines = await runEventsListText();
    const row = lines.find((line) => line.includes('event-a'));
    expect(row).toBeDefined();
    // The detail must be present -- dropping it would leave a row
    // indistinguishable from every other object under the same monitor name.
    expect(row).toContain('PR #101: needs review');
  });

  it('two distinct objects under the same named monitor render distinguishable rows', async () => {
    listEventsMock.mockResolvedValue([
      makeEvent({
        id: 'event-a',
        title: 'PR queue',
        summary: 'PR #101: needs review',
        body: 'PR #101: needs review',
      }),
      makeEvent({
        id: 'event-b',
        title: 'PR queue',
        summary: 'PR #202: needs review',
        body: 'PR #202: needs review',
      }),
    ]);

    const lines = await runEventsListText();
    const rowA = lines.find((line) => line.includes('event-a'));
    const rowB = lines.find((line) => line.includes('event-b'));
    expect(rowA).not.toEqual(rowB);
    expect(rowA).toContain('PR #101');
    expect(rowB).toContain('PR #202');
  });

  it('omits the detail when summary equals title (no additional information)', async () => {
    listEventsMock.mockResolvedValue([
      makeEvent({
        id: 'event-c',
        title: 'PR queue',
        summary: 'PR queue',
        body: 'PR queue',
      }),
    ]);

    const lines = await runEventsListText();
    const row = lines.find((line) => line.includes('event-c'));
    expect(row).toBe('event-c  pr-queue  normal  unread  PR queue');
  });
});
