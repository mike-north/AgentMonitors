/**
 * Unit tests for `verify`'s observe-stage discriminator (issue #442 round 19).
 *
 * These are deterministic, fast, unit-level tests on the pure predicate and
 * deadline math — NOT the slow, daemon-backed integration path in
 * `commands/verify.integration.test.ts` — so the discriminator's edge cases
 * (a single stale row, a second distinct row, a genuine `triggered` row
 * arriving mid-window) can be exercised without spinning up a real daemon.
 *
 * @see docs/specs/005-cli-reference.md §16
 */
import { describe, it, expect } from 'vitest';
import type {
  ObservationHistoryRecord,
  ObservationOutcome,
} from '@agentmonitors/core';
import {
  resolveObserveDeadline,
  resolveObserveVerdict,
} from './verify-observe.js';

const OBSERVE_FROM = 1_000_000;

function row(
  id: string,
  result: ObservationOutcome,
  createdAtMs: number,
): ObservationHistoryRecord {
  return {
    id,
    monitorId: 'm',
    workspacePath: '/ws',
    sourceName: 'file-fingerprint',
    observationData: {},
    result,
    createdAt: new Date(createdAtMs),
  };
}

describe('resolveObserveVerdict', () => {
  it('is not decisive on a single post-trigger no-change row, however many times it is re-seen', () => {
    // The SAME stale row, re-read on every poll — simulating a tick that was
    // already in flight when the trigger fired and finished just after
    // `observeFrom`. This must never become decisive on its own; it is the
    // exact bug this predicate exists to fix (issue #442 round 19).
    const rows = [row('01ROW1', 'no-change', OBSERVE_FROM + 100)];
    const seen = new Set<string>();
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBeNull();
    // Re-polling with the exact same row (nothing new happened) — still null.
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBeNull();
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBeNull();
  });

  it('is decisive once a SECOND, DISTINCT post-trigger no-change row is seen', () => {
    const seen = new Set<string>();
    const firstPoll = [row('01ROW1', 'no-change', OBSERVE_FROM + 100)];
    expect(
      resolveObserveVerdict(firstPoll, OBSERVE_FROM, false, seen),
    ).toBeNull();

    // A genuinely later, distinct tick also observed no-change.
    const secondPoll = [
      row('01ROW2', 'no-change', OBSERVE_FROM + 1_200),
      row('01ROW1', 'no-change', OBSERVE_FROM + 100),
    ];
    expect(resolveObserveVerdict(secondPoll, OBSERVE_FROM, false, seen)).toBe(
      'no-change',
    );
  });

  it('a genuine `triggered` row still wins immediately, even amid stale no-change rows', () => {
    const seen = new Set<string>();
    const rows = [
      row('01ROW2', 'triggered', OBSERVE_FROM + 1_200),
      row('01ROW1', 'no-change', OBSERVE_FROM + 100),
    ];
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBe(
      'triggered',
    );
  });

  it('ignores pre-trigger rows entirely', () => {
    const seen = new Set<string>();
    const rows = [
      row('01ROW1', 'no-change', OBSERVE_FROM - 500),
      row('01ROW0', 'triggered', OBSERVE_FROM - 10),
    ];
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBeNull();
  });

  it('is decisive immediately for a post-trigger no-files-matched row', () => {
    const seen = new Set<string>();
    const rows = [row('01ROW1', 'no-files-matched', OBSERVE_FROM + 100)];
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBe(
      'no-files-matched',
    );
  });

  it('suppresses the no-change verdict while a suppressed row is present (debounce settling — 002 §9.2/§9.3)', () => {
    const seen = new Set<string>();
    const rows = [
      row('01ROW2', 'no-change', OBSERVE_FROM + 1_200),
      row('01ROW1', 'suppressed', OBSERVE_FROM + 100),
    ];
    // Even two no-change-flavored rows must not fire while a `suppressed` row
    // is in the window — the change WAS observed and is settling; the eventual
    // `triggered` row at flush wins via the earlier check.
    expect(resolveObserveVerdict(rows, OBSERVE_FROM, false, seen)).toBeNull();
  });

  it('never fail-fasts on no-change or no-files-matched in manual mode', () => {
    const seen = new Set<string>();
    const noChangeRows = [
      row('01ROW1', 'no-change', OBSERVE_FROM + 100),
      row('01ROW2', 'no-change', OBSERVE_FROM + 1_200),
    ];
    expect(
      resolveObserveVerdict(noChangeRows, OBSERVE_FROM, true, seen),
    ).toBeNull();
    const noFilesRows = [row('01ROW1', 'no-files-matched', OBSERVE_FROM + 100)];
    expect(
      resolveObserveVerdict(noFilesRows, OBSERVE_FROM, true, seen),
    ).toBeNull();
    // But a real `triggered` row still resolves even in manual mode.
    const triggeredRows = [row('01ROW3', 'triggered', OBSERVE_FROM + 2_000)];
    expect(resolveObserveVerdict(triggeredRows, OBSERVE_FROM, true, seen)).toBe(
      'triggered',
    );
  });

  it('coerces string/number createdAt (wire-deserialized shape) the same as a Date', () => {
    const seen = new Set<string>();
    const wireRow = {
      ...row('01ROW1', 'no-change', 0),
      createdAt: new Date(OBSERVE_FROM + 100).toISOString(),
    } as unknown as ObservationHistoryRecord;
    const wireRow2 = {
      ...row('01ROW2', 'no-change', 0),
      createdAt: new Date(OBSERVE_FROM + 1_200).toISOString(),
    } as unknown as ObservationHistoryRecord;
    expect(
      resolveObserveVerdict([wireRow], OBSERVE_FROM, false, seen),
    ).toBeNull();
    expect(
      resolveObserveVerdict([wireRow2, wireRow], OBSERVE_FROM, false, seen),
    ).toBe('no-change');
  });
});

describe('resolveObserveDeadline', () => {
  const OBSERVE_FROM_2 = 2_000_000;

  it('extends the deadline to fit noChangeConfirmMs when using the default budget', () => {
    const detectDeadline = OBSERVE_FROM_2 + 6_000; // e.g. 1s interval + 5s margin
    const noChangeConfirmMs = 7_000; // 2 * 1s interval + 5s margin
    const deadline = resolveObserveDeadline(
      OBSERVE_FROM_2,
      detectDeadline,
      noChangeConfirmMs,
      false,
    );
    expect(deadline).toBe(OBSERVE_FROM_2 + noChangeConfirmMs);
    expect(deadline).toBeGreaterThan(detectDeadline);
  });

  it('never shrinks the deadline below detectDeadline when noChangeConfirmMs is smaller', () => {
    const detectDeadline = OBSERVE_FROM_2 + 100_000;
    const deadline = resolveObserveDeadline(
      OBSERVE_FROM_2,
      detectDeadline,
      7_000,
      false,
    );
    expect(deadline).toBe(detectDeadline);
  });

  it('honors an explicit --timeout-ms as-is, never extending past it (issue #442 round 19)', () => {
    // A timeout shorter than one interval: the operator's real cap wins, and
    // the discriminator must fail fast with budget-exceeded rather than being
    // silently stretched to fit two intervals.
    const shortDetectDeadline = OBSERVE_FROM_2 + 500;
    const deadline = resolveObserveDeadline(
      OBSERVE_FROM_2,
      shortDetectDeadline,
      7_000,
      true,
    );
    expect(deadline).toBe(shortDetectDeadline);
  });
});
