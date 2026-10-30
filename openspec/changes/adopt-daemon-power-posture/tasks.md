## 1. Design

- [ ] 1.1 Set the numeric per-interval wake budget (#469 design work)
- [ ] 1.2 Decide how battery state is detected per platform and how it adjusts intervals

## 2. Implementation

- [ ] 2.1 Add debug-level logging of poll-loop iterations and timer fires so wakeups are countable
- [ ] 2.2 Remove any busy-spinning and coalesce timers in the tick loop, scheduling, bookkeeping, and transports
- [ ] 2.3 Prefer event-driven watch paths where sources support them
- [ ] 2.4 Use conditional requests for network polling where the source protocol allows
- [ ] 2.5 Make intervals battery-aware where the platform exposes power state
- [ ] 2.6 Reconcile sleep/wake without replaying missed windows

## 3. Tests

- [ ] 3.1 Integration harness counting daemon wakeups over N idle tick intervals; assert O(N) with a small constant (use fake timers where deterministic)
- [ ] 3.2 Assert a due tick performs no intermediate wakeups before the next scheduled one
- [ ] 3.3 Encode #469's numeric budget as the bound in the harness assertion
- [ ] 3.4 Test sleep/wake reconciliation does not replay missed windows

## 4. Docs and release

- [ ] 4.1 Update `apps/website` docs describing the daemon's idle/power behavior
- [ ] 4.2 Add changesets for affected packages
