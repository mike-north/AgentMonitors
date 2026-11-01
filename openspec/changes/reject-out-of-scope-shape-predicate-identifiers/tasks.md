## 1. Contract

- [ ] 1.1 Decide how the snapshot identifier set is known at validate time (a per-source declared snapshot shape, a reserved root, …) and record the decision and rejected alternatives in `design.md`
- [ ] 1.2 File a GitHub issue for this change and add "Refs #N" to `proposal.md`

## 2. Implementation

- [ ] 2.1 Walk each `shape.derive[].when` CEL AST in the `shape` refinement (`libs/core/src/schema/monitor-schema.ts`) and reject identifiers outside the snapshot set and `now`, with the error on `shape.derive.<i>.when` naming the identifier
- [ ] 2.2 Keep evaluation-time "fact does not hold" for in-scope fields absent from a snapshot
- [ ] 2.3 Confirm `validate`, `monitor test`, and `watch declare` all surface the rejection through shared parse-time validation

## 3. Tests

- [ ] 3.1 Unit tests (`monitor-schema.test.ts`): `when: 'due < today'` is rejected at `shape.derive.0.when` naming `today`; `when: 'now <= due && due <= now + 48h'` is accepted (hand-authored expected messages)
- [ ] 3.2 Unit test (Shape stage, fixed `now`): a snapshot missing `priority` yields no `urgent` fact and no error
- [ ] 3.3 CLI integration test (`cli.integration.test.ts`): `validate` exits 1 and reports the `shape.derive.0.when` path for an out-of-scope identifier

## 4. Release collateral

- [ ] 4.1 Add a changeset for `@agentmonitors/core` and `@agentmonitors/cli` (newly rejected monitors)
- [ ] 4.2 If any exported type or helper changes, run `pnpm --filter @agentmonitors/core run fix:api-report`
- [ ] 4.3 Update the `shape` section of the `apps/website` authoring docs to state the identifier-scope rule
