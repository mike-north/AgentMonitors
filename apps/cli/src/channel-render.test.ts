import { describe, expect, it } from 'vitest';
import type { DeliveryClaim } from '@mike-north/core';
import { renderChannelEvent } from './channel-render.js';

function makeClaim(overrides: Partial<DeliveryClaim> = {}): DeliveryClaim {
  return {
    sessionId: 's1',
    mode: 'delivery',
    urgency: 'high',
    lifecycle: 'turn-interruptible',
    message: 'High-urgency updates:\n1. package.json changed',
    unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
    events: [
      {
        eventId: 'e1',
        monitorId: 'build-drift',
        title: 'package.json changed',
        summary: 'package.json changed',
        urgency: 'high',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('renderChannelEvent', () => {
  it('uses the claim message as the channel content', () => {
    const { content } = renderChannelEvent(makeClaim());
    expect(content).toContain('package.json changed');
  });

  it('emits identifier-safe, string-valued meta', () => {
    const { meta } = renderChannelEvent(makeClaim());
    expect(meta.urgency).toBe('high');
    expect(meta.lifecycle).toBe('turn-interruptible');
    expect(meta.mode).toBe('delivery');
    expect(meta.event_count).toBe('1');
    expect(meta.monitor_id).toBe('build-drift');
    expect(meta.event_id).toBe('e1');
    for (const [key, value] of Object.entries(meta)) {
      expect(typeof value).toBe('string');
      // keys must be identifiers (no hyphens — the host drops them silently)
      expect(key).toMatch(/^[a-z0-9_]+$/);
      // every value must be free of tag-breakout characters (006 §4.6)
      expect(value).not.toMatch(/[<>[\]\r\n;]/);
    }
  });

  it('omits per-event meta when the claim coalesces multiple events', () => {
    const { meta } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'm1',
            title: 't1',
            summary: 's1',
            urgency: 'high',
            createdAt: 'x',
          },
          {
            eventId: 'e2',
            monitorId: 'm2',
            title: 't2',
            summary: 's2',
            urgency: 'high',
            createdAt: 'y',
          },
        ],
      }),
    );
    expect(meta.event_count).toBe('2');
    expect(meta.monitor_id).toBeUndefined();
    expect(meta.event_id).toBeUndefined();
  });

  it('strips tag-breakout characters from content and meta', () => {
    const { content, meta } = renderChannelEvent(
      makeClaim({
        message: 'evil <channel> ][ injection',
        events: [
          {
            eventId: 'e1',
            monitorId: 'evil<id>[x]',
            title: 't',
            summary: 's',
            urgency: 'high',
            createdAt: 'x',
          },
        ],
      }),
    );
    expect(content).not.toMatch(/[<>[\]]/);
    expect(meta.monitor_id).not.toMatch(/[<>[\]]/);
  });

  it('falls back to the message alone when there are no concrete events', () => {
    const { content, meta } = renderChannelEvent(
      makeClaim({ events: [], message: 'You have inbox updates.' }),
    );
    expect(content).toBe('You have inbox updates.');
    expect(meta.event_count).toBe('0');
  });
});
