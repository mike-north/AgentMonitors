/**
 * Maximum length of an object key rendered into human-facing observation text.
 * Sized to stay readable on one terminal line while leaving room for the verb
 * prefix a source puts in front of it ("Command output changed: …").
 */
const MAX_DISPLAY_KEY_LENGTH = 60;

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
 * Sources that interpolate an `objectKey` into human-facing text MUST pass it
 * through this helper. The untruncated key remains available on the observation
 * itself (`objectKey`) and in `payload`, so debugging loses nothing.
 *
 * @param objectKey - the source's stable object identity
 * @returns the key unchanged when short enough, otherwise a prefix ending in `…`
 *
 * @public
 */
export function displayObjectKey(objectKey: string): string {
  if (objectKey.length <= MAX_DISPLAY_KEY_LENGTH) return objectKey;
  return `${objectKey.slice(0, MAX_DISPLAY_KEY_LENGTH - 1)}…`;
}
