# Atomic materialization repair and adversarial findings

Scope: existing PR #482, reviewed head `82a8dde1a22202b7a9bad7ecf493cc33de61e4ab`, then
rebased onto upstream `e1bafcfa15244972db4728ca0f4be4106ff10007`. This is the per-observation
transaction prerequisite, not the complete source-progress/outbox work in the downstream stack.

## Findings and reproduction

1. Empty snapshots passed a truthiness guard in `materializeObservation`. A real runtime test
   established `one`, registered a late recipient, then observed an empty string. The shared
   deletion diff was null; the recipient also lost its pre-event baseline. The new regression
   fails before the two nullish-presence checks and passes afterward, including empty-to-nonempty.
2. The Interpret commit test asserted an `eventId` field absent from `latestSnapshot` inside the
   fake adapter. Interpret caught that assertion and the test passed by checking only call count.
   Adding an outside assertion for the expected digest reproduced failure (`[]` vs `committed`).
   The repaired test captures a separate database connection's observations and asserts outside
   the adapter, including its successful digest. Separate connections establish committed visibility.

The existing later-recipient rollback test now fails on projection count, not timestamp-based
session ordering; that previous review issue is repaired. Transactions contain no awaited adapter
work. No new transaction-boundary defect found in this bounded review.

## Scope and remaining work

Source progress still precedes per-observation materialization in this PR; whole-span persistence
before Interpret and durable retries belong to the already-open downstream stack (#483, #494–#498,
#484). Independent tests against upstream reproduced these remaining gaps and were retained outside
this patch at `/tmp/agentmon-durability-review/atomic-ingest.test.ts` for that follow-up.

Rebase conflict was limited to the spec changelog and resolved by retaining both histories. Current
upstream's better-sqlite3 13.x repair is preserved. No canonical dirty checkout was modified. This
repair requires a separate final adversarial review: its author cannot approve their own repair.

## Validation

- Full core suite: 42 files, 612 tests passed on Node 24.14.0.
- Core strict TypeScript and API-report checks passed (report unchanged).
- Changed-file ESLint has no errors; existing service.ts release-tag warnings remain.
- Changed-file Prettier and `git diff --check` passed.
- The final lint-only test refactor was rechecked with strict TypeScript and the focused
  post-commit test after the full suite; it does not change production behavior.
