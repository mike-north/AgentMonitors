---
'@agentmonitors/cli': patch
---

`daemon once` now distinguishes skipped-not-due monitors from no monitors found

When monitors exist but are skipped because their interval has not elapsed, `daemon once` appends a parenthetical to the summary line: `(N skipped: interval not elapsed — next due in Xs)`, reporting the soonest next-due time across all skipped monitors. Previously, a second `daemon once` run within a monitor's interval printed `Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, making it impossible to distinguish the two cases.
