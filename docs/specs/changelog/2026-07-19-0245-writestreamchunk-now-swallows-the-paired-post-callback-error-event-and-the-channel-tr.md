## 2026-07-19 — `writeStreamChunk` now swallows the paired post-callback `'error'` event, and the channel transport's render-before-commit ordering is reflected everywhere it was previously described as commit-before-render (006 §4.2.1, §5.5) — Refs #442

Two fixes found on this PR's round-11 review.

- **`writeStreamChunk` could still crash the hook process despite the round-10 fix.** A real Node
  `Writable` is not mutually exclusive between its write callback and its `'error'` event: when a
  write fails, Node invokes the callback with the error AND separately EMITS the paired `'error'`
  event on a LATER tick for that SAME failure. The round-10 version removed its only `'error'`
  listener as soon as the callback settled the promise, so that paired emission had no listener left
  and became an UNCAUGHT exception — three independent real-stream probes (a closed pipe's write, a
  spawned child's closed stdin, and an `fs` write stream on a closed fd) reproduced `callback EPIPE ->
rejected promise -> uncaught EPIPE`, which could exit the hook process nonzero despite its
  always-exit-0 contract. Fixed by keeping the `'error'` listener armed through that later tick
  whenever the callback settles with an error (so the paired event is safely swallowed instead of
  going uncaught), detaching it only on the paths where no paired event will ever follow — a
  successful write, or `stream.write()` itself throwing synchronously. New regressions drive an
  actually-closed `fs` write stream (closed fd) and a real closed pipe (a child process whose stdin's
  reader has exited), with a `process.on('uncaughtException', ...)` guard proving neither reproduction
  crashes the process.
- **006, source comments, and this changelog still described the channel transport's oversized-event
  marker as committed before render — but production reserves, pushes/renders, and only THEN commits
  (`runChannelDeliveryCycle`, mirroring the hook side's round-9 reordering).** Corrected
  `channel-render.ts`'s and `hook-deliver-render.ts`'s doc comments, 006 §4.2.1 and §5.5, and the
  round-10 entry above to state the conditional truth in full: a successful (non-null) commit prevents
  ordinary repoll; a commit that resolves null means the reservation's lease already lapsed
  (`'surfaced-uncommitted'`) and the row is definitely uncommitted and eligible for at-least-once
  redelivery; a commit that REJECTS (an IPC/transport error) is a third, distinct case, not the same as
  resolving null — the daemon may have applied it before the response was lost, so whether the row is
  claimed or still pending is genuinely UNCERTAIN. The round-11 pass had collapsed the null and
  rejected cases together ("a null/rejected commit leaves it uncommitted and eligible for redelivery"),
  which is a false guarantee for the rejected case and contradicted the round-11 fix's own point that
  render-time commit outcome is genuinely unknown. Round-12 also fixed a channel-only mixed case:
  when the reserved single event is oversized AND `moreDeferred` is true, `renderChannelEvent`
  appended only the truncation marker, silently dropping the "more work is pending" signal —
  `CHANNEL_DEFERRED_MARKER` is now appended alongside it, matching the hook transport's existing dual-
  marker handling of the identical mixed case. `buildChannelTruncatedMarker`'s own TEXT needed no
  wording change — it was already outcome-neutral; only the prose describing what it does and doesn't
  guarantee needed correcting.

006 §4.2.1 and §5.5 previously asserted the channel transport's claim is durably committed before
render, and — after the round-11 fix — conflated a null commit resolution with a rejected commit
call; both sections, plus the round-10 entry above, are now corrected to describe the actual
reserve → push/render → commit ordering and its three-way conditional outcome, and to document the
mixed-case dual-marker rendering.

