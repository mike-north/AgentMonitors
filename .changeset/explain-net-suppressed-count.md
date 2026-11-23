---
'@agentmonitors/core': patch
---

`monitor explain` reports rows suppressed by the net collapse under their own `netSuppressed`
delivery count instead of folding them into `claimed` or `acknowledged`, so the counts match what
a session was actually shown. The net collapse no longer marks rows an earlier claim already
surfaced as suppressed when a later recap folds them into a newer endpoint; those rows stay
unread until acknowledged.
