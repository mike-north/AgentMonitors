---
'@agentmonitors/source-incoming-changes': patch
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Report unavailable incoming-changes repositories and refs as recoverable source errors instead of successful empty baselines. Verify commit-ish refs, capture Git stderr, and retain the last-good source state for recovery. Source consumers must now handle observation rejection for unavailable inputs through the existing error contract.

Require initial state before monitor test claims a baseline. Include source errors in history text and explain using bounded single-line display, without rewriting stored audit data. Existing source-error retry cadence and held-notification deferral remain unchanged.
