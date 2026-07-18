import { describe, expect, it } from 'vitest';
import type { DeliveryClaim } from '@agentmonitors/core';
import { renderChannelEvent } from './channel-render.js';
import {
  DIFF_ELISION_MARKER,
  MAX_EVENT_DIFF,
} from './delivery-event-render.js';

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
        body: 'Review whether build behavior or dependency state needs updating.',
      },
    ],
    ...overrides,
  };
}

describe('renderChannelEvent', () => {
  // Issue #436: a high-urgency channel delivery must render the SAME event
  // content the hook path injects — title + monitor body + a bounded change
  // summary — not the title alone.
  it('renders the title, the monitor body, and the change summary for a high-urgency event', () => {
    const { content } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'build-drift',
            title: 'package.json changed',
            summary: 'package.json changed',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: 'Review whether build behavior needs updating.',
            diffText: '- "version": "1.0.0"\n+ "version": "1.1.0"',
          },
        ],
      }),
    );
    // title
    expect(content).toContain('package.json changed');
    // monitor body-instructions (the author's "what to do")
    expect(content).toContain('Review whether build behavior needs updating.');
    // the bounded change summary (diffText)
    expect(content).toContain('Changes:');
    expect(content).toContain('+ "version": "1.1.0"');
    // per-event header carries monitor id + urgency
    expect(content).toContain('### build-drift (high)');
  });

  it('omits the Changes section when the event carries no diff', () => {
    const { content } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'build-drift',
            title: 'package.json changed',
            summary: 'package.json changed',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: 'Do the thing.',
          },
        ],
      }),
    );
    expect(content).toContain('Do the thing.');
    expect(content).not.toContain('Changes:');
  });

  it('bounds a large change summary with an explicit elision marker', () => {
    const bigDiff = '+ added line\n'.repeat(500); // well past MAX_EVENT_DIFF
    const { content } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'build-drift',
            title: 'a lot changed',
            summary: 'a lot changed',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: 'inspect the diff',
            diffText: bigDiff,
          },
        ],
      }),
    );
    expect(content).toContain(DIFF_ELISION_MARKER.trim());
    // The whole change summary must not exceed its per-event bound.
    const changesIdx = content.indexOf('Changes:\n');
    const rendered = content.slice(changesIdx + 'Changes:\n'.length);
    expect(rendered.length).toBeLessThanOrEqual(MAX_EVENT_DIFF);
  });

  // 006 §4.6 (issue #436 human-review finding #3): the per-event diff bound is
  // the ONLY remaining truncation path on the channel surface (the overall
  // content cap was removed — the channel is not length-bounded, §5.5). Its
  // elision marker is applied INSIDE buildEventBlock and then sanitized, so a
  // truncated block can never reintroduce a tag-breakout character. This
  // exercises truncation and breakout characters TOGETHER: a huge diff whose
  // content is full of `<`, `>`, `[`, `]` must still yield content with NONE of
  // the forbidden characters, marker included.
  it('a truncated change summary never reintroduces forbidden characters', () => {
    const evilBigDiff = '+ <tag>[idx]</tag>\n'.repeat(500); // past MAX_EVENT_DIFF
    const { content } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'build-drift',
            title: 'a lot changed',
            summary: 'a lot changed',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: 'inspect the diff',
            diffText: evilBigDiff,
          },
        ],
      }),
    );
    // Truncation actually happened on this path...
    expect(content).toContain(DIFF_ELISION_MARKER.trim());
    // ...and the COMPLETE returned content — marker and all — is tag-safe: none
    // of the forbidden tag-body characters (`<`, `>`, `[`, `]`, `\r`) survive.
    expect(content).not.toMatch(/[<>[\]\r]/);
  });

  it('renders one block per event for a coalesced high-urgency claim', () => {
    const { content } = renderChannelEvent(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'm1',
            title: 't1',
            summary: 's1',
            urgency: 'high',
            createdAt: 'x',
            body: 'body one',
          },
          {
            eventId: 'e2',
            monitorId: 'm2',
            title: 't2',
            summary: 's2',
            urgency: 'high',
            createdAt: 'y',
            body: 'body two',
          },
        ],
      }),
    );
    expect(content).toContain('### m1 (high)');
    expect(content).toContain('body one');
    expect(content).toContain('### m2 (high)');
    expect(content).toContain('body two');
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
            body: 'b1',
          },
          {
            eventId: 'e2',
            monitorId: 'm2',
            title: 't2',
            summary: 's2',
            urgency: 'high',
            createdAt: 'y',
            body: 'b2',
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
        events: [
          {
            eventId: 'e1',
            monitorId: 'evil<id>[x]',
            title: 't',
            summary: 's',
            urgency: 'high',
            createdAt: 'x',
            body: 'evil <channel> ][ injection in the body',
            diffText: 'evil <tag> [in] the diff',
          },
        ],
      }),
    );
    expect(content).not.toMatch(/[<>[\]]/);
    expect(meta.monitor_id).not.toMatch(/[<>[\]]/);
  });

  // 006 §5.5: the channel claims the FULL delivered set (no `maxEvents`), so it
  // MUST render every event it claims — the claimed set MUST equal the rendered
  // set. A large coalesced delivery whose joined blocks exceed the old 4000-char
  // hook cap must still render every block, uncut.
  it('renders every event of a large coalesced claim with no overall content cap', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      eventId: `e${i}`,
      monitorId: `monitor-${i}`,
      title: `title ${i}`,
      summary: `summary ${i}`,
      urgency: 'high' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      body: 'x'.repeat(300),
    }));
    const { content, meta } = renderChannelEvent(
      makeClaim({
        events,
        unreadCounts: { low: 0, normal: 0, high: 30, total: 30 },
      }),
    );
    // Comfortably past the removed hook-style 4000-char cap.
    expect(content.length).toBeGreaterThan(4000);
    expect(content).not.toContain('truncated');
    for (const event of events) {
      expect(content).toContain(`### ${event.monitorId} (high)`);
      expect(content).toContain(event.title);
    }
    // event_count reflects the full claimed/rendered set, not a partial one.
    expect(meta.event_count).toBe('30');
  });

  // Issue #436: a normal-band reminder carries no concrete events, but its
  // event_count must reflect the pending events it refers to — NOT read "0"
  // (which looks like a bug). 002 §9.2: reminders stay generic.
  it('renders a reminder claim generically and counts the pending events it refers to', () => {
    const { content, meta } = renderChannelEvent(
      makeClaim({
        urgency: 'normal',
        events: [],
        message: 'AgentMon messages are available. Read the inbox.',
        unreadCounts: { low: 0, normal: 3, high: 0, total: 3 },
      }),
    );
    // Stays generic — no injected event bodies leak into a reminder.
    expect(content).toBe('AgentMon messages are available. Read the inbox.');
    expect(content).not.toContain('### ');
    // The referent count is the pending total, not 0.
    expect(meta.event_count).toBe('3');
  });
});
