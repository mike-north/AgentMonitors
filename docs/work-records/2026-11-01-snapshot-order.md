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

## Event extension checkpoint

Snapshot-only commit `def8c1a` was independently accepted by reviewer after15 focused
passes. Event scope and design were then accepted by root: private AUTOINCREMENT event
sequence, persisted created_at primary, sequence tie, no public field leakage.

Caller audit found direct pure-preview inputs come from pending/unread SQL plus
filter/slice; mutation receives a high+normal concatenation. The public mutating
boundary now reloads authoritative persisted candidate records and canonicalizes their
order. Unknown/duplicate IDs fail before mutation. No private ordinal leaks into public
records. Event schema currently has logical ID references, no declared SQLite FKs.

Tests-first event red:5 failed /2 passed on snapshot-only candidate. Genuine adverse-ID
query order, missing sequence, unknown/duplicate identity and caller-modified artifact
cases failed; unequal-time priority already passed. Implemented event migration/order
repair and initial focused25tests passed. Added full runtime mixed-band claim and
concurrent migration cases; final validation pending. No remote action taken.

## Event extension validation complete

- Final focused32tests across event8/snapshot6/net11/hook-cap7 passed.
- Full core678 tests across47 files passed, exit0.
- Workspace build7, full check, and strict workspace API reports6 passed.
- An initial full-check failure was one test-only `Array<T>` lint style; corrected
  to `T[]`, then full check and workspace API reports reran successfully.
- No public API report diffs. Runtime tests also verify sequence is absent from
  returned event keys; snapshot results retain exact `{ content }` equality.
- Logs: `/private/tmp/event-order-core.log`, `/private/tmp/event-order-build.log`,
  `/private/tmp/event-order-check.log`, `/private/tmp/event-order-api.log`.
- Event commit is being frozen for independent review. Snapshot commit was accepted;
  combined final acceptance is pending. No remote action or prefix merge performed.

The existing collapse/markClaimed multi-statement boundary is not redesigned; this work
establishes deterministic persisted ordering, not atomicity against concurrent pruning.

## Recipient-view review repair in progress

Event candidate88426e4 was frozen but NOT accepted: root spotted raw canonical reload
losing legitimate public recipient views. New tests first failed incremental and
single-net delta/lifecycle preservation plus foreign-view handling (3red). An initial
exact-equality overlay rule then failed a stale legitimate delta after another collapse
re-anchored the stored projection (explicit red captured).

Root-directed final rule: authoritative event reload left-joins only the requested
session projection. Raw shared candidates stay raw. A lifecycle-bearing or non-shared
delta requests a recipient view, refreshed from current persisted projection, never
trusted as text. Thus stale/forged/other-recipient overlays cannot overwrite that view.
No matching projection retains prior raw behavior; no new authorization model introduced.

Focused35tests passed (event12/net11/perrecipient8/json4). Broad successor validation
pending;88426e4 remains review-held until this follow-up is frozen and independently
accepted. No remote actions performed.

## Recipient-view successor validation complete

Final core682 tests across47files passed. Workspace build7, full check and strict
workspaceAPI6 passed, no API report diffs. Focused35 passed after final representation
rule. Logs are `/private/tmp/event-view-core.log`, `/private/tmp/event-view-build.log`,
`/private/tmp/event-view-check.log`, `/private/tmp/event-view-api.log`.

The follow-up is frozen for independent review; no claim of combined acceptance until
reviewer confirms the exact successor. Source work remains on the managed worktree
branch with no remote mutations.

## Orthogonal lifecycle/delta contract correction

Successor e71d925 was held after root/reviewer compared baseline16a directly:
`listEvents(session)` adds deliveryState while its MonitorEventRecord.diffText remains
SHARED. Treating lifecycle presence as a recipient-delta marker over-expanded behavior.
Two additional tests first failed on e71 (incremental and single-net lifecycle-only
views changed shared→recipient delta). Root authorized the narrow correction.

Final rule now keeps fields independent: only supplied diff different from immutable
shared diff requests the current requested-session projection. Optional deliveryState
is refreshed independently. Raw and lifecycle-only shared views remain shared; explicit
projected/stale/forged/foreign non-shared deltas use current requested-session data.
No ordering, migration, event identity, or other runtime logic changed in this correction.
Final successor validation/review pending; earlier e71 is not accepted for publication.

## Orthogonal correction validation complete

Focused64tests/7files passed, including both new lifecycle-only regressions. Full core
684tests/47files, workspace build7, full check, and strict workspaceAPI6 all passed.
No API report changes. Logs: `/private/tmp/event-view-final-core.log`,
`/private/tmp/event-view-final-build.log`, `/private/tmp/event-view-final-check.log`,
`/private/tmp/event-view-final-api.log`. Final successor is being frozen for independent
exact-head acceptance; no remote actions occurred.
