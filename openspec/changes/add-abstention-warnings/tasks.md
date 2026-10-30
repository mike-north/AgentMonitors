## 1. Durable abstention records

- [ ] 1.1 Persist each abstention (pid, observed identity marks, failure reason, daemon life) durably so it survives daemon restarts
- [ ] 1.2 Deduplicate by abstained process; re-raise only on meaningful change in identity evidence

## 2. Surfaces

- [ ] 2.1 Add an abstention section to `agentmonitors doctor`
- [ ] 2.2 Deliver abstention warnings into the next active lead session through the normal delivery machinery; hold them until a session exists when none is open
- [ ] 2.3 Author warning text that names the process, states uncertainty plainly, and tells the user what they can do

## 3. Tests

- [ ] 3.1 Integration test: live-path abstention → warning visible via `doctor` AND delivered to the active lead session
- [ ] 3.2 Integration test: no-session sweep abstention persists across a daemon restart and surfaces on next session open
- [ ] 3.3 Test asserting warning text expresses uncertainty (a certainty phrasing for an abstention fails the test)
- [ ] 3.4 Test: N observations of the same abstained process yield one warning

## 4. Docs and release

- [ ] 4.1 Update `apps/website` docs (doctor output and the abstention warning)
- [ ] 4.2 Add changesets for `@agentmonitors/core` and `@agentmonitors/cli`; run `pnpm --filter @agentmonitors/core run fix:api-report` if public types change
