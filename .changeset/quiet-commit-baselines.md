---
'@agentmonitors/source-incoming-changes': patch
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Report unavailable incoming-changes repositories and refs as recoverable source errors instead of successful empty baselines. Resolve authored revision expressions unchanged, then verify the resolved object ID peels to a commit; reject blob paths without changing valid commit-search semantics in SHA-1 or SHA-256 repositories. Capture Git stderr and retain the last-good source state for recovery. Source consumers must now handle observation rejection for unavailable inputs through the existing error contract.

Require initial state before monitor test claims a baseline. Include source errors in history text and explain using bounded single-line display, without rewriting stored audit data. Existing source-error retry cadence and held-notification deferral remain unchanged.
