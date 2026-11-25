## 2026-07-19 — Hook-deliver awaits the write's ACTUAL completion (not stdout's synchronous return), clears a stale `moreDeferred` for a raced-down eventless reminder, and reworks the pre-commit truncation marker to be truthful regardless of commit outcome (006 §5.1, §5.2, §5.5) — Refs #442

Three fixes found on this PR's round-10 review, all consequences of round-9's render-before-commit
reordering.

- **An async write failure arriving AFTER `process.stdout.write`'s synchronous return could still
  reopen the at-most-once loss window round-9 closed.** `stdout.write`'s synchronous `true`/`false`
  return is a BACKPRESSURE signal, not a success signal — a write can return `true` immediately and
  still fail asynchronously afterward (e.g. `EPIPE` once Claude Code's hook consumer has already
  closed its end of the pipe). `writeAndCommitHookDelivery` only awaited the caller-supplied `write`
  callback's own return, so a `write` that appeared to "return" successfully but failed later,
  invisibly, would still let `commit` land on an unwritten delivery. Fixed by threading a genuinely
  awaited seam through: `writeStreamChunk` promisifies `stream.write(chunk, callback)`, resolving only
  on the callback's success signal (or rejecting on its error), and additionally listens for the
  stream's own `'error'` event during the write (whichever fires first settles the promise) — this is
  the seam `hook.ts`'s `deliver` action now calls instead of a bare `process.stdout.write`. A
  failure-injection test reproduces the exact shape (`write()` returns `true` synchronously, then the
  awaited completion rejects asynchronously) and proves no commit happens and the reservation is
  released instead.
- **A reminder claim raced down from a settled-high preview kept the STALE preview's `moreDeferred`.**
  `reserveSizedHookDelivery`'s eventless (`reservation.claim.events.length === 0`) branch returned
  `moreDeferred` unchanged even when it had been computed `true` from a settled-high preview that
  later lost the race to another transport (the reservation legitimately falls back to a reminder).
  `renderHookDelivery` never reads `moreDeferred` for an eventless claim, so the render itself was
  never wrong — but `--debug`'s `describeCapDeferral` line does read it, so a stale `true` reported a
  spurious cap-deferral diagnostic for a claim with no cap-truncated events at all. The channel
  transport's `reserveSizedChannelDelivery` already clears `moreDeferred: false` for the identical
  race; `reserveSizedHookDelivery` now does too, with a test reproducing the stale-high-preview →
  eventless-reservation transition and asserting no cap-deferral diagnostics are emitted.
- **The pre-commit truncation marker asserted an outcome it could not yet know.** Round-9 moved
  rendering to BEFORE the reservation's commit, but `buildHookClaimedUnreadMarker` still said "it is
  claimed but NOT acknowledged ... it will not redeliver automatically" — true only if the commit
  **resolves non-null**, but FALSE if it **resolves null** (the reservation's lease already lapsed):
  the rows then are definitely never claimed and deliberately stay pending, so they WILL redeliver via
  the ordinary context-event flow (§5.5) — the opposite of what the marker promised. (A commit that
  **rejects**, an IPC/transport error, is a third, distinct case the round-9 fix did not yet separate
  out — see the round-12 entry above: the daemon may have applied it before the response was lost, so
  the row's eventual state is genuinely UNCERTAIN, not a guaranteed redelivery either.)
  Reworded to assert only what holds regardless of the commit's outcome: "this update was too large to
  show in full; the full copy stays unread — run `agentmonitors events list --session <id> --unread`
  to see it now". `buildHookRecapMarker` is similarly reworded to drop its own premature "is claimed"
  assertion, keeping only the self-healing future-recap promise (true regardless of this particular
  commit's outcome). The channel transport's `buildChannelTruncatedMarker` was already outcome-neutral
  for the identical reason: it has the SAME render-before-commit ordering (reserve → push/render →
  commit) and the same conditional outcome — a successful (non-null) commit prevents ordinary repoll;
  a commit that resolves null leaves the pushed event definitely eligible for at-least-once
  redelivery; a rejected commit is neither, leaving the outcome uncertain — so it needed no wording
  change here (a round-11 review found stale source/spec comments elsewhere still describing the
  channel as committed before render, and a round-12 review found the null/rejected distinction itself
  still collapsed in places; see the 2026-07-19 round-11 and round-12 entries above).

006 §5.1, §5.2, and §5.5 previously asserted a specific claimed/redelivery outcome for the hook
transport's pre-commit truncation markers, and described the synchronous `stdout.write` return as the
write-completion signal; both are now corrected to the outcome-agnostic marker wording and the
awaited-completion write seam actually shipped.

