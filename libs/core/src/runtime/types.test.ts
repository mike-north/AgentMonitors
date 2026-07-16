/**
 * Tests for `defaultNotifyConfigForUrgency` (`types.ts`).
 *
 * The `high`-urgency default branch formats
 * `schedulingDefaults.highUrgencyDefaultDebounceSettleMs` as a whole-second
 * `settle-for` string (`${ms / 1000}s`) because `parseDuration`'s grammar
 * (`notifier.ts`, `/^(?<digits>\d+)(?<unit>[smhd])$/`) has no sub-second unit.
 * If the constant were ever changed to a non-multiple of 1000 (e.g. 15_500),
 * that formatting would silently produce an unparseable string like
 * `"15.5s"`, which `parseDuration` throws on at runtime. These tests pin both
 * the produced string's parseability and the constant's invariant so that
 * regression is caught here instead of in a running daemon.
 *
 * @see docs/specs/002-runtime-delivery.md §9.1 (high-urgency debounce settle)
 */
import { describe, expect, it } from 'vitest';
import { defaultNotifyConfigForUrgency } from './types.js';
import { schedulingDefaults } from './scheduling-defaults.js';
import { parseDuration } from '../notify/notifier.js';
import type { NotifyConfig } from '../schema/types.js';

describe('defaultNotifyConfigForUrgency', () => {
  it('returns a debounce default for high urgency with no authored notify block', () => {
    const notify = defaultNotifyConfigForUrgency('high', undefined);
    expect(notify).toEqual({
      strategy: 'debounce',
      'settle-for': '15s',
    });
  });

  it('produces a settle-for string that parseDuration accepts and resolves to the exact constant', () => {
    const notify = defaultNotifyConfigForUrgency('high', undefined);
    expect(notify?.strategy).toBe('debounce');
    // Regression guard: this call must not throw. Before the fix under test,
    // a non-second-multiple `highUrgencyDefaultDebounceSettleMs` would format
    // as e.g. "15.5s" here and parseDuration would throw.
    expect(() => parseDuration(notify?.['settle-for'] ?? '')).not.toThrow();
    expect(parseDuration(notify?.['settle-for'] ?? '')).toBe(
      schedulingDefaults.highUrgencyDefaultDebounceSettleMs,
    );
  });

  it('pins highUrgencyDefaultDebounceSettleMs to an exact multiple of 1000ms', () => {
    // parseDuration's grammar (notifier.ts) has no sub-second unit, so the
    // "${ms / 1000}s" formatting in defaultNotifyConfigForUrgency requires
    // this constant to stay a whole number of seconds. A regression here
    // (e.g. 15_500) would silently produce an invalid duration string.
    expect(schedulingDefaults.highUrgencyDefaultDebounceSettleMs % 1000).toBe(
      0,
    );
  });

  it('passes an authored notify block through unchanged, ignoring urgency', () => {
    const authored: NotifyConfig = {
      strategy: 'throttle',
      'suppress-for': '30s',
    };
    expect(defaultNotifyConfigForUrgency('high', authored)).toBe(authored);
    expect(defaultNotifyConfigForUrgency('normal', authored)).toBe(authored);
  });

  it('returns undefined for normal or low urgency with no authored notify block', () => {
    expect(defaultNotifyConfigForUrgency('normal', undefined)).toBeUndefined();
    expect(defaultNotifyConfigForUrgency('low', undefined)).toBeUndefined();
  });
});
