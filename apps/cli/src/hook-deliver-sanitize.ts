/**
 * Shared control-safe rendering for untrusted `hook deliver` stdin fields
 * (`session_id`, `hook_event_name`, `cwd`), used by both the always-on
 * stderr warnings (`hook-deliver-warnings.ts`, issues #329/#420) and the
 * opt-in `--debug` diagnosis (`hook-deliver-debug.ts`, issue #334). Both
 * paths interpolate the SAME untrusted payload fields into stderr, so they
 * MUST share one definition of "render untrusted id safely" rather than
 * risk drifting (issue #365).
 *
 * @see ../../../docs/specs/006-agent-integration.md §5.2.1
 * @see ../../../docs/specs/005-cli-reference.md §12.2.1
 */

/**
 * Force an untrusted string field from the stdin payload into a single-line,
 * control-safe, quoted form suitable for a stderr line. Any of the callers'
 * lines can be emitted for a pathological / hostile payload, so the raw
 * value must never carry terminal escape sequences or line breaks.
 *
 * `JSON.stringify` escapes newlines, tabs, ESC, and every other C0 control
 * character (plus quotes and backslashes); a follow-up pass escapes what it
 * leaves raw — DEL, the C1 controls (U+0080–U+009F, e.g. CSI), and the
 * U+2028/U+2029 line/paragraph separators (terminal/log injection; same
 * C0/C1 concern as hook-deliver-render.ts's sanitize). The length bound keeps
 * a pathological payload from flooding stderr, and truncation cuts at a
 * code-point boundary (not a raw UTF-16 index) so a surrogate pair is never
 * split into a lone surrogate that renders as a garbled \ud83d-style escape
 * (same rationale as hook-deliver-render.ts's truncateForCap).
 */
export function sanitizeUntrustedField(value: string): string {
  const MAX_LENGTH = 128;
  let truncated = value;
  if (value.length > MAX_LENGTH) {
    let out = '';
    for (const ch of value) {
      if (out.length + ch.length > MAX_LENGTH) break;
      out += ch;
    }
    truncated = `${out}…`;
  }
  // None of these code points can appear inside an escape sequence
  // JSON.stringify already produced, so a post-pass over the serialized string
  // is safe and keeps the output a valid, round-trippable JSON string.
  return JSON.stringify(truncated).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Same as {@link sanitizeUntrustedField}, but renders a missing/absent field
 * as the literal `(none)` instead of quoting the string `"undefined"`.
 */
export function sanitizeUntrustedFieldOrNone(
  value: string | undefined,
): string {
  return value === undefined ? '(none)' : sanitizeUntrustedField(value);
}
