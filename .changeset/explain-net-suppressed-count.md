---
'@agentmonitors/core': patch
---

`monitor explain` reports rows suppressed by the net collapse under their own `netSuppressed`
delivery count instead of folding them into `claimed`, so the counts match what a session was
actually shown.
