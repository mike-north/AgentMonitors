## Context

The Claude Code adapter is current (`libs/core/src/adapter/claude.ts`); Codex and Cursor are target
(Epic #259; roadmap G19, G20). 006 §11.3 lays out a matrix of seven contract dimensions × three hosts.
The Claude Code column is current today:

| Dimension                            | Claude Code (current)                                                                   | Codex (target)                                                                   | Cursor (target)                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Lifecycle mapping                    | SessionStart / SessionEnd / PreToolUse / Stop / TeammateIdle / PreCompact / PostCompact | probe; omit unsupported                                                          | probe; omit unsupported                                           |
| Delivery points + advisory injection | `UserPromptSubmit` / `PostToolUse` / `SessionStart` honor `additionalContext`           | probe                                                                            | probe                                                             |
| Session identity                     | stdin `session_id` (hooks); `CLAUDE_CODE_SESSION_ID` (MCP)                              | probe                                                                            | probe (unverified — e.g. a `CURSOR_`-prefixed env var)            |
| Workspace binding                    | stdin `cwd` → `CLAUDE_PROJECT_DIR` → cwd; `roots/list`                                  | probe: env / cwd / roots analogue                                                | probe: env / cwd / workspace-folder analogue                      |
| Delivery-surface state               | `hook-state.json` path                                                                  | inherit path shape unless required otherwise                                     | inherit path shape unless required otherwise                      |
| Portable baseline transport          | hook-deliver / hook-state                                                               | probe: hook/notify-command analogue, else best always-available advisory surface | probe: hook analogue, else best always-available advisory surface |
| Richer additive transport            | Claude channel MCP push                                                                 | probe: MCP/push analogue if any; additive only                                   | probe: MCP/push analogue if any; additive only                    |

Cells marked "probe" are not pinned; illustrative details are unverified.

## Decisions

- **One adapter per host, internal `surface` branch only when mechanisms diverge.** Rejected
  alternative: separate CLI and desktop adapters per host — rejected because two adapters would
  duplicate the host's delivery semantics and drift.
- **Contract dimensions are explicit even where implied by existing adapter members**, so each matrix
  cell is unambiguous.
- **Local hosts only.** Cloud-hosted agents stay deferred (NP5; closed #126).

## Open Questions

- The concrete lifecycle-hook names, session-identity signals, and workspace-binding mechanisms for
  Codex and Cursor (CLI and desktop) are not pinned; each MUST be confirmed with a per-host probe
  diagnostic (the `experiments/channel-probe` pattern generalized) before that adapter is current.
- Whether any in-scope host actually needs the internal CLI/desktop branch is a per-host probe outcome;
  the contract only requires the branch to exist if mechanisms diverge.
