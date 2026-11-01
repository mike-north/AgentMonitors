/**
 * CLI boundary for retained-work metadata. Older daemon builds can return raw
 * legacy errors and JSON timestamps; normalize those observations without
 * modifying durable work or accepting captured envelopes as diagnostic output.
 */
import type { MaterializationRetrySummary } from '@agentmonitors/core';

/** Terminal controls and Unicode separators cannot carry additional output lines. */
// eslint-disable-next-line no-control-regex -- These controls are the unsafe input being normalized.
const RETRY_ERROR_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

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
