## 2026-07-19 — `session start`'s post-compact recap now uses the reserve → render → write → commit ordering, matching `hook deliver` (005 §10.4, 006 §5.6) — Refs #442

`session start`'s SessionStart recap still committed the reservation (`claimDeliveryClient`) BEFORE
rendering or writing, then wrote via a bare, un-awaited `process.stdout.write` — the exact
claim-before-fallible-surface ordering the round-9 fix removed from `hook deliver`. An asynchronous
`EPIPE` (or any write failure) arriving after that call would durably claim the recap rows while
emitting nothing to the agent, reopening the at-most-once loss window §5.2 already documents for the
`hook deliver` transport. Fixed by routing `session start`'s recap through the SAME shared
`reserveRenderAndCommitHookDelivery` / `writeAndCommitHookDelivery` / `writeStreamChunk` flow
`hook.ts` uses — `post-compact` needs no per-event cap sizing, so the reservation is accepted
directly, but the write-before-commit ordering and the awaited-completion write are now identical
across both callers. `renderHookDelivery`'s own doc comment (`hook-deliver-render.ts`) now describes
both call sites. New failure-injection coverage in `commands/session-start-recap-ordering.test.ts`
drives a real, delayed `Writable` (mirroring `hook-deliver-commit-ordering.test.ts`) to prove a
write failure releases rather than commits.

Two related wording corrections on the same file set:

- `buildHookRecapMarker`'s doc comment (`hook-deliver-render.ts`) previously claimed
  {@link buildHookDeferredMarker}'s wording "makes no promise about the ordinary redelivery direction
  either way" — but that marker's own contract (used only for rows never reserved at all) explicitly
  promises the omitted remainder stays pending and redelivers. Corrected: recap candidates ARE part
  of THIS reservation and are therefore not guaranteed to remain pending — their post-commit ordinary
  redelivery state depends on which of the three commit outcomes lands — while the recap's own
  future-resurfacing promise does not depend on that outcome.
- `hook-deliver-commit-ordering.test.ts`'s top comment claimed a commit RPC rejection after a
  successful write makes "the safe direction ... a later DUPLICATE delivery" — overstating certainty.
  Corrected: the only remaining risk is a POSSIBLE later duplicate if the commit did not in fact
  apply, never a loss, since the output was already written.

