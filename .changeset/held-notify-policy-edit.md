---
'@agentmonitors/core': patch
---

Changing a monitor's effective notify policy now flushes its already-held debounce or rollup work
before observing new work. This deliberate early flush can occur before the old deadline or rollup
window. Captured urgency, content and timestamps stay unchanged; the new policy applies to new work.
Edit drains atomically commit events and hold removal. Failed drains retain the old work and defer
that monitor's new observation until reconciliation succeeds.
