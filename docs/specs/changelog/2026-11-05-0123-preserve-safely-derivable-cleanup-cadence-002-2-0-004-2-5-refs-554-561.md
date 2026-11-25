## 2026-11-05 — Preserve safely derivable cleanup cadence (002 §2.0, 004 §2.5) — Refs #554, #561

Correct the whole-source-scope guard introduced by the early reaper fix: rejecting
unrelated source config must not shorten valid runtime cadence protection. Derive
only poll timing, catching duration parse failure narrowly, and preserve authored
intervals and known defaults with existing settle/margin sizing. Missing definition
or unparseable cadence retains the five-minute fallback. Real-source/SQLite tests
reproduce the parent-head 665000ms-to-5m shortening and actual later-claim leak,
then verify repair within the restored window, legitimate work and workspace
isolation. The known finite-lifetime/held-only ownership gap is assigned to #562 by
Mike's accepted #561 decision, which permits #557 after the introduced regression and
truthful documentation are corrected. Separate M1 repair #562 follows #305/#537/#554:
durable exact ownership without TTL and explicit retirement, with source contracts
unchanged. Annotate current cleanup claims in 002/004/005 with the precise delayed
recovery and held-only discovery gap; preserve the intended goal and historical records.
#557 does not wait for that general repair.

