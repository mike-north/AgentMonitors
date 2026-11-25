## 2026-06-11 — `session start`/`session end` read the host session id from stdin; steel-thread UAT

**Correction (production bug).** `session start` and `session end` previously read the host session
id from `process.env['CLAUDE_CODE_SESSION_ID']` and quick-exited when it was absent. That env var
**does not exist** in a real Claude Code hook invocation (input arrives as JSON on stdin — the same
issue [`hook deliver`](./006-agent-integration.md) was already corrected for). The effect was severe:
in a real session `session start` returned before booting the daemon, so the session never
registered, and the entire activation chain (lazy daemon boot + delivery) silently no-opped in
production. Plan B's tests passed only because they set the env var manually.

Both commands now read the **stdin hook payload** (006 §5.0): `hostSessionId = payload.session_id`
(no env fallback), `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? process.cwd()`. The shared
stdin reader (`readHookPayload` + `HookPayload`) is extracted to `apps/cli/src/hook-payload.ts` and
imported by `hook deliver`, `session start`, and `session end`. Documented in
[006 §5.0/§5.6](./006-agent-integration.md) and [005 §10.4/§10.5](./005-cli-reference.md).

- **Single-process `SessionStart` (one stdin stream).** A Claude Code hook invocation provides **one**
  stdin stream, and both `session start` and `hook deliver` consume all of stdin via
  `readHookPayload()`. So a chained `agentmonitors session start && agentmonitors hook deliver`
  (the previous SessionStart hook form) is broken: `session start` consumes the payload and the
  chained `hook deliver` sees EOF, parses `{}`, and silently no-ops — killing the post-compact recap.
  Fixed by folding the recap into `session start`: it reads the payload **once**, registers, then
  claims `post-compact` and prints the rendered `additionalContext` itself. The SessionStart hook
  (`agent-plugins/agentmonitors/hooks/hooks.json`) now runs the single command
  `agentmonitors session start`. Documented in [006 §5.6](./006-agent-integration.md).
- **Steel-thread UAT added** (Plan D Task 4): an end-to-end CLI integration test that drives the
  `UserPromptSubmit` delivery path over **stdin** — a dropped file-fingerprint monitor + a
  watched-file change ends with the agent handed that monitor's own body-instruction as
  `additionalContext` at the turn boundary. A companion test drives the **actual shipped SessionStart
  command form** (one subprocess, one stdin payload) and asserts the post-compact recap is surfaced by
  that single command — the regression guard for the single-stdin-stream bug above. The Plan B
  lifecycle tests were migrated from `CLAUDE_CODE_SESSION_ID` to stdin payloads so they fail against
  the old env-reading code, locking the stdin contract so the env-var regression cannot return.
- **Follow-up — now resolved (see the channel-binding entry above):** the question of whether
  `channel serve` (`apps/cli/src/commands/channel.ts`) shares the same "no session-id env var" trap was
  verified separately and answered **no** — an MCP-server subprocess _does_ receive
  `CLAUDE_CODE_SESSION_ID` (re-confirmed against 2.1.160), so the channel server's
  `process.env['CLAUDE_CODE_SESSION_ID']` resolution is correct and needs no change. The hooks/stdin
  trap does not transfer (hook = short-lived per-event command with the id on stdin; channel = long-lived
  MCP subprocess that inherits the process environment).
- `@agentmonitors/cli` patch changeset included.

