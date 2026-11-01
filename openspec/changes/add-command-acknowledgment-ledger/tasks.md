## 1. Design closure

- [ ] 1.1 Decide how a host opts in to acknowledgment gating and record it in this change's design.md
- [ ] 1.2 Define the persisted ledger shape (table/columns) per the `persistence/schema` capability

## 2. Core gate

- [ ] 2.1 Compute `commandFingerprint = hash(argv ‖ cwd ‖ env-keys)` for each `command-poll` monitor (env keys only, never values)
- [ ] 2.2 Skip execution of a gated monitor whose fingerprint is not in the ledger and report it as `blocked: awaiting-acknowledgment`
- [ ] 2.3 Keep gating disabled by default so existing monitors execute exactly as today
- [ ] 2.4 Unit tests: fingerprint changes on argv/cwd/env-key edits and not on env-value edits; blocked monitor never spawns; default-disabled path executes

## 3. CLI

- [ ] 3.1 Add `agentmonitors monitor approve <id>` that records the monitor's current fingerprint
- [ ] 3.2 Render `blocked: awaiting-acknowledgment` in `scan` and `status` output
- [ ] 3.3 Docker-backed CLI integration tests: approve unblocks; editing `command` re-blocks; disabled gating never blocks

## 4. Release collateral

- [ ] 4.1 Add a changeset for `@agentmonitors/core`, `@agentmonitors/source-command-poll`, and `@agentmonitors/cli`
- [ ] 4.2 Regenerate api-reports for changed public APIs (`pnpm --filter <pkg> run fix:api-report`)
- [ ] 4.3 Document the gate and `monitor approve` in `apps/website`
