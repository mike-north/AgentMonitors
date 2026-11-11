---
'@agentmonitors/cli': minor
---

Render safe retained retry records in monitor explain and doctor, including missing or invalid definitions. Reconstruct socket timestamps, normalize legacy errors, and preserve old-daemon compatibility without mutating retained work. Keep available nested-only retry details visible once in text explain while preserving top-level summary precedence and structured omission. Doctor never reports an invented empty outbox for duplicate-id monitors and its explain remediation carries the workspace and directory it was given.
