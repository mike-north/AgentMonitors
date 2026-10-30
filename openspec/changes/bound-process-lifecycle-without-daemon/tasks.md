## 1. Self-bounding spawned work

- [ ] 1.1 Implement a daemon-death-independent watchdog that enforces each monitored command's window (timeout + 5s grace) on its original process group / `taskkill` tree (PR #472's approach)
- [ ] 1.2 Ensure no in-flight cleanup path requires the daemon to be alive

## 2. Tests

- [ ] 2.1 Integration test: SIGKILL the daemon mid-command with a timeout pending; assert the covered tree terminates at its deadline with no daemon present (verify by PID, not process-tree membership)
- [ ] 2.2 Integration test: several in-flight commands across a daemon crash each terminate by their own hard bound
- [ ] 2.3 Sweep-reconciliation test (with the restart sweep): a close-on-exec descendant that survives daemon death is reaped at the next daemon start, asserted as a sweep case, not a deadline case
- [ ] 2.4 Long-run soak harness: repeated poll cycles over an extended window accumulate zero unintended processes

## 3. Docs and release

- [ ] 3.1 Update `apps/website` docs describing command lifetime bounds across daemon crashes
- [ ] 3.2 Add a changeset for `@agentmonitors/source-command-poll`
