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

## Probe Evidence So Far

- **Codex ownership diagnostic (partial; Refs #316).** `experiments/host-probe/codex-owner.mjs` is a
  read-only diagnostic for an explicitly supplied, existing App Server control socket and thread id.
  It initializes the connection, records the server's self-reported version
  (`initialize.userAgent`), verifies the id in paginated `thread/loaded/list`, reads
  `thread/read.id` and `thread/read.cwd` without turn history, and rechecks that the thread is still
  loaded. Missing ownership, a malformed response, a connection failure, bounded-response overflow,
  or a timeout produce refusal, as does any such failure observed before the final response's parse
  completes; a valid final response cannot override it. It never discovers endpoints, starts
  servers, loads/resumes/forks sessions, sends observations, or starts/steers/interrupts turns, and
  it closes after one bounded snapshot.
- What it establishes: momentary thread ownership and workspace metadata as reported by that
  supplied server. What it does not: delivery capability, lifecycle mapping, the CLI/desktop
  surface, or a supported control endpoint for an existing desktop chat. Its synthetic socket tests
  (`experiments/host-probe/codex-owner.test.ts`) prove only its refusal and read-only behavior; they
  are not a live binding-probe artifact, and no Codex matrix cell moves to current on their basis.

## Open Questions

- The concrete lifecycle-hook names, session-identity signals, and workspace-binding mechanisms for
  Codex and Cursor (CLI and desktop) are not pinned; each MUST be confirmed with a per-host probe
  diagnostic (the `experiments/channel-probe` pattern generalized) before that adapter is current.
- Whether any in-scope host actually needs the internal CLI/desktop branch is a per-host probe outcome;
  the contract only requires the branch to exist if mechanisms diverge.
