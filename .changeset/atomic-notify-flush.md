---
'@agentmonitors/core': patch
---

Preserve pending rollup batches when a not-due window flush cannot commit its events, retry outbox, and notify state atomically.

Read and decide each not-due rollup window under the same writer lock as admission, preserving concurrent source checkpoints and held work. Roll back non-emitting state failures and continue healthy sibling monitors.
