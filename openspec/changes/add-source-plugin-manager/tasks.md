## 1. Decision

- [ ] 1.1 Confirm with the owner that G4 resolves as a real plugin manager (not "keep manual install and remove the placeholders"); if the latter, rewrite this change as REMOVED requirements plus documented manual install
- [ ] 1.2 Resolve the design.md open questions (discovery source, install location, daemon pickup of installed/removed sources)

## 2. Implementation

- [ ] 2.1 Implement `source search [query]` in `apps/cli/src/commands/source.ts`
- [ ] 2.2 Implement `source install <name>` and load installed plugins into the registry alongside the bundled sources (`apps/cli/src/sources.ts`)
- [ ] 2.3 Implement `source update [name]`
- [ ] 2.4 Implement `source remove <name>`, refusing to remove bundled sources

## 3. Tests

- [ ] 3.1 CLI integration tests for search, install, update, and remove, replacing the placeholder exit-1 assertions
- [ ] 3.2 Integration test: an installed source appears in `source list`, validates in `validate`, and is present in `schema generate` output
- [ ] 3.3 Integration test: a removed source makes a monitor using it fail `validate` as an unknown source
- [ ] 3.4 Negative test: `source remove` on a bundled source is refused

## 4. Collateral

- [ ] 4.1 Retire NP3 in the `principles` capability and update `sources/contract` (registry population, plugin installation) and the `cli/conventions` command inventory
- [ ] 4.2 Add a changeset for `@agentmonitors/cli` (and `@agentmonitors/core` if registry APIs change, with `pnpm --filter @agentmonitors/core run fix:api-report`)
- [ ] 4.3 Update `apps/website` docs for the new `source` commands
