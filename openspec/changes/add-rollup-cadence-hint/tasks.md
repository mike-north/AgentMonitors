## 1. Contract

- [ ] 1.1 Define "tighter than its delivery window" precisely (e.g. `watch.interval` shorter than the minimum gap between consecutive `window` openings) and reconcile it with 001's example recommending `interval: 1h` for a daily window
- [ ] 1.2 File a GitHub issue for this change and add "Refs #N" to `proposal.md`

## 2. Implementation

- [ ] 2.1 Compute the comparison for `rollup` monitors in `agentmonitors validate` and emit a non-fatal hint in text, JSON, and TOON output
- [ ] 2.2 Keep the exit status unchanged and leave runtime cadence untouched

## 3. Tests

- [ ] 3.1 CLI integration test: rollup monitor with `interval: 30s` and `window: '0 9 * * 1-5'` prints the hint and exits 0
- [ ] 3.2 CLI integration test: the same monitor with a non-tight interval prints no hint
- [ ] 3.3 Runtime test (fake timers): a rollup monitor with a tight interval still observes at that interval and delivers only at the window

## 4. Release collateral

- [ ] 4.1 Add a changeset for `@agentmonitors/cli` (and `@agentmonitors/core` if a helper is exported)
- [ ] 4.2 If `@agentmonitors/core` public API changes, run `pnpm --filter @agentmonitors/core run fix:api-report`
- [ ] 4.3 Mention the hint in the rollup section of `apps/website/src/pages/docs/authoring-monitors.md`
