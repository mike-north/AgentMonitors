/**
 * What a verify scratch key is: the object key of a synthetic file that
 * `agentmonitors verify` creates and deletes (`agentmonitors-verify-<token>[.ext]`),
 * which no real monitored object ever carries.
 *
 * Verify artifact ownership (002 §2.8, issue #562) is defined only over such
 * keys. The incoming-observation filter, the retained-retry drain filter, the
 * retry completion re-check and the retained-retry discard must all decide
 * "is this a retired verify artifact" with this one predicate; if any of them
 * diverged, a real path could be dropped by one stage and kept by another.
 * The module is separate from the runtime service so the store can share it
 * without importing the service.
 */

/**
 * True when `objectKey`'s basename is a `verify` scratch file
 * (`agentmonitors-verify-<token>[.ext]`) — a synthetic path verify created and
 * deleted, which no real monitored object ever carries (issue #414). It is the
 * canonical predicate gating every by-KEY object-event sweep (the reap backstop
 * AND `AgentMonitorRuntime.suppressObjectEvents`) so a by-key deletion can
 * only ever erase verify's own artifacts, never a real event at a genuine
 * watched path. Exported so the daemon-socket boundary can reject a non-scratch
 * key before it ever reaches the runtime.
 *
 * Splits on BOTH `/` and `\` so a Windows-style absolute `objectKey` (which
 * `verify` builds with `path.join`) still resolves to its basename — otherwise
 * the guard would fail to recognize a scratch key on Windows and leave stray
 * sessions/events behind (issue #418 review).
 */
export function isVerifyScratchObjectKey(objectKey: string): boolean {
  return verifyScratchRunId(objectKey) !== undefined;
}

/**
 * The run token a verify scratch key carries (`agentmonitors-verify-<token>`),
 * or `undefined` for any other key. Registration (issue #562) requires this to
 * equal the registering run's id, tying each artifact key to exactly one run.
 */
export function verifyScratchRunId(objectKey: string): string | undefined {
  const basename = objectKey.split(/[\\/]/).pop() ?? objectKey;
  return /^agentmonitors-verify-([0-9a-f]{12})(\..*)?$/.exec(basename)?.[1];
}
