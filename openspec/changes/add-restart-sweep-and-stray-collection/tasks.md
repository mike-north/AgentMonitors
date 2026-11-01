## 1. Daemon-life bookkeeping

- [ ] 1.1 Durably record spawned process identity marks (pid, start time, lineage, containment marks) per daemon life so a later start can attribute strays
- [ ] 1.2 Record the resolution of #478's extended scope (detached-but-identifiable descendants) in `docs/specs/spec-changelog.md` and on the issue

## 2. Restart sweep

- [ ] 2.1 On daemon startup, enumerate in-boundary processes from dead daemon lives and identity-verify each before any signal
- [ ] 2.2 Reap confirmed strays; record pid, identity evidence, and daemon life in diagnostics
- [ ] 2.3 Treat unverifiable targets as abstentions (hand off to the abstention warning surface)

## 3. Stray daemon / channel server / socket hygiene (#426)

- [ ] 3.1 Detect stray daemons, channel servers, and stale sockets from previous lives
- [ ] 3.2 Collect them through the identity-verified cleanup path

## 4. Tests

- [ ] 4.1 Integration test: orphan a process tree (identity kept) from a SIGKILLed daemon life, restart, assert it is reaped AND the sweep diagnostic records pid, identity evidence, and daemon life
- [ ] 4.2 Integration test: orphan a process whose identity cannot be confirmed, restart, assert it is left alone and a warning is produced
- [ ] 4.3 Assert never a wrong kill: an unrelated process is never signalled across sweep runs
- [ ] 4.4 Integration test: a detached-but-identifiable descendant from a dead daemon life is reaped on restart
- [ ] 4.5 Docker-backed CLI test: hard kill + restart leaves a clean process list (no stray daemon, channel server, or socket) with no manual intervention

## 5. Docs and release

- [ ] 5.1 Update `apps/website` docs describing restart reconciliation and stray collection
- [ ] 5.2 Add changesets for `@agentmonitors/cli` and `@agentmonitors/core`; run `pnpm --filter @agentmonitors/core run fix:api-report` if public types change
