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

  it('quotes the id even when it contains spaces or unusual characters, without truncation', () => {
    const weird = 'weird id "with quotes" and spaces';
    const msg = describeUnknownHostSessionWarning(weird);
    expect(msg).toContain(`"${weird}"`);
  });

  it('does not include a trailing newline — the caller owns line termination', () => {
    expect(describeUnknownHostSessionWarning('abc').endsWith('\n')).toBe(false);
  });
});
