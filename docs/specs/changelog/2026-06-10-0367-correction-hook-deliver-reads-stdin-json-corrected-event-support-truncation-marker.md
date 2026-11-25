## 2026-06-10 — Correction: `hook deliver` reads stdin JSON; corrected event support; truncation marker

Supersedes the input/event-support details of the Plan D entry below after verifying against the
current Claude Code hooks docs (<https://code.claude.com/docs/en/hooks.md>). Three corrections:

- **Input is stdin JSON, not env vars.** Claude Code delivers hook input as a JSON object on stdin
  (`session_id`, `cwd`, `hook_event_name`, …). There is **no `CLAUDE_CODE_SESSION_ID` environment
  variable** — the prior `hook deliver` relied on one and would silently no-op in real sessions. The
  command now reads stdin (robust against a TTY/empty/unparseable stream — it never hangs), derives
  `sessionId = payload.session_id` (no env fallback), `hookEventName = payload.hook_event_name`, and
  `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`.
- **`additionalContext` is honored only by context events.** Per the docs, only `UserPromptSubmit`,
  `SessionStart`, and `PostToolUse` honor `hookSpecificOutput.additionalContext`; `PreToolUse` (uses
  `permissionDecision`) and `Stop` (uses a top-level `decision`) do **not**. The old default
  `--hook-event-name PreToolUse` therefore targeted an event that ignores the context. The
  `--hook-event-name` flag is **removed**; the lifecycle is now **derived** from `hook_event_name`
  (`UserPromptSubmit`/`PostToolUse` → `turn-interruptible`, `SessionStart` → `post-compact`; any
  other event → emit nothing). `--lifecycle` remains as an optional override (mainly for tests). One
  command line — `agentmonitors hook deliver` — now works for every registered event.
- **Code-point-safe truncation with an explicit marker.** When the rendered context exceeds the
  4000-char cap it is truncated at a Unicode code-point boundary (never splitting a surrogate pair)
  and an explicit `[truncated — … run "agentmonitors events list --unread" …]` marker is appended
  (final string still ≤ cap). Truncation does **not** lose events: claiming marks rows claimed, not
  acknowledged (`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), so a
  truncated-away event stays **unread** and re-delivers via the next context event.

Docs updated: [006 §5.0/§5.1/§5.2/§5.3/§5.4/§5.5](../006-agent-integration.md),
[005 §12.2](../005-cli-reference.md). Tests: stdin-driven `hook deliver` integration tests, a
truncation-recoverability integration test (truncated-away events still in `events list --unread`),
and renderer truncation-marker + surrogate-pair unit tests.

---

