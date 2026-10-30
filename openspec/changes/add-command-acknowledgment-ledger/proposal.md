## Why

`command-poll` runs an arbitrary local argv on every due tick with no acknowledgment step. That is the
deliberate v1 decision: a `MONITOR.md` is workspace-resident configuration in the same trust class as
`package.json` scripts, git hooks, or `.claude` hooks, so a prompt would be security theater for the
single-trusted-workspace case. If multi-tenant or untrusted-workspace hosting ever matters, hosts need an
explicit gate. The gate is designed (not scheduled) so the v1 behavior is visibly a decision, not an
omission.

Source: 003 §11.6 ("Target (designed, deferred)"). Not a roadmap item and no tracking issue yet
(originated as #81's third open question). Relies on PP7 and AP6 (the CLI exposes the approve act the
core defines); does not resolve an existing contradiction between specs, code, or docs.

## What Changes

- Add an opt-in **command-acknowledgment ledger**: the runtime computes
  `commandFingerprint = hash(argv ‖ cwd ‖ env-keys)` for each `command-poll` monitor.
- When gating is enabled for a host, a monitor whose fingerprint is not in the persisted ledger does
  not execute and surfaces as `blocked: awaiting-acknowledgment` in `scan`/`status` output.
- New explicit CLI act `agentmonitors monitor approve <id>` records the fingerprint.
- Any edit that changes the fingerprint re-blocks the monitor.
- An empty ledger / gating-disabled default preserves v1 behavior (execute without acknowledgment).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sources/command-poll`: the "executes without interactive acknowledgment" rule becomes the default of
  an opt-in acknowledgment gate; adds the fingerprint, blocked state, approve act, and re-block rules.

## Impact

- `plugins/source-command-poll` / `libs/core/src/runtime/*`: fingerprint computation and pre-execution
  gate; a persisted ledger (new table or state row) per the `persistence/schema` capability.
- `apps/cli`: new `monitor approve <id>` command; `scan`/`status` render the blocked state
  (`cli/monitor-commands`, `cli/authoring-commands`).
- Published package behavior and public types change → changeset, api-report regeneration, website docs.
