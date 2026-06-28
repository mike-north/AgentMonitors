/**
 * Tests for the pure hook-delivery renderer.
 *
 * @see https://docs.claude.ai/en/api/claude-code/hooks
 */
import { describe, it, expect } from 'vitest';
import type { DeliveryClaim } from '@agentmonitors/core';
import { renderHookDelivery } from './hook-deliver-render.js';

/**
 * True if `s` contains a lone (unpaired) UTF-16 surrogate code unit — the
 * corruption a UTF-16-unit-boundary truncation would introduce by cutting an
 * astral code point (e.g. an emoji) in half.
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate: must be followed by a low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // consume the valid pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // low surrogate without a preceding high surrogate
      return true;
    }
  }
  return false;
}

function makeClaim(overrides: Partial<DeliveryClaim> = {}): DeliveryClaim {
  return {
    sessionId: 's1',
    mode: 'delivery',
    urgency: 'high',
    lifecycle: 'turn-interruptible',
    message: '1 monitor fired',
    unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
    events: [
      {
        eventId: 'e1',
        monitorId: 'watch-src',
        title: 'Files changed',
        summary: 'Files changed',
        body: 'Review the diff; flag risky changes.',
        urgency: 'high',
        createdAt: '2026-06-04T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('renderHookDelivery', () => {
  // (a) null claim → null
  it('returns null for a null claim (nothing pending)', () => {
    expect(renderHookDelivery(null, 'PreToolUse')).toBeNull();
  });

  // (b) zero-events claim with a BLANK message → null. The runtime never
  // produces this (claimDelivery returns null when nothing is pending), but the
  // renderer must stay silent defensively rather than emit an empty reminder.
  it('returns null when the claim has no events and a blank message', () => {
    expect(
      renderHookDelivery(
        makeClaim({ events: [], message: '   ' }),
        'PreToolUse',
      ),
    ).toBeNull();
  });

  // (b.2 — issue #198, AC1) a NORMAL-urgency turn-interruptible claim carries
  // events:[] but a populated reminder message. It must render a non-empty
  // additionalContext (the reminder line), NOT null — otherwise a default
  // monitor is silent mid-session.
  it('renders a reminder line for a normal-urgency claim with no event bodies', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'normal',
        events: [],
        message: 'AgentMon messages are available. Read the inbox.',
        unreadCounts: { low: 0, normal: 1, high: 0, total: 1 },
      }),
      'UserPromptSubmit',
    );
    expect(out).not.toBeNull();
    expect(out?.continue).toBe(true);
    expect(out?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.trim()).not.toBe('');
    expect(ctx).toContain('AgentMon messages are available. Read the inbox.');
    // Reminder only — no body-injection block markers leak in.
    expect(ctx).not.toContain('### ');
    // Advisory only — no permissionDecision field.
    expect(out).not.toHaveProperty('permissionDecision');
  });

  // (b.3 — issue #198, AC2) the same for LOW urgency (turn-idle reminder).
  it('renders a reminder line for a low-urgency claim with no event bodies', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'low',
        lifecycle: 'turn-idle',
        events: [],
        message: 'AgentMon has inbox updates ready for review.',
        unreadCounts: { low: 1, normal: 0, high: 0, total: 1 },
      }),
      'UserPromptSubmit',
    );
    expect(out).not.toBeNull();
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.trim()).not.toBe('');
    expect(ctx).toContain('AgentMon has inbox updates ready for review.');
    expect(ctx).not.toContain('### ');
  });

  // (b.4 — issue #198, AC1) the reminder text is sanitized (control characters
  // stripped) and round-trips as valid JSON, like the body-injection path.
  it('sanitizes the reminder message and produces valid JSON', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'normal',
        events: [],
        message: 'AgentMon messages are available.\x00 Read the inbox.',
      }),
      'UserPromptSubmit',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).not.toContain('\x00');
    expect(ctx).toContain('AgentMon messages are available. Read the inbox.');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  // (c) a claim with a high-urgency event → full advisory wire output
  it('renders a high-urgency event as advisory context', () => {
    const out = renderHookDelivery(makeClaim(), 'PreToolUse');
    expect(out).not.toBeNull();
    // Wire shape: continue + hookSpecificOutput
    expect(out?.continue).toBe(true);
    expect(out?.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    // Advisory: body text must appear in additionalContext
    expect(out?.hookSpecificOutput.additionalContext).toContain('watch-src');
    expect(out?.hookSpecificOutput.additionalContext).toContain(
      'Review the diff; flag risky changes.',
    );
    // Advisory only — no permissionDecision field
    expect(out).not.toHaveProperty('permissionDecision');
  });

  // (c.2 — issue #198, AC4) a post-compact recap claim carries events with
  // bodies; the renderer still injects the full per-event block(s) verbatim —
  // the reminder-only path (events:[]) must not change this behavior.
  it('renders a post-compact recap claim with full body blocks (unchanged)', () => {
    const out = renderHookDelivery(
      makeClaim({
        mode: 'recap',
        urgency: undefined,
        lifecycle: 'post-compact',
        message: 'Recap of recent AgentMon activity since your last recap:',
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Files changed',
            summary: 'Files changed',
            body: 'Review the diff; flag risky changes.',
            urgency: 'normal',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'SessionStart',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain('### watch-src');
    expect(ctx).toContain('Review the diff; flag risky changes.');
  });

  // hookEventName is echoed exactly
  it('echoes the hookEventName into hookSpecificOutput', () => {
    const out = renderHookDelivery(makeClaim(), 'Stop');
    expect(out?.hookSpecificOutput.hookEventName).toBe('Stop');
  });

  // (d) sanitization: a monitor body is trusted, user-authored markdown, and
  // additionalContext is a JSON string (JSON.stringify escapes everything), so
  // code/markdown punctuation (`<>`, `[]`, `;`, newlines) MUST be preserved
  // verbatim — only raw control characters are removed, and the result must
  // remain valid JSON.
  it('preserves markdown/code in the body and strips only control characters', () => {
    const body = 'Use `Array<T>`; see [the spec](url).\nLine two.';
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Changed <stuff>',
            summary: 's',
            // includes a NUL and a CR (control chars that must be stripped),
            // surrounding legitimate markdown that must survive
            body: `${body}\x00\r`,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    expect(out).not.toBeNull();
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    // Markdown/code punctuation and newlines are preserved verbatim
    expect(ctx).toContain('Use `Array<T>`; see [the spec](url).');
    expect(ctx).toContain('Line two.');
    expect(ctx).toContain('<stuff>');
    // Raw control characters are removed
    expect(ctx).not.toContain('\x00');
    expect(ctx).not.toContain('\r');
    // The full output round-trips as valid JSON (the wire requirement)
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  // (d.2) whitespace structure is preserved verbatim — no trim. A body that
  // starts with an indented code block must keep its indentation/newlines.
  it('preserves leading indentation and newlines in the body (no trim)', () => {
    const body = '    const x = 1;\n    return x;\n';
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Code changed',
            summary: 's',
            body,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    // the indented code block survives intact
    expect(ctx).toContain('    const x = 1;\n    return x;');
  });

  // (e) length cap: a very large body is capped at the configured limit
  it('caps total additionalContext length at 4000 chars', () => {
    const largeBody = 'x'.repeat(10_000);
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Files changed',
            summary: 'Files changed',
            body: largeBody,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    expect(out).not.toBeNull();
    expect(
      (out?.hookSpecificOutput.additionalContext ?? '').length,
    ).toBeLessThanOrEqual(4000);
  });

  // (e.2) truncation marker: an over-cap body yields output that is (a) ≤ cap
  // and (b) ends with the explicit truncation marker pointing at the still-
  // unread events. The marker proves the truncation is signposted, not silent.
  const TRUNCATION_TAIL =
    'run `agentmonitors events list --unread` to see the rest]';
  it('appends an explicit truncation marker when over the cap', () => {
    const largeBody = 'x'.repeat(10_000);
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Files changed',
            summary: 'Files changed',
            body: largeBody,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    // (a) still ≤ cap INCLUDING the marker
    expect(ctx.length).toBeLessThanOrEqual(4000);
    // (b) ends with the truncation marker
    expect(ctx.endsWith(TRUNCATION_TAIL)).toBe(true);
    expect(ctx).toContain('[truncated');
  });

  // (e.3) when the content fits under the cap, NO marker is appended.
  it('does not append a truncation marker when under the cap', () => {
    const out = renderHookDelivery(makeClaim(), 'PreToolUse');
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).not.toContain('[truncated');
  });

  // (e.4) surrogate-pair safety: when an astral character (emoji, a UTF-16
  // surrogate pair) sits exactly at the truncation boundary, it must be dropped
  // WHOLESALE — never split into a lone surrogate, which would corrupt the JSON
  // wire output. We pad the body so the cut lands on the emoji, then assert the
  // result contains no lone surrogate and round-trips as valid JSON.
  it('truncates at a code-point boundary and never splits a surrogate pair', () => {
    // Build a body of emoji (each '😀' is a surrogate pair, .length === 2) long
    // enough to force truncation. With every character occupying 2 UTF-16 units,
    // a naive .slice() at an odd budget would split one in half.
    const emoji = '😀';
    const body = emoji.repeat(5_000); // 10_000 UTF-16 units → forces truncation
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'm',
            title: 't',
            summary: 's',
            body,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.length).toBeLessThanOrEqual(4000);
    // No lone surrogate: every UTF-16 code unit in the high-surrogate range
    // [0xD800, 0xDBFF] must be immediately followed by a low surrogate
    // [0xDC00, 0xDFFF], and no low surrogate may appear without a preceding
    // high surrogate. A naive .slice() at an odd boundary would leave a lone
    // half here.
    expect(hasLoneSurrogate(ctx)).toBe(false);
    // The wire output round-trips as valid JSON (the wire requirement).
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    // And it still ends with the truncation marker.
    expect(ctx.endsWith(TRUNCATION_TAIL)).toBe(true);
  });

  // multi-event claim: both monitorIds appear
  it('includes all monitor bodies when multiple events are present', () => {
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'mon-a',
            title: 'Title A',
            summary: 's',
            body: 'Body A content',
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
          {
            eventId: 'e2',
            monitorId: 'mon-b',
            title: 'Title B',
            summary: 's',
            body: 'Body B content',
            urgency: 'normal',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'PreToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain('mon-a');
    expect(ctx).toContain('mon-b');
    expect(ctx).toContain('Body A content');
    expect(ctx).toContain('Body B content');
  });
});
