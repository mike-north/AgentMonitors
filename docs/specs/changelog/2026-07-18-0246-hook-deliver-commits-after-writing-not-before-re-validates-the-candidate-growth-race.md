## 2026-07-18 — Hook-deliver commits AFTER writing (not before), re-validates the candidate-growth race, `verify` reuses the same reserve/validate/commit flow, and marker selection is lifecycle-aware for post-compact recaps (006 §5.2, §5.5, §6.1) — Refs #442

Four fixes found on this PR's round-9 review.

- **An at-most-once loss window: `hook deliver` committed the reservation BEFORE rendering or
  writing any output.** `commitDeliveryClient` — the durable `first_notified_at` mutation that
  permanently excludes rows from ordinary redelivery — ran first; if the daemon applied the commit
  but its RPC response was lost, or if rendering/stdout writing failed afterward, the command's
  always-exit-0 try/catch swallowed the error and emitted nothing while the rows were durably
  excluded from redelivery forever (recoverable only via the durable-but-unread `agentmonitors events
list` copy). Fixed by inverting the order: `reserveRenderAndCommitHookDelivery` renders the
  RESERVATION's own (not-yet-committed) claim immediately, and `writeAndCommitHookDelivery` writes
  that output to stdout FIRST, committing only after a successful write. A write failure now releases
  the reservation instead of committing (nothing durably claimed, rows return to pending); a commit
  failure/uncertainty AFTER a successful write only risks a later DUPLICATE delivery — the safe
  direction, never a loss. Mirrors the channel transport's reserve → push → commit ordering (§4,
  issue #300).
- **The hook transport's final fit check trusted `moreDeferred` from the PRE-reservation preview,**
  which could go stale in the direction the round-8 fix didn't cover: a preview seeing only event A
  sizes `maxEvents=1` and computes `moreDeferred=false`; event B settles before the reservation lands;
  the reservation legitimately returns only A, which fits on its own, so the (stale) `false` was
  returned unchanged — silently dropping the marker that would have told the agent B stays genuinely
  pending (§5.5). Fixed by adding the same post-reservation candidate-growth re-check the channel
  transport already had (`settledWorkRemainsBeyondClaim`, round-6 entry below): `reserveSizedHookDelivery`
  re-runs the settled-high preview once more, after the reservation is accepted, and flips
  `moreDeferred` to `true` when a settled event isn't in the reservation — recomputing fit against the
  final, marker-reserving budget and releasing/retrying if it no longer fits.
- **`verify`'s `claimAndRender` duplicated a bespoke, unvalidated preview → direct-claim → render
  sequence of its own,** instead of reusing the hardened flow `hook deliver` uses — so `verify` could
  pass even when the production claimed-set-equals-rendered-set contract (§5.5) was violated by the
  same substitution race the round-8 fix closed on the real hook path. Fixed by extracting the shared
  reserve → validate-fit → render → commit sequence into `reserveRenderAndCommitHookDelivery`
  (`hook.ts`), which both `hook deliver` and `verify`'s `claimAndRender` now call.
- **Marker selection wasn't lifecycle-aware: a `post-compact` recap could render either ordinary
  marker, both of which are untruthful for it.** `decideDelivery`'s recap branch reads
  `unreadEventsForSession` (not `pendingEventsForSession`) and claims the FULL unread candidate set at
  commit time regardless of what actually renders — so a row being claimed never hides it from a
  FUTURE recap, only acknowledging does. That makes the deferred-remainder marker's "not yet claimed"
  framing wrong (the omitted blocks ARE claimed) and the claimed-unread marker's "will not redeliver
  automatically" actively false (it WILL, on the next recap). Fixed by making `renderHookDelivery`
  check `claim.lifecycle === 'post-compact'` and use a single, unified `buildHookRecapMarker` in place
  of both ordinary markers for a recap.

006 §5.2, §5.5, and §6.1 previously described commit-before-render, a preview-only candidate-growth
guard, and a `claimDeliveryClient`-based capability-parity claim for `hook deliver`; all three are now
corrected to match the shipped write-before-commit ordering, the hook-side growth re-check, and the
reserve/commit sequence `hook deliver` (and `verify`) actually use. `channel-hooks-ipc-parity.test.ts`
is updated to match.

