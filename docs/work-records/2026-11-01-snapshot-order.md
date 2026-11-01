# Snapshot and event ordering foundation repair

Owner: `/root/tool_curator`; worktree:
`/Users/mnorth/.codex/worktrees/snapshot-materialization-order/agentmonitors`;
branch `codex/snapshot-materialization-order`, based on actual main
`16a8c537a20040199c6cdd403cbb90c565618c76`.

## Scope and decisions

The coordinator requested independent snapshot-order reproduction, then authorized an
isolated foundation repair with tests first, no remote actions. Two genuine process-local
ULID factories at identical clocks committed A then B; both accepted498 ea34f1b3 and
main16a returned A as latest. Reproduction scripts remain in
`/private/tmp/snapshot-order-independent/`. Issue293 and spec002 require the most recently
materialized predecessor, not observed-time ordering.

Root and independent reviewer accepted SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`
snapshot sequence, retaining public ULID IDs as NOT NULL UNIQUE. Current hidden rowid is
only the legacy bootstrap policy; no claim to recover historical chronology lost before
migration or repair previously emitted diffs. Migration runs under existing schema
BEGIN IMMEDIATE, recreates explicit indexes/triggers after copying, and leaves event
relationships intact. Current repository schema has no enforced snapshot foreign keys.
Deletion, rollback, VACUUM/reopen, and concurrent-open semantics are documented in002.

## Tests-first evidence and implementation state

Added `runtime/snapshot-materialization-order.test.ts` and owned native source-loading
child fixture. Two genuine factories prime private scratch DBs, then parent chooses
higher-ID writer first and lower-ID writer second. Each child exits before the next
commit; an already-open reader plus fresh reader process must select B. No IDs or
production rows are substituted. A15s child timeout and final exit waits own lifecycle.

Initial corrected red run on untouched main:6 failed. Actual semantic failures included
cross-process latest A instead of B, clock reversal latest A, and legacy bootstrap A;
other cases exposed missing sequence. The first draft also had a test-only unavailable
`isValid` import, corrected to exported `decodeTime` before recording the semantic red.

Implemented private sequence in schema, transactional legacy rebuild, sequence-only
latestSnapshot, durable comments,002/004 and changelog, core patch Changeset. Existing
snapshot-tie comment now points at durable sequence. Native fixture lint configuration
matches the existing ordinary-JS override without exempting production sources.

Focused green: snapshot suite6 plus transactional materialization4 passed; earlier
snapshot tie suite5 also passed. Migration test additionally checks public rows,
explicit index/trigger preservation, no trigger replay, uniqueness and FK check.

## Snapshot validation complete

- Full core:670 tests across46 files passed, exit0.
- Workspace build:all7 projects passed.
- Full check:all package typechecks, lint (0 errors; existing warnings), formatting,
  test-file extension guard, and aipm validation passed. Initial lint found two new-test
  non-null assertions; replaced with an explicit missing-ID guard before final pass.
- Strict workspace API reports:all6 published projects passed, exit0; no API report diffs.
- Logs: `/private/tmp/snapshot-order-check.log`, `/private/tmp/snapshot-order-api.log`.
- Snapshot-only commit is being frozen for independent review. No remote action taken.

## Separate event tie extension authorized, not yet implemented

Independent reviewer proved main16a event net preview/collapse and claimed cursor select
A after equal-time real-process A→B commits with adverse genuine event IDs. Root authorized
one separate tests-first commit after the snapshot commit. Preserve observed timestamp
as the primary event ordering key; repair only equal-time materialization tie consistently
across preview/net/cursor. Must send small sequence/migration design to root before
implementation. Do not expand to history/frontier changes without separate proof.

Independent reviewer record is in the coordinator checkout:
`docs/work-records/2026-11-01-event-order-sibling-audit.md`;
probe `/private/tmp/event-order-independent`.

All five prefix CI heads are green according to coordinator, but merge remains held on
these confirmed foundation defects. No remote action is authorized for this workstream.
