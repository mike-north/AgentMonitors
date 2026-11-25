## 2026-07-19 — `verify`'s materialize/deliver stages carry a fresh deadline past a late observe resolution instead of inheriting an already-expired one (005 §16 step 6, Budget) — Refs #442

The round-19 fix (below) extends the observe stage's own deadline past the single-interval `detect`
deadline so a genuine `no-change` verdict has time to gather its second confirming row. But
materialize and deliver (steps 7–8) still polled against the original, un-extended `detect` deadline
— sized on the assumption observe resolves within one interval, leaving only the settle +
high-claim-settle + margin remainder for them. A **real** `triggered` row landing in the observe
stage's extension window (after `detect` but before `noChangeConfirmMs`) therefore left materialize
and deliver an already-expired deadline and zero remaining time, failing `budget-exceeded` even though
the event was durable. Reproduced deterministically with a 20s-interval command-poll monitor and a
backgrounded (detached) trigger command whose real file write lands ~30s after firing: the first
post-trigger tick (~20s) genuinely observes no change yet (one `no-change` row — never reaching
round 19's two-distinct-row bar), the second tick (~40s) observes the already-written file as
`triggered`, landing inside the `[detectMs=25s, noChangeConfirmMs=45s]` extension window — but
materialize's un-carried 25s `detectDeadline` had already passed, so materialize immediately failed
`budget-exceeded`. (A short interval can't reproduce this: with the 5s margin floor dominating, the
observe stage's own two-distinct-row `no-change` discriminator fail-fasts well before a slow
trigger's real change ever lands, so a wide-enough interval — where the 25%-of-interval margin
dominates the floor — is needed for the real `triggered` row to survive past the single stale
`no-change` row.)

Fixed: `verify` now re-grants materialize and deliver a fresh deadline of `max(detect deadline,
observe's actual resolution time + postObserveBudgetMs)` — the same settle + high-claim-settle +
margin remainder, just measured from when observe actually finished rather than from the original
trigger time — applied only for the default derived budget (an explicit `--timeout-ms` keeps its own
value as the hard total cap throughout, matching the observe-stage override semantics). `VerifyBudget`
gained `postObserveBudgetMs` (`detectMs - intervalMs`), and `totalMs` — the worst-case default maximum
— is corrected to `baselineMs + max(detectMs, noChangeConfirmMs) + postObserveBudgetMs` (previously
`baselineMs + detectMs`, which undercounted exactly this extension). 005 §16 step 6 and its Budget
section now document the re-grant and the corrected `totalMs` formula.

