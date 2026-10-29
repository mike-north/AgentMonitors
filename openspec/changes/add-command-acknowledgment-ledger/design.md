## Context

003 §11.6 records the trust decision for local execution in two parts: the v1 (current) rule that
`command-poll` executes without acknowledgment, and this deferred, designed-only gate. Only a sketch
exists; this change is to be fully specified if multi-tenant or untrusted-workspace hosting becomes a
requirement.

## Decisions

- **Fingerprint = `hash(argv ‖ cwd ‖ env-keys)`.** Env **keys**, not values, so secrets never enter the
  ledger (consistent with the rule that `env` values are never persisted) while adding or removing an
  injected variable still re-blocks.
- **Default preserves v1.** An empty-ledger-means-allow default (gating disabled unless a host opts in)
  composes with the current behavior instead of breaking every existing monitor.
- **Approval is an explicit CLI act** (`agentmonitors monitor approve <id>`), not an implicit side effect
  of `validate` or `scan`.

## Rejected alternatives

- **An interactive prompt in v1 for every new command.** Rejected: anyone who can write `MONITOR.md` into
  the workspace can already achieve arbitrary execution via `package.json` scripts, git hooks, or
  `.claude` hooks, and the daemon already scopes evaluation to its workspace; a prompt taxes the
  legitimate path without adding security.
- **Restricting the inherited environment (allow-list) as a safety measure.** Rejected for v1 in the
  same section of the source doc: it adds hygiene, not security, since the command runs as the daemon's
  own user.

## Open Questions

- How a host opts in to gating (config key, daemon flag, or host-adapter capability) is not specified by
  the source doc.
- Ledger persistence shape and scope (per workspace vs per user) are not specified.
- Whether `blocked: awaiting-acknowledgment` also surfaces through `doctor`/`verify` is not specified.
