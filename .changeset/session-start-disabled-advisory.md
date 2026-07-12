---
'@agentmonitors/cli': patch
---

`session start` no longer quick-exits silently when a project has monitor definitions but is not enabled: it now emits a one-line `additionalContext` advisory through the `SessionStart` hook (monitoring disabled, how many monitors were found, and the exact enable step), while still exiting 0 without opening a session or booting a daemon. A project with no monitor definitions at all still quick-exits fully silently, unchanged.
