---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Record durable counts for accepted notify work discarded when an ephemeral monitor is cancelled or its session retires. Show terminal dispositions in doctor and monitor explain after restart.

Serialize notify admission with declaration and owner retirement so outstanding observations cannot recreate held work. Keep existing holds visible in diagnostics even beside an older disposition.
