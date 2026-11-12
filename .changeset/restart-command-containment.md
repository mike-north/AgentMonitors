---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'@agentmonitors/source-command-poll': minor
---

Reconcile orphaned command-poll processes when the daemon starts on macOS and Linux. Persist command ownership before spawning, verify boot and process identity before cleanup, and retain diagnostics for reaped processes and conservative abstentions, including detached descendants that keep their ownership marks.

Identify unreadable ownership marks by PID without attributing those processes to a command, and preserve those discovery abstentions before later identity queries.
Do not reclassify an already confirmed terminal incarnation as new unreadable work; reused identifiers with different process identities remain subject to discovery.
