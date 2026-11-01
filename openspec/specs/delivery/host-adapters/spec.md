# delivery/host-adapters Specification

## Purpose

Defines the host-adapter boundary that keeps the runtime core host-agnostic: the `AgentRuntimeAdapter` contract every agent-host integration implements, and the built-in Claude Code adapter's lifecycle hook mapping, hook-state path derivation, and hook-state materialization. Host-specific names and paths live only here, never in the runtime core.

## Requirements

### Requirement: AgentRuntimeAdapter contract

Every agent-host integration SHALL be an `AgentRuntimeAdapter` with: `name` (unique adapter identifier); `hookEventMap: Record<AgentLifecycleEvent, string>` (each lifecycle event to the host's hook name); `defaultHookStatePath(input)` (default hook-state file path); `createSessionInput(input)` (builds the `OpenSessionInput` for opening a session); `materializeHookState(state)` (serializes `SessionHookState` to a JSON-serializable object for disk).

#### Scenario: Runtime resolves the session's adapter to write hook state

- **GIVEN** a session opened with adapter `claude-code`
- **WHEN** the runtime refreshes that session's hook state
- **THEN** it writes the output of the `claude-code` adapter's `materializeHookState` to the session's `hook_state_path`

### Requirement: Host-specific behavior stays in adapters

Host-specific hook names, hook-state paths, and session-input construction SHALL be defined only by an `AgentRuntimeAdapter`, never in the runtime core (per AP3). Supporting a new host SHALL mean adding a new adapter.

#### Scenario: Runtime core has no Claude Code hook names

- **WHEN** the runtime core claims a delivery at `turn-interruptible`
- **THEN** it operates on the `DeliveryLifecycle` value only, and the mapping to `PreToolUse` comes from the adapter

### Requirement: Claude Code adapter is the built-in default

The only built-in adapter SHALL be `claudeCodeAdapter`, named `claude-code`. It SHALL be registered by default in `AgentMonitorRuntime` and SHALL be the adapter used by all CLI commands.

#### Scenario: CLI sessions use the Claude Code adapter

- **WHEN** `agentmonitors session open` registers a session
- **THEN** the session's `adapter` is `claude-code`

### Requirement: Claude Code lifecycle hook mapping

`claudeCodeAdapter.hookEventMap` SHALL map: `session-opened` → `SessionStart`; `session-dormant` → `SessionEnd`; `turn-interruptible` → `PreToolUse`; `turn-ended` → `Stop`; `turn-idle` → `TeammateIdle`; `pre-compact` → `PreCompact`; `post-compact` → `PostCompact`.

#### Scenario: Delivery lifecycles map to Claude Code hooks

- **WHEN** the Claude Code adapter's map is read for the three delivery lifecycles
- **THEN** `turn-interruptible` is `PreToolUse`, `turn-idle` is `TeammateIdle`, and `post-compact` is `PostCompact`

### Requirement: Claude Code delivery hooks trigger delivery claims

The Claude Code hooks mapped to delivery lifecycles (`PreToolUse`, `TeammateIdle`, `PostCompact`) SHALL be the points at which the CLI requests a delivery claim for the corresponding `DeliveryLifecycle` via `hook.claim` (per the `daemon/ipc` capability).

#### Scenario: PostCompact hook claims a recap

- **WHEN** Claude Code fires `PostCompact` for a registered session
- **THEN** the CLI claims at lifecycle `post-compact`

### Requirement: Claude Code default hook-state path

The Claude Code adapter's default hook-state path SHALL be `<workspace-or-cwd>/.agentmonitors/sessions/<encoded-host-session-id>/hook-state.json`, where `<workspace-or-cwd>` is the input `workspacePath` when provided, otherwise the process working directory.

#### Scenario: Workspace-rooted hook-state path

- **WHEN** the default path is derived for workspace `/repo` and host session id `abc-123`
- **THEN** it is `/repo/.agentmonitors/sessions/abc-123/hook-state.json`

### Requirement: Claude Code host session id path encoding

The `<encoded-host-session-id>` segment SHALL replace each character outside `[A-Za-z0-9_-]` with `~` followed by its hex code point zero-padded to at least 2 digits. The results `.` and `..` SHALL be additionally escaped to prevent path traversal, and an empty result SHALL become `_empty`.

#### Scenario: Unsafe characters are escaped

- **WHEN** host session id `a/b.c` is encoded
- **THEN** the segment is `a~2fb~2ec`

#### Scenario: Empty host session id

- **WHEN** host session id `""` is encoded
- **THEN** the segment is `_empty`

#### Scenario: Traversal segments cannot escape the sessions directory

- **WHEN** host session id `..` is encoded
- **THEN** the segment is not `..` and the derived path stays under `.agentmonitors/sessions/`

### Requirement: Project-local runtime state directory is regenerable

`.agentmonitors/` SHALL hold only host-agnostic, regenerable runtime state (currently one `hook-state.json` per session) projected from the SQLite store, which remains the source of truth. It SHALL be created when a session opens, before any project opt-in, and SHALL be safe to delete; it is recreated on the next session open or tick (Refs #336).

#### Scenario: Deleted state directory is recreated

- **GIVEN** a registered session and a deleted `.agentmonitors/` directory
- **WHEN** the next tick or session open refreshes hook state
- **THEN** the session's `hook-state.json` is rewritten from the store

#### Scenario: init ignores the runtime state directory

- **WHEN** `agentmonitors init` (bare or `--enable-only`) runs
- **THEN** `.gitignore` ignores both `.agentmonitors/` and `.claude/*.local.*`

### Requirement: Claude Code hook-state materialization

The Claude Code adapter's `materializeHookState` SHALL pass every `SessionHookState` field through unchanged, so the on-disk JSON contains `sessionId`, `updatedAt`, `unread` (`low`, `normal`, `high`, `total`), `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, and `latestHighTitles`.

#### Scenario: On-disk hook state mirrors SessionHookState

- **GIVEN** a `SessionHookState` with `unread.total` 3 and `hasPendingHigh` `true`
- **WHEN** it is materialized by the Claude Code adapter
- **THEN** the written JSON has `unread.total` 3 and `hasPendingHigh` `true` with no fields added or removed
