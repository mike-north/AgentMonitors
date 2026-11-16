/**
 * Terminal-safe text for persisted runtime diagnostics.
 *
 * Diagnostics that the store persists and later projects to `explain`,
 * `doctor` and history readers (materialization-retry errors, and the
 * identity of an observation the retry outbox could not retain) may carry
 * source- or SQLite-supplied text. This module bounds that text so it can
 * never add output lines or control a terminal. It is control normalization,
 * not secret redaction: callers must pass metadata only, never a payload.
 *
 * Module-internal to the runtime; not part of the package's public API.
 */

/**
 * The longest persisted diagnostic string, in UTF-16 code units (002 `materialization_retry_outbox`).
 * @internal
 */
export const SAFE_DIAGNOSTIC_TEXT_MAX = 1_024;

/** C0, DEL, C1 and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex -- persisted diagnostics must remove terminal controls
const DIAGNOSTIC_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Replace each control or separator with a space and cap the result.
 * @internal
 */
export function safeDiagnosticText(text: string): string {
  return text
    .replace(DIAGNOSTIC_CONTROLS, ' ')
    .slice(0, SAFE_DIAGNOSTIC_TEXT_MAX);
}
