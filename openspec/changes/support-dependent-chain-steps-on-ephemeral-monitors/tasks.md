## 1. Design

- [ ] 1.1 Pin the chain-authoring surface, the fire-condition (`--until`) semantics, and what "satisfied" means for a step (#124)

## 2. Runtime

- [ ] 2.1 Allow the daemon to register an ephemeral monitor for the next chain step when the prior step fires, bound to the chain's declaring lead session
- [ ] 2.2 Reap a chain step when it is satisfied, retaining its materialized events (status `active` → `reaped`, `reaped_at` stamped)
- [ ] 2.3 Persist chain-step linkage durably so armed steps survive a daemon restart while the session lives and are never resurrected after it ends

## 3. Tests

- [ ] 3.1 Integration test: prior step fires → next step registered as an ephemeral monitor for the declaring session, evaluated on the next tick, projecting only into that session
- [ ] 3.2 Test: a satisfied step is reaped and its events retained
- [ ] 3.3 Restart-safety test: an armed unsatisfied step survives a daemon restart while the session lives; after session close it is reaped and not re-armed

## 4. Release collateral

- [ ] 4.1 Add a changeset for affected published packages
- [ ] 4.2 Regenerate the core API report if public types change (`pnpm --filter @agentmonitors/core run fix:api-report`)
- [ ] 4.3 Document chain steps in `apps/website` once a user-visible chain surface ships
