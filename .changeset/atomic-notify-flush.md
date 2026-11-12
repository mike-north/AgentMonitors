---
'@agentmonitors/core': patch
---

Preserve pending rollup batches when a not-due window flush cannot commit its events, retry outbox, and notify state atomically.

Read and decide each not-due rollup window under the same writer lock as admission, preserving concurrent source checkpoints and held work. Roll back non-emitting state failures and continue healthy sibling monitors.

A notify-policy edit that drains held rollup work uses the same owned transaction: if the drain fails, every write and the recipient cache roll back together and the batch stays held.
