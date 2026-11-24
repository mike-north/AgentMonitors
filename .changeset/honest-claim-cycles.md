---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Return unacknowledged claims to pending after a restart-safe claim TTL, defaulting to 30 minutes. Configure the duration with RuntimeStore's claimTtlMs constructor option. Preserve first-surfaced history, recipient cursors and independent delivery reservations.
