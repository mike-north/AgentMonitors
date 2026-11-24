---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Return unacknowledged claims to pending after a restart-safe claim TTL, defaulting to 30 minutes. Configure the shipped runtime with claim-ttl-ms in the workspace coordination file, or use RuntimeStore's claimTtlMs constructor option. Preserve first-surfaced history, recipient cursors and independent delivery reservations.

Keep lifecycle coordination independent of unapplied claim policy, and resolve offline history policy from its storage workspace without changing audit query scope.
