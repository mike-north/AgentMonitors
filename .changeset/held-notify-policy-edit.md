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

Reporting an older poll's ingestion failure no longer releases a successor's active admission,
preventing overlapping source observations and baseline regression during failure cleanup.

Tick and watcher startup reread each authored definition immediately before policy reconciliation,
so delayed discovery cannot restore obsolete pacing or drain newer holds. Deferred-result handoff
releases its retained snapshot lease even when argument access fails before ingestion, preserving
other live owners and reporting the already committed edit accurately.

Unknown-source admission checks current scoped holds, including a watcher's first hold created while
another monitor awaits, and blocks invalid-definition checkpoints/yields without skipping healthy
siblings. A live same-ID/workspace definition moved between flat and folder forms remains usable
when an older discovery or captured envelope still names its obsolete path. Current replacement
files and source semantics are reread; invalid definitions and duplicate IDs remain rejected.

A valid earlier location can replace an admitted path only when metadata proves that location
absent (ENOENT/ENOTDIR). Permission and I/O failures retain the blocked gate, original holds and
read diagnostic instead of being mistaken for deletion by a boolean existence check.

Closing admission now retains the current admitted or blocked location within its existing live
owner. Repeated unchanged discovery cannot reopen fallback while that location is still invalid
or unreadable. The one pathname retires with the last live lease; new owners read fresh definitions
and no historical paths or extra instruction snapshots are retained.
