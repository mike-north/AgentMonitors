## 2026-07-20 — The header-packing fixed-point search no longer oscillates into an under-scoped ack, and the coalesced-until-ack guard's mixed-recap case is documented correctly (006 §5.1.1) — Refs #438, #434, PR #445 review round 6

Two more follow-on defects found on round 6 of reviewing the same change.

**1. `resolveHookHeaderPacking`'s fixed-point-guess search could oscillate, under-scoping `--event-ids`
(BLOCKER).** The prior iterative-narrowing search re-guessed the next candidate id count from the
PREVIOUS candidate's packed-block count; at a specific boundary (two ~26-character event ids with
~1,774-character bodies, reserved against the deferred marker) this bounced between guesses (`guess=2`
packs 1 block; the resulting shorter 1-id header then packs 2 blocks; `guess` returns to 2, repeating)
without ever landing on a self-consistent `k`, so the loop exhausted and fell back to the narrowest
(0-id) header while BOTH blocks still rendered — an ack instruction naming zero ids for two rendered
events, which a compliant agent could only satisfy with the no-id "ack everything" form, silently
dropping unrelated deferred/recap rows into that same blanket ack. Resolved by testing each candidate
`k` directly (descending from `events.length` to `0`, packing only `blocks.slice(0, k)` against the
header built for `events.slice(0, k)`) rather than iterating a guess derived from the previous
candidate's result — `k = 0` is always self-consistent (no ids, no blocks), so the search is guaranteed
to terminate at a header whose named ids exactly match what's rendered. Regression test:
`hook-deliver-render.test.ts` reproduces the exact oscillation boundary and asserts the rendered
`--event-ids` count always equals the rendered `### ` block count.

**2. §5.1.1's coalesced-until-ack correction overgeneralized the high-only case to mixed-band recaps.**
The prior correction (round 5, below) stated an unacknowledged `high`-urgency **or mixed-band recap**
claim does not block a new `normal`-urgency reminder. That's true for a `high`-only claim (it touches
no `normal`/`low` row), but wrong for a mixed-band recap: if a `post-compact` recap claims an old
`normal` (or `low`) event alongside `high` events, that row stays claimed-but-unacknowledged, so
`normalPending` no longer equals `unreadNormal` once a fresh, unrelated `normal` event later arrives —
the band-scoped equality guard suppresses that band's next `turn-interruptible` reminder too, until the
recap's `normal`/`low` events are acknowledged. A current-head `service.ts` probe reproduced
`normalPending=1`, `unreadNormal=2`, and a `null` claim. Corrected `006-agent-integration.md` to
distinguish the high-only case from the mixed-recap case, and updated the stale `hook-deliver-render.ts`
doc comment making the same overgeneralization; the public website (`agent-integration.md`) already
scoped this correctly to "a `high`-only claim." Added a regression test (`service.test.ts`, "mixed-band
recap suppression") reproducing the exact scenario above.

