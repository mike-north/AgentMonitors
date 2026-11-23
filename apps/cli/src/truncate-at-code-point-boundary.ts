/** Shared prefix truncation for UTF-16 budgets in delivery content and diagnostics. */

/**
 * Return the longest prefix within `budget` UTF-16 code units without splitting
 * a surrogate pair. A code point that does not fit ends the prefix; later
 * characters are never substituted into the remaining space. Nonpositive
 * budgets retain nothing. Existing lone surrogates are preserved as supplied.
 *
 * Callers own marker reservation and sanitization. This helper preserves code
 * points, not grapheme clusters, so combining sequences can still be cut.
 *
 * @internal
 */
export function truncateAtCodePointBoundary(
  value: string,
  budget: number,
): string {
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out;
}
