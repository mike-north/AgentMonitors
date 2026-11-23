import { describe, expect, it } from 'vitest';
import { CHANNEL_POLL_MS_RANGE } from './commands/channel.js';
import { MAX_TIMER_DELAY_MS, parseIntegerOption } from './integer-option.js';

/**
 * Tests for strict bounded-integer flag parsing, exercised through the
 * `channel serve --poll-ms` range (issue #306).
 *
 * Expected values come from 005 §13: `--poll-ms` accepts a whole number from
 * 100 to 2147483647 (Node's timer ceiling); anything else is rejected with a
 * single-line diagnostic naming the flag and range.
 *
 * @see ../../../docs/specs/005-cli-reference.md §13
 * @see https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
 */

const parsePollMs = (raw: string) =>
  parseIntegerOption('--poll-ms', raw, CHANNEL_POLL_MS_RANGE);

const rejection = (raw: string) =>
  `--poll-ms must be a whole number from 100 to 2147483647 (got ${JSON.stringify(raw)}).`;

describe('parseIntegerOption (channel serve --poll-ms range)', () => {
  it('pins the documented range: 100 ms floor, Node timer ceiling', () => {
    expect(CHANNEL_POLL_MS_RANGE).toEqual({ min: 100, max: 2_147_483_647 });
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
  });

  it.each([
    ['a normal value', '3000', 3000],
    ['exactly the minimum', '100', 100],
    ['exactly the maximum', '2147483647', 2_147_483_647],
  ])('accepts %s', (_label, raw, value) => {
    expect(parsePollMs(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ['negative', '-1'],
    ['zero (not reinterpreted as the default)', '0'],
    ['fractional', '250.5'],
    ['partly numeric', '1junk'],
    ['NaN', 'NaN'],
    ['one below the minimum', '99'],
    ['one above the maximum', '2147483648'],
    ['far beyond the safe-integer range', '99999999999999999999'],
    ['Infinity', 'Infinity'],
    ['an exponent', '1e3'],
    ['a hex literal', '0x100'],
    ['a leading sign', '+500'],
    ['surrounding whitespace', ' 500 '],
    ['empty', ''],
  ])('rejects %s', (_label, raw) => {
    expect(parsePollMs(raw)).toEqual({ ok: false, message: rejection(raw) });
  });

  it('keeps the diagnostic on one line when the input contains a newline', () => {
    const result = parsePollMs('5\n00');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('\n');
      expect(result.message).toBe(
        '--poll-ms must be a whole number from 100 to 2147483647 (got "5\\n00").',
      );
    }
  });
});
