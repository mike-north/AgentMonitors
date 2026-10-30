---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Allow fresh normal and low reminder batches while older events remain claimed and unacknowledged.
Preserve same-band in-flight reservation holds and high-urgency settle coalescing, and update
suppression diagnostics to distinguish no new work from a temporary reservation.

Do not report an already-claimed-only backlog as a transport failure; fresh work remains eligible.
