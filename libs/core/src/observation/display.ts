/**
 * Maximum length of an object key rendered into human-facing observation text,
 * counted in UTF-16 code units (the unit every downstream cap in this repo uses).
 * Sized to stay readable on one terminal line while leaving room for the verb
 * prefix a source puts in front of it ("Command output changed: …").
 */
const MAX_DISPLAY_KEY_LENGTH = 60;

/**
 * Grapheme segmenter used to find a safe cut point. Constructed once at module
 * scope: `Intl.Segmenter` construction is comparatively expensive and this runs
 * per observation. Graphemes — not code points — are the right unit here because
 * the output is a headline a human reads: cutting a flag (`🇺🇸`, two regional
 * indicators) or a ZWJ sequence (`👩‍💻`) mid-cluster produces a *different*
 * visible character rather than the intended one, even though the result is
 * technically well-formed UTF-16.
 */
const graphemes = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * Render a source `objectKey` for inclusion in an observation's `title` or
 * `summary`, bounded to a headline-sized string (003 §2.8, issue #449).
 *
 * An `objectKey` is an **identity**, not a display string: it is free to be as
 * long as identity requires. `command-poll` defaults its key to the joined argv,
 * so a monitor polling an API through a large `jq` program produced a ~400
 * character headline that was entirely its own implementation detail — text that
 * lands verbatim in an agent's context window on every delivery.
 *
 * Sources that interpolate a **configuration-identity** `objectKey` (a joined
 * argv, a URL) into human-facing text pass it through this helper. The
 * untruncated key remains available on the observation itself (`objectKey`) and
 * in `payload`, so debugging loses nothing.
 *
 * **Truncation never splits a grapheme cluster.** Cutting by UTF-16 code unit
 * would emit a lone surrogate for an astral character (`"a".repeat(58) + "😀x"`
 * → 58 `a`s followed by a bare `\ud83d`), and that string is durably persisted
 * and re-serialized downstream. The cut is therefore made at a grapheme
 * boundary, which means the result may be SHORTER than the bound when a wide
 * cluster straddles it — the bound is a ceiling, not a target.
 *
 * @param objectKey - the source's stable object identity
 * @returns the key unchanged when short enough, otherwise a grapheme-safe prefix
 * ending in `…`, never longer than the bound
 *
 * @public
 */
export function displayObjectKey(objectKey: string): string {
  if (objectKey.length <= MAX_DISPLAY_KEY_LENGTH) return objectKey;
  // One code unit is reserved for the '…' so the returned string — marker
  // included — still respects the bound.
  const budget = MAX_DISPLAY_KEY_LENGTH - 1;
  let prefix = '';
  for (const { segment } of graphemes.segment(objectKey)) {
    if (prefix.length + segment.length > budget) break;
    prefix += segment;
  }
  return `${prefix}…`;
}
