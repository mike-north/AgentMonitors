---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Upgrade better-sqlite3 to 13.x, fixing a native crash (env != nullptr abort in Statement teardown) that could kill the daemon on Node 24.
