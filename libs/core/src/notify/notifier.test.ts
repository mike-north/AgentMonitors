import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Observation } from '../observation/types.js';
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  createDebounceNotifier,
  createImmediateNotifier,
  createThrottleNotifier,
  parseDuration,
  parseOperationTimeoutMs,
} from './notifier.js';

const obs = (title: string): Observation => ({ title });

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('parses days', () => {
    expect(parseDuration('2d')).toBe(172_800_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDuration('5 minutes')).toThrow('Invalid duration');
  });

  it('throws on missing unit', () => {
    expect(() => parseDuration('5')).toThrow('Invalid duration');
  });
});

// Issue #304 review, findings 5 + 6: `api-poll` and `command-poll` each
// hand-maintained an identical `timeout` scope-field default/parse/pattern —
// this is the shared helper both now call.
describe('parseOperationTimeoutMs', () => {
  it('falls back to the shared default when the raw value is undefined', () => {
    expect(parseOperationTimeoutMs(undefined)).toBe(
      DEFAULT_OPERATION_TIMEOUT_MS,
    );
  });

  it('falls back to the shared default for a non-string raw value', () => {
    // Matches both plugins' pre-existing behavior: a non-string `timeout` is
    // silently treated as "omitted" rather than a validation error here — the
    // JSON Schema `pattern` check is what rejects a malformed author value.
    expect(parseOperationTimeoutMs(42)).toBe(DEFAULT_OPERATION_TIMEOUT_MS);
  });

  it('parses a present string via parseDuration', () => {
    expect(parseOperationTimeoutMs('5m')).toBe(300_000);
  });

  it('rejects "0s" — a zero-length deadline is never meaningful', () => {
    expect(() => parseOperationTimeoutMs('0s')).toThrow(
      /Invalid timeout: "0s"/,
    );
  });

  it('rejects "0m", "0h", and "0d" the same way as "0s"', () => {
    for (const zero of ['0m', '0h', '0d']) {
      expect(() => parseOperationTimeoutMs(zero)).toThrow(
        /A zero-length timeout is not allowed/,
      );
    }
  });

  it('propagates the underlying parseDuration error for a malformed value', () => {
    expect(() => parseOperationTimeoutMs('soon')).toThrow(
      /Invalid duration: "soon"/,
    );
  });
});

describe('createImmediateNotifier', () => {
  it('fires callback synchronously for every observation', () => {
    const fired: Observation[] = [];
    const notifier = createImmediateNotifier((o) => fired.push(o));

    notifier.submit(obs('first'));
    notifier.submit(obs('second'));

    expect(fired).toHaveLength(2);
    expect(fired[0]?.title).toBe('first');
    expect(fired[1]?.title).toBe('second');
  });
});

describe('createDebounceNotifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after settle period with no new observations', () => {
    const fired: Observation[] = [];
    const notifier = createDebounceNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(5000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.title).toBe('first');
  });

  it('resets timer on new observation', () => {
    const fired: Observation[] = [];
    const notifier = createDebounceNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    vi.advanceTimersByTime(3000);
    notifier.submit(obs('second'));
    vi.advanceTimersByTime(3000);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(2000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.title).toBe('second');
  });

  it('fires with the last observation', () => {
    const fired: Observation[] = [];
    const notifier = createDebounceNotifier((o) => fired.push(o), 1000);

    notifier.submit(obs('a'));
    notifier.submit(obs('b'));
    notifier.submit(obs('c'));

    vi.advanceTimersByTime(1000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.title).toBe('c');
  });

  it('dispose cancels pending timer', () => {
    const fired: Observation[] = [];
    const notifier = createDebounceNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    notifier.dispose();
    vi.advanceTimersByTime(10_000);

    expect(fired).toHaveLength(0);
  });
});

describe('createThrottleNotifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately on first observation', () => {
    const fired: Observation[] = [];
    const notifier = createThrottleNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.title).toBe('first');
  });

  it('suppresses observations during cooldown', () => {
    const fired: Observation[] = [];
    const notifier = createThrottleNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    notifier.submit(obs('second'));
    notifier.submit(obs('third'));

    expect(fired).toHaveLength(1);
    expect(fired[0]?.title).toBe('first');
  });

  it('allows new observation after cooldown expires', () => {
    const fired: Observation[] = [];
    const notifier = createThrottleNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    vi.advanceTimersByTime(5000);
    notifier.submit(obs('second'));

    expect(fired).toHaveLength(2);
    expect(fired[1]?.title).toBe('second');
  });

  it('dispose resets suppression', () => {
    const fired: Observation[] = [];
    const notifier = createThrottleNotifier((o) => fired.push(o), 5000);

    notifier.submit(obs('first'));
    notifier.dispose();
    notifier.submit(obs('second'));

    expect(fired).toHaveLength(2);
  });
});
