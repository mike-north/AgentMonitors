---
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
---

Report held debounce and rollup observations in monitor explain and doctor even
when the current definition is rejected. Include counts, stored pacing and repair
guidance, and keep downstream stages pending while earlier work awaits release.
