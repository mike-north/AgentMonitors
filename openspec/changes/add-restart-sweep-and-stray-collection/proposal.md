## Why

Nothing reconciles what a previous daemon life left behind. A hard kill, crash, or power loss can
leave orphaned poll-command process trees, stray daemons, channel servers, and stale sockets, and
the next start does nothing about them — the user cleans up by hand. Refs #478 (restart sweep of
orphaned command-poll process trees), Refs #426 (adjacent daemon/channel-server/socket hygiene and
`gc`).

Source: 008 §2.1 (the "detached but identifiable MUST be caught by the restart sweep" clause),
§4.2, §4.3, §12 (row "Hard kill + restart leaves a clean process list with no manual
intervention").

## What Changes

- On startup the daemon sweeps strays left by a previous daemon life: every process still within
  the containment boundary (identity kept) that belongs to a dead daemon life is identity-verified
  and reaped — including detached-but-identifiable descendants.
- The sweep records what it reaped (pid, identity evidence, the daemon life it belonged to), so a
  sweep that silently did nothing is distinguishable from one with nothing to do.
- A sweep target that cannot be positively identity-verified is an abstention, never a kill.
- Stray daemons, channel servers, and stale sockets become detectable and collectable.
- Hardware failure is reconciled at the next start rather than prevented.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds the restart sweep, sweep diagnostics, sweep abstention, stray
  daemon/channel-server/socket collection, and next-start reconciliation.

## Impact

- Code: daemon startup path (`apps/cli/src/commands/daemon.ts`), `libs/core/src/runtime/*`
  (identity-marked spawn records per daemon life), `apps/cli/src/daemon-ipc.ts` (socket hygiene),
  channel-server bookkeeping.
- Principles: PP7, BP1, BP4 (per `principles`). Depends on `verify-identity-before-cleanup-signals`
  (#479) for identity verification and on `add-abstention-warnings` (#507) for the abstention
  surface; reaps the deferred-reconciliation descendants defined by
  `add-containment-probe-and-full-boundary-bounds` (#480) and the close-on-exec residual of
  `bound-process-lifecycle-without-daemon` (#470).
- Contradictions resolved: #478's original scope (written before the containment-boundary
  definition) covered only orphaned poll-command trees; 008 §4.2 extends it to detached-but-
  identifiable descendants. This change adopts the extended scope (resolution recorded in
  `docs/specs/spec-changelog.md` and on the issue per 008 §4.2).
- Related: the `daemon/ipc` capability owns the socket/lock protocol and the `delivery/transport-health`
  capability owns the channel heartbeat lease that keeps an orphaned channel server from pinning the
  daemon alive; this change adds collection on top, it does not change those contracts.
- The command surface for on-demand collection (`agentmonitors gc`, per #426) belongs to the `cli/*`
  capabilities and is not specified here.
- Changesets for `@agentmonitors/cli` and `@agentmonitors/core`.
