---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`daemon run`'s idle-reaping check (the block that stops the daemon after a workspace has had no
active sessions for the configured idle window) is now wrapped in the same log-and-continue error
boundary the observation tick already had. Previously a transient error there — for example
`runtime.listSessions()` hitting a brief schema-visibility gap right after a fresh database is
created — escaped the run loop uncaught and terminated the whole daemon process, silently ending
all monitoring for that workspace. It now logs `AgentMon reaping check failed: …` and continues to
the next tick, matching the existing `AgentMon runtime tick failed: …` behavior. Genuine stop
conditions (`daemon stop`, SIGINT/SIGTERM, and an actual idle-reap decision) are unaffected.
