## MODIFIED Requirements

### Requirement: command-poll executes without interactive acknowledgment

`command-poll` SHALL execute configured commands without an interactive acknowledgment step unless command-acknowledgment gating is enabled for the host: `MONITOR.md` is workspace-resident configuration in the same trust class as `package.json` scripts, git hooks, or `.claude` hooks, and the daemon already scopes evaluation to its workspace. Gating SHALL be disabled by default.

#### Scenario: New monitor runs on its first due tick

- **WHEN** a new `command-poll` monitor is added to the workspace and gating is not enabled
- **THEN** its command executes on the first due tick without any approval prompt

## ADDED Requirements

### Requirement: command-poll command fingerprint

The runtime SHALL compute a `commandFingerprint` for each `command-poll` monitor as `hash(argv ‖ cwd ‖ env-keys)`, using `env` keys only and never `env` values.

#### Scenario: Env value change keeps the fingerprint

- **WHEN** a monitor's `env: { TOKEN_HINT: a }` becomes `env: { TOKEN_HINT: b }`
- **THEN** its `commandFingerprint` is unchanged

#### Scenario: Argv change changes the fingerprint

- **WHEN** a monitor's `command` changes from `['git', 'status']` to `['git', 'log']`
- **THEN** its `commandFingerprint` changes

### Requirement: Unacknowledged commands are blocked when gating is enabled

When command-acknowledgment gating is enabled, a `command-poll` monitor whose `commandFingerprint` is not in the persisted acknowledgment ledger SHALL NOT execute and SHALL surface as `blocked: awaiting-acknowledgment` in `scan` and `status` output.

#### Scenario: New monitor under gating does not run

- **WHEN** gating is enabled and a new `command-poll` monitor is added
- **THEN** its command is never spawned and `scan` reports it as `blocked: awaiting-acknowledgment`

### Requirement: Explicit approval records the fingerprint

The CLI SHALL provide `agentmonitors monitor approve <id>`, which records the monitor's current `commandFingerprint` in the ledger so that it executes on subsequent due ticks.

#### Scenario: Approve unblocks the monitor

- **GIVEN** a blocked monitor `ofocus-today`
- **WHEN** the user runs `agentmonitors monitor approve ofocus-today`
- **THEN** the monitor executes on its next due tick

### Requirement: Fingerprint-changing edits re-block

Any edit that changes a gated monitor's `commandFingerprint` SHALL re-block it until it is approved again.

#### Scenario: Editing cwd re-blocks an approved monitor

- **GIVEN** an approved monitor
- **WHEN** its `cwd` is edited
- **THEN** it reports `blocked: awaiting-acknowledgment` and does not execute until re-approved
