## Context

`channel serve` binds by the inherited `CLAUDE_CODE_SESSION_ID` (006 §4.4 item 1). That inheritance is
empirically confirmed (Claude Code 2.1.157 via `experiments/channel-probe`; re-confirmed 2.1.160, where
the value equals the live session id and the `hostSessionId` the `SessionStart` hook registers from its
stdin `session_id`) but is not in the documented MCP environment contract. The documented signals are
`CLAUDE_PROJECT_DIR` (also the server's cwd) and `roots/list`, which returns the workspace as a single
`file://` root.

## Decisions

- **Session binding stays preferred.** It gives exact accounting and never hits multi-lead ambiguity.
- **Workspace binding is a fallback, not a peer.** It is used only when the session id is absent.
- **Ambiguity degrades, never guesses.** With multiple leads the channel does not claim; the runtime can
  detect the multi-lead condition because it tracks every session.

Rejected alternative: pick the most recently active lead when `W` has several. Rejected because a wrong
guess claims (and thus mutes, per the band-scoped coalescing guard) another session's work — a
session-isolation break.

## Open Questions

- **Synthetic session vs. hook precondition (006 §10).** Should the channel server open a synthetic
  workspace-lead session when channels are used **without** the hook-driven `session open` flow, or
  require the hook flow as a precondition? 006 §4.4 states the channel "MUST confirm" its id
  corresponds to a tracked session ("the runtime opens the session; the channel transport only
  attaches to it"), but the current implementation binds through the idempotent `session.open`, which
  resumes the hook-opened session and otherwise opens a new one. This change does not decide the
  question; decide it before implementing the fallback, since a workspace-bound channel has no host
  session id to open a session under.
- **Re-verify binding signals per host version.** Re-run the `experiments/channel-probe` diagnostic when
  targeting a new Claude Code version; the env-var side of binding is observed-not-contracted.
- **Surface-only rendering.** How the multi-lead "surface unread without claiming" push is rendered (a
  reminder-style summary with no `event_id` meta is the natural fit) is left to implementation.
