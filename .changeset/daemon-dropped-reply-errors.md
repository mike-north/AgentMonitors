---
'@agentmonitors/cli': patch
---

A daemon that closes its connection before replying is now reported as an error instead of being treated as success. Previously a command left waiting on such a connection exited 0 with no output. Now `monitor history`, `session list`, `events list` and `daemon stop` exit 1 with an error, `doctor` exits 1 and reports the daemon as unreachable (`daemon-unreachable`), and `monitor explain` falls back to reading the workspace's store in-process, as it does when no daemon is reachable.
