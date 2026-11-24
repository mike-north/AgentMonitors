---
'@agentmonitors/core': minor
---

Add `RuntimeStore.externalEventReceiptStatus()`, which reads a receipt within one exact workspace,
and `RuntimeStore.externalObjectSequence()`, which reads an object's highest accepted sequence by
exact workspace, monitor, source, and object, with the new public type
`ExternalObjectSequenceRecord`. Both refuse a corrupt stored row instead of returning it. Storing a
nonempty held debounce or rollup batch, or admitting materialization retries, now marks the
database forward-only for that route in the same transaction. `createDb()` refuses to open a
database marked with a capability this version does not know, leaving it unchanged.
