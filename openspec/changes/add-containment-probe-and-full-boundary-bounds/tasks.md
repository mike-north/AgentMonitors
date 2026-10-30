## 1. Design

- [ ] 1.1 Produce the per-platform inventory: which OS facilities implement each ladder rung on each supported platform, and each rung's probe (#480)
- [ ] 1.2 Record the platform table in the `reliability/process-hygiene` spec as part of this change

## 2. Capability probe and selection

- [ ] 2.1 Probe containment mechanisms at daemon startup and select the highest succeeding rung, with no user-facing configuration surface
- [ ] 2.2 Ensure probing never triggers OS permission prompts
- [ ] 2.3 Detect an optional strongest-primitive component automatically; fall back when absent without gating the install
- [ ] 2.4 Spawn monitored commands under the selected rung's mechanism (`plugins/source-command-poll`)

## 3. Full-boundary bounds and deferred reconciliation

- [ ] 3.1 On rungs that track re-grouped/re-sessioned descendants, terminate them at the deadline
- [ ] 3.2 On lower rungs, record identity-kept out-of-group descendants as deferred-reconciliation (attributable, reported in diagnostics) and hand them to the restart sweep
- [ ] 3.3 Expose the five-state classification in diagnostics

## 4. Achieved-guarantee reporting

- [ ] 4.1 Add the containment report (mechanism + guarantee level) to `agentmonitors doctor`
- [ ] 4.2 Re-derive the report on every probe so an environment downgrade changes it

## 5. Tests

- [ ] 5.1 Capability-probe fixtures: the highest succeeding rung is selected, with no prompt
- [ ] 5.2 Rung 1 behavioral test: deadline-kill of a re-sessioned descendant
- [ ] 5.3 Rung 2 behavioral test: group deadline-kill plus sweep of the re-sessioned case
- [ ] 5.4 Rung 3 behavioral test: direct-child kill plus sweep
- [ ] 5.5 Regression: a command that re-sessions an identity-kept child is terminated at the deadline on a kernel-containment rung, and reaped by the next daemon start on the fallback rung
- [ ] 5.6 Doctor report matches the selected rung; a simulated mechanism downgrade changes the report (Docker-backed CLI test where platform-specific)

## 6. Docs and release

- [ ] 6.1 Update `apps/website` docs: containment report in `doctor`, and the escape posture (recovery is the user's ordinary OS tooling)
- [ ] 6.2 Add a changeset for `@agentmonitors/cli` and `@agentmonitors/source-command-poll` (and `@agentmonitors/core` if public types change)
- [ ] 6.3 Run `pnpm --filter <pkg> run fix:api-report` for any package whose public API changes
