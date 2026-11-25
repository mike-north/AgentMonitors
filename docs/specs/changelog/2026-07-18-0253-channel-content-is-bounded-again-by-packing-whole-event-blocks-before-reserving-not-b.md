## 2026-07-18 — Channel content is bounded again by packing whole event blocks before reserving, not by cutting an already-claimed render (006 §4.2.1, §5.5) — Refs #442

Supersedes/refines the "channel `content` is not length-bounded" entry directly below. Restoring
rendering-parity with the hook path (the entry below) made a coalesced channel push's SIZE unbounded
again: full event bodies plus a bounded per-event change summary, with no cap on how many coalesced
events one push could carry. That entry's fix (dropping the overall `content` cap) was necessary to
preserve claimed-set-equals-rendered-set, but on its own left one `notifications/claude/channel`
JSON-RPC payload with no upper bound at all.

- **The channel is bounded again, but the boundedness now lives BEFORE reservation, not in the
  renderer.** `renderChannelEvent` still renders every event in the `DeliveryClaim` it is given — it
  never drops a block to fit a cap, so claimed-set-equals-rendered-set (§5.5) is preserved exactly as
  the entry below established. `channel serve` now previews the settled high-urgency delivery
  (`previewSettledHighDeliveryClient`), sizes how many WHOLE event blocks fit under a channel-specific
  content ceiling (`packChannelEventsUnderCap`, `apps/cli/src/channel-render.ts`), and passes that
  count as `reserveDelivery`'s `maxEvents` — the identical pack-then-claim pattern the hook-deliver
  transport already used for its 4000-char `additionalContext` cap (§5.1, issue #299), just against a
  much larger, non-single-turn ceiling. Any events that do not fit stay pending and re-deliver on a
  later poll.
- **Single-oversized-event handling matches the hook path.** When one event's own block alone exceeds
  the ceiling, it is shown partially (mid-truncated at a Unicode code-point boundary) to guarantee
  forward progress — its full body stays unread and re-delivers, exactly as §5.5 already specifies for
  the hook transport.
- **The deferral marker is bracket-free by construction**, not sanitized after the fact — it is chosen
  to contain no `<`/`>`/`[`/`]` so it never needs a `contentValue` pass of its own and can never
  interact with the tag-breakout stripping (§4.6).
- **Shared truncation/packing primitives.** `truncateWithMarker` (the code-point-safe truncate-and-
  append-marker loop) and the whole-block packing helpers (`packWholeBlocks`/`packEventsUnderCap`) are
  now defined ONCE in `apps/cli/src/delivery-event-render.ts` and used by both transports — before this
  they were character-identical copies (`boundDiff` in `delivery-event-render.ts`, `truncateForCap` in
  `hook-deliver-render.ts`).
- **`DeliveryEventSummary.diffText` is additive to the published `@agentmonitors/core` API** (a minor
  bump, not a patch — precedent: `DeliveryEventSummary.body` in #60 and the `schedulingDefaults`
  export).
- **Downstream effect on the hook-deliver transport.** Rendering `diffText` there too (the entry below)
  makes each `additionalContext` block grow by up to ~800 chars, so `packEventsUnderCap` now fits fewer
  events per delivery under the existing 4000-char cap than before this change — expected, not a
  regression: the deferred remainder still re-delivers at the next context event (§5.5, unchanged).

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

