/**
 * Verification uses retained observation identity, not second-rounded timestamps,
 * to separate historical rows from new recording activity. These tests preserve
 * conservative negative verdicts for in-flight work and incomplete history.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createDb,
  RuntimeStore,
  type ObservationHistoryRecord,
  type ObservationOutcome,
} from '@agentmonitors/core';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import {
  createObserveWindow,
  resolveObserveDeadline,
  resolveObserveVerdict,
} from './verify-observe.js';

/** Arbitrary millisecond timestamps intentionally share one persisted second. */
function row(
  id: string,
  result: ObservationOutcome,
  createdAtMs = 1000,
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
const BASELINE = row('01BASE', 'triggered');

/** Every complete first window includes the already-captured baseline frontier. */
function complete(
  ...rows: ObservationHistoryRecord[]
): ObservationHistoryRecord[] {
  return [...rows, BASELINE];
}

describe('resolveObserveVerdict', () => {
  it('recognizes a new same-second triggered row and excludes historical same-second success', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    expect(
      resolveObserveVerdict(
        [BASELINE, row('00OLD', 'triggered')],
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        complete(
          row('04', 'no-change', 3000),
          row('03', 'no-change', 2000),
          row('02', 'triggered', 1000),
        ),
        state,
        false,
      ),
    ).toBe('triggered');
  });

  it('uses actual persisted identities to distinguish equal-second observation timestamps', () => {
    const db = createDb(':memory:');
    // The fixture owns this connection; the public branded DB hides its client.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    const store = new RuntimeStore(db);
    const input = {
      monitorId: 'm',
      workspacePath: '/ws',
      sourceName: 'test',
      result: 'triggered' as const,
      observationData: {},
    };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1100);
      store.recordObservationHistory(input);
      const baseline = store.listObservationHistory({
        monitorId: 'm',
        workspacePath: '/ws',
      })[0];
      if (!baseline) throw new Error('Expected baseline');
      const state = createObserveWindow(baseline.id, baseline.id);
      expect(resolveObserveVerdict([baseline], state, false)).toBeNull();
      vi.setSystemTime(1750);
      store.recordObservationHistory(input);
      const rows = store.listObservationHistory({
        monitorId: 'm',
        workspacePath: '/ws',
      });
      expect(rows.map(({ createdAt }) => createdAt.getTime())).toEqual([
        1000, 1000,
      ]);
      expect(rows[0]?.id).not.toBe(baseline.id);
      expect(resolveObserveVerdict(rows, state, false)).toBe('triggered');
      // A second write at exactly1750ms must advance raw identity too; record
      // order is now the boundary even when neither clock precision advances.
      const firstId = rows[0]?.id;
      if (!firstId) throw new Error('Expected first new observation');
      store.recordObservationHistory(input);
      const sameMillisecond = store.listObservationHistory({
        monitorId: 'm',
        workspacePath: '/ws',
      });
      expect(sameMillisecond).toHaveLength(3);
      const secondId = sameMillisecond[0]?.id;
      if (!secondId) throw new Error('Expected second new observation');
      expect(secondId > firstId).toBe(true);
      expect(
        sameMillisecond.map(({ createdAt }) => createdAt.getTime()),
      ).toEqual([1000, 1000, 1000]);
    } finally {
      vi.useRealTimers();
      client.close();
    }
  });

  it('retains a triggered row recorded while the trigger command is still running', () => {
    const state = createObserveWindow(BASELINE.id, '03');
    expect(
      resolveObserveVerdict(
        complete(row('03', 'no-change', 3000), row('02', 'triggered', 2000)),
        state,
        false,
      ),
    ).toBe('triggered');
  });

  it('ignores negative evidence from during a long trigger command', () => {
    const state = createObserveWindow(BASELINE.id, '03');
    expect(
      resolveObserveVerdict(
        complete(row('03', 'no-change'), row('02', 'no-change')),
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('04', 'no-change'), row('03', 'no-change')],
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('05', 'no-change'), row('04', 'no-change')],
        state,
        false,
      ),
    ).toBe('no-change');
  });

  it('requires distinct newly recorded no-change rows, not repeated sightings', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    const first = complete(row('02', 'no-change'));
    for (let poll = 0; poll < 5; poll += 1)
      expect(resolveObserveVerdict(first, state, false)).toBeNull();
    // Adjacent windows retain the frontier even though the baseline aged out.
    expect(
      resolveObserveVerdict(
        [row('03', 'no-change'), row('02', 'no-change')],
        state,
        false,
      ),
    ).toBe('no-change');
  });

  it('lets triggered win over two no-change rows', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    expect(
      resolveObserveVerdict(
        complete(
          row('04', 'triggered'),
          row('03', 'no-change'),
          row('02', 'no-change'),
        ),
        state,
        false,
      ),
    ).toBe('triggered');
  });

  it('fails fast on newly recorded no-files-matched only after trigger completion', () => {
    const state = createObserveWindow(BASELINE.id, '02');
    expect(
      resolveObserveVerdict(
        complete(row('02', 'no-files-matched')),
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('03', 'no-files-matched'), row('02', 'no-files-matched')],
        state,
        false,
      ),
    ).toBe('no-files-matched');
  });

  it('remembers settling evidence after a bounded history window rotates', () => {
    const state = createObserveWindow(BASELINE.id, '02');
    expect(
      resolveObserveVerdict(complete(row('02', 'suppressed')), state, false),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('03', 'no-change'), row('02', 'suppressed')],
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('04', 'no-change'), row('03', 'no-change')],
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('05', 'triggered'), row('04', 'no-change')],
        state,
        false,
      ),
    ).toBe('triggered');
  });

  it('does not let prior no-change sightings overpower later settling evidence', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    expect(
      resolveObserveVerdict(complete(row('02', 'no-change')), state, false),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [
          row('04', 'no-change'),
          row('03', 'suppressed'),
          row('02', 'no-change'),
        ],
        state,
        false,
      ),
    ).toBeNull();
  });

  it('refuses negative verdicts when a truncated window could have hidden a change', () => {
    const state = createObserveWindow(BASELINE.id, '04');
    // Missing the prior frontier means an intervening success/suppression could
    // have fallen out of the retained window before the first poll.
    expect(
      resolveObserveVerdict(
        [row('06', 'no-change'), row('05', 'no-change')],
        state,
        false,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('07', 'no-files-matched'), row('06', 'no-change')],
        state,
        false,
      ),
    ).toBeNull();
    // A visible positive remains evidence even when earlier history is missing.
    expect(
      resolveObserveVerdict(
        [row('08', 'triggered'), row('07', 'no-files-matched')],
        state,
        false,
      ),
    ).toBe('triggered');
  });

  it('never treats an empty/unavailable history window as evidence of no change', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    expect(resolveObserveVerdict([], state, false)).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('03', 'no-change'), row('02', 'no-change')],
        state,
        false,
      ),
    ).toBeNull();
  });

  it('never fail-fasts in manual mode but accepts a newly recorded change', () => {
    const state = createObserveWindow(BASELINE.id, BASELINE.id);
    expect(
      resolveObserveVerdict(
        complete(row('03', 'no-change'), row('02', 'no-change')),
        state,
        true,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('04', 'no-files-matched'), row('03', 'no-change')],
        state,
        true,
      ),
    ).toBeNull();
    expect(
      resolveObserveVerdict(
        [row('05', 'triggered'), row('04', 'no-files-matched')],
        state,
        true,
      ),
    ).toBe('triggered');
  });

  it('does not depend on wire timestamps being revived into Date instances', () => {
    const wire = {
      ...row('02', 'triggered'),
      createdAt: '1970-01-01T00:00:01.000Z',
    } as unknown as ObservationHistoryRecord;
    expect(
      resolveObserveVerdict(
        complete(wire),
        createObserveWindow(BASELINE.id, BASELINE.id),
        false,
      ),
    ).toBe('triggered');
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
