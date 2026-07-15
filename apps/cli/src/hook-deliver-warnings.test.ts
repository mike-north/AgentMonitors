/**
 * Tests for the pure `hook deliver` always-on stderr warning formatter
 * (issue #329).
 *
 * @see ./commands/hook.ts (writes this line to stderr, unconditionally)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */
import { describe, expect, it } from 'vitest';
import { describeUnknownHostSessionWarning } from './hook-deliver-warnings.js';

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
