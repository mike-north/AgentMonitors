---
'@agentmonitors/cli': patch
'@agentmonitors/core': minor
---

Report held debounce and rollup observations in monitor explain and doctor even
when the current definition is rejected. Include counts, stored pacing and repair
guidance, and keep downstream stages pending while earlier work awaits release.

Distinguish definition rejection, source availability, owner inactivity and
retired declarations with an additive release-barrier field derived from tick's
read-only predicates. Describe retained retry and captured-data prerequisites
without promising that an overdue batch must flush on the next tick.
