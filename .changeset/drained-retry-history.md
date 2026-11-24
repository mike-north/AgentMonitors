---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Record a tick whose retry drain completes retained work as `triggered` in monitor history. The tick's single history row now counts the drained events in `emitted`, so `agentmonitors monitor history` shows that a retried event was eventually emitted instead of `no-change`.
