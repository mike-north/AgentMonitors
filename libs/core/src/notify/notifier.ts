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
