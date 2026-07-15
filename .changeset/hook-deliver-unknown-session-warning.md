---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`hook deliver` now writes a one-line stderr diagnostic, unconditionally (not gated behind
`--debug`), when the hook payload's `session_id` matches no tracked AgentMon session:

```
hook deliver: no session registered for host session id "<id>"
```

Previously an unresolvable `session_id` produced byte-empty stdout + exit 0 — identical to the
_expected_ empty output during the ~15s high-urgency claim-settle window — leaving an operator no
way to tell "will never resolve" from "still settling" without reaching for `--debug` (issue #329).
Stdout and the exit code are unchanged in every case; every other quiet-return branch (disabled
workspace, unreachable daemon, settle-window hold, nothing pending, …) remains silent by default,
diagnosable via `hook deliver --debug`.
