/**
 * Strict parsing for CLI flags whose value is a bounded whole number.
 *
 * Commander hands every option value to an action as the raw string the user
 * typed. Lenient conversions (`parseInt(value) || fallback`, `Number(value)`)
 * silently reinterpret typos: `1junk` becomes `1`, `-1` becomes a near-zero
 * timer, `2.5` truncates, and an explicit `0` falls back to the default. This
 * module is the single place that decides whether such a string is an
 * acceptable integer, so every flag that adopts it rejects the same inputs
 * with the same one-line diagnostic shape.
 *
 * Scope: parsing and range checking only. Deciding what to do with a rejected
 * value (report it, exit nonzero) stays with the command.
 */

/**
 * Largest delay Node's timers honor. A larger `setTimeout` delay is clamped to
 * 1 ms with a `TimeoutOverflowWarning`, so a millisecond flag that feeds a
 * timer must never exceed it.
 *
 * @see https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
 * @internal
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Inclusive bounds an integer option's value must fall within. @internal */
export interface IntegerOptionRange {
  /** Smallest accepted value, inclusive. */
  readonly min: number;
  /** Largest accepted value, inclusive. */
  readonly max: number;
}

/** Outcome of parsing one integer option value. @internal */
export type IntegerOptionParseResult =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      /** Single-line diagnostic naming the flag, the accepted range, and the input. */
      readonly message: string;
    };

/**
 * Accepts only plain ASCII decimal digits: no sign, whitespace, decimal point,
 * exponent, or radix prefix. Anything else is not a whole number as typed.
 */
const DECIMAL_DIGITS = /^[0-9]+$/;

/**
 * Parse `raw` as a whole number within `range` for the option named `flag`.
 *
 * The rejection message always fits on one line: the raw input is echoed
 * through `JSON.stringify`, so control characters in it are escaped rather
 * than breaking the diagnostic.
 * @internal
 */
export function parseIntegerOption(
  flag: string,
  raw: string,
  range: IntegerOptionRange,
): IntegerOptionParseResult {
  const value = DECIMAL_DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= range.min && value <= range.max) {
    return { ok: true, value };
  }
  return {
    ok: false,
    message: `${flag} must be a whole number from ${String(range.min)} to ${String(range.max)} (got ${JSON.stringify(raw)}).`,
  };
}
