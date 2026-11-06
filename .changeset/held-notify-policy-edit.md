---
'@agentmonitors/core': patch
---

Changing a monitor's effective notify policy now flushes its already-held debounce or rollup work
before observing new work. This deliberate early flush can occur before the old deadline or rollup
window. Captured urgency, content and timestamps stay unchanged; the new policy applies to new work.
Edit drains atomically commit events and hold removal. Failed drains retain the old work and defer
that monitor's new observation until reconciliation succeeds.

Escalation grants participate in effective policy edits even for immediate/throttle observations.
Queued watcher checkpoints and yields recheck admission at their durable writes; failed drains
keep them backpressured. Startup drains refresh session hook state even when the source stays idle.

Concurrent polling rechecks admission after observation and retains blocked results locally so a
later tick can recover without advancing the old cursor. Watcher creation uses the latest admitted
initial definition, and policy snapshots retire with their live admission instead of accumulating
retired monitor instructions.

Watcher completion/error closes checkpoint admission while retaining its scoped ownership until
accepted queued writes settle, so recovery polling or replacement watchers read those writes before
advancing their own baseline. Late, aborted and superseded callbacks cannot rewind a newer cursor.
