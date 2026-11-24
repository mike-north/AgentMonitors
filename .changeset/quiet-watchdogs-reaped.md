---
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Reap known adopted watchdog zombies when bounded command observations run as Linux PID 1 or a child subreaper, preserving libuv child exit statuses.
