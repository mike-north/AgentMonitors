/**
 * Tests for the pure hook-delivery renderer.
 *
 * @see https://docs.claude.ai/en/api/claude-code/hooks
 */
import { describe, it, expect } from 'vitest';
import type { DeliveryClaim } from '@agentmonitors/core';
import { renderHookDelivery } from './hook-deliver-render.js';

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

  // (b) zero-events claim → null
  it('returns null when the claim has no events', () => {
    expect(
      renderHookDelivery(makeClaim({ events: [] }), 'PreToolUse'),
    ).toBeNull();
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
