---
'@agentmonitors/cli': patch
---

`agentmonitors doctor` is now cross-referenced from the places users actually hit trouble: both
`init` closing summaries (bootstrap and `init <name>`) name it as the health-check next step, the
shared "no daemon running for this workspace" error (`session open/close/list`, `events list/ack`,
`hook claim`) points at it alongside the `daemon run` fix-it command, and the `SessionStart`
monitors-found-but-disabled advisory names it too. `doctor`'s own `daemon-reachable` and
`lead-session` fail lines now note that failing is expected when no agent session is currently
open, instead of reading as a broken setup.
