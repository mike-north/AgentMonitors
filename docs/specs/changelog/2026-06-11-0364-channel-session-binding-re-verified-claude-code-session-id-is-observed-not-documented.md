## 2026-06-11 — Channel session binding re-verified; `CLAUDE_CODE_SESSION_ID` is observed-not-documented (006 §4.4)

Prompted by the just-merged session-lifecycle stdin fix (hooks read `session_id` from stdin, **not**
an env var): does the same "no session-id env var" trap apply to the channel server, which runs as an
**MCP server** rather than a hook? Verified it does **not**.

- **Confirmed: an MCP-server subprocess receives `CLAUDE_CODE_SESSION_ID`.** Re-confirmed live against
  Claude Code 2.1.160 (the variable is present in MCP/child-process environments and its value exactly
  equals the live session id), corroborating the 2026-05-31 `experiments/channel-probe` run on 2.1.157.
  So `agentmonitors channel serve` resolving its session via `process.env['CLAUDE_CODE_SESSION_ID']`
  (`apps/cli/src/commands/channel.ts`) is correct — **no code change**. The hooks/stdin trap does not
  transfer: a hook is a short-lived per-event command (session id arrives on stdin), whereas the
  channel server is a long-lived MCP subprocess that inherits Claude Code's process environment.
- **Doc-precision correction.** The previous §4.4 cited <https://code.claude.com/docs/en/mcp.md> in a
  way that implied all three signals are documented. They are not: the current MCP reference documents
  only `CLAUDE_PROJECT_DIR` and `roots/list`; it is **silent** on `CLAUDE_CODE_SESSION_ID`. §4.4 now
  marks the two workspace signals **documented** and the session-id signal **empirically observed but
  undocumented** (host-version-dependent), with workspace binding (§4.4 #2) as the documented-safe
  fallback. Added an explicit hooks-vs-MCP contrast citing <https://code.claude.com/docs/en/hooks.md>
  (hook session id = stdin `session_id`; documented hook env vars do not include it).
- Updated the §10 open-question note to record the 2.1.160 re-confirmation and the observed-not-
  contracted caveat. Docs-only; no published-package behavior change, no changeset.

