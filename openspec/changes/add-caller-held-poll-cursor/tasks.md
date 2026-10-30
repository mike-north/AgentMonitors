## 1. Gate

- [ ] 1.1 Measure `command-poll` poll cost on representative monitors; proceed only if measured cost justifies the cursor protocol (#81)
- [ ] 1.2 Resolve the open questions in `design.md` and finalize the delta specs before implementation

## 2. Implementation (`@agentmonitors/source-command-poll`)

- [ ] 2.1 Add the `cursor` block (`initial`, `next-state`) to the `command-poll` `scopeSchema` and config parsing
- [ ] 2.2 Template `{{state}}` placeholders in `command` with the current cursor; store the extracted `next-state` value in `nextState`

## 3. Tests

- [ ] 3.1 Unit: first run executes argv with `initial`; second run executes argv with the extracted `next-state` value
- [ ] 3.2 Unit: cursor survives a restart via persisted source state (integration with the runtime's `sourceState` persistence)
- [ ] 3.3 Schema-parity tests for valid and invalid `cursor` blocks

## 4. Release collateral

- [ ] 4.1 Add a changeset for `@agentmonitors/source-command-poll`
- [ ] 4.2 Regenerate API reports if a public surface changes (`pnpm --filter <pkg> run fix:api-report`)
- [ ] 4.3 Document the cursor block in `apps/website`
