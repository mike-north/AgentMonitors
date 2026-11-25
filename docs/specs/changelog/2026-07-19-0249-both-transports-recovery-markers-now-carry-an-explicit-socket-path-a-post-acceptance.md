## 2026-07-19 — Both transports' recovery markers now carry an explicit `--socket <path>`, a post-acceptance `moreDeferred` flip re-validates the actual claim's fit, and the hook side splits its marker framing to match the channel side's claimed-vs-deferred distinction (006 §4.2.1, §5.1, §5.5) — Refs #442

Four fixes found on this PR's round-7 review, all following directly from the round-3/round-6/round-5
entries below.

- **A post-acceptance `moreDeferred` flip could commit a claim the render then silently shrinks.**
  `reserveSizedChannelDelivery`'s candidate-set-growth re-check (round-6 entry below) computed
  `revalidatedMoreDeferred` AFTER `resolveChannelClaimFit` had already accepted the claim against the
  ORIGINAL `moreDeferred` value. At the cap boundary — two blocks that together fit under the FULL cap
  but NOT under the marker-reserving budget — a third candidate settling in the revalidation window
  flips `moreDeferred` to `true` post-acceptance; `renderChannelEvent` then has to reserve marker room
  itself and silently drops the second block from the render while `meta.event_count` still reports
  the full committed count. The fix recomputes `resolveChannelClaimFit` against the FINAL
  `moreDeferred` value before trusting it, and releases/retries through the existing mismatch path on
  a no-longer-fits result — exactly like the initial fit check does. Separately, if that revalidation
  preview call itself rejects, the reservation is now released BEFORE the error propagates (it
  previously threw first, leaving the reservation leased until the 30s TTL).
- **The mid-truncation marker's recovery command was not reliably runnable.** `channel serve` may be
  bound to an enabled workspace's own persisted/derived socket (issue #358), which takes precedence
  over a stale `$AGENTMONITORS_SOCKET` — but `agentmonitors events list` itself resolves its socket
  ENV-FIRST (issue #335), so a copy-pasted marker command with no `--socket` could silently query a
  stale or different workspace's daemon. `buildChannelTruncatedMarker` and the hook transport's marker
  builders now take the resolved `socketPath` and render an explicit, shell-quoted `--socket <path>`
  clause; `channel.ts`/`hook.ts`/`verify.ts`/`session.ts` thread their own resolved socket through.
- **The hook transport's single shared marker falsely implied the mid-truncated event would
  redeliver.** `hook-deliver-render.ts` previously rendered both the genuinely-deferred-remainder
  branch and the single-event mid-truncation branch (plus a truncated reminder message) with ONE
  marker whose "more monitor updates are pending" framing is only true for the FIRST. Since
  `claimDeliveryClient` claims (sets `first_notified_at`) synchronously, the mid-truncation/reminder
  cases are already-claimed content being cut — they will NOT redeliver via the ordinary
  context-event flow. The marker is split into `buildHookDeferredMarker` (kept for the genuinely
  deferred case) and `buildHookClaimedUnreadMarker` (claimed-unread framing for the other two),
  mirroring the channel transport's `CHANNEL_DEFERRED_MARKER` vs `buildChannelTruncatedMarker` split.
- **006 §5.5 and a matching source comment falsely claimed a mid-truncated hook event re-delivers.**
  Both are corrected to describe the claimed-unread recovery path (durable unread copy only, no
  automatic redelivery), consistent with the marker split above.

