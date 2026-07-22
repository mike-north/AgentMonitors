import { describe, expect, it } from 'vitest';
import type { DeliveryClaim } from '@agentmonitors/core';
import {
  buildChannelTruncatedMarker,
  CHANNEL_DEFERRED_MARKER,
  MAX_CHANNEL_CONTENT,
  renderChannelEvent,
} from './channel-render.js';
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

  // 006 §4.6 / §4.2.1 / §5.5 (issue #436 human-review finding #3): the
  // per-event diff bound is an INDEPENDENT truncation layer from the
  // channel's own content ceiling (`MAX_CHANNEL_CONTENT`, 20,000 chars,
  // exercised further down this file) — the channel packs WHOLE blocks under
  // that ceiling (never dropping a partial block to fit), with the single
  // exception of a lone oversized event, which `renderChannelEvent`
  // mid-truncates as a last resort (§4.2.1). The per-event diff bound applies
  // regardless of overall size, so no single untrusted diff is dumped
  // wholesale even when the whole claim comfortably fits under the ceiling.
  // Its elision marker is applied INSIDE buildEventBlock and then sanitized,
  // so a truncated block can never reintroduce a tag-breakout character. This
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

  // Issue #441 cross-monitor coalescing (PR #456 review finding 2): mirrors
  // `renderHookDelivery`'s identical footer — `claim.coalescedReminder` must
  // be surfaced explicitly whenever set, since `claim.events`/`claim.message`
  // carry no representation of it on their own, and `claimDelivery` claims
  // the coalesced normal rows alongside the surfaced high events (006 §5.5).
  it('appends the coalesced reminder footer after the packed event block(s)', () => {
    const { content } = renderChannelEvent(
      makeClaim({
        coalescedReminder: 'AgentMon messages are available. Read the inbox.',
      }),
    );
    expect(content).toContain('package.json changed');
    expect(content).toContain(
      'AgentMon messages are available. Read the inbox.',
    );
    expect(
      content.indexOf('package.json changed') <
        content.indexOf('AgentMon messages are available'),
    ).toBe(true);
  });

  it('does not render a coalesced-reminder footer when the field is absent (ordinary high-only claim, unchanged)', () => {
    const { content } = renderChannelEvent(makeClaim());
    expect(content).not.toContain('AgentMon messages are available');
  });

  it('reserves room for the coalesced reminder footer so content never exceeds MAX_CHANNEL_CONTENT', () => {
    const bigDiff = '+ added line\n'.repeat(2_000); // well past the per-event bound
    const { content } = renderChannelEvent(
      makeClaim({
        coalescedReminder: 'AgentMon messages are available. Read the inbox.',
        events: [
          {
            eventId: 'e1',
            monitorId: 'build-drift',
            title: 'package.json changed',
            summary: 'package.json changed',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: 'Review whether build behavior needs updating.',
            diffText: bigDiff,
          },
        ],
      }),
    );
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
    expect(content).toContain('AgentMon messages are available');
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

  // 006 §5.5: when the coalesced claim's blocks all fit under
  // MAX_CHANNEL_CONTENT, the channel renders every event it claims uncut — the
  // claimed set equals the rendered set. A large coalesced delivery whose
  // joined blocks exceed the old 4000-char hook cap, but stay under
  // MAX_CHANNEL_CONTENT, must still render every block, uncut.
  it('renders every event of a large coalesced claim under the ceiling, uncut', () => {
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

  // Issue #442 (PR #442 review comment 3609314694): an OVERSIZED FIRST event
  // must not bypass the ceiling. `packChannelEventsUnderCap` deliberately
  // returns at least 1 for a non-empty list (forward progress), so `channel.ts`
  // will size/reserve a single event even when that event's OWN body dwarfs
  // MAX_CHANNEL_CONTENT — before this fix, `renderChannelEvent` joined the
  // block unconditionally with no size check at all, reproducing exactly the
  // on-head probe: a 5,000,000-char body yielding `{ cap: 20000, fit: 1,
  // contentLength: 5000016 }`.
  it('mid-truncates a single oversized event so the pushed content never exceeds the ceiling', () => {
    const hugeBody = 'x'.repeat(5_000_000);
    const sessionId = 'sess-abc123';
    const { content } = renderChannelEvent(
      makeClaim({
        sessionId,
        events: [
          {
            eventId: 'e1',
            monitorId: 'runaway-monitor',
            title: 'huge payload',
            summary: 'huge payload',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: hugeBody,
          },
        ],
      }),
    );
    // The invariant the ceiling exists to guarantee, verified on the ACTUAL
    // pushed content — not merely on what the packer sizing function returns.
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
    // Signposted, not silently dropped: the still-unread full body is
    // recoverable via a DIRECTLY RUNNABLE session-scoped command (`events
    // list` requires `--session`, issue #420 P2 — PR #442 round-6 review), not
    // the bare `--unread` form that would exit 1. This render happens BEFORE
    // the reservation is committed (issue #442, PR #442 round-11/round-12
    // review) — at render time it is genuinely unknown whether the commit
    // that follows will land, so it must use `buildChannelTruncatedMarker`'s
    // outcome-neutral marker (issue #442 round-5/round-6), not the
    // `CHANNEL_DEFERRED_MARKER` alone, which would promise a later-poll
    // re-delivery this single (non-mixed) case cannot guarantee.
    expect(content).toContain(buildChannelTruncatedMarker(sessionId).trim());
    expect(content).toContain(
      `agentmonitors events list --session ${sessionId} --unread`,
    );
    expect(content).not.toContain(CHANNEL_DEFERRED_MARKER.trim());
    // Still channel-safe: no tag-breakout characters survive truncation.
    expect(content).not.toMatch(/[<>[\]\r]/);
  });

  // Same pathological case, but with a second small event queued behind the
  // oversized first one: the first block is mid-truncated AND a second,
  // genuinely distinct event stays pending beyond this claim
  // (packChannelEventsUnderCap sized/reserved exactly the one oversized
  // event, so the second was never claimed). This is the MIXED case (issue
  // #442, PR #442 round-12 review): the mid-truncated event's own tail and
  // the separately-deferred remainder are two different, non-overlapping
  // facts, so BOTH markers must be signposted — rendering only the
  // truncation marker would silently drop the "more work is pending" signal,
  // contradicting 006 §5.5's candidate-growth guarantee (and diverging from
  // the hook transport's `renderHookDelivery`, which renders both of its
  // analogous markers in the identical mixed case).
  it('mid-truncates the oversized first event AND signposts the genuinely deferred remainder (mixed case)', () => {
    const hugeBody = 'y'.repeat(5_000_000);
    const sessionId = 'sess-def456';
    const { content, meta } = renderChannelEvent(
      makeClaim({
        sessionId,
        events: [
          {
            eventId: 'e1',
            monitorId: 'runaway-monitor',
            title: 'huge payload',
            summary: 'huge payload',
            urgency: 'high',
            createdAt: '2026-01-01T00:00:00.000Z',
            body: hugeBody,
          },
        ],
        unreadCounts: { low: 0, normal: 0, high: 2, total: 2 },
      }),
      { moreDeferred: true },
    );
    // The content ceiling still holds even with both markers appended.
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
    // The mid-truncated event's own tail: recoverable via the durable,
    // directly-runnable session-scoped recovery command — an
    // outcome-neutral fact that holds regardless of whether the pending
    // commit (not yet attempted at render time) ultimately lands.
    expect(content).toContain(buildChannelTruncatedMarker(sessionId).trim());
    expect(content).toContain(
      `agentmonitors events list --session ${sessionId} --unread`,
    );
    // The separately deferred remainder: a second, distinct event exists
    // beyond this claim and will surface on a later poll.
    expect(content).toContain(CHANNEL_DEFERRED_MARKER.trim());
    expect(meta.event_count).toBe('1');
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

// ---------------------------------------------------------------------------
// PR #442 round-6 review: `agentmonitors events list` requires `--session
// <id>` (issue #420 P2); the truncation marker must render a directly
// executable command, not the bare `--unread` form the reviewer confirmed
// exits 1.
// ---------------------------------------------------------------------------
describe('buildChannelTruncatedMarker', () => {
  it('renders the exact runnable recovery command, including the real session id', () => {
    const marker = buildChannelTruncatedMarker('session-42');
    expect(marker).toBe(
      '\n\n(this update was too large to show in full; run `agentmonitors events list --session session-42 --unread` to see the full copy)',
    );
  });

  it('sanitizes a session id carrying tag/attribute-breakout characters', () => {
    const marker = buildChannelTruncatedMarker('a<b>c[d];e\r\nf');
    // The raw, unsanitized id must not survive verbatim into the marker.
    expect(marker).not.toContain('a<b>c[d];e\r\nf');
    // No tag-breakout or attribute-breakout characters survive from the
    // EMBEDDED session id (§4.6) — the marker's own template intentionally
    // starts with `\n\n`, so only the id-derived characters are checked here.
    const [, embeddedId] = /--session (\S+) --unread/.exec(marker) ?? [
      undefined,
      '',
    ];
    expect(embeddedId).not.toMatch(/[<>[\]\r\n;]/);
    expect(marker).toContain('agentmonitors events list --session');
  });

  // Issue #358/#442, PR #442 round-7 review: `events list` resolves its
  // socket env-first (issue #335), so a bare (no `--socket`) marker command
  // could silently query a stale or different workspace's daemon. The marker
  // must carry the EXACT socket `channel serve` is bound to.
  it('threads the resolved socket path into the marker as an explicit --socket flag', () => {
    const marker = buildChannelTruncatedMarker(
      'session-42',
      '/tmp/agentmon-real.sock',
    );
    expect(marker).toBe(
      "\n\n(this update was too large to show in full; run `agentmonitors events list --session session-42 --socket '/tmp/agentmon-real.sock' --unread` to see the full copy)",
    );
  });

  it('shell-quotes a socket path so the advertised command stays safe to paste', () => {
    const marker = buildChannelTruncatedMarker(
      'session-42',
      "/tmp/weird ' path.sock",
    );
    expect(marker).toContain(
      String.raw`--socket $'/tmp/weird\x20\x27\x20path.sock'`,
    );
  });

  it('omits --socket entirely when no socket path is supplied', () => {
    const marker = buildChannelTruncatedMarker('session-42');
    expect(marker).not.toContain('--socket');
  });

  // PR #442 round-8 review: the socket path is interpolated into `content`
  // AFTER `contentValue`'s tag-safety sanitization pass has already run, so an
  // explicit path carrying tag-breakout characters must not reintroduce them
  // raw into the pushed content.
  it('never lets a socket path reintroduce a forbidden tag-breakout character into the marker', () => {
    const marker = buildChannelTruncatedMarker(
      'session-42',
      '/tmp/x<channel>[oops];bad\r\nend`.sock',
    );
    // Isolate ONLY the interpolated `--socket <escaped>` clause — the marker's
    // own fixed template legitimately contains a backtick pair (a markdown
    // code span around the advertised command), which is not the thing under
    // test here.
    const [, socketClause] = /--socket (\S+) --unread/.exec(marker) ?? [
      undefined,
      '',
    ];
    expect(socketClause).not.toMatch(/[<>[\]\r\n;`]/);
    expect(socketClause).toContain(String.raw`\x3c`);
    expect(socketClause).toContain(String.raw`\x60`);
  });
});
