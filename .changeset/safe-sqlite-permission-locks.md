---
'@agentmonitors/core': patch
---

Preserve SQLite locks by tightening existing database permissions before opening connections. This prevents stale reads and locking protocol errors across processes while keeping newly created files owner-only.
