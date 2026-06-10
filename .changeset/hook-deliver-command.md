---
'@agentmonitors/cli': minor
---

Add `hook deliver` command: advisory turn-boundary delivery of monitor instructions. The command is designed to run as a Claude Code hook (`PreToolUse`, `Stop`, etc.) and claims pending events for the session, rendering them as `additionalContext` injected non-blockingly into the agent at the turn boundary. Always exits 0; prints nothing when there is nothing pending or when outside a Claude session.
