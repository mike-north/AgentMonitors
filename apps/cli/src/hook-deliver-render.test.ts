/**
 * Tests for the pure hook-delivery renderer.
 *
 * @see https://docs.claude.ai/en/api/claude-code/hooks
 */
import { describe, it, expect } from 'vitest';
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  packEventsUnderCap,
  renderHookDelivery,
  renderMonitoringDisabledAdvisory,
} from './hook-deliver-render.js';

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

  // (b.2 — issue #198, AC1 / issue #438) a NORMAL-urgency turn-interruptible
  // claim carries events:[] but a populated reminder message. It must render a
  // non-empty additionalContext (the reminder line), NOT null — otherwise a
  // default monitor is silent mid-session. The runtime emits a SEMANTIC message
  // with no product-name prefix; this transport OWNS attribution and prepends
  // its own label (the hook's additionalContext arrives unlabeled).
  it('renders an attributed, actionable reminder line for a normal-urgency claim with no event bodies', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'normal',
        events: [],
        message:
          'Monitored changes are pending. Run `agentmonitors events list --session s1 --unread` to see them, then `agentmonitors events ack --session s1` once handled.',
        unreadCounts: { low: 0, normal: 1, high: 0, total: 1 },
      }),
      'UserPromptSubmit',
    );
    expect(out).not.toBeNull();
    expect(out?.continue).toBe(true);
    expect(out?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.trim()).not.toBe('');
    // Transport-owned attribution (issue #438): the hook prepends its label.
    expect(ctx).toContain('AgentMon: Monitored changes are pending.');
    // Self-sufficient, actionable next steps with the real session id (issue
    // #438) — including the acknowledge step (issue #434).
    expect(ctx).toContain('agentmonitors events list --session s1 --unread');
    expect(ctx).toContain('agentmonitors events ack --session s1');
    // No reference to the legacy `inbox` model anywhere in delivered text.
    expect(ctx).not.toContain('inbox');
    // Reminder only — no body-injection block markers leak in.
    expect(ctx).not.toContain('### ');
    // Advisory only — no permissionDecision field.
    expect(out).not.toHaveProperty('permissionDecision');
  });

  // (b.3 — issue #198, AC2 / issue #438) the same for LOW urgency (turn-idle
  // reminder).
  it('renders an attributed, actionable reminder line for a low-urgency claim with no event bodies', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'low',
        lifecycle: 'turn-idle',
        events: [],
        message:
          'Monitored changes are pending. Run `agentmonitors events list --session s1 --unread` to see them, then `agentmonitors events ack --session s1` once handled.',
        unreadCounts: { low: 1, normal: 0, high: 0, total: 1 },
      }),
      'UserPromptSubmit',
    );
    expect(out).not.toBeNull();
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.trim()).not.toBe('');
    expect(ctx).toContain('AgentMon: Monitored changes are pending.');
    expect(ctx).toContain('agentmonitors events ack --session s1');
    expect(ctx).not.toContain('inbox');
    expect(ctx).not.toContain('### ');
  });

  // (b.4 — issue #198, AC1) the reminder text is sanitized (control characters
  // stripped) and round-trips as valid JSON, like the body-injection path.
  it('sanitizes the reminder message and produces valid JSON', () => {
    const out = renderHookDelivery(
      makeClaim({
        urgency: 'normal',
        events: [],
        message: 'Monitored changes are pending.\x00 Run the listed command.',
      }),
      'UserPromptSubmit',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).not.toContain('\x00');
    expect(ctx).toContain(
      'AgentMon: Monitored changes are pending. Run the listed command.',
    );
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

  // (c.3 — issue #434) a body-injection delivery CLAIMS the events it renders,
  // but claiming is not acknowledgment — until the recipient acknowledges, the
  // coalesced-until-ack rule (002 §9.2) mutes every later normal reminder. So
  // the delivered payload MUST name the ack step, with the real session id, ONCE
  // per batch (not per event).
  it('includes a single ack instruction in a high-urgency delivery (issue #434)', () => {
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'sess-434',
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-a',
            title: 'A changed',
            summary: 's',
            body: 'body a',
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
          {
            eventId: 'e2',
            monitorId: 'watch-b',
            title: 'B changed',
            summary: 's',
            body: 'body b',
            urgency: 'high',
            createdAt: '2026-06-04T00:00:01.000Z',
          },
        ],
      }),
      'UserPromptSubmit',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      'When handled, acknowledge: agentmonitors events ack --session sess-434',
    );
    // Emitted once per batch, not once per event.
    const occurrences = ctx.split('When handled, acknowledge:').length - 1;
    expect(occurrences).toBe(1);
    // Both event bodies still injected.
    expect(ctx).toContain('body a');
    expect(ctx).toContain('body b');
  });

  // (c.4 — issue #434) the SessionStart recap likewise carries the ack
  // instruction: the recap re-shows unread events until acknowledged, so the
  // completion step must travel with it.
  it('includes the ack instruction in a post-compact recap (issue #434)', () => {
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'sess-recap',
        mode: 'recap',
        urgency: undefined,
        lifecycle: 'post-compact',
        message: 'Recap of recent activity since your last recap:',
        events: [
          {
            eventId: 'e1',
            monitorId: 'watch-src',
            title: 'Files changed',
            summary: 'Files changed',
            body: 'Review the diff.',
            urgency: 'normal',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
        ],
      }),
      'SessionStart',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      'When handled, acknowledge: agentmonitors events ack --session sess-recap',
    );
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
  // and (b) ends with the explicit, directly runnable session-scoped
  // truncation marker pointing at the still-unread event (issue #442: a bare
  // `--unread` without `--session <id>` exits 1, so the marker must render the
  // real command for the claim's own session, not the unusable bare form). A
  // SINGLE oversized event's own block is what's cut here, so it uses the
  // outcome-agnostic claimed-unread framing, not the "more updates are
  // pending" deferred framing (issue #442, PR #442 round-7/round-10 review).
  const TRUNCATION_TAIL =
    'run `agentmonitors events list --session s1 --unread` to see it now]';
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

  // (e.2.1 — issue #442 regression) the marker's command is derived from THIS
  // claim's own sessionId, not the default fixture's — proving the fix isn't
  // hardcoded and that a bare `--unread` (which exits 1 without `--session`)
  // never leaks into the rendered marker.
  it('renders the truncation marker with the exact claim sessionId, not a bare --unread', () => {
    const largeBody = 'x'.repeat(10_000);
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'session-abc-123',
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
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-abc-123 --unread` to see it',
    );
    // The unusable bare form (no --session) must never appear.
    expect(ctx).not.toContain('`agentmonitors events list --unread` to see it');
    // The claimed-unread framing, not the "more updates are pending" one —
    // this event's own content stays unread, an outcome-agnostic claim that
    // holds whether or not the reservation's commit lands (issue #442, PR #442
    // round-7/round-10 review).
    expect(ctx).toContain('the full copy stays unread');
    expect(ctx).not.toContain('more monitor updates are pending');
  });

  // (issue #442, PR #442 round-8 review) Mixed case: this claim's single
  // event is ITSELF oversized (mid-truncation branch) AND `moreDeferred` is
  // true — genuinely more high-urgency work exists beyond this one claimed
  // event and stays pending. Before the fix, the claimed-unread marker alone
  // suppressed the second, real signal that further, DIFFERENT work is
  // queued and will redeliver — the render must carry BOTH signposts.
  it('renders both the claimed-unread notice and the genuinely-pending deferral notice when the sole claimed event is itself oversized', () => {
    const largeBody = 'x'.repeat(10_000);
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'session-mixed',
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
      { moreDeferred: true },
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.length).toBeLessThanOrEqual(4000);
    // This event's own tail: stays unread (outcome-agnostic wording).
    expect(ctx).toContain('the full copy stays unread');
    // The genuinely separate, still-pending remainder: will redeliver later.
    expect(ctx).toContain('more monitor updates are pending');
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-mixed --unread` to see the rest',
    );
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-mixed --unread` to see it',
    );
  });

  // (e.2.3 — issue #358/#442, PR #442 round-7 review) the marker's recovery
  // command must carry an explicit `--socket <path>`, since `events list`
  // resolves its own socket env-first (issue #335) and would otherwise ignore
  // the workspace's own (possibly different) resolved socket, silently
  // querying a stale or wrong daemon.
  it('threads the resolved socket path into the marker as an explicit --socket flag', () => {
    const largeBody = 'x'.repeat(10_000);
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'session-abc-123',
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
      { socketPath: '/tmp/agentmon-real.sock' },
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      "run `agentmonitors events list --session session-abc-123 --socket '/tmp/agentmon-real.sock' --unread` to see it",
    );
  });

  // A socket path containing a shell metacharacter (a single quote) must not
  // corrupt the advertised command or allow shell injection when pasted
  // verbatim.
  it('shell-quotes a socket path so the advertised command stays safe to paste', () => {
    const out = renderHookDelivery(
      makeClaim({ sessionId: 'session-xyz' }),
      'PostToolUse',
      { moreDeferred: true, socketPath: "/tmp/weird ' path.sock" },
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      String.raw`--socket $'/tmp/weird\x20\x27\x20path.sock'`,
    );
  });

  // PR #442 round-8 review: `additionalContext` preserves `<>[]` verbatim (it
  // is a plain JSON string, not tag-delimited — see `sanitize`), but a socket
  // path is still shell-escaped via the transport-shared `escapeShellPath` for
  // consistency with the channel transport and so the advertised command is
  // guaranteed to round-trip to the exact original path.
  it('escapes a socket path carrying shell/control characters via the shared helper', () => {
    const out = renderHookDelivery(
      makeClaim({ sessionId: 'session-xyz' }),
      'PostToolUse',
      { moreDeferred: true, socketPath: '/tmp/x`bad\r.sock' },
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(String.raw`\x60`);
    expect(ctx).toContain(String.raw`\x0d`);
  });

  // (e.2.2 — issue #442) the `moreDeferred` deferred-remainder marker (appended
  // when genuinely-pending events were left unclaimed) is ALSO session-scoped
  // — and, unlike the mid-truncation case above, keeps the "more updates are
  // pending" framing, since those events really do redeliver (issue #442, PR
  // #442 round-7 review).
  it('renders a session-scoped marker when the caller deferred more events', () => {
    const out = renderHookDelivery(
      makeClaim({ sessionId: 'session-xyz' }),
      'PostToolUse',
      { moreDeferred: true },
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-xyz --unread` to see the rest',
    );
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

  // (issue #299, AC1) `moreDeferred` — the transport claimed only a subset that
  // fits and DEFERRED more high-urgency events for the next context event. Even
  // though the surfaced event fits under the cap, the marker MUST be appended so
  // the agent knows more is pending and re-delivering.
  it('appends the truncation marker when the caller deferred more events', () => {
    const out = renderHookDelivery(makeClaim(), 'PostToolUse', {
      moreDeferred: true,
    });
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    // The surfaced event is still shown in full…
    expect(ctx).toContain('Review the diff; flag risky changes.');
    // …and the marker signposts the deferred remainder.
    expect(ctx).toContain('[truncated');
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  // (issue #299, AC1) whole-event packing: when two event blocks EACH fit but
  // their COMBINED length exceeds the cap, the renderer surfaces the first block
  // in FULL and drops the second entirely (with a marker) rather than cutting the
  // second block mid-body. A partially-shown block would be a claimed-but-unread
  // event with no clean re-delivery boundary.
  it('packs whole event blocks under the cap (never a partial block)', () => {
    const bodyA = `AAAA ${'a'.repeat(2200)}`;
    const bodyB = `BBBB ${'b'.repeat(2200)}`;
    const out = renderHookDelivery(
      makeClaim({
        events: [
          {
            eventId: 'e1',
            monitorId: 'mon-a',
            title: 'Title A',
            summary: 's',
            body: bodyA,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:00.000Z',
          },
          {
            eventId: 'e2',
            monitorId: 'mon-b',
            title: 'Title B',
            summary: 's',
            body: bodyB,
            urgency: 'high',
            createdAt: '2026-06-04T00:00:01.000Z',
          },
        ],
      }),
      'PostToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.length).toBeLessThanOrEqual(4000);
    // First block shown IN FULL.
    expect(ctx).toContain(bodyA);
    // Second block NOT shown even partially (no fragment of its body leaks in).
    expect(ctx).not.toContain('BBBB');
    expect(ctx).not.toContain('bbbbb');
    // Signposted as truncated.
    expect(ctx).toContain('[truncated');
  });
});

// (issue #442, PR #442 round-9/round-10 review) Marker selection is
// lifecycle-aware: a `post-compact` recap re-shows the FULL unread set on
// EVERY recap, regardless of whether a row is already claimed (§5.5 —
// `decideDelivery`'s recap branch reads `unreadEventsForSession`, not
// `pendingEventsForSession`, and `applyDelivery` claims the FULL candidate
// set at commit time regardless of what actually renders). Neither of the
// two ordinary markers is truthful for a recap:
//   - the "genuinely pending" deferred marker ("more monitor updates are
//     pending ... run events list --unread to see the rest") wrongly implies
//     the omitted content is NOT yet claimed;
//   - the ordinary claimed-unread marker's outcome-agnostic "the full copy
//     stays unread" wording is accurate but incomplete for a recap — it
//     misses the POSITIVE guarantee a recap actually offers ("will reappear
//     on future recaps"), which the recap-aware marker states explicitly.
describe('renderHookDelivery post-compact recap marker (issue #442, round-9 review)', () => {
  function recapEvent(
    overrides: Partial<DeliveryEventSummary> = {},
  ): DeliveryEventSummary {
    return {
      eventId: 'e1',
      monitorId: 'watch-src',
      title: 'Files changed',
      summary: 'Files changed',
      body: 'a body',
      urgency: 'normal',
      createdAt: '2026-06-04T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeRecapClaim(
    overrides: Partial<DeliveryClaim> = {},
  ): DeliveryClaim {
    return makeClaim({
      mode: 'recap',
      urgency: undefined,
      lifecycle: 'post-compact',
      message: 'Recap of recent AgentMon activity since your last recap:',
      events: [recapEvent()],
      ...overrides,
    });
  }

  it('an oversized single-event recap uses recap-aware language, never the ordinary claimed-unread framing', () => {
    const out = renderHookDelivery(
      makeRecapClaim({
        sessionId: 'session-recap',
        events: [recapEvent({ body: 'x'.repeat(10_000) })],
      }),
      'SessionStart',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.length).toBeLessThanOrEqual(4000);
    expect(ctx).toContain('[truncated');
    // The turn-interruptible claimed-unread framing must NOT leak into a recap.
    expect(ctx).not.toContain('the full copy stays unread');
    // Truthful recap framing: it WILL reappear on future recaps.
    expect(ctx).toContain('will reappear on future recaps');
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-recap --unread` to see it now',
    );
  });

  it('a multi-event recap whose combined blocks exceed the cap uses recap-aware language, never the genuinely-pending "more monitor updates" framing', () => {
    const bodyA = `AAAA ${'a'.repeat(2200)}`;
    const bodyB = `BBBB ${'b'.repeat(2200)}`;
    const out = renderHookDelivery(
      makeRecapClaim({
        sessionId: 'session-recap-multi',
        events: [
          recapEvent({ eventId: 'e1', monitorId: 'mon-a', body: bodyA }),
          recapEvent({ eventId: 'e2', monitorId: 'mon-b', body: bodyB }),
        ],
      }),
      'SessionStart',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx.length).toBeLessThanOrEqual(4000);
    // First block shown in full; second omitted from THIS recap render.
    expect(ctx).toContain(bodyA);
    expect(ctx).not.toContain('BBBB');
    expect(ctx).toContain('[truncated');
    // The omitted event was already claimed at commit time (the recap
    // decision claims the FULL candidate set) — the ordinary "genuinely
    // pending, will redeliver at the next context event" framing is wrong
    // here; it never redelivers via the context-event flow, only via the
    // next recap.
    expect(ctx).not.toContain('more monitor updates are pending');
    expect(ctx).toContain('will reappear on future recaps');
    expect(ctx).toContain(
      'run `agentmonitors events list --session session-recap-multi --unread` to see it now',
    );
  });

  it('a recap that fits entirely under the cap carries no marker at all', () => {
    const out = renderHookDelivery(makeRecapClaim(), 'SessionStart');
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).not.toContain('[truncated');
  });

  it('a non-recap (turn-interruptible) claim keeps the ordinary markers unchanged', () => {
    // Regression guard: the lifecycle-aware branch must not alter behavior
    // for the non-recap lifecycles already covered above.
    const out = renderHookDelivery(
      makeClaim({
        sessionId: 'session-plain',
        events: [recapEvent({ body: 'x'.repeat(10_000) })],
      }),
      'PreToolUse',
    );
    const ctx = out?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain('the full copy stays unread');
    expect(ctx).not.toContain('will reappear on future recaps');
  });
});

// (issue #299) The transport-side sizing used to CLAIM exactly the events that
// will be rendered under the context cap, so the truncated-away remainder stays
// pending and re-delivers at the next context event.
describe('packEventsUnderCap', () => {
  function makeEvent(
    id: string,
    body: string,
    overrides: Partial<DeliveryEventSummary> = {},
  ): DeliveryEventSummary {
    return {
      eventId: `evt-${id}`,
      monitorId: id,
      title: `Title ${id}`,
      summary: 's',
      urgency: 'high',
      createdAt: '2026-06-04T00:00:00.000Z',
      body,
      ...overrides,
    };
  }

  it('returns 0 for an empty list', () => {
    expect(packEventsUnderCap([], 's1')).toBe(0);
  });

  it('returns the full count when every whole block fits under the cap', () => {
    const events = [
      makeEvent('mon-a', 'short body A'),
      makeEvent('mon-b', 'short body B'),
      makeEvent('mon-c', 'short body C'),
    ];
    expect(packEventsUnderCap(events, 's1')).toBe(3);
  });

  it('returns only the events that fit (reserving marker room) when combined length exceeds the cap', () => {
    // Each ~2200-char block fits alone; two combined (~4500) exceed the 4000 cap.
    const events = [
      makeEvent('mon-a', 'a'.repeat(2200)),
      makeEvent('mon-b', 'b'.repeat(2200)),
    ];
    expect(packEventsUnderCap(events, 's1')).toBe(1);
  });

  it('returns at least 1 even when the first event alone exceeds the cap (forward progress)', () => {
    const events = [
      makeEvent('mon-a', 'x'.repeat(10_000)),
      makeEvent('mon-b', 'short'),
    ];
    // The first is surfaced (and claimed) even though it overflows — it is
    // mid-truncated by renderHookDelivery; the marker points at the unread rest.
    expect(packEventsUnderCap(events, 's1')).toBe(1);
  });

  // (issue #442 regression) the marker's length varies with the session id
  // (it is embedded in the rendered command), so sizing MUST reserve room
  // based on THIS session's own marker length — not a fixed constant. Three
  // ~1700-char blocks combined exceed the cap, so the packer reserves marker
  // room: a SHORT session id's marker leaves room for 2 whole blocks, while a
  // much LONGER session id's marker (500 extra chars embedded in the rendered
  // command) leaves room for only 1.
  it('sizes against the session-specific marker length, not a fixed constant', () => {
    const events = [
      makeEvent('mon-a', 'a'.repeat(1700)),
      makeEvent('mon-b', 'b'.repeat(1700)),
      makeEvent('mon-c', 'c'.repeat(1700)),
    ];
    const longSessionId = 'x'.repeat(500);
    const shortFit = packEventsUnderCap(events, 's1');
    const longFit = packEventsUnderCap(events, longSessionId);
    expect(shortFit).toBe(2);
    expect(longFit).toBe(1);
  });

  // (issue #358/#442, PR #442 round-7 review) the marker now also embeds an
  // explicit `--socket <path>`, so a long socket path must ALSO shrink how
  // many whole blocks fit — mirroring the long-session-id case above.
  it('sizes against the socket path length, not just the session id', () => {
    const events = [
      makeEvent('mon-a', 'a'.repeat(1700)),
      makeEvent('mon-b', 'b'.repeat(1700)),
      makeEvent('mon-c', 'c'.repeat(1700)),
    ];
    const longSocketPath = '/tmp/' + 'x'.repeat(500) + '.sock';
    const noSocketFit = packEventsUnderCap(events, 's1');
    const withSocketFit = packEventsUnderCap(
      events,
      's1',
      undefined,
      longSocketPath,
    );
    expect(noSocketFit).toBe(2);
    expect(withSocketFit).toBe(1);
  });
});

// (issue #269) the "monitors exist but this project is not enabled" advisory
// emitted by `session start`'s quick-exit path.
describe('renderMonitoringDisabledAdvisory', () => {
  it('produces the SessionStart wire shape (continue + hookSpecificOutput)', () => {
    const out = renderMonitoringDisabledAdvisory(1, 'SessionStart');
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    // Advisory only — no permissionDecision field (BP2).
    expect(out).not.toHaveProperty('permissionDecision');
  });

  it('states monitoring is disabled, the count, and the exact enable step', () => {
    const out = renderMonitoringDisabledAdvisory(3, 'SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('disabled');
    expect(ctx).toContain('3 monitor definitions found');
    expect(ctx).toContain('.claude/agentmonitors.local.md');
    expect(ctx).toContain('enabled: true');
  });

  // Criterion 2 (issue #331): the advisory also points at `agentmonitors
  // doctor` for the full workspace-health picture, not just the enable step.
  it('also names `agentmonitors doctor` for the full workspace-health picture', () => {
    const ctx = renderMonitoringDisabledAdvisory(1, 'SessionStart')
      .hookSpecificOutput.additionalContext;
    expect(ctx).toContain('agentmonitors doctor');
  });

  it('uses singular "definition" for a count of exactly 1', () => {
    const ctx = renderMonitoringDisabledAdvisory(1, 'SessionStart')
      .hookSpecificOutput.additionalContext;
    expect(ctx).toContain('1 monitor definition found');
    expect(ctx).not.toContain('1 monitor definitions');
  });

  it('echoes the passed hookEventName', () => {
    const out = renderMonitoringDisabledAdvisory(2, 'SessionStart');
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});
