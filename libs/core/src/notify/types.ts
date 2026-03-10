import type { Observation } from '../observation/types.js';

export type NotifyStrategy = 'debounce' | 'throttle';

export type NotifyCallback = (observation: Observation) => void;

/**
 * A notifier controls when observations become inbox items.
 *
 * - immediate: every observation fires immediately
 * - debounce: wait for observations to stop, then fire
 * - throttle: fire on first observation, suppress for cooldown
 */
export interface Notifier {
  /** Submit an observation for notification processing */
  submit(observation: Observation): void;
  /** Cancel any pending timers */
  dispose(): void;
}
