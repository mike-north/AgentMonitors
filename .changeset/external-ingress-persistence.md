---
'@agentmonitors/core': minor
---

Add `RuntimeStore.withExternalEventReceipt()`, which decides one external event (duplicate,
conflict, stale, or accepted) and commits its receipt, the object's sequence high-water mark, and
the caller's synchronous durable work together, or rolls all of it back. The high-water mark never
moves backwards, including when the callback accepts further events. New public types:
`ExternalEventReceiptInput`, `ExternalEventReceiptOperation`, `ExternalEventReceiptContext`,
`ExternalEventReceiptCompletion`, `ExternalEventReceiptDecision`, `ExternalEventReceiptRecord`, and
`ExternalEventReceiptOutcome`. Nothing in the runtime, daemon, or CLI calls the operation yet.
