---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Allow fresh normal and low reminder batches while older events remain claimed and unacknowledged.
Preserve same-band in-flight reservation holds and high-urgency settle coalescing, and update
suppression diagnostics to distinguish no new work from a temporary reservation.

Use the explicit `no-new-work` diagnostic for healthy claimed-only backlogs. Retain conservative
health warnings for legacy daemon reasons whose policy can still block future batches.
