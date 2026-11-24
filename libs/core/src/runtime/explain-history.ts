/**
 * What one `observation_history` row records, for `monitor explain`
 * (002 §10.7, 005 §6 `monitor explain`).
 *
 * History holds more than source outcomes. Lost observations (002 §2) and the
 * retained-work drain's reports (002 §2.7) are `errored` rows too, though no
 * source call failed. Explain classifies every row here, once, and each stage
 * reads only the kinds it owns, so a loss or a drain report is never read as a
 * failed source call. The classification is exhaustive: a row with an outcome
 * this module does not recognize is `unrecognized`, which no stage reads,
 * rather than falling through to the Observation stage.
 *
 * The kinds are read from what is already recorded; this module never decides
 * what a row records.
 *
 * @internal
 */
import type { ObservationHistoryRecord, ObservationOutcome } from './types.js';

/**
 * The kind of one history row (005 §6, "Which history rows each stage reads").
 *
 * - `source-outcome` — what a source call produced: a span's batch row
 *   (`triggered` with observations, `suppressed`, `no-change`,
 *   `no-files-matched`, `rebaselined`) or an `errored` row with none of the
 *   markers below, or a drained tick's `triggered` row that keeps the
 *   source's own `no-files-matched` or `rebaselined` as `sourceOutcome`
 *   (002 §15). The Observation stage reads it.
 * - `released-work` — any other `triggered` row with `observed: 0`: held
 *   notify work flushed, or retained work drained, with no new source input
 *   (002 §2.6, §2.7). Work was materialized; nothing is missing.
 * - `admission-loss` — an observation a span dispatched but could not keep:
 *   the outbox could not retain it (`notRetained`) or a hold refused it
 *   (`holdRefused`) (002 §2, §4.7). The source call succeeded. Materialization
 *   reports the loss.
 * - `skipped-retry-loss` — a terminal retry an operator skipped (`skipped`,
 *   002 §2.7). Materialization reports the loss.
 * - `retry-drain` — the drain's report of retained work it could not complete:
 *   a failed attempt, a failed removal of a retired artifact's row, or a
 *   monitor paused behind a terminal retry (002 §2.7). Materialization reports
 *   the retained work.
 * - `unrecognized` — an outcome this version does not know. No stage reads it.
 *
 * @internal
 */
export type HistoryRowKind =
  | 'source-outcome'
  | 'released-work'
  | 'admission-loss'
  | 'skipped-retry-loss'
  | 'retry-drain'
  | 'unrecognized';

/** One history row with its kind. @internal */
export interface ClassifiedHistoryRow {
  kind: HistoryRowKind;
  row: ObservationHistoryRecord;
}

/**
 * The opening of every error the retained-work drain records (002 §2.7). The
 * runtime writes these messages through {@link retryDrainReport}, and
 * {@link classifyHistoryRow} recognizes them by the same opening, so the two
 * cannot drift apart. The retry id is a ULID (26 Crockford base32 characters),
 * as the outbox mints every retry id.
 *
 * History records no marker for these rows, so a source error that opens the
 * same way, ULID included, reads as a drain report (005 §6). Whether the
 * outbox held that retry when the row was written cannot be checked: a retry
 * leaves the outbox when it completes, and history does not record outbox
 * state.
 */
const RETRY_DRAIN_REPORT_PATTERN =
  /^Materialization retry [0-9A-HJKMNP-TV-Z]{26} (?:failed: |could not be discarded |stopped after )/u;

/**
 * Build a retained-work drain report (002 §2.7): `Materialization retry <id>`
 * followed by `failed: …`, `could not be discarded …` or `stopped after …`.
 *
 * @internal
 */
export function retryDrainReport(
  retryId: string,
  outcome:
    | `failed: ${string}`
    | `could not be discarded ${string}`
    | `stopped after ${string}`,
): string {
  return `Materialization retry ${retryId} ${outcome}`;
}

/** Outcomes a batch row or a source failure records (002 §15 `observation_history`). */
function isSourceBatchOutcome(
  result: ObservationOutcome,
): result is Exclude<ObservationOutcome, 'errored'> {
  switch (result) {
    case 'triggered':
    case 'suppressed':
    case 'no-change':
    case 'no-files-matched':
    case 'rebaselined':
      return true;
    case 'errored':
      return false;
    default: {
      // Stored rows are typed by the reader, not checked; a newer writer can
      // still record an outcome this version does not know.
      const unknown: never = result;
      void unknown;
      return false;
    }
  }
}

/**
 * Classify one history row by what it records (see {@link HistoryRowKind}).
 *
 * @internal
 */
export function classifyHistoryRow(
  row: ObservationHistoryRecord,
): HistoryRowKind {
  const data = row.observationData;
  if (row.result === 'errored') {
    if (data['notRetained'] === true || data['holdRefused'] === true) {
      return 'admission-loss';
    }
    if (data['skipped'] === true) return 'skipped-retry-loss';
    const error = data['error'];
    if (typeof error === 'string' && RETRY_DRAIN_REPORT_PATTERN.test(error)) {
      return 'retry-drain';
    }
    return 'source-outcome';
  }
  if (!isSourceBatchOutcome(row.result)) return 'unrecognized';
  if (row.result === 'triggered' && data['observed'] === 0) {
    // The drained tick's source still reported its own outcome (002 §15).
    const sourceOutcome = data['sourceOutcome'];
    return sourceOutcome === 'no-files-matched' ||
      sourceOutcome === 'rebaselined'
      ? 'source-outcome'
      : 'released-work';
  }
  return 'source-outcome';
}

/**
 * Classify a newest-first history window. The order is preserved.
 *
 * @internal
 */
export function classifyHistory(
  rows: readonly ObservationHistoryRecord[],
): ClassifiedHistoryRow[] {
  return rows.map((row) => ({ kind: classifyHistoryRow(row), row }));
}
