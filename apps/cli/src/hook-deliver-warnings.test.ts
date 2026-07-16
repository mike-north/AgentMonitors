/**
 * Tests for the pure `hook deliver` always-on stderr warning formatters
 * (issues #329, #420 P1).
 *
 * @see ./commands/hook.ts (writes these lines to stderr, unconditionally)
 * @see ../../../docs/specs/005-cli-reference.md §12.2.1 (always-on diagnostics)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */
import { describe, expect, it } from 'vitest';
import {
  describeMalformedPayloadWarning,
  describeUnknownHostSessionWarning,
  describeUnmappedLifecycleWarning,
} from './hook-deliver-warnings.js';

describe('describeUnknownHostSessionWarning', () => {
  it('names the unresolved host session id in the exact wording the issue specifies', () => {
    expect(describeUnknownHostSessionWarning('verify-host')).toBe(
      'hook deliver: no session registered for host session id "verify-host"',
    );
  });

  it('quotes an id containing spaces and escapes embedded quotes', () => {
    const weird = 'weird id "with quotes" and spaces';
    const msg = describeUnknownHostSessionWarning(weird);
    expect(msg).toContain(JSON.stringify(weird));
    expect(msg).toContain('\\"with quotes\\"');
  });

  // session_id comes from untrusted stdin JSON and the warning is
  // unconditional — a newline or terminal escape must never reach stderr raw
  // (log/terminal injection).
  it('escapes newlines and control characters so the warning stays one control-safe line', () => {
    const hostile = 'evil\nid\twith\r\x1b[31mred';
    const msg = describeUnknownHostSessionWarning(hostile);
    // No character below 0x20 may survive — not just the ones we seeded.
    const controlChars = [...msg].filter((ch) => ch.charCodeAt(0) < 0x20);
    expect(controlChars).toEqual([]);
    expect(msg).toContain('\\n');
    expect(msg).toContain('\\t');
    expect(msg).toContain('\\r');
    expect(msg).toContain('\\u001b');
  });

  // Regression: JSON.stringify only escapes C0 controls (< U+0020) — DEL,
  // the C1 controls (U+0080–U+009F, e.g. U+009B CSI), and the U+2028/U+2029
  // line/paragraph separators passed through raw, undermining the
  // "control-safe one line" contract (005 §12.2.1 / 006 §5.2.1).
  it('escapes DEL, C1 controls, and U+2028/U+2029 that JSON.stringify leaves raw', () => {
    const hostile = 'a\u007fb\u009bc\u0085d\u2028e\u2029f';
    const msg = describeUnknownHostSessionWarning(hostile);
    const rawSurvivors = [...msg].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (
        (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
      );
    });
    expect(rawSurvivors).toEqual([]);
    expect(msg).toContain('\\u007f');
    expect(msg).toContain('\\u009b');
    expect(msg).toContain('\\u0085');
    expect(msg).toContain('\\u2028');
    expect(msg).toContain('\\u2029');
  });

  // The escaping must stay a faithful JSON string: parsing the quoted portion
  // recovers the original id exactly (escaped, not stripped).
  it('keeps the rendered id a round-trippable JSON string', () => {
    const hostile = 'a\u009b\u2028\x1b[31m"quoted"';
    const msg = describeUnknownHostSessionWarning(hostile);
    const quoted = msg.slice(msg.indexOf('"'));
    expect(JSON.parse(quoted)).toBe(hostile);
  });

  it('truncates a pathologically long id instead of flooding stderr', () => {
    const long = 'x'.repeat(10_000);
    const msg = describeUnknownHostSessionWarning(long);
    expect(msg.length).toBeLessThan(200);
    expect(msg).toContain('…');
  });

  // Regression: a raw slice(0, 128) splits a surrogate pair straddling the
  // boundary, leaving a lone surrogate that JSON.stringify renders as a
  // garbled \ud83d escape.
  it('never splits a surrogate pair at the truncation boundary', () => {
    const straddling = `${'x'.repeat(127)}😀${'y'.repeat(50)}`;
    const msg = describeUnknownHostSessionWarning(straddling);
    // The emoji did not fit whole within the cap, so it is dropped wholesale.
    expect(msg).not.toContain('😀');
    expect(msg).not.toMatch(/\\ud83d/i);
    expect(msg).toContain('x…');

    // An emoji that fits entirely within the cap survives intact.
    const fitting = `${'x'.repeat(20)}😀${'y'.repeat(200)}`;
    expect(describeUnknownHostSessionWarning(fitting)).toContain('😀');
  });

  it('does not include a trailing newline — the caller owns line termination', () => {
    expect(describeUnknownHostSessionWarning('abc').endsWith('\n')).toBe(false);
  });
});

describe('describeMalformedPayloadWarning (issue #420 P1)', () => {
  it('names the missing session_id and points at the expected input, on one line', () => {
    const msg = describeMalformedPayloadWarning();
    expect(msg).toContain('hook deliver:');
    expect(msg).toContain('no session_id in the stdin payload');
    expect(msg).toContain('Claude Code hook JSON payload on stdin');
    // Single control-safe line; the caller appends the newline.
    expect(msg).not.toContain('\n');
  });
});

describe('describeUnmappedLifecycleWarning (issue #420 P1)', () => {
  it('names the offending hook_event_name and the events that DO map', () => {
    const msg = describeUnmappedLifecycleWarning('PreToolUse');
    expect(msg).toContain('hook deliver:');
    expect(msg).toContain('hook_event_name "PreToolUse"');
    expect(msg).toContain('does not map to a delivery lifecycle');
    expect(msg).toContain('UserPromptSubmit, PostToolUse, and SessionStart');
    expect(msg).not.toContain('\n');
  });

  it('renders a missing event name as (none) rather than "undefined"', () => {
    const msg = describeUnmappedLifecycleWarning(undefined);
    expect(msg).toContain('hook_event_name (none)');
    expect(msg).not.toContain('undefined');
  });

  // hook_event_name is untrusted stdin JSON emitted unconditionally, so it
  // gets the same control-safe escaping as the session id (shared sanitizer).
  it('escapes control characters and terminal escapes in the event name', () => {
    const msg = describeUnmappedLifecycleWarning('evil\nname\x1b[31m ');
    const controlChars = [...msg].filter((ch) => ch.charCodeAt(0) < 0x20);
    expect(controlChars).toEqual([]);
    expect(msg).toContain('\\n');
    expect(msg).toContain('\\u001b');
    expect(msg).toContain('\\u2028');
  });

  it('truncates a pathologically long event name instead of flooding stderr', () => {
    const msg = describeUnmappedLifecycleWarning('z'.repeat(10_000));
    expect(msg.length).toBeLessThan(300);
    expect(msg).toContain('…');
  });

  it('does not include a trailing newline — the caller owns line termination', () => {
    expect(describeUnmappedLifecycleWarning('x').endsWith('\n')).toBe(false);
  });
});
