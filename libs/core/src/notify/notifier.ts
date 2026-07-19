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
 * JSON Schema `pattern` for a source's `timeout` scope field: one or more
 * digits, with **no leading zero** — so the value can never parse to a
 * zero-length duration (`"0s"`, `"0m"`, `"0h"`, `"0d"` are all rejected, see
 * {@link parseOperationTimeoutMs}) — followed by exactly one of `s`, `m`,
 * `h`, `d`. Shared by `api-poll` and `command-poll` (issue #304 review) so the
 * grammar can't drift between the two copies.
 */
export const OPERATION_TIMEOUT_PATTERN = '^[1-9]\\d*[smhd]$';

/**
 * Resolve a source's `timeout` scope field into milliseconds (issue #304
 * review, findings 5 and 6). `rawTimeout` is the raw `config['timeout']`
 * value read straight off the author's config: a present string is parsed via
 * {@link parseDuration}; anything else — including `undefined`, when the
 * author omits the field — falls back to
 * {@link DEFAULT_OPERATION_TIMEOUT_MS}. This mirrors the exact
 * `typeof rawTimeout === 'string' ? parseDuration(rawTimeout) : DEFAULT`
 * fallback both `api-poll` and `command-poll` previously duplicated.
 *
 * Unlike a bare {@link parseDuration} call, a **zero-length** duration
 * (`"0s"`, `"0m"`, `"0h"`, `"0d"`) is rejected here even though
 * `parseDuration` itself accepts it — other `parseDuration` callers use zero
 * meaningfully (e.g. notify `settle-for: 0`) — because a zero-length
 * request/command deadline is never a meaningful configuration: it would
 * abort every request or command before it could ever complete, producing a
 * confusing per-tick `timed out after 0ms` error on every run.
 */
export function parseOperationTimeoutMs(rawTimeout: unknown): number {
  if (typeof rawTimeout !== 'string') return DEFAULT_OPERATION_TIMEOUT_MS;
  const ms = parseDuration(rawTimeout);
  if (ms <= 0) {
    throw new Error(
      `Invalid timeout: "${rawTimeout}". A zero-length timeout is not allowed; specify at least 1 unit (e.g. "1s").`,
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
