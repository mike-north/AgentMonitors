---
'@mike-north/core': patch
---

Preserve a monitor's persisted source state when a source omits `nextState` (e.g. a transient resolution failure) instead of overwriting it with an empty value — prevents event loss on transient source failures.
