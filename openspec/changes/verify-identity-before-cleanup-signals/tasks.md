## 1. Identity marks and verification

- [ ] 1.1 Capture identity marks (start time, lineage, containment marks) for every process the daemon may later signal
- [ ] 1.2 Implement a single signal-time verification step used by every cleanup path
- [ ] 1.3 Route timeout escalation (SIGTERM, SIGKILL follow-up, `taskkill`), live reaping, `daemon stop`/detach-failure termination, the restart sweep, and `gc` through that step
- [ ] 1.4 On verification failure, abstain (no signal) and hand the target to the abstention warning surface

## 2. Tests

- [ ] 2.1 Unit/integration test: a recycled-identifier fixture produces abstention, not a signal
- [ ] 2.2 Test per live signal path (not only the sweep) proving it routes through the same verification
- [ ] 2.3 Restart-sweep test reproducing the pid-4242 example: mismatch → no signal, warning names the pid and the failed check

## 3. Docs and release

- [ ] 3.1 Update `apps/website` docs: cleanup only ever signals processes it can confirm are its own
- [ ] 3.2 Add changesets for affected packages (`@agentmonitors/cli`, `@agentmonitors/source-command-poll`, `@agentmonitors/core` as applicable)
