# Snapshot and event ordering foundation repair

Owner: `/root/tool_curator`.
Worktree: `/Users/mnorth/.codex/worktrees/snapshot-materialization-order/agentmonitors`.
Branch: `codex/snapshot-materialization-order`, based on actual main commit
`16a8c537a20040199c6cdd403cbb90c565618c76`.

The entries below preserve the evidence and status recorded at each checkpoint.

## Scope and decisions

The coordinator requested an independent snapshot-order reproduction, then authorized
an isolated foundation repair with tests first and no remote actions. Two genuine
process-local ULID factories with identical clocks committed A and then B. Both the
accepted #498 candidate, `ea34f1b3`, and main commit `16a8` returned A as the latest
snapshot. Reproduction scripts remain in `/private/tmp/snapshot-order-independent/`.
Issue #293 and specification 002 require the most recently materialized predecessor,
not ordering by observation time.

The coordinator and independent reviewer accepted a SQLite
`INTEGER PRIMARY KEY AUTOINCREMENT` snapshot sequence, retaining public ULID IDs as
`NOT NULL UNIQUE`. Current hidden rowid order is only the legacy bootstrap policy;
it does not recover historical chronology lost before migration or repair previously
emitted diffs. Migration runs under the existing schema transaction's `BEGIN IMMEDIATE`,
recreates explicit indexes and triggers after copying, and leaves event relationships
intact. The current repository schema has no enforced snapshot foreign keys.
Specification 002 documents deletion, rollback, VACUUM, reopen, and concurrent-open
semantics.

## Tests-first evidence and implementation state

Added `runtime/snapshot-materialization-order.test.ts` and an owned child fixture that
loads native source. Two genuine factories prime private scratch databases. The parent
then chooses the writer with the higher ID first and the writer with the lower ID second.
Each child exits before the next commit. An already-open reader and a fresh reader
process must both select B. No IDs or production rows are substituted. A 15-second child
timeout and explicit waits for child exit bound the process lifecycle.

The corrected initial run on untouched main had six failing tests. Semantic failures
included returning A instead of B across processes, returning A after a clock reversal,
and selecting A during legacy bootstrap. Other cases exposed the missing sequence.
The first draft also used an unavailable test-only `isValid` import; this was corrected
to the exported `decodeTime` before recording the semantic failures.

Implemented the private sequence in the schema, transactional legacy rebuild,
sequence-only `latestSnapshot`, durable comments, updates to specifications 002 and 004
and the changelog, and a core patch Changeset. The existing snapshot-tie comment now
points to the durable sequence. The native fixture lint configuration follows the
existing ordinary JavaScript override without exempting production sources.

Focused validation passed all six snapshot cases and four transactional materialization
cases. The five earlier snapshot-tie cases also passed. The migration test additionally
checks public rows, preservation of explicit indexes and triggers, absence of replayed
trigger effects, uniqueness, and foreign-key integrity.

## Snapshot validation complete

- Full core: 670 tests across 46 files passed, with exit code 0.
- Workspace build: all seven projects passed.
- Full check: package typechecks, lint (zero errors; existing warnings), formatting,
  the test-file extension guard, and aipm validation passed. Initial lint found two
  non-null assertions in the new test; an explicit missing-ID guard replaced them
  before the final pass.
- Strict workspace API reports: all six published projects passed, with exit code 0
  and no API report diffs.
- Logs: `/private/tmp/snapshot-order-check.log` and `/private/tmp/snapshot-order-api.log`.
- The snapshot-only commit is being frozen for independent review. No remote action
  was taken.

## Separate event tie extension authorized, not yet implemented

The independent reviewer proved that main commit `16a8` selects A in event net previews,
collapse, and the claimed cursor after equal-time commits of A and then B from real
processes with adverse genuine event IDs. The coordinator authorized a separate commit,
with tests first, after the snapshot commit. Preserve the observation timestamp as the
primary event ordering key and repair only the equal-time materialization tie across
preview, net collapse, and cursor advancement. Send the coordinator a small sequence and
migration design before implementation. Do not expand the repair to history or frontiers
without separate proof.

The independent reviewer record is in the coordinator checkout at
`docs/work-records/2026-11-01-event-order-sibling-audit.md`.
The probe is in `/private/tmp/event-order-independent`.

According to the coordinator, all five prefix CI heads are green, but merge remains held
on these confirmed foundation defects. No remote action is authorized for this workstream.

## Event extension checkpoint

The reviewer independently accepted snapshot-only commit `def8c1a` after 15 focused
tests passed. The coordinator then accepted the event scope and design: a private
AUTOINCREMENT event sequence, persisted `created_at` as the primary key for ordering,
the sequence as its tie-breaker, and no public field leakage.

The caller audit found that direct pure-preview inputs come from pending and unread SQL
queries followed by filtering or slicing. Mutation receives concatenated high-urgency
and normal-urgency candidates. The public mutation boundary now reloads authoritative
persisted candidate records and orders them consistently. Unknown or duplicate IDs fail
before mutation. No private ordinal leaks into public records. The event schema has
logical ID references and no declared SQLite foreign keys.

The tests-first event run on the snapshot-only candidate had five failures and two passes.
Cases covering genuine adverse-ID query order, a missing sequence, unknown or duplicate
identities, and caller-modified artifacts failed. Unequal-time priority already passed.
After the event migration and ordering repair, the initial 25 focused tests passed.
Added full runtime claims with mixed urgency bands and concurrent migration cases;
final validation is pending. No remote action was taken.

## Event extension validation complete

- All 32 focused tests passed: eight event cases, six snapshot cases, 11 net cases,
  and seven hook-cap cases.
- Full core: 678 tests across 47 files passed, with exit code 0.
- Workspace build: seven projects passed. Full check and strict API reports for all
  six published workspace projects also passed.
- An initial full-check failure was one test-only `Array<T>` lint style violation.
  This was corrected to `T[]`, then full check and workspace API reports passed again.
- No public API report diffs. Runtime tests also verify that returned event keys omit
  the sequence; snapshot results retain exact `{ content }` equality.
- Logs: `/private/tmp/event-order-core.log`, `/private/tmp/event-order-build.log`,
  `/private/tmp/event-order-check.log`, and `/private/tmp/event-order-api.log`.
- The event commit is being frozen for independent review. The snapshot commit was
  accepted; combined final acceptance is pending. No remote action or prefix merge
  was performed.

The existing `collapseNetForClaim` and `markClaimed` boundary uses multiple statements
and is not redesigned. This work establishes deterministic persisted ordering, not
atomicity against concurrent pruning.

## Recipient-view review repair in progress

Event candidate `88426e4` was frozen but not accepted. The coordinator spotted that
reloading raw records discarded legitimate public recipient views. New tests first
failed on incremental and single-net delta and lifecycle preservation, plus foreign-view
handling: three failing cases. An initial exact-equality overlay rule then failed for a
stale legitimate delta after another collapse re-anchored the stored projection.
That failure was captured explicitly.

The coordinator-directed rule at this checkpoint reloads authoritative events and
left-joins only the requested session's projection. Raw shared candidates stay raw.
A candidate with lifecycle state or a non-shared delta requests a recipient view,
refreshed from the current persisted projection rather than trusted as text. Stale,
forged, and other-recipient overlays therefore cannot overwrite that view. When no
projection matches, prior raw behavior remains; no new authorization model is introduced.

All 35 focused tests passed: 12 event cases, 11 net cases, eight per-recipient cases,
and four JSON cases. Broad successor validation is pending. Candidate `88426e4` remains
held for review until this follow-up is frozen and independently accepted.
No remote actions were performed.

## Recipient-view successor validation complete

Full core passed 682 tests across 47 files. The workspace build passed for seven
projects; full check and strict workspace API reports passed for six published projects,
with no API report diffs. All 35 focused tests passed after the representation rule was
updated. Logs are `/private/tmp/event-view-core.log`, `/private/tmp/event-view-build.log`,
`/private/tmp/event-view-check.log`, and `/private/tmp/event-view-api.log`.

The follow-up is frozen for independent review. There is no claim of combined acceptance
until the reviewer confirms the exact successor. Source work remains on the managed
worktree branch with no remote mutations.

## Orthogonal lifecycle/delta contract correction

Successor `e71d925` was held after the coordinator and reviewer compared it directly with
baseline `16a8`. `listEvents(session)` adds `deliveryState`, while its
`MonitorEventRecord.diffText` remains shared. Treating lifecycle presence as a marker
for a recipient delta expanded the behavior too far. Two additional tests first failed
on `e71d925`: incremental and single-net lifecycle-only views changed a shared delta into
a recipient delta. The coordinator authorized the narrow correction.

The final rule keeps the fields independent. Only a supplied diff that differs from the
immutable shared diff requests the current projection for the requested session.
Optional `deliveryState` is refreshed independently. Raw views and lifecycle-only shared
views remain shared. Explicit projected, stale, forged, and foreign non-shared deltas
use current data for the requested session. This correction changed no ordering,
migration, event identity, or other runtime logic. Final successor validation and review
are pending; the earlier `e71d925` candidate is not accepted for publication.

## Orthogonal correction validation complete

All 64 focused tests across seven files passed, including both new lifecycle-only
regressions. Full core passed 684 tests across 47 files. The workspace build passed for
seven projects, full check passed, and strict workspace API reports passed for six
published projects. No API reports changed. Logs are
`/private/tmp/event-view-final-core.log`, `/private/tmp/event-view-final-build.log`,
`/private/tmp/event-view-final-check.log`, and `/private/tmp/event-view-final-api.log`.
The final successor is being frozen for independent acceptance of that exact commit.
No remote actions occurred.
