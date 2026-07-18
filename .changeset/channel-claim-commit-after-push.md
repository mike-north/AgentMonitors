---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fix a delivery-loss defect in the Claude Code channel transport: it no longer marks a delivery
claimed before it has surfaced it. The channel now **reserves** the delivery, pushes it, and
**commits** the claim only after a successful push — releasing the reservation on a rejected or
disconnected push so the event stays unclaimed and re-delivers via the hook transport (or the next
poll). Previously a transient MCP disconnect permanently consumed the delivery, because the rows were
left claimed and the hook path suppressed them as cross-transport duplicates.

- New core `reserveDelivery` / `commitDelivery` / `releaseDelivery` (with an in-memory reservation
  registry) and matching `hook.reserve` / `hook.commit` / `hook.release` daemon IPC. Reserving leases
  the rows so a concurrent hook claim can't double-surface them; committing marks them claimed ("was
  surfaced") — never acknowledged. `claimDelivery` is refactored into a shared decide + apply, leaving
  the hook transport's behavior unchanged.
- No change to notify/debounce timing, urgency bands, or the unread/claimed/acknowledged model.

See docs/specs/006-agent-integration.md §4.5.1.
