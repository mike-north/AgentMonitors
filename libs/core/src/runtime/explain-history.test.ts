/**
 * Classification of `observation_history` rows for `monitor explain`
 * (005 §6, "Which history rows each stage reads"). Each expected kind comes
 * from what 002 says the row records, not from the classifier's output.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2, §2.6, §2.7, §4.7
 * @see ../../../../docs/specs/005-cli-reference.md `monitor explain`
 */
import { describe, expect, it } from 'vitest';
import {
  classifyHistory,
  classifyHistoryRow,
  retryDrainReport,
} from './explain-history.js';
import type { ObservationHistoryRecord, ObservationOutcome } from './types.js';

const CREATED_AT = new Date('2026-08-13T18:00:00.000Z');

function row(
  result: ObservationOutcome,
  observationData: Record<string, unknown>,
): ObservationHistoryRecord {
  return {
    id: `row-${result}`,
    monitorId: 'm',
    workspacePath: '/work',
    sourceName: 'stage-source',
    observationData,
    result,
    createdAt: CREATED_AT,
  };
}

describe('classifyHistoryRow', () => {
  it.each([
    ['triggered', { observed: 2, emitted: 2 }],
    ['suppressed', { observed: 1, emitted: 0 }],
    ['no-change', { observed: 0, emitted: 0 }],
    ['no-files-matched', { observed: 0, emitted: 0 }],
    ['rebaselined', { observed: 0, emitted: 0 }],
  ] as const)('a %s batch row is a source outcome', (result, data) => {
    expect(classifyHistoryRow(row(result, data))).toBe('source-outcome');
  });

  it('an errored row without a loss or drain marker is a source outcome (a failed source call)', () => {
    expect(
      classifyHistoryRow(row('errored', { error: 'upstream is down' })),
    ).toBe('source-outcome');
  });

  it('a triggered row with observed 0 is released work, not a missing observation (002 §2.6, §2.7)', () => {
    // A held flush, or a drained retry recorded as one row per monitor per tick.
    expect(
      classifyHistoryRow(row('triggered', { observed: 0, emitted: 3 })),
    ).toBe('released-work');
  });

  it.each([
    [
      'an outbox drop',
      { error: 'x Not retained for retry: full.', notRetained: true },
    ],
    [
      'a hold refusal',
      { error: 'Observation "A" was not held', holdRefused: true },
    ],
  ])('%s is an admission loss (002 §2, §4.7)', (_name, data) => {
    expect(classifyHistoryRow(row('errored', data))).toBe('admission-loss');
  });

  it('a skipped terminal retry is a skipped-retry loss (002 §2.7)', () => {
    expect(
      classifyHistoryRow(
        row('errored', {
          error: 'A write failed Retry skipped after 5 failed attempts.',
          skipped: true,
          retryId: 'r1',
        }),
      ),
    ).toBe('skipped-retry-loss');
  });

  it.each([
    retryDrainReport('r1', 'failed: A write failed'),
    retryDrainReport(
      'r1',
      "could not be discarded after its verify artifact's cleanup took effect: busy",
    ),
    retryDrainReport(
      'r1',
      'stopped after 5 failed attempts; newer input waits',
    ),
  ])('the drain report %j is a retry-drain row (002 §2.7)', (error) => {
    expect(classifyHistoryRow(row('errored', { error }))).toBe('retry-drain');
  });

  it('a source error that only mentions a retry is still a source outcome', () => {
    expect(
      classifyHistoryRow(
        row('errored', { error: 'upstream said: Materialization retry r1' }),
      ),
    ).toBe('source-outcome');
  });

  it('a marker that is not exactly true does not make a loss', () => {
    expect(
      classifyHistoryRow(row('errored', { error: 'boom', skipped: 'true' })),
    ).toBe('source-outcome');
  });

  it('an outcome this version does not know is unrecognized, never a source outcome', () => {
    // A newer writer can store a result the reader's type does not include.
    const future = row('triggered', {});
    (future as { result: string }).result = 'deferred';
    expect(classifyHistoryRow(future)).toBe('unrecognized');
  });
});

describe('classifyHistory', () => {
  it('keeps the window newest first', () => {
    const rows = [
      row('errored', { error: 'lost', holdRefused: true }),
      row('no-change', { observed: 0, emitted: 0 }),
    ];
    expect(classifyHistory(rows).map(({ kind }) => kind)).toEqual([
      'admission-loss',
      'source-outcome',
    ]);
  });
});
