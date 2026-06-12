---
'@agentmonitors/source-command-poll': minor
---

Add new bundled observation source plugin `@agentmonitors/source-command-poll`. Runs a configured argv command on the tick loop (spawned directly, never through a shell) and reports change using `text-diff` (default), `json-diff`, or `exit-code` strategies — the local-process sibling of `api-poll`. Captures up to 1 MiB of stdout (marking `truncated` on overflow and diffing stably on the capped slice), enforces a wall-clock `timeout` with SIGTERM→SIGKILL escalation and no orphaned processes, and is stateful (the first successful run records a baseline and emits nothing). Execution failures (spawn failure, timeout) surface as transition-edge `ok ↔ failing` health observations rather than per-tick spam — a nonzero exit code with output is treated as a result, not a failure. `env` is merged over the inherited daemon environment and is never persisted in any observation or state row.
