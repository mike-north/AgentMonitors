## 1. Core read

- [ ] 1.1 Add a session-scoped armed-set read over `monitor_state.notify_state` (debounce, throttle, `pendingRollup`), event age vs `DEFAULT_HIGH_URGENCY_SETTLE_MS`, and `session_event_state` (`net_suppressed_at`, `interpret_*`), reusing the `monitor explain` hold substrate
- [ ] 1.2 Compute the hold reason per armed entry and, where deterministic, the earliest fire time (settle expiry, rollup window opening)
- [ ] 1.3 Assemble received / pending / armed buckets for a session in one read, covering persistent and ephemeral monitors identically
- [ ] 1.4 Ensure the read never claims, acknowledges, advances a cursor, or invokes a source `observe()`

## 2. Daemon and CLI surface

- [ ] 2.1 Add an `inspect` daemon method with Zod-validated params
- [ ] 2.2 Add `apps/cli/src/commands/inspect.ts` (`--session`, `--socket`, `--format`) and register it

## 3. Tests

- [ ] 3.1 Integration test with fake timers: a change inside a settle/debounce window is armed, moves to pending when it fires, and to received when claimed — three separately asserted transitions
- [ ] 3.2 Tests: a rollup-window hold and a recorded `net` / Interpret suppression appear as armed (met-and-held), not pending or absent
- [ ] 3.3 Test: `session_event_state` and `session_object_cursor` byte-identical before/after `inspect`
- [ ] 3.4 Test: high-urgency settle entry reports earliest fire time = detection + 15 s (fake timers)
- [ ] 3.5 Test: an ephemeral watch's held change is reported identically to a persistent monitor's
- [ ] 3.6 Docker-backed CLI test of `inspect` over the real socket contract

## 4. Release collateral

- [ ] 4.1 Add a changeset for `@agentmonitors/cli` (and `@agentmonitors/core` if its public API changes)
- [ ] 4.2 Regenerate the core API report if public types change (`pnpm --filter @agentmonitors/core run fix:api-report`)
- [ ] 4.3 Document `inspect` in `apps/website`
