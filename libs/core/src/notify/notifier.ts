import type { Observation } from '../observation/types.js';
import type { NotifyCallback, Notifier } from './types.js';

/** Parse a duration string like "5m", "30s", "1h", "2d" into milliseconds. */
export function parseDuration(duration: string): number {
  const match = /^(?<digits>\d+)(?<unit>[smhd])$/.exec(duration);
  const digits = match?.groups?.['digits'];
  const unit = match?.groups?.['unit'];
  if (!digits || !unit) {
    throw new Error(
      `Invalid duration: "${duration}". Expected format: <number><s|m|h|d>`,
    );
  }

  const value = Number(digits);

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      throw new Error(`Unknown duration unit: "${unit}"`);
  }
}

/**
 * Default wall-clock deadline, in milliseconds, for a single bounded external
 * operation (an HTTP request, a spawned command, …) that a source's `timeout`
 * scope field controls, used when the author omits the field. Centralized
 * here (issue #304 review) so every bundled source that exposes a `timeout`
 * field — `api-poll` and `command-poll` today — shares one default instead of
 * each hand-maintaining its own copy, which had already drifted into a
 * byte-for-byte duplicate across the two plugins.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/**
 * The largest delay Node's `setTimeout`/`setInterval` can schedule: a 32-bit
 * signed integer of milliseconds (`2_147_483_647`, ~24.8 days). A longer
 * value silently overflows to a 1ms timer (with a `TimeoutOverflowWarning` on
 * stderr) instead of throwing, so without this bound a config like
 * `timeout: "25d"` would fire almost immediately — the opposite of the
 * author's intent — rather than erroring at parse time (issue #304 review).
 *
 * @see https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
 */
export const MAX_OPERATION_TIMEOUT_MS = 2_147_483_647;

/**
 * Build a regex fragment (no anchors) matching the decimal string form of
 * every integer in `[1, max]`, with **no leading zeros** — e.g.
 * `digitRangeFragment(24)` matches `"1"`..`"24"` but neither `"0"` nor `"25"`.
 * Internal to {@link OPERATION_TIMEOUT_PATTERN}'s construction (issue #304
 * review, third round): a hand-written pattern per unit would have to encode
 * `Math.floor(MAX_OPERATION_TIMEOUT_MS / unitMs)` and would silently drift
 * from {@link MAX_OPERATION_TIMEOUT_MS} on the next edit, so the pattern is
 * derived from the same numeric bound the parser enforces instead.
 *
 * Standard digit-DP range-to-regex construction: for each digit-length
 * shorter than `max`, the full range is `[1-9]` followed by any digits; for
 * `max`'s own digit length, {@link zeroRangeFragment} recursively bounds the
 * trailing digits once the shared leading digits are fixed.
 */
function digitRangeFragment(max: number): string {
  const digits = String(max);
  const branches: string[] = [];
  for (let length = 1; length < digits.length; length++) {
    branches.push(length === 1 ? '[1-9]' : `[1-9][0-9]{${String(length - 1)}}`);
  }
  const first = digits[0];
  const rest = digits.slice(1);
  if (!first) throw new Error('unreachable: digits is non-empty');
  if (rest.length === 0) {
    branches.push(`[1-${first}]`);
  } else if (first === '1') {
    branches.push(`1${zeroRangeFragment(rest)}`);
  } else {
    const lower = String.fromCharCode(first.charCodeAt(0) - 1);
    branches.push(`[1-${lower}][0-9]{${String(rest.length)}}`);
    branches.push(`${first}${zeroRangeFragment(rest)}`);
  }
  return `(?:${branches.join('|')})`;
}

/**
 * Regex fragment matching every integer in `[0, Number(digits)]`, rendered
 * with exactly `digits.length` digit positions (leading zeros allowed in
 * this fixed-width representation — it only ever appears as a fixed-length
 * suffix of {@link digitRangeFragment}'s leading digits). Recursion helper;
 * not useful standalone.
 */
function zeroRangeFragment(digits: string): string {
  if (digits.length === 1) {
    return digits === '0' ? '0' : `[0-${digits}]`;
  }
  const first = digits[0];
  const rest = digits.slice(1);
  if (!first) throw new Error('unreachable: digits is non-empty');
  const branches: string[] = [];
  if (first !== '0') {
    const lower = String.fromCharCode(first.charCodeAt(0) - 1);
    branches.push(
      lower === '0'
        ? `0[0-9]{${String(rest.length)}}`
        : `[0-${lower}][0-9]{${String(rest.length)}}`,
    );
  }
  branches.push(`${first}${zeroRangeFragment(rest)}`);
  return `(?:${branches.join('|')})`;
}

/** Milliseconds per unit, matching {@link parseDuration}'s switch. */
const OPERATION_TIMEOUT_UNIT_MS: Record<'s' | 'm' | 'h' | 'd', number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * JSON Schema `pattern` for a source's `timeout` scope field: one or more
 * digits, with **no leading zero** — so the value can never parse to a
 * zero-length duration (`"0s"`, `"0m"`, `"0h"`, `"0d"` are all rejected, see
 * {@link parseOperationTimeoutMs}) — followed by exactly one of `s`, `m`,
 * `h`, `d`. Shared by `api-poll` and `command-poll` (issue #304 review) so the
 * grammar can't drift between the two copies.
 *
 * Each unit's digit run is additionally bounded to
 * `Math.floor(MAX_OPERATION_TIMEOUT_MS / <unit's ms-per-unit>)` (issue #304
 * review, third round): a raw `\d*` digit run let a value like `"25d"` pass
 * authoring-time schema validation while {@link parseOperationTimeoutMs}
 * rejected it at runtime, so the schema and the parser disagreed on what a
 * valid config looked like. Deriving the per-unit bound from
 * {@link MAX_OPERATION_TIMEOUT_MS} (via {@link digitRangeFragment}) keeps the
 * two in permanent agreement instead of hand-duplicating four magic numbers.
 */
export const OPERATION_TIMEOUT_PATTERN = `^(?:${(
  Object.entries(OPERATION_TIMEOUT_UNIT_MS) as ['s' | 'm' | 'h' | 'd', number][]
)
  .map(
    ([unit, unitMs]) =>
      `${digitRangeFragment(Math.floor(MAX_OPERATION_TIMEOUT_MS / unitMs))}${unit}`,
  )
  .join('|')})$`;

/**
 * Resolve a source's `timeout` scope field into milliseconds (issue #304
 * review, findings 5 and 6). `rawTimeout` is the raw `config['timeout']`
 * value read straight off the author's config: `undefined` — the author
 * omitted the field — falls back to {@link DEFAULT_OPERATION_TIMEOUT_MS}.
 * Anything else must be a string; a present-but-wrong-type value (a number,
 * `null`, an object, …) is a misconfiguration, not "omitted", and is rejected
 * rather than silently defaulted (issue #304 review, second-round finding:
 * `timeout: 123` or `timeout: null` previously fell back to the default
 * exactly like an omitted field, hiding the mistake).
 *
 * A present string is parsed via {@link parseDuration}, so a malformed value
 * (e.g. `"soon"`, missing a unit) throws the same descriptive
 * `Invalid duration: "<value>". Expected format: <number><s|m|h|d>` error as
 * every other duration field. Two values that `parseDuration` alone would
 * accept are rejected here, ahead of the parse, so this parser and the
 * `OPERATION_TIMEOUT_PATTERN` JSON Schema `pattern` (which requires a
 * non-zero leading digit) agree on every input:
 *
 * - A **zero-length** duration (`"0s"`, `"0m"`, `"0h"`, `"0d"`, …) — other
 *   `parseDuration` callers use zero meaningfully (e.g. notify
 *   `settle-for: 0`), but a zero-length request/command deadline is never a
 *   meaningful configuration: it would abort every request or command before
 *   it could ever complete, producing a confusing per-tick
 *   `timed out after 0ms` error on every run.
 * - A **leading-zero** duration (`"01s"`, `"007m"`, …) — issue #304 review,
 *   second-round finding: the schema pattern's `[1-9]\d*` already rejects
 *   these, but `parseDuration`'s own `\d+` digit group happily parses them,
 *   so a schema-valid config could previously behave differently than a
 *   parser-only call with the same string. Rejecting leading zeros here too
 *   is a deliberate validation tightening (documented in the affected
 *   packages' changesets) so the two never disagree.
 *
 * Finally, a value that parses to more milliseconds than
 * {@link MAX_OPERATION_TIMEOUT_MS} — e.g. `"25d"` — is rejected: Node's
 * `setTimeout` cannot schedule that delay and would silently fire almost
 * immediately instead.
 */
export function parseOperationTimeoutMs(rawTimeout: unknown): number {
  if (rawTimeout === undefined) return DEFAULT_OPERATION_TIMEOUT_MS;
  if (typeof rawTimeout !== 'string') {
    const got = rawTimeout === null ? 'null' : typeof rawTimeout;
    throw new Error(
      `Invalid timeout: expected a string matching ${OPERATION_TIMEOUT_PATTERN} (e.g. "30s"), got ${got}.`,
    );
  }

  const zeroLengthMatch = /^0+[smhd]$/.exec(rawTimeout);
  if (zeroLengthMatch) {
    throw new Error(
      `Invalid timeout: "${rawTimeout}". A zero-length timeout is not allowed; specify at least 1 unit (e.g. "1s").`,
    );
  }
  const leadingZeroMatch = /^0\d+[smhd]$/.exec(rawTimeout);
  if (leadingZeroMatch) {
    throw new Error(
      `Invalid timeout: "${rawTimeout}". A leading zero is not allowed; use "1s" instead of "01s" (must match ${OPERATION_TIMEOUT_PATTERN}).`,
    );
  }

  const ms = parseDuration(rawTimeout);
  if (ms > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: "${rawTimeout}" (${String(ms)}ms) exceeds the maximum supported deadline of ${String(MAX_OPERATION_TIMEOUT_MS)}ms (~24.8 days) — Node's setTimeout cannot schedule a longer delay.`,
    );
  }
  return ms;
}

/** Every observation fires immediately. */
export function createImmediateNotifier(callback: NotifyCallback): Notifier {
  return {
    submit(observation: Observation) {
      callback(observation);
    },
    dispose() {
      // nothing to clean up
    },
  };
}

/**
 * Debounce: wait for observations to stop arriving for `settleMs`,
 * then fire with the last observation.
 */
export function createDebounceNotifier(
  callback: NotifyCallback,
  settleMs: number,
): Notifier {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastObservation: Observation | undefined;

  return {
    submit(observation: Observation) {
      lastObservation = observation;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        if (lastObservation !== undefined) {
          callback(lastObservation);
          lastObservation = undefined;
        }
        timer = undefined;
      }, settleMs);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      lastObservation = undefined;
    },
  };
}

/**
 * Throttle: fire on the first observation, then suppress for `suppressMs`.
 */
export function createThrottleNotifier(
  callback: NotifyCallback,
  suppressMs: number,
): Notifier {
  let suppressed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    submit(observation: Observation) {
      if (suppressed) {
        return;
      }
      callback(observation);
      suppressed = true;
      timer = setTimeout(() => {
        suppressed = false;
        timer = undefined;
      }, suppressMs);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      suppressed = false;
    },
  };
}
