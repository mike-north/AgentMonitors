---
'@agentmonitors/core': patch
---

Commit event rows, lead-session projections, recipient cursor seeds, and snapshots atomically.
Preserve empty snapshots as valid diff baselines, including deletion deltas for late recipients.
