## 2026-06-10 — Plan D Tasks 2–3: hook-deliver renderer + `hook deliver` command

- Added `apps/cli/src/hook-deliver-render.ts` — a **pure, side-effect-free renderer** that maps a
  `DeliveryClaim` to the Claude Code hook wire shape
  `{ continue: true, hookSpecificOutput: { hookEventName, additionalContext } }`. Returns `null`
  when the claim is null or has no events. `additionalContext` is capped at 4000 characters; unlike
  the channel transport (§4.6), it is a plain JSON string that is **not** tag-delimited, so
  markdown/code punctuation (`<>`, `[]`, `;`) and newlines are preserved verbatim (a monitor body is
  trusted, user-authored markdown) — only raw C0/C1 control characters (except tab/newline) are
  stripped. The rendered context includes a lead line and one block per event: monitorId, urgency,
  title, and the monitor's `body`-instructions from `DeliveryEventSummary.body`.
- Added `hook deliver` subcommand to `apps/cli/src/commands/hook.ts`. Designed to run as a Claude
  Code lifecycle hook (`PreToolUse`, `Stop`, `PostCompact`). Reads `CLAUDE_CODE_SESSION_ID` +
  `CLAUDE_PROJECT_DIR` from env, resolves the daemon socket via `.local.md`, looks up the session,
  claims pending deliveries at the given `--lifecycle`, renders, and writes the wire JSON to stdout.
  **Always exits 0** — any internal error is swallowed (a hook that exits non-zero would interrupt
  the user's session). Prints nothing when there is nothing pending.
- [005 §12.2](./005-cli-reference.md) added (`hook deliver` command reference, flags, wire output,
  always-exit-0 contract).
- [006 §5](./006-agent-integration.md) added (hook-deliver transport spec: wire contract, behavior
  steps, lifecycle-to-delivery mapping, and hook registration examples).
- `.changeset/hook-deliver-command.md`: `@agentmonitors/cli` minor (new `hook deliver` command).

---

