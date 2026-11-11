/**
 * CLI boundary for retained-work metadata. Older daemon builds can return raw
 * legacy errors and JSON timestamps; normalize those observations without
 * modifying durable work or accepting captured envelopes as diagnostic output.
 */
import type {
  MaterializationRetrySummary,
  UnretainedObservationLoss,
} from '@agentmonitors/core';

/** Terminal controls and Unicode separators cannot carry additional output lines. */
// eslint-disable-next-line no-control-regex -- These controls are the unsafe input being normalized.
const RETRY_ERROR_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/**
 * Materialization details have a retry-summary variant and ordinary variants
 * such as event IDs. Recognize only the summary shape; unrelated stage details
 * retain their own semantics, even when they contain payload or records keys.
 * Socket timestamps are revived by normalizeRetrySummary, just as for the
 * report-level summary; this guard does not reinterpret persisted statuses.
 * Wire projection and text rendering share this app-internal discriminator.
 * @internal
 */
export function isMaterializationRetrySummary(
  details: Record<string, unknown> | undefined,
): details is Record<string, unknown> & MaterializationRetrySummary {
  return (
    details != null &&
    typeof details['pending'] === 'number' &&
    typeof details['terminal'] === 'number' &&
    typeof details['bytes'] === 'number' &&
    Array.isArray(details['records'])
  );
}

/**
 * Keep legacy failure text on one bounded terminal line. This is control
 * normalization, not secret redaction; callers must supply error metadata only.
 * @internal
 */
export function retryErrorForDisplay(error: string | null): string | null {
  return error?.replace(RETRY_ERROR_CONTROLS, ' ').slice(0, 1024) ?? null;
}

/**
 * Reconstruct the retry Date contract and explicitly project allowed metadata.
 * Optional report fields are handled by callers so older daemons do not acquire
 * synthetic recovery obligations. Unknown envelope/payload fields never cross
 * this projection, even if an older daemon included them.
 * @internal
 */
export function normalizeRetrySummary(
  summary: MaterializationRetrySummary,
): MaterializationRetrySummary {
  return {
    pending: summary.pending,
    terminal: summary.terminal,
    bytes: summary.bytes,
    records: summary.records.map((record) => ({
      id: record.id,
      status: record.status,
      attemptCount: record.attemptCount,
      nextAttemptAt:
        record.nextAttemptAt === null ? null : new Date(record.nextAttemptAt),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      lastError: retryErrorForDisplay(record.lastError),
    })),
  };
}

/**
 * Shared human-readable record details for explain and doctor. Record identity,
 * attempts and deadlines support investigation without implying an implemented
 * operator retry command. Error normalization remains defensive at display time.
 * @internal
 */
export function retryRecordLines(
  summary: MaterializationRetrySummary | undefined,
): string[] {
  return (summary?.records ?? []).flatMap((record) => {
    const lines = [
      `  Retry ${record.id}: status=${record.status}  attempts=${String(record.attemptCount)}  next-at=${record.nextAttemptAt?.toISOString() ?? 'none'}  updated-at=${record.updatedAt.toISOString()}`,
    ];
    const error = retryErrorForDisplay(record.lastError);
    if (error) {
      lines.push(`    Last error: ${error}`);
    }
    return lines;
  });
}

/**
 * Reconstruct an unretained-observation loss from the wire: revive its Date
 * and project only its documented metadata fields, with text normalized like
 * retry errors. A malformed value from a skewed daemon is dropped rather than
 * rendered, since doctor cannot describe what it cannot read.
 * @internal
 */
export function normalizeUnretainedObservationLoss(
  loss: UnretainedObservationLoss | undefined,
): UnretainedObservationLoss | undefined {
  if (
    loss == null ||
    typeof loss.count !== 'number' ||
    !Number.isSafeInteger(loss.count) ||
    loss.count < 1 ||
    typeof loss.error !== 'string'
  ) {
    return undefined;
  }
  // A missing or unparseable timestamp would revive as an Invalid Date that
  // throws when doctor renders it, so the whole loss is treated as absent.
  const rawRecordedAt: unknown = loss.recordedAt;
  const recordedAt = new Date(rawRecordedAt as string);
  if (
    (typeof rawRecordedAt !== 'string' && typeof rawRecordedAt !== 'number') ||
    Number.isNaN(recordedAt.getTime())
  ) {
    return undefined;
  }
  const text = (value: unknown): string | undefined =>
    typeof value === 'string'
      ? (retryErrorForDisplay(value) ?? undefined)
      : undefined;
  const integer = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : undefined;
  const position = integer(loss.position);
  const spanSize = integer(loss.spanSize);
  const objectKey = text(loss.objectKey);
  const title = text(loss.title);
  return {
    count: loss.count,
    recordedAt,
    error: text(loss.error) ?? '',
    ...(position !== undefined ? { position } : {}),
    ...(spanSize !== undefined ? { spanSize } : {}),
    ...(objectKey !== undefined ? { objectKey } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * Which observation a loss names, on one line:
 * `observation 300 of 600 (object-299, "Title")`. Mirrors explain's wording.
 * @internal
 */
export function describeUnretainedObservation(
  loss: UnretainedObservationLoss,
): string {
  const position =
    loss.position !== undefined
      ? `observation ${String(loss.position)}${loss.spanSize !== undefined ? ` of ${String(loss.spanSize)}` : ''}`
      : 'an observation';
  const identity = [
    ...(loss.objectKey !== undefined ? [loss.objectKey] : []),
    ...(loss.title !== undefined ? [`"${loss.title}"`] : []),
  ];
  return identity.length > 0
    ? `${position} (${identity.join(', ')})`
    : position;
}
