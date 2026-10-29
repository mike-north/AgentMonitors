## ADDED Requirements

### Requirement: Channel falls back to workspace binding

When no host session id is available, `channel serve` SHALL resolve the workspace `W` from
`CLAUDE_PROJECT_DIR` (or the MCP `roots/list` root) and surface the lead session(s) projected for `W`
(per `delivery/session-projection`). Session binding by `CLAUDE_CODE_SESSION_ID` SHALL remain preferred
whenever that id is present.

#### Scenario: Host stops setting the session id

- **WHEN** `channel serve` starts without `CLAUDE_CODE_SESSION_ID` and with `CLAUDE_PROJECT_DIR=/repo`
- **THEN** it binds to workspace `/repo` instead of idling

#### Scenario: Session id present

- **WHEN** both `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` are set
- **THEN** the channel binds by session id

### Requirement: Single-lead workspace binding is exact

When `W` has exactly one active lead session, workspace binding SHALL behave identically to session
binding for that lead: it reserves, pushes, and commits that lead's deliveries, with exact unread/claimed
accounting.

#### Scenario: One lead in the workspace

- **WHEN** the channel is workspace-bound to `W` and `W` has one active lead L with a settled `high` event
- **THEN** the event is pushed and committed as claimed for L

### Requirement: Multi-lead workspace binding never claims

When `W` has multiple concurrent active lead sessions, a workspace-bound channel MUST degrade rather than
guess: it SHALL surface the workspace's unread but MUST NOT reserve or claim on behalf of any lead; the
per-session hook transport remains the accurate surface.

#### Scenario: Two leads in the workspace

- **WHEN** the channel is workspace-bound to `W` and `W` has active leads L1 and L2 with pending events
- **THEN** the channel claims nothing for L1 or L2
- **AND** each lead's events remain pending for its own hook transport

## REMOVED Requirements

### Requirement: Channel without a host session id does not poll

**Reason**: Replaced by the workspace-binding fallback; a channel without a host session id now binds by
workspace instead of idling.
**Migration**: No user action. Hosts that set `CLAUDE_CODE_SESSION_ID` are unaffected; hosts that do not
gain workspace-bound delivery.
