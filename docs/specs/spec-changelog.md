# Spec Changelog

This file records clarifications, contradiction resolutions, and structural changes to the
Agent Monitors spec set in `docs/specs/`.

## Usage

- Add entries when ambiguity is resolved or the intended contract changes.
- Prefer short entries tied to the numbered doc affected.
- If implementation behavior and desired behavior differ, say so explicitly.

## 2026-07-22 — Transport-health review round 12: verdict wording corrected to workspace scope (005 §15) — Refs #425

The `doctor` verdict line said `delivery to THIS session → via {hook | channel | both | none}`, but
the computation it summarizes is workspace-wide — `doctor` has no per-session attribution, only the
transport registry and lead-session state for the whole workspace. A reader could take "THIS
session" literally and expect the verdict to reflect their own invoking session specifically, which
it never has. The verdict, its surrounding CLI-reference prose, and the getting-started skill doc now
say `delivery to active sessions in this workspace → via {hook | channel | both | none}`, matching
what the check actually answers. No logic, problem codes, or exit codes changed — wording only.

## 2026-07-21 — Transport-health review round 11: two-lead hook coverage test now drives real `hook deliver` (006 §12.3, 005 §15) — Refs #425

Round 10's positive two-covered-lead case still seeded both hook heartbeats with
`seedHeartbeat`, a hand-written JSON record keyed by the caller-supplied `hostSessionId` — it never
called `writeTransportHeartbeat` or invoked real `hook deliver`. That proves
`computeTransportHealth`'s aggregation logic (given two per-session records, coverage is complete),
but it cannot catch a regression in the WIRING the test exists to protect: if `hook deliver` stopped
forwarding `session_id` from its `UserPromptSubmit` stdin payload into `hostSessionId`, if
`heartbeatKey` regressed to per-workspace keying, or if `sanitizeKey`'s hash suffix collided for two
real session ids, every assertion in the hand-seeded case would stay green while the production path
silently broke. The test now opens both lead sessions and runs the real `agentmonitors hook deliver`
against each, with a `UserPromptSubmit` payload naming its own `hostSessionId` on stdin, then asserts
`doctor` reports full hook coverage and a deliverable, exit-0 verdict.

## 2026-07-21 — Transport-health review round 10: remaining stale per-workspace hook source comments, coverage-collapse test gap (006 §12.3, 005 §15) — Refs #425

Round 9's "two stale comments" claim was itself incomplete: it fixed the two TEST comments it named,
but three SOURCE comments describing the superseded per-workspace hook model were still present and
contradicted `heartbeatKey`'s per-session contract (006 §12.3) — `TransportHeartbeat.hostSessionId`'s
JSDoc said only `channel` is session-scoped, `heartbeatKey`'s own doc comment described hook as
"per-workspace... each invocation overwrites the last", and a `doctor.ts` comment referred to "the
per-workspace hook record". All three are reworded to describe the per-session record every active
lead now leaves. A fourth comment, in `transport-health.test.ts`'s cross-workspace matching test,
correctly stated hook has "no per-session identity of its own" for the OLD model but was never
updated when the storage keying changed; it now says hook records ARE per-session while
`selectHeartbeats` still matches candidates by same-workspace only (the two are independent facts,
and the test's assertions were already correct).

Separately, `transport-health.integration.test.ts`'s `seedHeartbeat` fixture wrote every hook record
to a literal `hook-workspace.json`, regardless of `hostSessionId` — so the suite could never seed two
active leads' hook heartbeats and have both survive; a wiring regression that collapsed real
`hook deliver` invocations back onto a single shared record would have left every test in the file
green. The fixture now keys hook records by host session id, matching the real registry, and a new
positive case seeds two active leads' hook heartbeats and asserts both survive with a fully
deliverable, exit-0 verdict.

## 2026-07-20 — Transport-health review round 9: remaining stale workspace-keyed hook comments in tests (006 §12.3, 005 §15) — Refs #425

Round 8's "Corrected throughout" claim for the stale workspace-keyed hook description missed two
comments: `transport-health.test.ts`'s "no ACTIVE lead recipient" `describe` block and
`transport-health.integration.test.ts`'s "closed session" test both still said `hook` records are
"keyed per WORKSPACE, not per session", contradicting `heartbeatKey`'s per-session contract (006
§12.3) that both tests otherwise correctly exercise. Reworded both to describe a per-session record
left by a now-closed session, matching the shipped behavior and the rest of round 8's corrections.

## 2026-07-20 — Transport-health review round 8: hook selection filtered to active leads, empty `claimedEventIds` is untrustworthy, stale docs/tests (006 §12.3/§12.7, 005 §15) — Refs #425

An eighth review round against the head that closed round 7 found one remaining false green, one
remaining unsafe remediation branch, and documentation/tests that had fallen behind round-6/7's
production fixes:

- **`hook` selection returned every same-workspace record, including closed/non-lead sessions'
  (blocker).** After the round-6-follow-up keyed `hook` per session, `selectHeartbeats` still
  returned every heartbeat matching the workspace rather than narrowing to active leads first, the
  way `channel` already did. A direct probe with one healthy active-lead record plus one
  closed-session record bound to an obsolete socket produced `socket-mismatch`,
  `hook.healthy: false`, `reach: 'none'`, and `deliverable: false` for a workspace where the only
  currently-open session was working fine. Selection now prefers records naming an ACTIVE lead,
  falling back to every same-workspace record only when none match — mirroring `channel`'s pattern
  — so an inactive session's record can no longer poison the active aggregate. See 006 §12.3.
- **An empty `claimedEventIds` array on a suppressing hold was accepted as "trustworthy but empty"
  (blocker).** `hasValidClaimedEventIds` only checked `Array.isArray` and element types, so `[]`
  passed and fell into the scoped-remediation branch, where an empty `ids` list renders
  `--event-ids` as omitted — silently falling back to the unscoped, blanket
  `agentmonitors events ack --session <id>` the round-6 fix exists to avoid.
  `classifyReminderHold` only ever returns an `already-claimed`/`coalesced-until-ack` hold when at
  least one event is claimed, so a real hold from this build always names at least one id; an empty
  array reaching `doctor` can only be malformed or hand-built and is now routed to
  `delivery-diagnosis-unavailable`, the same as a missing field. `settle-window`'s legitimate empty
  array never reaches this check — only the two suppressing reasons do. See 006 §12.7 / 005 §15.
- **Stale documentation and tests still described the superseded workspace-keyed hook model.**
  006 §12.3's selection description, 005 §15's `hook-lead-uncovered` table row, source JSDoc on
  `TransportProblemCode`/`computeTransportHealth`, and comments/test names in
  `transport-health.test.ts` and `transport-health.integration.test.ts` all still said hook records
  were "single" or "workspace-keyed", contradicting the per-session `heartbeatKey` behavior already
  shipped. Corrected throughout.
- **A stray comment still claimed `readTransportHeartbeats` performs opportunistic GC** in
  `isHeartbeatStale`'s future-timestamp branch, despite reads being deliberately pure since the
  round-7 write-path-only GC fix. Corrected to reference `reapExpiredHeartbeats`.
- **A test called the two-argument pre-fix `readTransportHeartbeats(now)` signature**, which no
  longer exists (reads take no arguments) — a TypeScript compile failure that would have prevented
  the whole suite from running. Fixed to call the current zero-argument signature.
- **The website skill guide and the original changeset text still named the unscoped
  `agentmonitors events ack --session <id>`** as the `reminders-suppressed` remediation, contradicting
  the scoped `--event-ids`/`--socket` command the round-6 fix and the changeset's own "Review fixes"
  section already document. Corrected both.

## 2026-07-20 — Transport-health review round 7: `claimedEventIds` is optional and its absence is never an ack-all fallback (006 §12.7, 005 §15) — Refs #425

A review pass against the round-6 head found two related defects in the reminders-suppressed
remediation, plus documented a hook-keying fix from a round-6 follow-up commit that had not yet
reached the specs:

- **`HookDeliveryHold.claimedEventIds` was required on the already-published `@agentmonitors/core`
  public type (blocker).** The round-6 work added it as a required field with no accompanying
  changeset. Worse, it didn't reflect reality: a `HookDeliveryDiagnosis` crosses the daemon IPC
  boundary, so it can arrive from a build that predates the field, serializing a hold with no
  `claimedEventIds` key at all despite the compile-time type. It is now optional, with a core
  changeset.
- **A hold with a missing/malformed `claimedEventIds` silently became an ack-all fallback (blocker).**
  `.flatMap((entry) => entry.hold.claimedEventIds)` contributed a literal `undefined` per such hold
  (flatMap keeps a non-array return value as one element rather than dropping it), and
  `Array.prototype.join` rendered that as an empty string — producing a malformed, blank
  `--event-ids  --socket ...` flag. That is worse than the documented "omit the flag" fallback for a
  genuinely empty `[]` (a valid, deliberate signal from `settle-window`), because it looks like a
  safe, scoped command while actually being broken. Such a session is now reported via
  `delivery-diagnosis-unavailable` instead — never folded into `reminders-suppressed`'s scoped
  command, and never a bare, unscoped `agentmonitors events ack --session <id>` either, which would
  reintroduce the exact blanket-acknowledgement defect round 6 fixed. See 006 §12.7 / 005 §15.
- **006 §12.3 still described `hook` as workspace-keyed and overwritten per prompt**, which a
  round-6 follow-up commit (keying both transports by host session id when known, to fix a
  permanent false RED where two active leads sharing one workspace-wide hook record could never
  both read as covered) had already made stale. Corrected to describe per-session keying for both
  transports, while keeping the (still-true) distinction that only `channel` does session-id-first,
  cross-workspace _matching_ — `hook` has no cross-workspace identity to misresolve, so its
  selection stays same-workspace-only and returns every matching record rather than one
  representative.

## 2026-07-20 — Transport-health review round 6: hook coverage, non-finite lease rejection, scoped ack remediation, stale GC docs (006 §12, 005 §15) — Refs #425

A sixth review round against the head that closed round 5, plus the write-only GC fix above, found
four more defects — three additional false greens/unsafe remediations, and one documentation
contradiction the GC fix itself introduced:

- **The every-active-lead-covered rule (round 5) only applied to `channel`, not `hook` (blocker).**
  Hook heartbeats already carry `hostSessionId`, but `computeTransportHealth` ignored it and treated
  one workspace-keyed hook record as valid evidence for every active lead. With active leads `a` and
  `b` and a hook heartbeat naming only `a`, the result read `deliveryWillReachThisSession: 'hook'` and
  `deliverable: true` for the whole workspace even though `b` had no hook invocation evidence at all —
  the same false-green shape the round-5 `channel-lead-uncovered` code fixed for channel, one
  transport over. Because `hook`'s single record is workspace-keyed (not session-keyed, by design —
  see 006 §12.3), "uncovered" here means "every active lead other than the one this one record
  names", not "no record at all". A symmetric `hook-lead-uncovered` problem code now reports every
  such uncovered lead, and disqualifies `hook` from being the listening method while any are
  uncovered (006 §12.4's problem-code list; 005 §15 `transport:hook` behavior).

- **A persisted `ttlMs` of `1e309` (which `JSON.parse` overflows to `Infinity`) was accepted as a
  valid lease (blocker).** `isTransportHeartbeat` only checked `typeof ttlMs === 'number'`, and
  `Infinity` passes that check. `isHeartbeatStale`'s `age > ttlMs` is then `false` forever, so the
  record never ages out and can never be reaped — the identical never-expires failure mode the
  future-`updatedAt` clamp (round 4) already hardens against, reached through a different field.
  `ttlMs` (and `pid`/`schemaVersion`) must now be finite; `ttlMs` must additionally be positive, since
  a zero or negative lease is not a lease at all.

- **The reminders-suppressed remediation was an unscoped, blanket acknowledgement (blocker).**
  `agentmonitors events ack --session <id>` with no `--event-ids` acks EVERY unread row for that
  session — including events the agent never claimed or even saw — and the remediation also omitted
  `--socket`, so it could target a different daemon than the one this `doctor` invocation actually
  diagnosed. `HookDeliveryDiagnosis`'s holds now carry the exact `claimedEventIds` responsible for the
  suppression (computed in `diagnoseHookDelivery` as unread-minus-pending), and the rendered
  remediation names those ids plus the resolved socket, so following the advice can never clear
  unrelated unseen work or target the wrong daemon.

- **The write-only GC fix left two contradicting "reaped on both read and write" paragraphs in the
  specs.** 005 §15 and 006 §12.2 each still described the OLD read-and-write reaping contract
  immediately alongside (006 §12.2, adjacent to) the new write-only rule, so the same head specified
  mutually exclusive semantics for whether `doctor` mutates state. Both paragraphs — and the stale
  `readTransportHeartbeats`/`doctor.ts` code comments describing an optional `now` parameter and
  read-side deletion that no longer exist — are corrected to state the write-only contract
  unambiguously.

## 2026-07-20 — Heartbeat GC is write-path only; `doctor` never mutates the registry (006 §12.2, 005 §15) — Refs #425

Opportunistic reaping ran on the READ path, so the health surface destroyed the evidence of the
failure it had just reported. Two consecutive `doctor` runs, with the active lead and daemon
unchanged and nothing recovered, disagreed: the first reported `[heartbeat-stale]` and exited 1; the
second found no record at all, took the "no transport has ever reported in" branch, and exited 0. A
dead channel server looked fixed purely because somebody had looked at it — and `doctor` was
mutating state, which 005 §15 explicitly says it never does.

Reaping now belongs solely to `writeTransportHeartbeat`: an expired record is removed when a
transport re-registers, which is the real reconciliation event, not when a bystander reads the
registry. `readTransportHeartbeats()` is a pure read. A lapsed transport keeps reporting its failure
on every health check until something actually writes again. Guarded by a three-consecutive-run
integration regression and a repeated-read unit test.

## 2026-07-20 — Transport-health review round 5: dormant sessions no longer read as live, every active lead must be covered, corrupt timestamps can no longer become representative, a stale sibling can no longer hide behind a healthy one (006 §12; 005 §15) — Refs #425

A fifth review round, against the exact head that closed round 4, found four more defects — all
either a false clean bill of health, or the opposite (an idle state wrongly reading as a live
failure):

- **`doctor` treated a DORMANT lead session as if it were still open (blocker).** `hasLeadSession`
  meant "any lead session ever registered for this workspace", not "is one currently active" — a
  session a prior `session close` had already marked `dormant` still counted. This let a closed
  session's leftover, in-TTL hook heartbeat cross the CLI boundary as live: `lead-session` read
  `pass`, the per-monitor rollup showed delivery counts instead of the `lead-session=none` marker,
  and the JSON `leadSession` field read `true` — even though `computeTransportHealth`'s own
  `leadHostSessionIds` (round 3) already correctly excluded it, so `deliveryWillReachThisSession`
  disagreed with every other field about whether a session was open. `gatherDeliveryDiagnoses` also
  asked the daemon to diagnose the dormant session's suppression state, for no live process to answer.
  Fixed by deriving the ACTIVE lead-session set exactly once in `doctorCommand` and threading it
  through every check, the delivery-diagnosis fetch, the per-monitor rollup, and the JSON shape —
  `gatherDeliveryDiagnoses` now takes that filtered list directly rather than the whole report. A
  closed session is therefore `idle`/exit 0 everywhere, matching the pre-existing "no lead session at
  all → idle" contract this doc already stated (§15 below), rather than the round-4 fix's `fail`/exit 1
  for this same case, which contradicted it.
- **Proving one active lead is covered is not proving all of them are (blocker; new problem code
  `channel-lead-uncovered`).** With two active leads and a channel heartbeat matching only one, the
  round-4 fix ("at least one active lead has a matching channel heartbeat") was satisfied and reported
  a clean, workspace-wide `deliverable: true` / `channel.healthy: true` verdict — silently hiding that
  the second active lead has no channel listener at all. Fixed by comparing the matched host-session
  ids against the FULL active-lead set and reporting every uncovered one under a new, transport-owned,
  blocking problem code, `channel-lead-uncovered`.
- **A stale sibling's problem did not exclude the channel from the listening method (blocker).**
  `deliveryWillReachThisSession`/`deliverable` were computed from a hand-maintained list of four
  problem codes that disqualify a transport from counting as "listening" — a list that omitted
  `heartbeat-stale` (and would have omitted `channel-lead-uncovered` above too). With a fresh,
  healthy channel record for one active lead and a stale one for another, the union of both records'
  problems already made `channel.healthy: false`, but the listening-method check still counted the
  channel, so `deliveryWillReachThisSession` read `channel` and the verdict ended in "(healthy)"
  regardless. Fixed by deriving "does this problem disqualify a transport from listening" from the
  same non-shared/non-advisory problem classification `healthy` already uses, instead of a
  separately-maintained code list that could (and did) drift out of sync.
- **Representative selection could pick a corrupt or future-timestamped record over a valid current
  one (blocker).** Round 4 ranked by problem count first, specifically so a broken sibling session
  would be shown as the representative record rather than being hidden by a healthy one. That ranking
  backfired on corruption: an unparseable `updatedAt` contributes its own `heartbeat-stale` problem,
  so "most problems wins" could make a CORRUPT record the representative even alongside a perfectly
  healthy, current one — reporting `running: false`/`reach: none` for a transport that is actually up.
  A far-future timestamp had the mirror bug on a tie: its raw `Date.parse` value reads as "freshest"
  even though `isHeartbeatStale` independently treats it as stale, letting it shadow a valid current
  listener. Fixed by separating representative selection (now freshness-first, with unparseable AND
  out-of-tolerance-future timestamps both sorting as oldest) from problem aggregation (unchanged: every
  matching record's problems are still unioned regardless of which one is chosen as representative), so
  a broken sibling's problems are never hidden either way.

## 2026-07-21 — Preserve BOTH object identity and the Interpret digest in a delivered event block; TAB is an escaped control character in `events list --format text` (002 §1.1.6/§1.1.8, 005 §11.1, 006 §4.2.1) — Refs #449

Round-10 review follow-up to the 2026-07-20 `#449` entry below. The `objectDetail` fix in that
entry closed the object-identity loss, but selecting `objectDetail` alone for the rendered detail
line silently dropped a successful Interpret digest entirely — `buildEventBlock` (006 §4.2.1) now
renders an ADDITIONAL digest line (`DeliveryEventSummary.summary`) whenever it says something the
title, body, and `objectDetail` line do not, so a named multi-object `prose` monitor's delivered
block carries both which object changed and what the digest said about it. The common
no-digest-produced case is unaffected: `summary` then degrades to the same deterministic chain as
`objectDetail`, so the two are equal and the digest line is suppressed to avoid duplication. 006
§4.2.1 and the `buildEventBlock` TSDoc are updated to state the three-way suppression explicitly.

**`events list --format text`'s control-safe transform now also escapes TAB (U+0009).** It is a C0
control character like the others this transform escapes, and left raw it can still shift the
visual column layout of a row; the prior fix (2026-07-20 entry below) omitted it from the escaped
set. 005 §11.1 is updated to state the control-safe transformation and the `summary === body`
non-suppression explicitly (it previously claimed exact parity with `buildEventBlock`'s detail-line
suppression, which stopped being accurate once the digest line above was added and was already
inaccurate before that: `events list --format text` never renders `event.body`, so it has no reason
to suppress on a `summary === body` match the way the rendered block does).

**Two additional generated-artifact/report fixes, no behavior change to a runtime contract:**
`diffKeyedCollection`'s additive sixth parameter (`displayScope`, 2026-07-20 entry below) is now
reflected in the checked-in `libs/core/api-report/core.api.md`; and `generateMonitorSchema`'s
editor/authoring JSON Schema now adds a `pattern: "\\S"` constraint on `name` so it stays in parity
with `monitorFrontmatterSchema`'s whitespace-only rejection (2026-07-20 entry below) — previously
`agentmonitors schema generate`/editor validation accepted a `name: "   "` the authoritative parser
rejected at runtime.

## 2026-07-20 — Object identity in a delivered event block must not be lost to an Interpret digest, and an authored monitor name must not be blank (002 §1.1.8, §5.4, 006 §4.2.1) — Refs #449

Round-9 review follow-up to the 2026-07-19 `#449` entry above. Three fixes:

**A digest is not an object identity.** `DeliveryEventSummary.summary` prefers the per-recipient
Interpret digest (G14, 002 §1.1.8) when one was produced; a digest is a prose reading of the
_change_, not necessarily a naming of _which object_ changed. `buildEventBlock` (006 §4.2.1) had
been reading `summary` for its per-object detail line — the same line #449 introduced specifically
so a named multi-object source could still name the object that moved — so a named multi-object
`prose` monitor's delivered block could silently carry no object identity at all once Interpret ran.
A new field, `DeliveryEventSummary.objectDetail`, carries the deterministic per-object text
(`MonitorEventRecord.summary`, never digest-replaced); the transport-shared block renders it instead
of `summary`. `summary`'s digest-preferring contract is unchanged (existing regression test still
asserts the digest lands there for `claimDelivery`).

**A whitespace-only authored name must not win the 002 §5.4 title-precedence race.**
`monitorFrontmatterSchema`'s `name` field previously rejected only the empty string (`.min(1)`),
which passes a value like `"   "` — non-empty, but blank. Because an authored `name` unconditionally
wins the title-precedence rule, a whitespace-only name silently displaced a source's real title with
a blank line, on both a persistent monitor's frontmatter and an ephemeral watch's `--display-name`
(its only naming affordance, 007 §4.6). Both authoring boundaries now reject a whitespace-only name
with an explicit, actionable error rather than accepting it silently.

**`events list --format text` did not control-safe-escape untrusted fields.** The format documents
one record per line, but `title`/`summary`/`monitorId` are source- or author-controlled text that can
carry a raw CR/LF (forging a second row) or a raw terminal escape sequence (reaching the terminal
unmodified). These fields are now passed through a single-line-safe transform before interpolation:
line-breaking characters (CR, LF, and the Unicode line/paragraph separators) collapse to a space, and
every other C0/C1 control character is escaped to a visible `\uXXXX` form.

Also fixed: the 006 §4.2.1 rendering-contract prose still said the detail line is "omitted only when
it repeats the title," which stopped being true once the body-equality suppression (also #449) was
added — it is now omitted for either match. A Markdown inline-code span illustrating the detail line
had also been split across a line break by prior wrapping, which renders incorrectly; it is now a
single line.

## 2026-07-20 — `OPERATION_TIMEOUT_PATTERN` now bounds each unit numerically, closing the last schema/parser `timeout` gap; `api-poll`'s composite `id`-length rejection no longer allocates (003 §4.1/§4.9) — Refs #304

Round-6 review follow-up. Two prior entries in this file (2026-07-19, "Composite cumulative byte
budget, `timeout` non-string/leading-zero/overflow validation" and "`api-poll` bounds request
duration...") describe the schema/parser gap this entry closes as "deliberate" and "documented" —
that framing was wrong: an author-visible authoring/runtime split (`agentmonitors validate` accepts
`timeout: "25d"`, `source.observe` then rejects it) is a parity bug regardless of how clearly it is
documented, not an acceptable design point. `OPERATION_TIMEOUT_PATTERN` previously used a raw
`[1-9]\d*` digit run per unit — a pure string grammar that could not express
`parseOperationTimeoutMs`'s `MAX_OPERATION_TIMEOUT_MS` numeric ceiling. The pattern is now built
from `Math.floor(MAX_OPERATION_TIMEOUT_MS / <unit's ms-per-unit>)` per unit (`2147483`s, `35791`m,
`596`h, `24`d) via a standard digit-range-to-regex construction, so the schema and the parser reject
exactly the same set of `timeout` values — `"25d"` now fails `agentmonitors validate` too, at
authoring time, instead of only at runtime. 003 §4.1 and §4.9 no longer cite the pattern's old
literal regex text (`^[1-9]\d*[smhd]$`), which is stale now that the pattern is unit-specific and
numerically bounded; they instead name `OPERATION_TIMEOUT_PATTERN` and state its derivation. See
`libs/core/src/notify/notifier.test.ts` for the per-unit boundary coverage (exact maximum accepted,
one more rejected, for all four units) and
`plugins/source-command-poll/src/schema-parity.test.ts` for the closed-gap parity case.

Separately, `plugins/source-api-poll/src/composite.ts`'s `MAX_PART_ID_LENGTH` check (added in the
2026-07-19 "Composite part-count/part-`id` caps" entry below) counted a part `id`'s Unicode code
points via `Array.from(id).length`, which materializes one array element per code point BEFORE the
length is even read — an 11 MiB `id` (the round-3 reviewer's own repro for _why_ the cap exists)
still allocated roughly its own size in memory just to be rejected, undermining the cap's own
purpose. It now counts via a plain `for...of` loop that returns as soon as the running count exceeds
`MAX_PART_ID_LENGTH`, making rejection O(`MAX_PART_ID_LENGTH`) instead of O(`id.length`).

The four `@agentmonitors/source-api-poll` Changesets accumulated across this issue's review rounds
(request/response bounds, composite byte budget, composite part/id bounds, and review-fix
follow-ups) are also consolidated into one, reclassified `minor` — the new `timeout` scope field is
additive authoring surface, matching this repository's precedent for the earlier `api-poll`
composite option.

## 2026-07-19 — `daemon run --detach`'s log `fchmod` is a fail-closed exception to the §3.1 warn-and-continue rule, not an oversight (002 §3.1) — Refs #389

Round-7 review follow-up. `openLogFd`'s final `fchmodSync` on the opened log descriptor already
closed the descriptor and threw an actionable error when `fchmod` failed (e.g. `EPERM` because a
pre-existing `--log` file is owned by another user). The review correctly flagged that this reads
as contradicting §3.1's general "degrade gracefully where the artifact is not ours" rule — warn
once to stderr and continue on `EPERM`/`EACCES` — which was written for artifacts the daemon merely
tightens incidentally to a write that happens regardless (hook-state files, the database, sockets,
directories).

That general rule was never meant to cover this case, and the spec did not say so explicitly. The
`--detach` log is different in kind: whether it can be made owner-only gates whether the daemon
starts logging at all, and once started the log accumulates workspace paths and monitor-failure
details for the process's lifetime. Continuing to write those into a file the daemon cannot secure
to `0600` would be strictly worse than refusing to start — it is the one artifact in this section
where the mode check is the whole point of the operation, not incidental to it. §3.1 now states
this fail-closed behavior as its own bullet, and calls out the exception explicitly from the
warn-and-continue bullet so the two are not read as contradictory.
`apps/cli/src/open-log-fd-fail-closed.test.ts` adds a regression asserting the fail-closed outcome
(descriptor closed, spawn refused) by forcing `fchmodSync` to throw.

## 2026-07-19 — `daemon run --detach`'s `--log` parent-directory tightening is default-location-only, and its log file fails closed against a symlinked path (002 §3.1) — Refs #389

Round-5/round-6 review follow-up to the entry directly below, which said every log parent "now
uses `ensurePrivateDir`" and "a permissive pre-existing directory is tightened" unconditionally.
That was true only for the default (Agent-Monitors-owned) location; a custom `--log` path's parent
may be a directory the user owns for other reasons (a repo checkout, a shared logs directory), and
unconditionally chmod-ing it to `0700` silently stripped group/other access — a functional
regression, not a hardening. `openLogFd` now takes an `isDefaultLocation` flag: a _missing_ parent
is always created `0700` (there is no pre-existing mode to preserve either way), but an _existing_
parent is tightened only at the default location; a pre-existing custom parent is left exactly as
found, mirroring the existing `--socket`-directory precedent.

Separately, `restrictExistingPathMode` correctly no-ops on a symlinked log path (refusing to
tighten or follow it), but the subsequent `openSync(logPath, 'a')` still followed the symlink,
appending the daemon's stdout/stderr into whatever it pointed at without ever securing that
target's mode — defeating the owner-only file invariant this section otherwise guarantees. The
final open now uses `O_NOFOLLOW` (failing with `ELOOP`, reported as a clean spawn error, when the
last path component is a symlink) and `fchmod`s the resulting descriptor rather than the path, so a
planted symlink at the log path can no longer redirect the daemon's output onto an unintended
target.

## 2026-07-19 — `daemon run --detach`'s log/parent-dir creation is owner-only from birth, and its ready-timeout report now states whether cleanup succeeded (002 §3.1, 005 §9.2) — Refs #389

Round-4 review follow-up, two independent findings.

**Log/dir creation followed the process umask.** `openLogFd` used a plain `mkdirSync`/`openSync`
for `--log`'s parent directory and file. Under a common `umask 022` this created the parent `0755`
and the log `0644` — readable by every other local user — for a file that carries the daemon's
stdout/stderr (workspace paths, socket paths, monitor failure messages). It now uses
`ensurePrivateDir` (the same AgentMon-owned-directory helper every other runtime-data directory
uses) for the parent, `restrictExistingPathMode` to tighten a pre-existing log file before appending
to it, and `PRIVATE_FILE_MODE` (`0600`) on open — so the file is owner-only from birth regardless of
umask, and a permissive artifact left by an earlier version is migrated forward on the next boot,
matching the rest of 002 §3.1's local-data permission model.

**The ready-timeout/spawn-error branch discarded `terminateSpawnedDetachedDaemon`'s result.** 005
§9.2 item 5 already promises "the error message states whether the cleanup succeeded" — the
unproven-identity branch (the prior 2026-07-19 entry above) honors that, but the ready-timeout/
spawn-error branch `await`ed the same cleanup call and dropped its return value, so its own report
could never say whether the spawned child was actually confirmed gone. Both non-success `--detach`
branches now share one formatter (`describeSpawnedCleanupOutcome`) so the wording — and its cleanup
-succeeded/cleanup-FAILED unit coverage — cannot drift between them again.

## 2026-07-19 — `daemon run --detach` never reports a failure while leaving its child running (005 §9.2) — Refs #389

Review follow-up. `--detach`'s unproven-identity branch reported failure and returned **without
terminating the child it had spawned**. If our child was in fact the daemon that successfully bound
the socket but `daemon status` never proved it (persistent status errors, or no pid reported), the
command told the user it was not started, exited non-zero, and left an unowned daemon serving —
indefinitely under `--reap-after-ms 0` — so the retry its own error message suggested then collided
with the process that invocation orphaned.

Every non-success `--detach` outcome (readiness timeout, spawn error, race loss, unproven identity)
now terminates the spawned process and **confirms it is gone** — `SIGTERM`, escalating to `SIGKILL`
if it has not exited within a short grace window — before returning, and the error message states
whether that cleanup succeeded. Only the pid THIS invocation spawned is ever signalled: a daemon
proven to be serving under a different pid belongs to a concurrent lazy boot and is left untouched.

## 2026-07-19 — Manual-CLI ergonomics: `daemon run --detach`, an always-on no-socket diagnostic on `hook deliver`, and `events` help that names the required `--session` (005 §3, §9.2, §11.1, §12.2/§12.2.1) — Refs #389

Three independent papercuts on the "drive the CLI directly, no plugin" path, all surfaced by a blind
usability evaluation. None blocks success alone; together they cost a first-time manual user a
"is this broken?" moment each.

**P1 — `daemon run` gained `--detach` (005 §9.2, §3).** `init` tells manual users to "start the
daemon yourself: `agentmonitors daemon run`", which then blocks their terminal — leaving `& disown`
and log redirection to be discovered. The issue allowed either a real flag or documenting the shell
idiom; the flag is what shipped, because the daemon already has a supported detached-spawn path
(`spawnDetachedDaemon()`, used by the hook-driven lazy boot) and reusing it keeps one background
daemon story instead of two. `--detach` re-invokes `daemon run` (without `--detach`) as a detached
`unref`'d child with every value resolved by the parent and passed explicitly, appends the child's
output to `--log` (default `<workspace data dir>/daemon.log`), waits up to 15s for the socket to
answer, and prints the pid/socket/log. It composes with `--reap-after-ms 0` — the supported way to
keep a daemon alive while no agent session is open — and reports "reaping disabled" for that pair.
The already-running guard runs before anything is backgrounded. `init`'s next-steps line now names
the `--detach` form. This is deliberately **additive** and independent of the open question in #435
about whether a channel-attached session should count as reaper activity; it changes no reaping rule.

**P2 — `hook deliver` warns on stderr when no per-workspace socket is configured (005 §12.2 step 3,
§12.2.1).** That branch previously returned empty stdout + exit 0 with the explanation gated behind
`--debug`, making it indistinguishable from "nothing pending" — a state that never self-resolves.
It joins the always-on stderr diagnostics (now four, not three). A workspace that is **not enabled**
remains silent on both streams: that is an opt-out, not a misconfiguration. `hook deliver`'s stdout
stays byte-identical in every mode (the hook wire contract, 006 §5.1) — an explicit non-goal to change.

**P3 — `events list`/`events ack` summaries name the required `--session` (005 §11.1).** `events
--help` renders only the summary line per subcommand, so the requirement was discoverable only by
running the command and reading commander's `required option '--session <id>' not specified`. Both
summaries now say `(requires --session <id>)`. `--session` remains **required** on both — a non-goal
to relax; only the documentation changed.

## 2026-07-19 — `daemon run --detach` verifies the daemon it spawned actually won the socket, kills an unmanaged child on timeout, `--log` requires `--detach`, and the no-socket warning gets a boot-failed variant (005 §9.2, §9.3, §12.2/§12.2.1) — Refs #389

PR review follow-ups on the `--detach`/no-socket-diagnostic work above.

**Finding 1 — identity check on `--detach` success.** The readiness wait only proved SOME daemon
answers on the socket, not that it is the child THIS invocation spawned: concurrent lazy-boot
elsewhere (`session start`'s check-then-spawn has no cross-process pre-spawn lock; only the
bind-time startup lock serializes) can make the spawned child lose the race and exit while a
different daemon answers. `daemon status`'s response (005 §9.3) now carries `pid` and `reapAfterMs`
— additive fields, CLI-layer only (not a core `RuntimeStatus` change) — so `--detach` can compare the
serving pid against its own spawned pid and, on a mismatch, report the OTHER daemon's actual pid and
reap setting instead of assuming success.

**Finding 2 — ready-timeout no longer leaves the child unmanaged.** On a genuine readiness timeout
the spawned child (whose pid is now known) is sent `SIGTERM` before the command exits, and a
synchronous spawn failure (`ENOENT`/`EACCES`) is now raced against the readiness poll and reported
immediately with the real cause, rather than waiting out the full 15s and pointing at a log file the
daemon never got the chance to write.

**Finding 3 — `--log` without `--detach` now errors.** It was previously accepted and silently
ignored outside the detach branch — the same "silently ignored flag" papercut class the parent
change exists to close.

**Finding 4 — the `--reap-after-ms 0` persistence test was tautological.** It asserted survival at
2,500ms, but the boot-grace window is 10,000ms — every freshly booted daemon survives 2.5s
regardless of whether the flag ever reached it. Fixed by asserting the CONFIGURATION directly via
`daemon status`'s new `reapAfterMs` field (finding 1's addition) instead of a timing window.

**Finding 6 — the no-socket warning's "manual path only" framing was incomplete (005 §12.2.1).** A
`session start` lazy boot that times out mid-session leaves the workspace enabled with no socket
persisted — the SAME shape as a workspace that has never had a session start at all, and reachable
from the automated path, not just manual invocation. `.local.md` gained a `lastBootFailureAt` marker
(written on boot-timeout, cleared on the next successful boot) so `hook deliver` can tell the two
apart and give each an accurate remediation — the never-configured message is unchanged; the
boot-failed variant leads with automatic retry rather than "run daemon run --detach yourself."

**Finding 7 — the spawn-then-poll readiness loop had three near-identical copies.** `daemon run
--detach`, `session start`'s lazy boot, and `verify --use-workspace-daemon` each hand-rolled the same
poll-until-`daemonAvailable` loop with slightly different timeout/poll constants. Extracted into one
`waitForDaemonAvailable(socketPath, timeoutMs, pollMs?)` next to `daemonAvailable`
(`daemon-ipc.ts`); each call site keeps its own pre-existing timeout/poll values — no behavior change.

Finding 5 (test teardown pid fallback) is test-infrastructure-only, no spec change.

## 2026-07-20 — PR-alerting presets are disjoint by construction, so enabling both is not an interrupt multiplier (003 §11.9) — Refs #444, #441

Shipping two presets a user may enable together risked reproducing #441's measured
interrupt-multiplier by construction. Measured directly with both presets' `--jq` run over the same
raw PR set: `pr-review` held `[1, 2]` while `my-prs` held `[2, 3, 4]` — PR 2 (red CI, undecided,
non-draft) was claimed by **both**, so every transition on it would deliver two alerts.

The server-side `--search` scope does not fix this in general. It does under the default
(`review-requested:@me` cannot match a PR you authored, since GitHub forbids requesting review from
yourself), but not under the label-driven model — which is exactly the model required when author and
reviewer share an identity, the case this whole workflow runs in.

`pr-review` now **excludes PRs with failing checks**, which makes the two memberships partition by
readiness under every scoping model: a red PR is not review-ready, it belongs to its author, and
`my-prs` already classifies it `ci-failing`. Re-measured after the change: `[1]` versus `[2, 3, 4]`,
disjoint. A test asserts every plausible PR state lands in at most one payload and fails if the
exclusion is removed.

Residual, by nature rather than defect: a PR merging leaves `pr-review` and enters `my-prs` as
`merged`. Under the default scope those are different PRs. Under a same-identity scope it is one
benign removal plus one actionable entry for the same merge — one dismissible fire, not a multiplier.
Delivery-layer cross-monitor coalescing (#441) is complementary; per #441's own guidance the
authoring-level fix is preferred and is what this does.

## 2026-07-19 — PR-alerting presets: selectable reviewer scoping, a review-revision signal, and time-bounded terminal states (003 §11.9, 005 §2) — Refs #444

Three review findings, each of which defeated one of the goals the presets exist to serve.

**1. The reviewer preset was not scoped to a reviewer.** It returned every open, non-draft,
non-release PR — including the user's own — so it alerted on work the reviewer did not own, and
unrelated rows could consume the 30-row window and hide a real request. Reviewer scoping is
**workflow-dependent**, so the fix is a documented default (`--search 'review-requested:@me'`, the
semantically exact reading, which also covers team-assigned requests) plus `-author:@me`,
`label:needs-review`, and unscoped scaffolded as ready-to-edit alternatives. Measured against this
repository: unscoped returns 6 open PRs, `review-requested:@me` returns 0, and no open PR carries a
requested reviewer — PRs are authored and reviewed under one identity, and GitHub does not permit
requesting review from yourself, which also makes `-author:@me` empty here. Hardcoding any single
filter would take the preset from "too many PRs" to "zero PRs, ever" for some workflow. The empty
case is **silent** — indistinguishable from "nothing needs review" — so the scaffolded body names it
and gives the exact command to check; a `validate`/`monitor test` warning on a zero-row first run
needs support in those commands and is recorded as the follow-up rather than claimed.

**2. Repeat feedback from the same reviewer was invisible.** Reducing each latest review to
`{by, state}` meant a second `CHANGES_REQUESTED` from the same reviewer left `reviewDecision`, the
reduced array, and `commentCount` all unchanged — so `json-diff` emitted nothing even though new
blocking feedback had landed, breaking the single most important author-side trigger. Reviews now
carry `at` (`submittedAt`), which is fixed at submission and therefore a revision signal that cannot
churn between polls, and are sorted by `(by, at, state)` so ordering cannot flap the diff.

**3. Terminal states are now time-bounded to 6h** after `mergedAt`/`closedAt`, rather than lingering
until they fall out of `--limit`. Unbounded, every new merge evicted an older terminal row from the
window and emitted a spurious removal diff — a spurious interrupt at `high` urgency. Time-bounding
makes each terminal PR produce exactly one entry and one predictable drop-off, independent of
`--limit`. The bound reads `mergedAt`/`closedAt`, never `updatedAt`, so post-merge activity cannot
extend it, and **no timestamp is emitted into the payload**: a timestamp in the diffed output changes
on essentially every poll and fires continuously. `fromdateiso8601` errors outright on fractional
seconds, so the query strips them and treats an unparseable timestamp as current (fail-open — a stale
row beats a missed merge alert).

Separately: the presets set an explicit `key:`, which is what keeps the delivered event title short
(`Command output changed: my-prs`) instead of the joined argv — a `command-poll` monitor that omits
`key:` gets its entire `gh` command and `--jq` program as the alert headline. Making the title use the
monitor's authored `name` is a source-level change affecting every `command-poll` monitor and is
tracked as issue #449, not done here; a regression guard keeps the presets from drifting back to the
raw-argv title.

## 2026-07-19 — PR-alerting presets become actionable-only membership sets at `high` urgency (003 §11.9, 005 §2) — Refs #444

Field testing a dogfooded author-side monitor overturned the `normal`-urgency choice recorded below.
Detection worked — three `monitor_events` materialized — but delivery was **suppressed on all four
lead sessions**, so the author was never told CI had failed. Two independent mechanisms cause this:

1. **Normal reminders are coalesced-until-acknowledgment** (002 §9.2). The implemented guard is
   `normalPending.length === unreadNormal.length`: every unread normal event must be unclaimed, so a
   single claimed-but-unacked normal event from **any** monitor suppresses the reminder for **all** of
   them. In an active session that is nearly always true, making a `normal` PR monitor structurally
   unreliable exactly when its audience has been working.
2. **Normal carries no event body mid-session** (002 §9.2/§9.3). Normal and low deliver a generic
   reminder with an empty `events` array; bodies arrive only at recap.

`high` is only safe if the payload cannot fire on non-events, so both presets now emit a **membership
set of actionable items** rather than full state. `my-prs` reduces each PR to a `needs` verdict
(`ci-failing`, `changes-requested`, `draft`, `merged`, `closed`) and drops it entirely when `none`;
`pr-review` admits only undecided, non-draft, non-release PRs authored by someone else. A green,
non-draft, undecided PR is absent, so an ordinary CI run produces no event. Encoding draft as
_membership_ rather than as a diffed `isDraft` field is what keeps both directions of draft↔ready
firing.

**Generalized rule:** `high` is defensible for a `json-diff` monitor when the payload is filtered so
that every _entering_ transition is actionable. `json-diff` is symmetric, so entries _leaving_ the set
(CI recovering, a review answered, a draft marked ready, a terminal PR aging out) also fire; the goal
is to bound those to one per resolved item, not to zero, and to name them in the monitor body so they
are cheap to dismiss. The presets no longer claim every fire is actionable.

**This reverses the `--state open` decision recorded in the entry below.** That change fixed a real
window-eviction risk, but it also collapsed `MERGED` and `CLOSED` into an indistinguishable
disappearance — and "merged, clean up the branch" versus "closed unmerged, find out why" are
different instructions the acceptance criteria require distinguishing. `--state all --limit 60`
restores nameable terminal states while addressing the eviction concern by widening the window
(measured ~3.5s per poll against a real repository; terminal PRs held 15 of 20 slots at `--limit 20`,
which is what motivated the widening). The residual risk — a still-open PR older than 60 newer PRs
aging out of the query — is documented in 003 §11.9 rather than silently accepted.

Note also that 002 §9.2's prose claims the coalesced reminder re-fires when "a fresh unclaimed normal
event arrives". The implemented guard does not do that: a fresh unclaimed event makes the two counts
unequal, keeping the reminder suppressed. The field observation matches the code, not the prose. That
inaccuracy is tracked separately and is not corrected here.

## 2026-07-19 — PR-alerting presets: correct the `cwd` claim, exclude own PRs, fix the recency window, GITHUB_TOKEN, stderr, and curated names (003 §11.9, 005 §2) — Refs #444

Review of the presets added below (same date, same issue) surfaced eight defects, all fixed here:

1. **`cwd` claim was wrong.** `command-poll`'s effective `cwd` defaults to the **daemon's own** process
   working directory, never a "workspace/config root" — the daemon could be launched from anywhere. The
   original text (and `init.ts`'s comment, and this PR's changeset) all said otherwise. Fixed by having
   `init` scaffold an explicit, absolute `cwd:` (the project root `init` was run from) into both
   presets, and correcting every doc/comment that repeated the wrong claim. See the corrected item 1 of
   the entry directly below.
2. **`GITHUB_TOKEN` precedence.** `gh` gives an inherited `GITHUB_TOKEN` unconditional precedence over
   keyring/`gh auth login` credentials, so a daemon environment with one exported would silently
   resolve `@me` against the wrong identity. The generated wrapper now runs `gh` via `env -u
GITHUB_TOKEN`.
3. **`pr-review` included the user's own PRs.** Added `--search '-author:@me'` (GitHub search-qualifier
   negation — `gh pr list` has no `--author`-exclusion flag) so a PR the reviewer opens themselves no
   longer double-fires against both presets.
4. **`my-prs`'s sliding window could silently drop an open PR.** `--state all --limit 10` lets an older
   still-open PR age out once enough newer PRs (including merged/closed ones) exist; once evicted, its
   CI going red produced no event. Changed to `--state open --limit 30`: only actually-open PRs compete
   for the cap, and leaving the open set (merge or close) now surfaces as a removal, same as
   `pr-review`. Trade-off: `state` can no longer read `MERGED`/`CLOSED` from real `gh` output (it is
   still carried for shape symmetry), so the body now says to check the PR directly to tell which.
5. **`2>&1` on the success path could pollute the diffed JSON.** A one-time `gh` warning would have
   merged into stdout and degraded `json-diff` to a raw-text comparison. The wrapper now redirects
   stderr to a per-invocation temp file only consulted on the failure branch.
6. **The named scaffold path clobbered curated preset names.** `init pr-review --type pr-review`
   derived `name: Pr review` from the positional, overwriting the template's own `name: PRs awaiting my
review`. The derived-name seed is now skipped for preset types (`--name` still overrides), and
   005 §2's "re-type the name" workaround text is removed since it's no longer needed.
7. **The interactive prompt modeled presets as source types**, contradicting 005 §2's own "not source
   types" claim. The prompt and its error now list source types and presets as separate categories.
8. **`--urgency` seeding could contradict the rationale comment above it.** Seeding a different urgency
   left the preset-specific "why this value" comment attached to the wrong value. `seedUrgency` now
   swaps in a generalized comment when the seeded value differs, mirroring `seedCommand`'s existing
   #388 pattern.

Test coverage added: an end-to-end scaffold-then-parse test for both presets (with and without
`--urgency`), a CI-only failure (not skip) when the jq suite's `jq` binary is missing, and cleanup of
the test file's temp directories and a dead `MONITOR.md` write that nothing ever read.

## 2026-07-19 — Repo-scoped PR-alerting presets: `init --type pr-review` and `--type my-prs` (003 §11.9, 005 §2) — Refs #444

Added two ready-made `command-poll` presets to `init --type`, one per pull-request role: `pr-review`
(reviewer — open, non-draft PRs awaiting review, excluding `changeset-release/*` heads) and `my-prs`
(author — CI, review feedback, and state changes on the current `gh` user's own PRs). Both are new
`TEMPLATES` entries only; no source, schema, or runtime behavior changed.

Three contract points are now specified rather than left to the author of each hand-written monitor:

1. **Repository auto-scoping is achieved by omission of `--repo`, plus an explicit scaffolded `cwd:`.**
   `gh` resolves the repository from its working directory, and `command-poll`'s effective `cwd`
   defaults to the **daemon's own** process working directory (003 §11.1) — not a "workspace/config
   root", which an earlier draft of this entry, `init.ts`'s own comment, 003 §11.9, 005 §2, and this
   PR's changeset all incorrectly claimed (corrected below, 2026-07-19). `init` scaffolds an explicit,
   absolute `cwd:` (the project root it was run from) into both presets specifically to fix that: it is
   what then lets omitting `--repo` scope `gh` correctly, regardless of where the daemon is later
   launched from. Interpolating an owner/name at scaffold time is explicitly rejected — it would
   hardcode what `cwd:` makes portable. `--author @me` applies the same auto-scoping rule to identity.
2. **Which fields are diffed is the real product decision.** `json-diff` fires on any semantic change
   to stdout, so the `--jq` reduction decides what becomes an interrupt. `my-prs` reduces
   `statusCheckRollup` to only the _failing_ check names, which is what makes green→red fire while
   the queued/in-progress churn of a normal CI run stays silent; diffing the rollup whole would
   interrupt once per check, per push.
3. **A broken `gh` is a loud failure, not a silent baseline.** 003 §11.2/§11.5 classify a nonzero exit
   _with output_ as a normal result, so a preset that merely `exit 1`-ed on `gh` failure would record
   the error text as its first baseline and never fire again. Both presets instead terminate by
   signal (`kill -TERM $$`) after writing a remedy to stderr, which §11.5 classifies as an execution
   failure: `Command failing: <key>` is emitted on the very first tick, the remedy travels in
   `stderrTail`, any prior baseline is preserved, the alert is edge-triggered, and recovery emits
   `Command recovered: <key>`.

Both presets are `normal` urgency, and the `my-prs` case establishes a general rule (002 §9, 003
§11.9). The intuitive call is `high` — a stalled PR of one's own is interrupt-worthy — but
`json-diff` is **symmetric**: a PR leaving an actionable state diffs exactly as much as one entering
it, so CI recovering red→green, a PR merging, and one's own new PR appearing all fire too. Filtering
the payload down to only actionable PRs does not fix this; it relocates the benign fire from "a field
changed" to "an entry was removed", which the diff reports identically. Since no payload design makes
every fire actionable, `high` would interrupt mid-turn on good news (#441). Generalized: **`high` is
only defensible for a `json-diff` monitor when the watched value cannot transition back to a benign
state**, because at the diff layer recovery is indistinguishable from breakage.

Two field traps are recorded rather than left for the next author to rediscover. `reviewDecision` is
the empty string, not `null`, when there is no decision, so a `// "NONE"` coalesce is a silent no-op.
And `--limit` makes the query a recency window, not a set: an old PR aging out produces a removal
diff that is not a transition, which the monitor body calls out explicitly.

Collapsing `statusCheckRollup` to a single `PASSING`/`PENDING`/`FAILING` verdict was considered and
rejected: it is quieter than the raw array but reintroduces the churn one level up, firing twice on
every ordinary push (`PASSING → PENDING → PASSING`) even when CI never breaks. Reducing to failing
check _names_ stays silent across that whole cycle — asserted directly — and names the failing check
in the delivered event.

Known limitation, recorded rather than worked around: `gh pr list` exposes no review-thread data, so
inline review comments that do not move `reviewDecision` are invisible to `my-prs`. A first-class
`source-github-pr` plugin modelling PR transitions semantically remains the north star and would
close that gap; these presets deliver the capability without it.

## 2026-07-19 — Transport-health review fixes round 4: future-timestamp staleness, symlink-safe writes, delivery-diagnosis-unavailable (006 §12; 005 §15) — Refs #425

A further round of review on the delivery-transport health surface found three defects, two of which
change verdict semantics:

- **A future `updatedAt` used to read as fresh forever (blocker).** `isHeartbeatStale` computed
  `now - updatedAt > ttlMs`; a record whose `updatedAt` is ahead of `now` (clock skew, or a corrupt or
  forged record) makes that difference negative, which is never `> ttlMs`. Such a record would never
  age out — blocking the opportunistic GC introduced in the prior round, and letting `doctor` report a
  dead or bogus transport as `running` indefinitely. Fixed by treating any `updatedAt` more than a
  small clock-skew tolerance ahead of `now` as stale, the same conservative direction already used for
  an unparseable timestamp.
- **The heartbeat write followed a pre-planted symlink at its temp path.** The write used a plain
  `writeFileSync` to a deterministic sibling temp path (`<target>.<pid>.tmp`) before renaming it into
  place. Because the registry directory predates the 0700-owner-only migration in some installs, a
  symlink planted there while it was still permissive would be followed, letting a routine heartbeat
  refresh overwrite an arbitrary file the symlink points at. Fixed by mirroring
  `writePrivateFileAtomic` (000, local-permissions.ts): remove whatever sits at the temp path first,
  then (re)create it with `O_EXCL`, which refuses to follow a symlink planted between the two calls.
- **A failed delivery-diagnosis call read as "checked, nothing suppressed" (blocker; new problem
  code).** `doctor` asks the daemon's `hook.diagnose` RPC, per lead session, whether reminders are
  currently suppressed. A thrown call (an older daemon rejecting it as unsupported, or a connection
  error) was silently dropped, leaving the diagnosis set indistinguishable from a clean "not
  suppressed" answer — so `deliverable` could read `true` even though the check never actually ran. A
  new problem code, `delivery-diagnosis-unavailable`, makes the distinction explicit and, unlike the
  existing advisory codes, is blocking: `deliverable` can never be `true` while it is present.

## 2026-07-19 — Transport-health review fixes: registry GC, lead-session gating, non-blocking version-skew (006 §12; 005 §15) — Refs #425

Review of the initial delivery-transport health surface (below) found several defects that made the
surface report `fail` for a workspace with nothing genuinely broken, or blame the wrong side of a
failure:

- **Registry GC + lead-session gating (blocker).** Records were removed only on clean shutdown, so an
  uncleanly-killed transport's heartbeat sat on disk forever, past its own TTL — and the
  `transport:<name>` check applied the "no lead session → skip/idle" discipline only to a transport
  that had never reported in, not to one whose stale heartbeat was found on this scan. One
  uncleanly-killed channel server therefore failed every future `doctor` run in that workspace
  permanently, including with no session open, contradicting §15's own "no lead session → both
  transport checks are idle" text. Fixed by reaping expired-past-TTL records opportunistically on both
  read and write, and by extending the lead-session gate to the configured-transport branch too.
- **Hook `lastDeliveryAt` erased on the next empty prompt (blocker).** Hook heartbeat writes were
  whole-record overwrites; the first per-invocation write (before delivery is known) omitted
  `lastDeliveryAt`, silently resetting it to `never` on any subsequent prompt with nothing pending.
  Fixed by making the write read-modify-write on that one field, and by recording it only when
  `flow.output` was actually non-null (written to the host), not on every reservation that merely
  committed.
- **`version-skew` made informational, not blocking.** It made `doctor` exit non-zero for up to the
  hook's 24h TTL after every single CLI upgrade — the hook heartbeat legitimately carries the
  pre-upgrade version until the next prompt — directly contradicting its own "No action needed"
  remediation. Now behaves like `channel-registration-unverified`: reported, never blocking.
- **Registry key collisions.** The sanitized heartbeat key collapsed distinct raw ids to the same
  filename (`run:1`/`run_1`, or two ids differing only past the 96-char truncation point). Fixed by
  appending a short hash of the raw id.
- **Channel heartbeat coupled to poll completion.** Refreshing only after the reserve/commit/release
  IPC settled let a daemon wedged past the channel's TTL blame the transport for the daemon's outage.
  Fixed with an independent refresh timer.
- **Session-id-first matching wrongly applied to `hook`.** Only `channel` (one long-lived process per
  host session) should match by session id across workspaces; `hook` (a fresh per-prompt process with
  no per-session identity, keyed per workspace) now matches by workspace only.
- **Idle transport checks now always carry a remediation**, in both text and `--json`.
- Cleanup: the XDG data-root and workspace-hash derivations, previously duplicated across
  `workspace-paths.ts`, `transport-heartbeat.ts`, and `daemon-ipc.ts`, now have one canonical source
  (`workspace-paths.ts`); `getCliVersion()` is memoized; `computeTransportHealth`'s `HOME`/data-root
  comparison now takes `expectedHome`/`expectedDataRoot` as input instead of reading them live,
  restoring the purity its own doc comment already claimed.

## 2026-07-19 — Transport-health review round 4: multi-session channel selection, NaN-safe ordering, documented `pipelineProblems` (005 §15) — Refs #425

Three ways the surface could still have issued a **false clean bill of health**, all closed:

- **A broken session hidden behind a healthy sibling.** The channel entry was derived from the
  freshest matching heartbeat alone. With two registered leads — one healthy channel, one bound to
  the wrong workspace — that reported delivery as healthy while a live session silently received
  nothing. It now evaluates EVERY heartbeat matching an active lead, unions their problems (each
  prefixed with the host session id, since "the channel is misbound" is unactionable without saying
  which session), and picks as representative the record with the MOST problems, ties broken by
  freshness.
- **A channel adopted from someone else's session.** A channel matching no active lead session was
  falling back to any same-workspace record and being reported as this session's healthy, deliverable
  transport — including when the workspace had no lead sessions at all. Such a record is still
  _shown_ (a reader diagnosing silence needs to know a server is running) but now carries
  `channel-session-unmatched` and can never count toward `deliveryWillReachThisSession`. The
  workspace fallback remains correct for the session-less hook transport, and only there.
- **A corrupt timestamp outranking a valid record.** Ordering used `Date.parse` directly; the
  registry is untrusted and only proves `updatedAt` is a _string_, so `NaN` was reachable and made
  the comparator inconsistent. Unparseable timestamps now sort as oldest.

`pipelineProblems[]` is also now documented in the canonical `--json` shape, including _why_ it
duplicates the per-transport copies: either can be read alone and be correct, and only the top-level
list is present when no transport is configured — exactly the case where a muted or daemon-less
workspace would otherwise look merely idle.

## 2026-07-19 — Delivery-transport health surface + transport heartbeats (006 §12; 005 §15) — Refs #425

Nothing answered "what transport will actually deliver monitor events to THIS session, and is it
healthy?" Both transports can silently diverge from the workspace they serve, and every divergence
presents identically — silence — while every existing surface reports green. Three distinct
instances were observed in one day of dogfooding: (a) a reaped daemon with no session to revive it;
(b) a channel server bound to the home-directory workspace because the session was launched from
`$HOME`; and (c) correctly-materialized events whose reminders were withheld on every lead session
by the `coalesced-until-ack` guard (002 §9.2/§9.3) — including a CI failure the agent was never told
about. `monitor explain` diagnoses (c) correctly, but only if you think to run it, and nobody runs it
while things appear fine.

### 006 §12 — Transport health & heartbeats (_current_)

New section. Each transport now writes a **heartbeat**: `channel serve` on startup and every poll
(removed on clean shutdown), `hook deliver` per invocation once it resolves a session plus the
delivery timestamp when it surfaces something. A record names the pid, resolved CLI path/version,
`HOME`/data root, bound workspace and socket, host session id, and last delivery — precisely the
values a long-lived channel server freezes at session start and that stop matching reality without
any visible signal.

Two design points are load-bearing and stated as contract, not implementation detail:

- **Records carry an owner-declared TTL lease.** A server killed without cleanup leaves its file
  behind, so a reader must judge it dead without trusting the writer to have removed it. Declaring
  the bound in the record (rather than as a reader-side constant) keeps the judgement correct if a
  future writer heartbeats on a different cadence, and gives a lease primitive a later
  daemon-lifetime policy can consume directly. The channel's lease is short (tens of seconds); the
  hook's spans a day, because there is no hook process between prompts and a short lease would
  report a healthy setup as dead during any human pause.
- **Records live in a machine-wide registry under the data root**, not the per-workspace directory.
  Storing a channel heartbeat inside the workspace _it resolved_ would make failure mode (b)
  undetectable by construction. A transport under a genuinely different `HOME`/`XDG_DATA_HOME` is
  invisible from here and is reported as an **absence** whose wording names that possibility — never
  as a clean bill of health.

§12.4 states the surface's contract: name the listening method; report each cause **distinctly**
(never one generic "unhealthy"); attach a concrete remediation to every problem; and separate "which
method is listening" from "will anything actually arrive right now". §12.5 records what a heartbeat
**cannot** prove: during the channels research preview the host drops channel events silently when
the plugin is loaded as a plain MCP server and returns no error, so "connected" is not sufficient for
healthy. That is surfaced as an explicitly-unverifiable advisory (pointing at `verify` and the
dev-flag remediation) rather than asserting health we cannot prove or crying wolf; a future active
probe would upgrade it to detection.

Numbered §12 rather than inserted as §7 deliberately: renumbering would have invalidated existing
`006 §7`–`§11` cross-references across the spec set, the roadmap, the glossary, and historical
entries in this changelog.

### 005 §15 — `doctor` reports delivery transports

`doctor` gains a **Delivery transports** section, two `transport:<name>` checks, and a
`delivery-verdict` check, with problem codes `daemon-unreachable`, `workspace-mismatch`,
`socket-mismatch`, `environment-mismatch`, `reminders-suppressed`, `heartbeat-stale`,
`version-skew`, and the `channel-registration-unverified` advisory. The prior statement that `doctor`
"performs no MCP/channel checks" is removed as superseded.

`deliveryWillReachThisSession` (the method) and `deliverable` (will anything arrive) are separate
fields on purpose — the suppression case is exactly where they diverge, and collapsing them is what
hid the undelivered CI failure. Pipeline-wide problems are recorded on every configured transport in
`--json` but rendered once, at the verdict, so one down daemon does not read as one problem per
transport.

**Exit codes stay conservative.** A `transport:<name>` check is `fail` only for a transport that
reported in and is genuinely broken. "A lead session exists but no transport has reported in yet" is
`idle`, matching the existing `daemon-reachable`/`lead-session` idle discipline (issue #373): it is
the ordinary state of a script-registered session or one that has not yet had its first prompt, and
failing there would cry wolf on a setup about to be fine.

## 2026-07-19 — A delivered event's title is the monitor's authored `name`, and an `objectKey` is bounded in human-facing text (002 §5.4, 003 §2.8, §4.4, §11.4) — Refs #449

Previously the event `title` was whatever the source wrote, and `command-poll` writes
`"Command output changed: <objectKey>"` with `objectKey` defaulting to the joined argv. A live
delivery therefore headlined itself with ~400 characters of its own `jq` program while the monitor's
authored name — "My PRs — CI, review feedback, state changes" — appeared nowhere in the delivery.
That contradicts the principle #434/#438 established (delivered text is the agent's action surface
and must be self-sufficient): a headline that is the monitor's own implementation conveys nothing and
consumes context on every delivery.

Two rules now: **002 §5.4** — the runtime, not the source, chooses the title: the monitor's authored
`name` when present, otherwise the source title unchanged (documented fallback). The source's
per-object text stays as the `summary`, and source identity stays on `objectKey`/`payload`, so no
information is lost. Because the choice happens once at materialization the title is
transport-independent by construction — hook and channel cannot diverge. **003 §2.8** — an
`objectKey` is an identity, not a headline: a source interpolating one into `title`/`summary` bounds
it with `displayObjectKey` (≤60 characters, otherwise a prefix ending in `…`). Keyed collections bound
only the monitor-scope half of `<scope>#<key>`, keeping the informative item key whole. §4.4
(`api-poll`) and §11.4 (`command-poll`) updated to cite both rules.

Delivery rendering follows: both injecting transports' shared per-event block now renders the
`summary` on its own line beneath the title, omitted when the two are identical (006 §4.2.1). Without
it, a per-object source's delivered block would name no object at all once the title became the
monitor name — the exact self-sufficiency regression #434/#438 guards against.

Review of the above corrected three over-claims in the first draft of these rules. (1) §2.8's bound
was stated as a **universal** MUST, but `file-fingerprint`'s absolute path, `incoming-changes`'
repository path, keyed collections' item keys, and the `api-poll` composite fallback key are all
still unbounded. The rule is now scoped to **configuration-identity** keys (a joined argv, a URL) —
the cases where a key is long because of how the monitor is written and where a head-truncated prefix
stays informative — and the path-like cases are documented as deliberately excluded, because a path's
informative part is its tail and head-truncation would destroy it (a path-aware ellipsis is
follow-up). (2) 002 §5.4 claimed the source title is "never lost"; `Observation.summary` is optional
and MAY differ from the required `title`, so a named monitor whose source sets a distinct summary
does drop the source title from delivered text. §5.4 now carries a compatibility table for all three
observation shapes, and 003 §2.1's field table no longer describes `title` as the inbox-item title.
(3) The bound truncated by UTF-16 code unit, which split astral code points (`"a".repeat(58) + "😀x"`
emitted a lone high surrogate into durably persisted text); it now cuts at a grapheme-cluster
boundary, so a flag or ZWJ sequence is kept whole and the result may be shorter than the bound.

Ephemeral monitors: an explicit `--display-name` now propagates into the authored-name signal, so a
named ephemeral watch headlines with its display name like a persistent monitor's `name:` (007 §4.6
"same pipeline semantics"), including after the definition is reconstructed from its durable record
on daemon restart.

`api-poll` additionally **redacts** the URL it interpolates (userinfo/query/fragment stripped, the
treatment its warning text already had) before bounding it. Title and summary are durably persisted
and delivered to agents, and a polled URL routinely carries a token, so the redaction that protected
diagnostics has to protect delivered text too; `objectKey`/`payload.url` keep the exact URL.

Not addressed here: issue #449's third item, a semantic diff hint for `json-diff` `diffText` (the
"PR #443 became MERGED, PR #447 appeared" rendering). That is the presentation half of #440 and
remains open.

## 2026-07-19 — Composite byte-budget exact-render check and Unicode-code-point `id`-length parity (003 §4.9) — Refs #304

Fourth round of review follow-ups on the #304 bounds, in the same PR before merge, closing two gaps
left open by the round below.

- **The cumulative byte budget still undercounted the final artifact.** `framedPartByteLength`
  tallies each part's framed section (`## <id>\n<body>`) as it is observed, but
  `renderCompositeSnapshot` also inserts `\n\n` separators between sections when assembling the
  final artifact — bytes the running per-part tally never counted. A reviewer reproduced the gap
  directly against the real helpers: a fixture built to sit exactly at the 10 MiB budget by the
  summed-helper math rendered to 10,485,762 bytes against the running tally's 10,485,760, a 2-byte
  (98 bytes at the 50-part cap) undercount that let an over-budget composite through.
  `observeComposite` now performs a final `Buffer.byteLength` check on the actual rendered artifact
  (separators included) before accepting the observation — exact regardless of part order or count
  — and the boundary fixtures were re-derived to assert the final RENDERED byte length at and one
  byte over the budget, not the pre-render running tally.
- **The part-`id` length check counted UTF-16 code units, not Unicode code points**, while the
  JSON Schema `maxLength` keyword (and `agentmonitors validate`) counts code points — so a
  200-emoji `id` (200 code points, `id.length === 400` in UTF-16) passed schema validation and then
  was wrongly rejected by `source.observe`, an authoring-time-green/runtime-red split. The parser
  now counts code points (`Array.from(id).length`) to match the schema's `ucs2length` semantics; new
  parity tests cover a 200-emoji `id` accepted by both surfaces and a 257-code-point `id` rejected
  at the boundary by both.

(Verified: `plugins/source-api-poll/src/composite.ts`, `renderCompositeSnapshot`;
`plugins/source-api-poll/src/index.ts`, `observeComposite`; `plugins/source-api-poll/src/index.test.ts`,
"a composite whose cumulative RENDERED bytes sit exactly at the budget succeeds (boundary)",
"parseCompositeConfig counts part ids in Unicode code points, not UTF-16 code units (astral emoji)",
"parseCompositeConfig rejects an id with one more than MAX_PART_ID_LENGTH emoji code points (astral
boundary)".)

## 2026-07-19 — Composite part-count/part-`id` caps, rendered-artifact byte budget (003 §4.9, 004 §3.2) — Refs #304

Third round of review follow-ups on the #304 bounds, in the same PR before merge.

- **The cumulative byte budget only bounded response-body bytes** — not the assembled composite
  ARTIFACT, part count, request count, or worst-case tick duration. A reviewer reproduced two shapes
  that sailed past it entirely: 100,000 empty-body parts (0 cumulative body bytes) completing
  100,000 requests and producing a 1,699,998-byte baseline, and a single empty-body part with an
  11 MiB `id` producing an 11,534,340-byte baseline — `renderCompositeSnapshot` frames every part
  with `## <id>\n` regardless of body size, and neither the byte counter nor anything else bounded
  that framing overhead or the number of parts.
- **`change-detection.composite.parts` is now capped at 50 entries and each part's `id` at 256
  characters** (§4.9), enforced identically in the JSON Schema (`maxItems`/`maxLength`, so
  `agentmonitors validate`/`monitor test`/`watch declare` reject an over-limit config at authoring
  time) and the parser (`parseCompositeConfig`, defense in depth for a hand-edited `MONITOR.md` that
  skipped validation — 002 §2.2's tick-time isolation still applies as the last line of defense).
  Both reviewer repro shapes above are now rejected at config-parse time, before `observe()` issues
  a single request.
- **The cumulative byte budget now sums each part's RENDERED framed section** (`## <id>\n<body>`,
  via the new `framedPartByteLength` helper) rather than the raw response body, so id-framing
  overhead counts toward the same 10 MiB figure too — closing the gap the part-count/id-length caps
  don't already close on their own. `framedPartByteLength` is a running per-part tally taken during
  observation, before `renderCompositeSnapshot` assembles the final artifact; it does **not** by
  itself match the renderer's output byte-for-byte, because the renderer also inserts `\n\n`
  separators between sections that this per-part helper has no reason to count. A follow-up entry
  below closes that remaining gap with an exact check on the final rendered artifact.
- **The part-count cap also bounds worst-case tick duration** (§4.9): with the existing 5-worker
  composite concurrency bound, a composite resolves or fails in at most `ceil(parts / 5) *
timeout`; at the new 50-part cap and the default 30s timeout, that ceiling is `ceil(50 / 5) * 30s
= 300s` (5 minutes) — a documented, known bound rather than an unbounded function of `parts.length`.
- **004 §3.2** gained required-scenario rows for the part-count/part-`id` caps (including both
  reviewer repro shapes) and renamed the existing cumulative-budget row to reflect the
  rendered-artifact (not body-only) semantics.

(Verified: `plugins/source-api-poll/src/composite.ts`, `MAX_COMPOSITE_PARTS`,
`MAX_PART_ID_LENGTH`, `framedPartByteLength`, `parseCompositeConfig`;
`plugins/source-api-poll/src/index.ts`, `MAX_COMPOSITE_BYTES`, `observeComposite`, `scopeSchema`;
`plugins/source-api-poll/src/index.test.ts`, "composite cumulative byte budget (issue #304 review,
second + third round)", "composite part-count and part-id bounds (issue #304 review, third
round)".)

## 2026-07-19 — Composite cumulative byte budget, `timeout` non-string/leading-zero/overflow validation (003 §4.1/§4.9, 004 §3.2) — Refs #304

Second round of review follow-ups on the #304 bounds, in the same PR before merge.

- **Composite cumulative body-byte budget (§4.9).** The per-part 10 MiB cap and the 5-worker
  concurrency bound each addressed a different risk, but neither bounded the AGGREGATE size of an
  assembled composite: a composite with many small parts (the reported case: 12 × 1 MiB parts,
  each individually far under the per-part cap) could still assemble and baseline a
  `snapshotText`/`nextState` many times the size of any single-URL monitor's response, persisted
  every tick. `api-poll` now tracks the running sum of every fetched part's body length across one
  composite and fails the whole observation — aborting every other in-flight part via the same
  shared `AbortSignal` the concurrency bound already uses — once the total exceeds the same 10 MiB
  figure (reused as a cumulative budget, not a second configurable knob).
- **`timeout` rejects a present non-string value instead of silently defaulting (§4.9/§11.1).**
  `parseOperationTimeoutMs` previously treated ANY non-string `timeout` — including a genuinely
  present but wrong-typed one (`timeout: 123`, `timeout: null`) — the same as an omitted field,
  silently falling back to the 30s default. Only `undefined` (truly omitted) now defaults; any
  other non-string value throws a descriptive error.
- **`timeout` rejects a leading zero, matching the schema pattern (§4.9/§11.1).** The JSON Schema
  `pattern` (`^[1-9]\d*[smhd]$`) has always required a non-zero leading digit, but
  `parseOperationTimeoutMs` called `parseDuration` directly, whose own `\d+` digit group happily
  accepted a leading zero (`"01s"`) — a schema/parser mismatch where a schema-valid config could
  behave differently than the same string parsed standalone. The parser now rejects a leading zero
  too, a deliberate validation tightening (also applies to `command-poll`, which shares the same
  helper — see its changeset).
- **`timeout` rejects a value exceeding Node's `setTimeout` max (§4.9/§11.1).** A duration like
  `"25d"` (2,160,000,000ms) exceeds the 32-bit signed `setTimeout` maximum
  (`2_147_483_647`ms, ~24.8 days); Node does not throw for an over-range delay, it silently
  overflows to a ~1ms timer (with a `TimeoutOverflowWarning`), firing almost immediately instead of
  the author's intended deadline. `parseOperationTimeoutMs` now rejects any value above the max.
  The JSON Schema `pattern` is a pure string grammar and cannot express this numeric bound, so this
  one check is parser-only — a documented, narrow schema/parser gap, not a parity bug.
- **§4.1's scope example and optional-field inventory now include `timeout`** (previously present
  in the schema and §4.9 but missing from the canonical example/field list), and 004 §3.2 gained
  required-scenario rows for the request/body deadline, the body cap's `status-code` exemption, and
  composite concurrency/fail-fast/cumulative-budget, closing a traceability gap between the #304
  bounds and their required-test-scenario inventory.

(Verified: `plugins/source-api-poll/src/index.ts`, `MAX_COMPOSITE_BYTES`, `observeComposite`;
`plugins/source-api-poll/src/index.test.ts`, "composite cumulative byte budget (issue #304 review,
second round)"; `libs/core/src/notify/notifier.ts`, `parseOperationTimeoutMs`,
`MAX_OPERATION_TIMEOUT_MS`; `libs/core/src/notify/notifier.test.ts`;
`plugins/source-command-poll/src/schema-parity.test.ts`.)

## 2026-07-19 — `api-poll`/`command-poll` timeout hardening and composite fail-fast fix (003 §4.9/§11.1) — Refs #304

Follow-up review fixes on top of the #304 bounds below, in the same PR before merge.

- **`status-code` is exempt from the byte cap (§4.9).** The response byte cap was enforced before
  `resolveStrategy`, so a `status-code` monitor watching a large endpoint (the body is irrelevant to
  that strategy — only the status transition is watched) regressed to erroring on every tick once
  the cap shipped. `api-poll` now skips reading the body entirely when
  `change-detection.strategy` is explicitly `status-code`, releasing the unread response back to
  the connection pool instead of buffering or counting it — cheaper, and exempt from the cap by
  construction. The inferred-strategy path (§4.2) is unaffected: inference never resolves to
  `status-code`, so it always reads the body.
- **Declared-Content-Length rejection no longer leaks the connection (§4.9).** The early-rejection
  path threw without aborting the request or releasing the response body, unlike the streamed-count
  path (which already aborted); undici kept the socket open with the unconsumed body pending — one
  leaked connection per tick, multiplied by up to 5 in composite mode. Both oversize paths now abort
  symmetrically.
- **Composite concurrency fails fast and cancels doomed siblings (§4.9).** The bounded worker pool
  only checked a shared failure flag _between_ items, so a part that failed instantly (e.g. a 401)
  still waited for every other in-flight sibling to reach its own full per-part deadline before the
  composite surfaced the failure — re-lengthening exactly the tick this bound exists to shorten. The
  pool (now its own module, `map-with-concurrency.ts`) races a dedicated failure promise against the
  worker pool and hands every part a shared `AbortSignal`, so the batch rejects the instant the
  first part fails and cancels every other in-flight part instead of letting them run to completion.
- **Mid-body abort classification hardened (§4.9).** `readBoundedBody`'s catch now also checks
  `controller.signal.aborted` (mirroring `fetchBody`'s own fallback), so an HTTP/2 or
  socket-teardown race that rejects a mid-body read with a raw `TypeError: terminated` (instead of
  the `AbortError` the timer itself produces) is still classified as the documented "timed out"
  error rather than leaking the raw undici error.
- **Zero-length `timeout` is rejected (§4.9/§11.1).** `timeout: "0s"` (or `"0m"`/`"0h"`/`"0d"`)
  previously passed both the JSON Schema `pattern` and `parseDuration`, producing a deadline that
  aborts every request/command before it can ever complete. A new core-level helper,
  `parseOperationTimeoutMs` (exported next to `parseDuration`, alongside
  `DEFAULT_OPERATION_TIMEOUT_MS` and the updated `OPERATION_TIMEOUT_PATTERN`,
  `^[1-9]\d*[smhd]$`), now backs the `timeout` field for **both** `api-poll` and `command-poll` —
  replacing each plugin's previously hand-maintained, byte-for-byte-identical copy of the
  default/parse/pattern — and rejects a zero-length value up front with a descriptive error at
  both validation and observe time.

(Verified: `libs/core/src/notify/notifier.ts`, `parseOperationTimeoutMs`; `libs/core/src/notify/notifier.test.ts`;
`plugins/source-api-poll/src/index.ts`; `plugins/source-api-poll/src/map-with-concurrency.ts`;
`plugins/source-api-poll/src/index.test.ts`; `plugins/source-api-poll/src/map-with-concurrency.test.ts`;
`plugins/source-command-poll/src/index.ts`; `plugins/source-command-poll/src/schema-parity.test.ts`.)

## 2026-07-19 — `api-poll` bounds request duration, response size, and composite concurrency (003 §4.9) — Refs #304

Fixes a P1 daemon-availability defect: `api-poll` could wait forever on a stalled connection or
body, buffer an unbounded response into memory, and fan out an unbounded number of concurrent
requests in composite mode — any of which could wedge a tick, delay unrelated monitors, or exhaust
memory.

- **New §4.9 (request/body deadline, response size cap, composite concurrency).** A single
  `AbortController`-backed deadline (default `30s`, override via the new `timeout` scope field,
  duration string) now bounds the entire request/response exchange — not just the initial `fetch()`
  — including a stalled/trickling chunked body. A 10 MiB response body cap is enforced twice: an
  early rejection against a (trusted-but-not-authoritative) declared `Content-Length`, and a
  streamed running count that is the real authority. Composite mode (§2.6) now runs at most 5 parts
  concurrently (a bounded worker pool) instead of starting every part at once via `Promise.all`,
  with the same per-part deadline and byte cap as a single-URL monitor.
- **Errored-observation semantics preserved.** Both the deadline and the byte cap throw (not
  truncate-and-continue) — the runtime records an `errored` observation, `nextState` never advances,
  and any prior baseline is preserved, matching the existing non-2xx (§4.8) and network-error (§4.6)
  behavior. This is deliberately unlike `command-poll`'s stdout cap (§11.2), which truncates and
  still treats the capped output as a valid result — a stalled/incomplete HTTP body is not a
  meaningful baseline the way capped command output is.

## 2026-07-19 — `verify`'s materialize/deliver stages carry a fresh deadline past a late observe resolution instead of inheriting an already-expired one (005 §16 step 6, Budget) — Refs #442

The round-19 fix (below) extends the observe stage's own deadline past the single-interval `detect`
deadline so a genuine `no-change` verdict has time to gather its second confirming row. But
materialize and deliver (steps 7–8) still polled against the original, un-extended `detect` deadline
— sized on the assumption observe resolves within one interval, leaving only the settle +
high-claim-settle + margin remainder for them. A **real** `triggered` row landing in the observe
stage's extension window (after `detect` but before `noChangeConfirmMs`) therefore left materialize
and deliver an already-expired deadline and zero remaining time, failing `budget-exceeded` even though
the event was durable. Reproduced deterministically with a 20s-interval command-poll monitor and a
backgrounded (detached) trigger command whose real file write lands ~30s after firing: the first
post-trigger tick (~20s) genuinely observes no change yet (one `no-change` row — never reaching
round 19's two-distinct-row bar), the second tick (~40s) observes the already-written file as
`triggered`, landing inside the `[detectMs=25s, noChangeConfirmMs=45s]` extension window — but
materialize's un-carried 25s `detectDeadline` had already passed, so materialize immediately failed
`budget-exceeded`. (A short interval can't reproduce this: with the 5s margin floor dominating, the
observe stage's own two-distinct-row `no-change` discriminator fail-fasts well before a slow
trigger's real change ever lands, so a wide-enough interval — where the 25%-of-interval margin
dominates the floor — is needed for the real `triggered` row to survive past the single stale
`no-change` row.)

Fixed: `verify` now re-grants materialize and deliver a fresh deadline of `max(detect deadline,
observe's actual resolution time + postObserveBudgetMs)` — the same settle + high-claim-settle +
margin remainder, just measured from when observe actually finished rather than from the original
trigger time — applied only for the default derived budget (an explicit `--timeout-ms` keeps its own
value as the hard total cap throughout, matching the observe-stage override semantics). `VerifyBudget`
gained `postObserveBudgetMs` (`detectMs - intervalMs`), and `totalMs` — the worst-case default maximum
— is corrected to `baselineMs + max(detectMs, noChangeConfirmMs) + postObserveBudgetMs` (previously
`baselineMs + detectMs`, which undercounted exactly this extension). 005 §16 step 6 and its Budget
section now document the re-grant and the corrected `totalMs` formula.

## 2026-07-19 — `verify`'s observe stage requires two distinct post-trigger `no-change` rows, not one persisting (005 §16 step 6, Budget) — Refs #442

`verify`'s observe stage previously fail-fast on a single post-trigger `no-change` observation-history
row once it had merely _persisted_ for a full monitor interval — the same guard mechanism as the
`suppressed` debounce carve-out, but applied to a single row re-read on every poll rather than to
genuinely new evidence. A daemon tick already in flight (mid-scan) when the trigger fired can finish
and record its necessarily-stale, pre-trigger `no-change` row _after_ the trigger's timestamp under
enough scheduling delay (a busy CI runner); every subsequent poll then re-reads that SAME retained
row, and once one wall-clock interval passed, that persistence alone was wrongly treated as decisive
— even though the next genuine post-trigger tick could still finish and observe the real change
later. It also under-budgeted: the default detect budget (interval + margin, ~37.5s for the
file-fingerprint default) could not fit both the default detect window AND an extra full-interval
persistence wait, so a genuine no-change case could report `budget-exceeded` instead of the documented
`no-change` verdict.

Fixed: a `no-change` verdict now requires **two distinct observation-history rows** (different ids),
both reporting `no-change` after the trigger, before it is decisive — a single stale row, however long
it lingers, never reaches that bar; a `triggered` row still wins immediately regardless. The pure
discriminator is extracted into `apps/cli/src/verify-observe.ts` (`resolveObserveVerdict`,
`resolveObserveDeadline`) so it is unit-testable independent of the daemon-backed integration path.
`verify-budget.ts`'s `VerifyBudget` gained `noChangeConfirmMs` (`2 × interval + margin`, no settle
term) — the observe stage's deadline is extended to at least this value, but **only** when using the
default derived budget; an explicit `--timeout-ms` is honored as the operator's real cap and is never
silently extended, so a timeout shorter than one interval still fails fast with `budget-exceeded`. 005
§16 step 6 and its Budget section now document both the two-distinct-row rule and the conditional
deadline extension.

## 2026-07-19 — `session start`'s post-compact recap now uses the reserve → render → write → commit ordering, matching `hook deliver` (005 §10.4, 006 §5.6) — Refs #442

`session start`'s SessionStart recap still committed the reservation (`claimDeliveryClient`) BEFORE
rendering or writing, then wrote via a bare, un-awaited `process.stdout.write` — the exact
claim-before-fallible-surface ordering the round-9 fix removed from `hook deliver`. An asynchronous
`EPIPE` (or any write failure) arriving after that call would durably claim the recap rows while
emitting nothing to the agent, reopening the at-most-once loss window §5.2 already documents for the
`hook deliver` transport. Fixed by routing `session start`'s recap through the SAME shared
`reserveRenderAndCommitHookDelivery` / `writeAndCommitHookDelivery` / `writeStreamChunk` flow
`hook.ts` uses — `post-compact` needs no per-event cap sizing, so the reservation is accepted
directly, but the write-before-commit ordering and the awaited-completion write are now identical
across both callers. `renderHookDelivery`'s own doc comment (`hook-deliver-render.ts`) now describes
both call sites. New failure-injection coverage in `commands/session-start-recap-ordering.test.ts`
drives a real, delayed `Writable` (mirroring `hook-deliver-commit-ordering.test.ts`) to prove a
write failure releases rather than commits.

Two related wording corrections on the same file set:

- `buildHookRecapMarker`'s doc comment (`hook-deliver-render.ts`) previously claimed
  {@link buildHookDeferredMarker}'s wording "makes no promise about the ordinary redelivery direction
  either way" — but that marker's own contract (used only for rows never reserved at all) explicitly
  promises the omitted remainder stays pending and redelivers. Corrected: recap candidates ARE part
  of THIS reservation and are therefore not guaranteed to remain pending — their post-commit ordinary
  redelivery state depends on which of the three commit outcomes lands — while the recap's own
  future-resurfacing promise does not depend on that outcome.
- `hook-deliver-commit-ordering.test.ts`'s top comment claimed a commit RPC rejection after a
  successful write makes "the safe direction ... a later DUPLICATE delivery" — overstating certainty.
  Corrected: the only remaining risk is a POSSIBLE later duplicate if the commit did not in fact
  apply, never a loss, since the output was already written.

## 2026-07-19 — `writeStreamChunk` now swallows the paired post-callback `'error'` event, and the channel transport's render-before-commit ordering is reflected everywhere it was previously described as commit-before-render (006 §4.2.1, §5.5) — Refs #442

Two fixes found on this PR's round-11 review.

- **`writeStreamChunk` could still crash the hook process despite the round-10 fix.** A real Node
  `Writable` is not mutually exclusive between its write callback and its `'error'` event: when a
  write fails, Node invokes the callback with the error AND separately EMITS the paired `'error'`
  event on a LATER tick for that SAME failure. The round-10 version removed its only `'error'`
  listener as soon as the callback settled the promise, so that paired emission had no listener left
  and became an UNCAUGHT exception — three independent real-stream probes (a closed pipe's write, a
  spawned child's closed stdin, and an `fs` write stream on a closed fd) reproduced `callback EPIPE ->
rejected promise -> uncaught EPIPE`, which could exit the hook process nonzero despite its
  always-exit-0 contract. Fixed by keeping the `'error'` listener armed through that later tick
  whenever the callback settles with an error (so the paired event is safely swallowed instead of
  going uncaught), detaching it only on the paths where no paired event will ever follow — a
  successful write, or `stream.write()` itself throwing synchronously. New regressions drive an
  actually-closed `fs` write stream (closed fd) and a real closed pipe (a child process whose stdin's
  reader has exited), with a `process.on('uncaughtException', ...)` guard proving neither reproduction
  crashes the process.
- **006, source comments, and this changelog still described the channel transport's oversized-event
  marker as committed before render — but production reserves, pushes/renders, and only THEN commits
  (`runChannelDeliveryCycle`, mirroring the hook side's round-9 reordering).** Corrected
  `channel-render.ts`'s and `hook-deliver-render.ts`'s doc comments, 006 §4.2.1 and §5.5, and the
  round-10 entry above to state the conditional truth in full: a successful (non-null) commit prevents
  ordinary repoll; a commit that resolves null means the reservation's lease already lapsed
  (`'surfaced-uncommitted'`) and the row is definitely uncommitted and eligible for at-least-once
  redelivery; a commit that REJECTS (an IPC/transport error) is a third, distinct case, not the same as
  resolving null — the daemon may have applied it before the response was lost, so whether the row is
  claimed or still pending is genuinely UNCERTAIN. The round-11 pass had collapsed the null and
  rejected cases together ("a null/rejected commit leaves it uncommitted and eligible for redelivery"),
  which is a false guarantee for the rejected case and contradicted the round-11 fix's own point that
  render-time commit outcome is genuinely unknown. Round-12 also fixed a channel-only mixed case:
  when the reserved single event is oversized AND `moreDeferred` is true, `renderChannelEvent`
  appended only the truncation marker, silently dropping the "more work is pending" signal —
  `CHANNEL_DEFERRED_MARKER` is now appended alongside it, matching the hook transport's existing dual-
  marker handling of the identical mixed case. `buildChannelTruncatedMarker`'s own TEXT needed no
  wording change — it was already outcome-neutral; only the prose describing what it does and doesn't
  guarantee needed correcting.

006 §4.2.1 and §5.5 previously asserted the channel transport's claim is durably committed before
render, and — after the round-11 fix — conflated a null commit resolution with a rejected commit
call; both sections, plus the round-10 entry above, are now corrected to describe the actual
reserve → push/render → commit ordering and its three-way conditional outcome, and to document the
mixed-case dual-marker rendering.

## 2026-07-18 — Hook-deliver commits AFTER writing (not before), re-validates the candidate-growth race, `verify` reuses the same reserve/validate/commit flow, and marker selection is lifecycle-aware for post-compact recaps (006 §5.2, §5.5, §6.1) — Refs #442

Four fixes found on this PR's round-9 review.

- **An at-most-once loss window: `hook deliver` committed the reservation BEFORE rendering or
  writing any output.** `commitDeliveryClient` — the durable `first_notified_at` mutation that
  permanently excludes rows from ordinary redelivery — ran first; if the daemon applied the commit
  but its RPC response was lost, or if rendering/stdout writing failed afterward, the command's
  always-exit-0 try/catch swallowed the error and emitted nothing while the rows were durably
  excluded from redelivery forever (recoverable only via the durable-but-unread `agentmonitors events
list` copy). Fixed by inverting the order: `reserveRenderAndCommitHookDelivery` renders the
  RESERVATION's own (not-yet-committed) claim immediately, and `writeAndCommitHookDelivery` writes
  that output to stdout FIRST, committing only after a successful write. A write failure now releases
  the reservation instead of committing (nothing durably claimed, rows return to pending); a commit
  failure/uncertainty AFTER a successful write only risks a later DUPLICATE delivery — the safe
  direction, never a loss. Mirrors the channel transport's reserve → push → commit ordering (§4,
  issue #300).
- **The hook transport's final fit check trusted `moreDeferred` from the PRE-reservation preview,**
  which could go stale in the direction the round-8 fix didn't cover: a preview seeing only event A
  sizes `maxEvents=1` and computes `moreDeferred=false`; event B settles before the reservation lands;
  the reservation legitimately returns only A, which fits on its own, so the (stale) `false` was
  returned unchanged — silently dropping the marker that would have told the agent B stays genuinely
  pending (§5.5). Fixed by adding the same post-reservation candidate-growth re-check the channel
  transport already had (`settledWorkRemainsBeyondClaim`, round-6 entry below): `reserveSizedHookDelivery`
  re-runs the settled-high preview once more, after the reservation is accepted, and flips
  `moreDeferred` to `true` when a settled event isn't in the reservation — recomputing fit against the
  final, marker-reserving budget and releasing/retrying if it no longer fits.
- **`verify`'s `claimAndRender` duplicated a bespoke, unvalidated preview → direct-claim → render
  sequence of its own,** instead of reusing the hardened flow `hook deliver` uses — so `verify` could
  pass even when the production claimed-set-equals-rendered-set contract (§5.5) was violated by the
  same substitution race the round-8 fix closed on the real hook path. Fixed by extracting the shared
  reserve → validate-fit → render → commit sequence into `reserveRenderAndCommitHookDelivery`
  (`hook.ts`), which both `hook deliver` and `verify`'s `claimAndRender` now call.
- **Marker selection wasn't lifecycle-aware: a `post-compact` recap could render either ordinary
  marker, both of which are untruthful for it.** `decideDelivery`'s recap branch reads
  `unreadEventsForSession` (not `pendingEventsForSession`) and claims the FULL unread candidate set at
  commit time regardless of what actually renders — so a row being claimed never hides it from a
  FUTURE recap, only acknowledging does. That makes the deferred-remainder marker's "not yet claimed"
  framing wrong (the omitted blocks ARE claimed) and the claimed-unread marker's "will not redeliver
  automatically" actively false (it WILL, on the next recap). Fixed by making `renderHookDelivery`
  check `claim.lifecycle === 'post-compact'` and use a single, unified `buildHookRecapMarker` in place
  of both ordinary markers for a recap.

006 §5.2, §5.5, and §6.1 previously described commit-before-render, a preview-only candidate-growth
guard, and a `claimDeliveryClient`-based capability-parity claim for `hook deliver`; all three are now
corrected to match the shipped write-before-commit ordering, the hook-side growth re-check, and the
reserve/commit sequence `hook deliver` (and `verify`) actually use. `channel-hooks-ipc-parity.test.ts`
is updated to match.

## 2026-07-19 — Hook-deliver awaits the write's ACTUAL completion (not stdout's synchronous return), clears a stale `moreDeferred` for a raced-down eventless reminder, and reworks the pre-commit truncation marker to be truthful regardless of commit outcome (006 §5.1, §5.2, §5.5) — Refs #442

Three fixes found on this PR's round-10 review, all consequences of round-9's render-before-commit
reordering.

- **An async write failure arriving AFTER `process.stdout.write`'s synchronous return could still
  reopen the at-most-once loss window round-9 closed.** `stdout.write`'s synchronous `true`/`false`
  return is a BACKPRESSURE signal, not a success signal — a write can return `true` immediately and
  still fail asynchronously afterward (e.g. `EPIPE` once Claude Code's hook consumer has already
  closed its end of the pipe). `writeAndCommitHookDelivery` only awaited the caller-supplied `write`
  callback's own return, so a `write` that appeared to "return" successfully but failed later,
  invisibly, would still let `commit` land on an unwritten delivery. Fixed by threading a genuinely
  awaited seam through: `writeStreamChunk` promisifies `stream.write(chunk, callback)`, resolving only
  on the callback's success signal (or rejecting on its error), and additionally listens for the
  stream's own `'error'` event during the write (whichever fires first settles the promise) — this is
  the seam `hook.ts`'s `deliver` action now calls instead of a bare `process.stdout.write`. A
  failure-injection test reproduces the exact shape (`write()` returns `true` synchronously, then the
  awaited completion rejects asynchronously) and proves no commit happens and the reservation is
  released instead.
- **A reminder claim raced down from a settled-high preview kept the STALE preview's `moreDeferred`.**
  `reserveSizedHookDelivery`'s eventless (`reservation.claim.events.length === 0`) branch returned
  `moreDeferred` unchanged even when it had been computed `true` from a settled-high preview that
  later lost the race to another transport (the reservation legitimately falls back to a reminder).
  `renderHookDelivery` never reads `moreDeferred` for an eventless claim, so the render itself was
  never wrong — but `--debug`'s `describeCapDeferral` line does read it, so a stale `true` reported a
  spurious cap-deferral diagnostic for a claim with no cap-truncated events at all. The channel
  transport's `reserveSizedChannelDelivery` already clears `moreDeferred: false` for the identical
  race; `reserveSizedHookDelivery` now does too, with a test reproducing the stale-high-preview →
  eventless-reservation transition and asserting no cap-deferral diagnostics are emitted.
- **The pre-commit truncation marker asserted an outcome it could not yet know.** Round-9 moved
  rendering to BEFORE the reservation's commit, but `buildHookClaimedUnreadMarker` still said "it is
  claimed but NOT acknowledged ... it will not redeliver automatically" — true only if the commit
  **resolves non-null**, but FALSE if it **resolves null** (the reservation's lease already lapsed):
  the rows then are definitely never claimed and deliberately stay pending, so they WILL redeliver via
  the ordinary context-event flow (§5.5) — the opposite of what the marker promised. (A commit that
  **rejects**, an IPC/transport error, is a third, distinct case the round-9 fix did not yet separate
  out — see the round-12 entry above: the daemon may have applied it before the response was lost, so
  the row's eventual state is genuinely UNCERTAIN, not a guaranteed redelivery either.)
  Reworded to assert only what holds regardless of the commit's outcome: "this update was too large to
  show in full; the full copy stays unread — run `agentmonitors events list --session <id> --unread`
  to see it now". `buildHookRecapMarker` is similarly reworded to drop its own premature "is claimed"
  assertion, keeping only the self-healing future-recap promise (true regardless of this particular
  commit's outcome). The channel transport's `buildChannelTruncatedMarker` was already outcome-neutral
  for the identical reason: it has the SAME render-before-commit ordering (reserve → push/render →
  commit) and the same conditional outcome — a successful (non-null) commit prevents ordinary repoll;
  a commit that resolves null leaves the pushed event definitely eligible for at-least-once
  redelivery; a rejected commit is neither, leaving the outcome uncertain — so it needed no wording
  change here (a round-11 review found stale source/spec comments elsewhere still describing the
  channel as committed before render, and a round-12 review found the null/rejected distinction itself
  still collapsed in places; see the 2026-07-19 round-11 and round-12 entries above).

006 §5.1, §5.2, and §5.5 previously asserted a specific claimed/redelivery outcome for the hook
transport's pre-commit truncation markers, and described the synchronous `stdout.write` return as the
write-completion signal; both are now corrected to the outcome-agnostic marker wording and the
awaited-completion write seam actually shipped.

## 2026-07-18 — The socket path in both markers is now transport-safe-escaped, the hook transport reserves/validates/commits instead of claiming directly, and its two markers can co-render (006 §4.2.1, §5.1, §5.5) — Refs #442

Three fixes found on this PR's round-8 review.

- **A raw socket path could reintroduce forbidden tag-breakout characters into the channel's
  `content`.** The marker's socket path was interpolated AFTER `contentValue`'s tag-safety
  sanitization pass had already run (it is appended directly, not re-sanitized), and the prior
  `shellQuoteSingle` helper preserves every byte literally inside single quotes — so an explicit
  socket path containing `<`/`>`/`[`/`]` (or a raw CR/backtick) reintroduced those bytes unescaped
  into the pushed `<channel>` body, violating §4.6. Replaced by `escapeShellPath`
  (`delivery-event-render.ts`), shared by both transports: it renders the path in bash/zsh ANSI-C
  quoting (`$'...'`), hex-escaping (`\xNN`) every byte outside a conservative safe set
  (`[A-Za-z0-9/._-]`) — no forbidden byte can survive raw, while the path still reconstructs exactly
  when the advertised command is run. A path containing only safe bytes still renders as a plain,
  more-readable single-quoted token (no escaping needed). Verified end to end: the channel integration
  test now uses an adversarial-but-filesystem-legal socket path (spaces + brackets) and actually
  executes the advertised recovery command via a real shell against the live daemon.
- **A hook-deliver claim could be irreversibly claimed and then have its render silently drop a
  block.** `previewSettledHighDeliveryClient` (sizing) and `claimDeliveryClient` (the sized claim)
  are two separate IPC round-trips, so a concurrent caller could substitute different, larger pending
  events into the same requested count — passing the count check but overflowing the render's own
  repack. Because `claimDelivery` sets `first_notified_at` synchronously, the dropped tail of an
  already-claimed row could never redeliver. Fixed by switching `hook deliver` to the same
  reserve → validate-fit → commit/release pattern the channel transport already uses: it now reserves
  (leases, does not claim), re-validates the ACTUAL reserved claim's fit via the new
  `resolveHookClaimFit` (the same predicate `renderHookDelivery` itself uses), and only commits once
  the fit is confirmed — releasing and retrying (bounded, forward-progress-guaranteed) on a mismatch.
- **The mixed case (a sole claimed event that is itself oversized, AND further different work
  genuinely stays pending) silently dropped one of the two real signals.** `renderHookDelivery`'s
  mid-truncation branch rendered only the claimed-unread marker even when `moreDeferred` was also
  true, so an agent had no way to know a separate, still-pending remainder existed and would
  redeliver. Both markers now render together whenever both conditions hold — they describe
  non-overlapping facts and neither implies the other.

006 §5.1, §4.2.1, and the changeset for #436/#442 previously described only the socketless, unsplit
recovery command; both are now corrected to match the shipped, split-marker, socket-and-session-scoped
contract, including the mixed claimed-truncation + deferred-remainder case.

## 2026-07-19 — Both transports' recovery markers now carry an explicit `--socket <path>`, a post-acceptance `moreDeferred` flip re-validates the actual claim's fit, and the hook side splits its marker framing to match the channel side's claimed-vs-deferred distinction (006 §4.2.1, §5.1, §5.5) — Refs #442

Four fixes found on this PR's round-7 review, all following directly from the round-3/round-6/round-5
entries below.

- **A post-acceptance `moreDeferred` flip could commit a claim the render then silently shrinks.**
  `reserveSizedChannelDelivery`'s candidate-set-growth re-check (round-6 entry below) computed
  `revalidatedMoreDeferred` AFTER `resolveChannelClaimFit` had already accepted the claim against the
  ORIGINAL `moreDeferred` value. At the cap boundary — two blocks that together fit under the FULL cap
  but NOT under the marker-reserving budget — a third candidate settling in the revalidation window
  flips `moreDeferred` to `true` post-acceptance; `renderChannelEvent` then has to reserve marker room
  itself and silently drops the second block from the render while `meta.event_count` still reports
  the full committed count. The fix recomputes `resolveChannelClaimFit` against the FINAL
  `moreDeferred` value before trusting it, and releases/retries through the existing mismatch path on
  a no-longer-fits result — exactly like the initial fit check does. Separately, if that revalidation
  preview call itself rejects, the reservation is now released BEFORE the error propagates (it
  previously threw first, leaving the reservation leased until the 30s TTL).
- **The mid-truncation marker's recovery command was not reliably runnable.** `channel serve` may be
  bound to an enabled workspace's own persisted/derived socket (issue #358), which takes precedence
  over a stale `$AGENTMONITORS_SOCKET` — but `agentmonitors events list` itself resolves its socket
  ENV-FIRST (issue #335), so a copy-pasted marker command with no `--socket` could silently query a
  stale or different workspace's daemon. `buildChannelTruncatedMarker` and the hook transport's marker
  builders now take the resolved `socketPath` and render an explicit, shell-quoted `--socket <path>`
  clause; `channel.ts`/`hook.ts`/`verify.ts`/`session.ts` thread their own resolved socket through.
- **The hook transport's single shared marker falsely implied the mid-truncated event would
  redeliver.** `hook-deliver-render.ts` previously rendered both the genuinely-deferred-remainder
  branch and the single-event mid-truncation branch (plus a truncated reminder message) with ONE
  marker whose "more monitor updates are pending" framing is only true for the FIRST. Since
  `claimDeliveryClient` claims (sets `first_notified_at`) synchronously, the mid-truncation/reminder
  cases are already-claimed content being cut — they will NOT redeliver via the ordinary
  context-event flow. The marker is split into `buildHookDeferredMarker` (kept for the genuinely
  deferred case) and `buildHookClaimedUnreadMarker` (claimed-unread framing for the other two),
  mirroring the channel transport's `CHANNEL_DEFERRED_MARKER` vs `buildChannelTruncatedMarker` split.
- **006 §5.5 and a matching source comment falsely claimed a mid-truncated hook event re-delivers.**
  Both are corrected to describe the claimed-unread recovery path (durable unread copy only, no
  automatic redelivery), consistent with the marker split above.

## 2026-07-18 — The hook-deliver transport's truncation marker now advertises the same directly-runnable, session-scoped recovery command as the channel transport (006 §5.1, §5.5) — Refs #442

Parity fix following the channel-side fix directly below: `hook-deliver-render.ts`'s `TRUNCATION_MARKER`
had the identical defect — it advertised `agentmonitors events list --unread`, but `events list`
requires `--session <id>` (§5, issue #420 P2), so the exact advertised command exits 1. The constant is
replaced by `buildHookTruncatedMarker(sessionId)`, mirroring `buildChannelTruncatedMarker`: it renders
the directly-runnable `agentmonitors events list --session <id> --unread` for the claim that actually
received it, sanitized the same way every other claim-derived field reaching `additionalContext` is.
Unlike the channel side, the hook transport keeps a SINGLE marker builder for both the deferred-remainder
branch and the single-event mid-truncation branch (§5.5) — `claimDeliveryClient` claims synchronously
(no two-phase reserve/commit), so there is no "will re-deliver later" framing on the hook side that
session-scoping would undermine. `packEventsUnderCap` (both the exported hook-deliver wrapper and its
callers in `hook.ts`/`verify.ts`) now takes the claim's `sessionId` so pre-claim sizing reserves room
for THIS session's own marker length, not a fixed constant — a longer or shorter session id changes how
many whole event blocks fit under the 4000-char cap. §5.1's example marker text is updated to show the
session-scoped command.

## 2026-07-18 — The mid-truncation marker's advertised recovery command is now directly runnable, and a candidate-set-growth race no longer drops the deferral marker (006 §4.2.1, §5.5) — Refs #442

Two follow-on fixes to the round-5 entry directly below, both found on the same PR's round-6 review.

- **The truncation marker's advertised command was unusable.** `CHANNEL_TRUNCATED_MARKER` told the
  agent to run `agentmonitors events list --unread` to recover a mid-truncated event's full body, but
  `events list` **requires** `--session <id>` (005 §11.1, issue #420 P2) — the exact advertised
  command exits 1. `CHANNEL_TRUNCATED_MARKER` (a constant) is replaced by
  `buildChannelTruncatedMarker(sessionId)`, which renders the directly-runnable
  `agentmonitors events list --session <id> --unread` for THIS claim's own `sessionId`, sanitized the
  same way every other claim-derived field reaching the `<channel>` tag body is (§4.6). Because
  `appendMarkerWithinCap` computes its truncation budget from the marker argument's actual length, a
  longer or shorter session id already yields correct cap sizing with no separate adjustment. §4.2.1
  and §5.5 are updated to describe the session-scoped command instead of the bare form.
- **A "candidate-set growth" race could silently drop the deferral marker.** The sizing preview may
  hold exactly one settled event (`maxEvents = 1`, `moreDeferred: false`) when a SECOND event settles
  before `reserveDelivery` runs; the resulting one-event claim genuinely fits, so the existing
  actual-claim-fit check (round-3 entry below) reported `fits: true` and returned early — but that
  check only asks "does the claimed set fit," never "did more settled work appear in the gap." The
  second, now-settled event was left pending with no marker signposting it, contrary to §5.5 ("the
  render omits any pending event ... signposting that more updates are pending").
  `reserveSizedChannelDelivery` now re-runs the same read-only settled-high preview once more, after a
  reservation is accepted, and compares it against the claimed event ids; any settled event not in the
  claim forces `moreDeferred: true` on the result.
- §4.2.1's blanket "`renderChannelEvent` renders every event ... it never drops a block to fit a cap"
  is corrected to name the single-event mid-truncation exception explicitly (previously only §5.5
  documented it — the two sections contradicted each other on this point).

## 2026-07-18 — A mid-truncated single oversized channel event no longer claims a later-poll re-delivery it cannot make (006 §5.5) — Refs #442

Corrects a false recovery-path claim introduced by the round-4 fix directly below. When a single
event's own block exceeds the ceiling even alone, `renderChannelEvent` mid-truncates it and appends a
marker to signpost the omission — but by the time that render runs, `runChannelDeliveryCycle` has
already reserved and is about to COMMIT the claim (`first_notified_at` gets set on success). Because
`pendingEventsForSession()` only returns rows whose `first_notified_at` is still `NULL` (002 §7), that
committed row can never appear in a later poll's settled-high preview again — the omitted tail does
NOT "surface on a later poll," contradicting what `CHANNEL_DEFERRED_MARKER` told the agent.

- **Two distinct markers now exist**, disambiguating two different situations that were previously
  conflated under one string:
  - `CHANNEL_DEFERRED_MARKER` — unchanged: appended when some settled-high events were left OUT of
    this claim entirely (never reserved). Those rows genuinely stay pending and re-deliver on a later
    poll.
  - `CHANNEL_TRUNCATED_MARKER` — new: appended only in the single-event mid-truncation branch, where
    the event IS committed by this cycle. It points at the durable, still-unread copy of the full body
    (`agentmonitors events list --unread`) instead of promising a re-delivery that cannot happen —
    claiming a delivery never acknowledges it (BP2 / SP4), so the full body remains recoverable there.
- No change to reserve/commit/release semantics, the ceiling itself (`MAX_CHANNEL_CONTENT`), or the
  packing behavior for the multi-event deferral case.

## 2026-07-18 — Channel content is bounded again by packing whole event blocks before reserving, not by cutting an already-claimed render (006 §4.2.1, §5.5) — Refs #442

Supersedes/refines the "channel `content` is not length-bounded" entry directly below. Restoring
rendering-parity with the hook path (the entry below) made a coalesced channel push's SIZE unbounded
again: full event bodies plus a bounded per-event change summary, with no cap on how many coalesced
events one push could carry. That entry's fix (dropping the overall `content` cap) was necessary to
preserve claimed-set-equals-rendered-set, but on its own left one `notifications/claude/channel`
JSON-RPC payload with no upper bound at all.

- **The channel is bounded again, but the boundedness now lives BEFORE reservation, not in the
  renderer.** `renderChannelEvent` still renders every event in the `DeliveryClaim` it is given — it
  never drops a block to fit a cap, so claimed-set-equals-rendered-set (§5.5) is preserved exactly as
  the entry below established. `channel serve` now previews the settled high-urgency delivery
  (`previewSettledHighDeliveryClient`), sizes how many WHOLE event blocks fit under a channel-specific
  content ceiling (`packChannelEventsUnderCap`, `apps/cli/src/channel-render.ts`), and passes that
  count as `reserveDelivery`'s `maxEvents` — the identical pack-then-claim pattern the hook-deliver
  transport already used for its 4000-char `additionalContext` cap (§5.1, issue #299), just against a
  much larger, non-single-turn ceiling. Any events that do not fit stay pending and re-deliver on a
  later poll.
- **Single-oversized-event handling matches the hook path.** When one event's own block alone exceeds
  the ceiling, it is shown partially (mid-truncated at a Unicode code-point boundary) to guarantee
  forward progress — its full body stays unread and re-delivers, exactly as §5.5 already specifies for
  the hook transport.
- **The deferral marker is bracket-free by construction**, not sanitized after the fact — it is chosen
  to contain no `<`/`>`/`[`/`]` so it never needs a `contentValue` pass of its own and can never
  interact with the tag-breakout stripping (§4.6).
- **Shared truncation/packing primitives.** `truncateWithMarker` (the code-point-safe truncate-and-
  append-marker loop) and the whole-block packing helpers (`packWholeBlocks`/`packEventsUnderCap`) are
  now defined ONCE in `apps/cli/src/delivery-event-render.ts` and used by both transports — before this
  they were character-identical copies (`boundDiff` in `delivery-event-render.ts`, `truncateForCap` in
  `hook-deliver-render.ts`).
- **`DeliveryEventSummary.diffText` is additive to the published `@agentmonitors/core` API** (a minor
  bump, not a patch — precedent: `DeliveryEventSummary.body` in #60 and the `schedulingDefaults`
  export).
- **Downstream effect on the hook-deliver transport.** Rendering `diffText` there too (the entry below)
  makes each `additionalContext` block grow by up to ~800 chars, so `packEventsUnderCap` now fits fewer
  events per delivery under the existing 4000-char cap than before this change — expected, not a
  regression: the deferred remainder still re-delivers at the next context event (§5.5, unchanged).

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

## 2026-07-18 — Channel `content` is not length-bounded: claimed set equals rendered set (006 §4.2.1 ↔ §5.5) — Refs #436

Resolves a contradiction between §4.2.1 and §5.5 that produced an event-loss defect. §4.2.1 said the
channel `content` was "capped at 4000 chars" (with a truncation marker), while §5.5 said the channel
is an **uncapped** caller that "omit[s] `maxEvents` and claim[s] the full delivered set." Both were
true in the implementation at once: the channel reserved and committed the entire `DeliveryClaim`, but
the renderer capped the joined blocks at 4,000 chars — so when an early body exhausted the cap, later
blocks were dropped from the tag while every candidate was still claimed. Those claimed-but-unrendered
events were then excluded from subsequent hook-path delivery, remaining only manually discoverable via
`events list --unread` — **not** the automatic redelivery §5.5 guarantees.

- **§5.5 is authoritative.** The channel is genuinely not length-bounded (its surface is an MCP
  notification, not a single length-capped `additionalContext` string like the hook path). §4.2.1 now
  states the channel renders the **full** delivered set with **no** overall `content` cap, so the
  **claimed set always equals the rendered set** (§5.5 invariant). Only the **per-event** change
  summary stays bounded (§4.6, currently 800 chars each) so no single untrusted diff is dumped
  wholesale; the number of coalesced events is uncapped because all of them are claimed and therefore
  must all surface.
- **Implementation.** `apps/cli/src/channel-render.ts` drops the 4,000-char `content` cap and its
  channel-level truncation marker; per-event `diffText` bounding (in the transport-shared
  `delivery-event-render.ts`) is unchanged, and that marker is sanitized as part of the block so it
  can never reintroduce tag-breakout characters.
- **The hook-deliver transport is unaffected.** Its `additionalContext` remains length-bounded and
  keeps sizing **whole** blocks under its 4000-char cap (previewing, sizing, then claiming exactly the
  events it renders — §5.1/§5.5), so it too never claims an event it does not surface.

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

## 2026-07-18 — Channel `content` renders the full event (title + monitor body + bounded change summary), at parity with the hook path (006 §4.2.1) — Refs #436

Fixes a delivery-completeness defect on the channel surface. A body-injection claim (a settled
high-urgency delivery) rendered only the event **title** into the `<channel>` tag body; the monitor
body (the author's instructions for what to do when the monitor fires) and the change summary
(`diffText`) never reached the agent, so the receiving agent had to already know what the monitor
meant and separately run `events list` to see what changed — defeating push delivery. This violated
§6 ("same events, same urgency … only the surface"): the channel is a rendering surface over the same
semantics as the hook-deliver transport, not a lesser summary.

- **New §4.2.1 (`content` rendering contract).** The channel tag body now renders the **same
  per-event block the hook-deliver transport injects** (§5.1), via a transport-shared block builder
  (`apps/cli/src/delivery-event-render.ts`): `### <monitor_id> (<urgency>)`, the title, the monitor
  body, and — when present — a `Changes:` section carrying a **bounded** `diffText` (per-event cap
  with an explicit elision marker). The only per-transport difference is content sanitization (the
  channel strips `<>[]` for tag safety, §4.6; the hook path preserves them). Reminder claims
  (`normal`/`low`) still render their generic coalesced message as-is, subject to the same tag-safety
  sanitization (002 §9.2) — unchanged. (The channel surface is not length-bounded — see the
  claimed-set-equals-rendered-set reconciliation below.)
- **`DeliveryEventSummary.diffText` (new, optional).** The delivery summary a transport receives now
  carries the event's change summary, so a transport can surface _what changed_, not just the title
  and instructions. This is the **recipient-specific** delta (`session_event_state.diff_text`, G10 /
  002 §1.1.2) — the diff THIS recipient's own baseline cursor produces against the shared observation
  — falling back to the shared `MonitorEventRecord.diffText` only for a legacy pre-G10 row whose
  per-recipient column is `null`. Absent when the event carried no diff at all. Additive core API
  change (minor bump — no behavior change to existing consumers).
- **`event_count` on a reminder tag.** A reminder claim carries no concrete events, so `event_count`
  now reports the session's **unread total** (the pending events the reminder refers to) rather than
  `0`, which read like a bug. A body-injection claim still reports its coalesced event count.
- **Parity is now enforced by a real test.** `channel-hooks-ipc-parity.test.ts` renders one
  `DeliveryClaim` through both real renderers and asserts both surface the identical per-event block.

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

## 2026-07-19 — `command-poll` drains excess stdout/stderr instead of killing the command (003 §11.2) — Refs #302

Clarifies the drain-not-kill contract for `command-poll`'s 1 MiB stdout cap, and documents an
independent stderr retention cap. An earlier implementation used `execFile({ maxBuffer })`, which
kills the child the instant either stream crosses the cap and reports the overflow as a truncated
success with a fabricated zero exit code — losing the command's real exit status, mislabeling
stderr-only overflow as stdout truncation, and potentially baselining a command that never actually
finished its side effects. §11.2 now states explicitly that neither stream's retention cap is ever a
kill trigger: both streams are consumed as they arrive (never buffered to completion), stdout retains
its leading 1 MiB, stderr is bounded independently to a small cap sized for diagnostics, and the
command always runs to its real completion with its real exit code reported.

- No schema or persisted-shape change — `payload`/`snapshot`/`nextState` still carry
  `{ command, exitCode, strategy, stdout, truncated }`; only the mechanics behind that `exitCode` and
  `truncated` are now spelled out.
- §11.7 gains four verification bullets: an overflow-then-side-effect-then-nonzero-exit case, a
  large-stderr/small-stdout case, a simultaneous-large-stdout-and-stderr case, and a
  keeps-writing-past-both-caps case that must still resolve promptly rather than hang the tick.

## 2026-07-18 — Channel transport commits claims only after a successful push: reserve → commit/release (006 §4.5.1) — Refs #300

Fixes a P1 delivery-loss defect in the channel transport. The channel marked a delivery **claimed
before** it knew the MCP push succeeded (`claimDelivery` then `await mcp.notification()`), so a
rejected or disconnected push permanently consumed the delivery: the rows stayed claimed and the hook
transport suppressed them as cross-transport duplicates (§4.5) even though nothing ever surfaced them
— violating the additive/fallback guarantee (§6 / NP-CH). No change to runtime notify/debounce timing,
urgency bands, or the unread/claimed/acknowledged model; the hook transport is unaffected.

- **New §4.5.1 (transport-state semantics: reserve → commit/release).** A transport surfacing claims
  over a fallible channel MUST NOT stamp `first_notified_at` ("was surfaced") before it actually
  surfaces the claim. The channel now **reserves** the delivery (renders the claim and **leases** its
  rows without any durable state change), **pushes**, and then **commits** on success (marks claimed,
  BP2 — still not acknowledged) or **releases** on failure (drops the lease, returning the rows to
  `pending` for the hook path or the next poll). Leased rows are hidden from a concurrent hook claim,
  so the in-flight window preserves cross-transport dedup (§4.5).
- **Guarantees:** no claim before surfacing (claim timestamps stay truthful); failed/disconnected
  pushes fall back to the hook path or retry; a successful push is durably deduplicated only once its
  commit resolves non-null — a null resolve permits ordinary redelivery, and a rejected commit leaves
  the daemon-side outcome uncertain (see the three-way outcome below); rows stay unacknowledged
  throughout. The reservation registry is in-memory and daemon-local, and a lost or self-expired lease
  safely returns rows to `pending` (PP1).
- **At-least-once boundary — three distinct commit outcomes, not two.** After a successful push,
  `commitDelivery` either resolves non-null (the rows are now claimed), resolves null (the lease had
  already lapsed mid-push or the daemon restarted — the rows are definitely still pending and
  re-deliver), or rejects (an IPC/transport error whose effect on the rows is genuinely uncertain —
  the daemon may have applied it before the response was lost). Only the null case is a known
  re-deliverable-pending state; the rejected case is a possible duplicate surface, never a lost
  delivery. The transport reports these distinctly and never treats an uncommitted push as a
  successful claim.
- **Lease-aware diagnostics:** while a reservation is in flight, the `hook deliver --debug` diagnosis,
  the reminder-suppression diagnosis, and the per-session hook-state projection all exclude leased
  rows from "pending claimable work" (routed through the same lease-aware accessor the claim decision
  uses), so they never advertise a row the reservation makes momentarily unclaimable. Reserve/release
  refresh the hook-state projection so it tracks the lease.
- **Realization:** core `reserveDelivery` / `commitDelivery` / `releaseDelivery` (backed by an
  in-memory `DeliveryReservationRegistry`) + `hook.reserve` / `hook.commit` / `hook.release` daemon
  IPC; the channel drives them via `runChannelDeliveryCycle`. `claimDelivery` is refactored into a
  pure decide + a mutating apply that both paths share (behavior-preserving for the hook path).
- **UAT:** [`docs/uat/channel-transport.md`](../uat/channel-transport.md) Part A-2 (steps 12a–12c)
  adds the transient-push-failure recipe (issue #277).

## 2026-07-18 — Invalid schedule/rollup timezones are validated at authoring time and isolated at runtime (001 §3.6, 002 §2.2, 003 §5.2) — Refs #297

An invalid IANA `timezone` (e.g. `America/New_Yrok`) on a `schedule` monitor made
`Intl.DateTimeFormat` throw inside `cronFieldValuesForDate()`, and `scheduleForMonitor()` was called
outside the per-monitor `observe()`/`ingest()` try/catches in `tick()` — so the throw escaped and
aborted the **entire** tick, stopping every other monitor. Two-part fix:

- **Authoring-time validation (001 §3.6, 003 §5.2).** `libs/core/src/schema/validate-scope.ts` adds
  `invalidTimezoneError()` / `isValidIanaTimeZone()`, wired into `validateWatchScope()` alongside the
  existing `change-detection.collection` check (003 §12) — so a `schedule` monitor's `scope.timezone`
  is now rejected by `validate`, `monitor test`, and `watch declare` (007 §4.2) with an actionable
  error. The `rollup` notify strategy's `timezone` already had this check
  (`rollupNotifySchema.timezone` in `monitor-schema.ts`); it now shares the same helper.
- **Runtime defensive isolation (002 §2.2).** `PollingDecision` gains an optional `error` field;
  `scheduleForMonitor()` catches a cron-matching failure internally instead of throwing. Every caller
  treats a present `error` as "this monitor cannot be scheduled right now" and isolates it: the tick
  loop records it exactly like an `observe()` failure (isolated per AP, `erroredObservations` +
  `errored` `observation_history` row); the not-due `dispatchRollup()` window-flush path (a `rollup`
  monitor's `notify.timezone`, evaluated independently of `scope.timezone`) gets the same isolation;
  `monitor.explain` (002 §10.7) renders it as an `observation`-stage `failure` computed purely
  in-memory (explain **MUST NOT** mutate state, so no `observation_history` row backs it) instead of
  crashing; `doctor` folds it into `valid`/`validationError`. `monitor-test.ts`'s no-daemon
  `explainMonitorInProcess` fallback (005 §6) also needed a fix: its case-A/B/C heuristic previously
  treated "definition ok, nothing persisted" as always meaning "never ticked" (case C, generic
  remediation) — the new in-memory-only observation failure needed a fourth signal (absence of a
  `scheduling` stage) to route to case A (show the real report) instead.

## 2026-07-18 — `json-diff` renders a structural `diffText`, not a text line diff (002 §5.2, 003 §4.2/§11.3) — Refs #437

Dogfood observation: a `command-poll` monitor with `change-detection: json-diff` watched
`gh pr list --json`, whose output is compact single-line JSON. When one array element changed (a PR
merged out of the list), `diffText` was a `buildTextDiff` line diff of the two ~700-char lines — the
entire array serialized onto one line each — so the delta rendered as remove-everything/add-everything.
The `json-diff` **strategy** correctly detected the change (it parses both sides as JSON and compares
structurally, per the existing `hasChanged` semantics); the rendered `diffText` was throwing that
structure away by always going through the line-level renderer regardless of strategy.

Fixed by making the runtime's diff renderer strategy-aware: `buildDiff(previous, current, strategy)`
(new, `libs/core/src/runtime/diff.ts`) reads the object's `change-detection.strategy` off the
observation's persisted `snapshot`/`snapshotMetadata` (`changeDetectionStrategyOf`) and dispatches to
`buildJsonDiff` for `strategy: json-diff`, falling back to the existing `buildTextDiff` for every
other strategy (including omitted) and whenever either side fails to parse as JSON — mirroring each
`json-diff` source's own `hasChanged` fallback so the renderer never disagrees with the strategy that
decided a change occurred. `buildJsonDiff` renders added/removed/changed elements or key paths,
diffing arrays of objects by a stable-key heuristic first (`id`/`key`/`uuid`/`_id`/`slug`/`sha`/
`number`/`name`, whichever is a unique scalar on every element of both sides), then whole-element
deep-equality matching when no such field exists, and index-based positional diffing for arrays of
non-object elements — bounded to 20 diff entries (an explicit `… N more changes elided` marker beyond
that, mirroring `buildTextDiff`'s existing 20-line cap) with each rendered value truncated at 300
characters, since this text reaches LLM context windows. All three `diffText` computation sites
(`processObservation`'s shared event diff, `insertEvent`'s per-recipient diff, and
`collapseNetForClaim`'s net-collapse recompute) now call `buildDiff` instead of `buildTextDiff`
directly. `buildTextDiff` itself is unchanged — every non-`json-diff` object renders byte-identically
to before.

002 §5.2 and 003 §4.2/§11.3 now document the renderer split; `buildDiff` is newly exported from
`@agentmonitors/core` (`buildJsonDiff` is module-internal, not part of the public API surface).

**Follow-up (same PR, review fix):** the stable-key and deep-equality array matchers used by
`buildJsonDiff` are themselves order-insensitive (they match by key/content, not position), but
`hasChanged` (003 §4.2/§11.3) is array-order-**sensitive** (it sorts object keys, never array
elements) — so a pure element reorder is a real detected change. The matchers now fall back to an
explicit `reordered` entry when they find no other diff, preserving the invariant "change detected ⟺
non-empty `diffText`" instead of silently rendering an empty diff for a change that was actually
observed. `diffJsonArrayByDeepEquality` also now threads the caller's field path through (previously
hardcoded to the array's own top level), so a nested array's removed/added entries keep their
location context.

**Follow-up (review round 2):** three additional defects in the structural renderer, found by review
and empirical repro:

- **Untrusted content in rendered paths (002 §5.2).** An object key or identity-key value is
  attacker/source-controlled JSON content, but was interpolated into the rendered path verbatim — a
  100,000-char `id` produced a 100,345-char one-entry diff (bypassing the documented 20-entry/
  300-char bounds), and an `id` containing a newline fabricated a fake second diff line. `diff.ts`
  now bounds every path segment to 60 chars and backslash-escapes path-syntax characters (`.`, `[`,
  `]`, `=`, `\`) and control characters (including the newline case) before interpolation, and adds a
  final 20,000-char cap over the fully-rendered `diffText` as a last-resort backstop. A field literally
  named `[x]` (previously indistinguishable from `[index]`/`[key=value]` array-element syntax) is now
  escaped to `\[x\]`. `renderJsonValue`'s existing 300-char truncation now cuts at a code-point
  boundary instead of a raw UTF-16 index, so an astral (surrogate-pair) character can no longer be
  split into a lone surrogate.
- **Quadratic no-identity array matching (002 §5.2).** `diffJsonArrayByDeepEquality` did a full
  `JSON.stringify(sortKeysDeep(...))` of both elements per probe — `O(N*M)` — making a reversed
  5,000-element array take roughly 1.5s of synchronous daemon-tick time. It now canonicalizes each
  element exactly once and matches via a counted multiset (`O(N+M)`). `deepEqualJson` no longer
  serializes whole subtrees at all (a genuine recursive structural comparison, short-circuiting on
  the first difference instead of re-canonicalizing every ancestor subtree at every recursion level),
  and the canonicalization helper now reuses `sortKeys` from `observation/keyed-collection.ts` instead
  of a duplicate copy. The unbounded entry list is no longer materialized before the 20-entry render
  cap: a small `DiffEntrySink` stops storing past `cap + 1` while still counting every entry the
  traversal visits, so the elision-count line stays exact.
- **Totality: a deeply nested JSON body could throw an uncaught `RangeError` (002 §5.2, ingest
  path).** `buildJsonDiff`'s try/catch covered only the two `JSON.parse` calls; the recursive
  traversal ran OUTSIDE it and stack-overflowed around 2,500 nesting levels (`JSON.parse` itself
  tolerates roughly 4.2M) — every `diffText` call site (`processObservation`, `insertEvent`,
  `collapseNetForClaim`) would have thrown instead of falling back to `buildTextDiff`, silently
  losing the event on the ingest path. `buildJsonDiff` now catches `RangeError` around the traversal
  and returns `undefined`, restoring the documented "falls back to `buildTextDiff`" totality.
- **Empty per-recipient diff for a formatting-only change.** Two byte-different snapshots that are
  structurally equal (key order/whitespace differ only) previously rendered `''` under `json-diff` —
  violating "change detected ⟺ non-empty `diffText`" wherever a caller (e.g. a stale per-recipient
  cursor) treats a byte-different snapshot as a real change. `buildJsonDiff` now renders
  `~ formatting-only change (no structural difference)` instead of the empty string in that case.

`buildDiff`'s `strategy` parameter is now the named `ChangeDetectionStrategy` union (`'json-diff' |
'text-diff' | 'exit-code' | 'status-code' | (string & {})`, exported from `@agentmonitors/core`)
instead of a bare `string`, since it is part of the curated public API surface. `sortKeys` is now
exported from `observation/keyed-collection.ts` (core-internal; not re-exported from `index.ts`) so
`diff.ts` can reuse it instead of duplicating it.

## 2026-07-18 — Snapshots ordered deterministically under second-resolution timestamp ties (002 §5.2, §15) — Refs #293

`monitor_snapshots.created_at` is stored at epoch-**second** precision, so several snapshots for one
`(workspace_path, monitor_id, object_key)` written in the same second (an ordinary same-tick burst)
tie on `created_at`. `latestSnapshot()` previously ordered ONLY by `created_at DESC` and could
return the **oldest** tied row as "latest", corrupting the shared diff chain — a direct `v1, v2, v3`
reproduction returned `v1`. This is the same ordering problem `monitor_events` already solved with a
monotonic ULID.

- **§5.2 — snapshots now have a total materialization order.** The runtime MUST resolve "the latest
  stored snapshot" to the **most recently materialized** row under identical timestamps. Satisfied by
  a monotonic ULID snapshot `id` (strictly increasing in insertion order) and `ORDER BY created_at
DESC, id DESC` — the `(created_at, id)` tie-break the events table already uses. No schema
  migration: `id` was already a ULID column; only its generator and the query's secondary sort key
  changed.
- **§15 `monitor_snapshots`** appendix row annotated: `id` is a monotonic ULID; `created_at` is
  epoch seconds with ties broken by `id`.
- **User-visible newest-first listings** that sort by second-precision `created_at` — `events list` /
  `monitor explain` event rows and the observation-history audit trail — apply the same `id`
  tie-break so their within-second order is stable (observation-history `id` also switched to a
  monotonic ULID for this).

This is a clarification + correctness fix; the intended contract (newest snapshot is the diff
predecessor) was always implied by §5.2 but not stated, and the implementation violated it under
ties.

## 2026-07-18 — `hook deliver --debug` renders untrusted stdin fields control-safe, matching the always-on warning (005 §12.2.1, 006 §5.2.1) — Refs #365

The always-on unknown-session warning (#329/#362/#363) JSON-string-escapes and length-bounds the
untrusted `session_id` it renders. The `--debug` diagnosis path (`hook-deliver-debug.ts`) interpolated
the SAME untrusted stdin fields — `session_id`, `hook_event_name`, and `cwd` — raw, on the adjacent
lines: `describePayload`, `describeUnmappedLifecycle`, `describeLifecycle`, `describeWorkspace`,
`describeWorkspaceDisabled`, and `describeNoSessionMatch`. A hostile payload (control characters,
terminal escapes, U+2028/U+2029, or a multi-KB flood) reached the operator's stderr raw whenever
`--debug` was set. Both specs now document that every untrusted field a `--debug` line interpolates
gets the identical rendering as the always-on warning. Implementation: the escaping/bounding logic
moved out of `hook-deliver-warnings.ts` into a new shared module
(`apps/cli/src/hook-deliver-sanitize.ts`, `sanitizeUntrustedField`/`sanitizeUntrustedFieldOrNone`) so
the always-on and `--debug` paths share one definition of "render untrusted id safely" rather than
risk drifting again.

## 2026-07-18 — `command-poll` timeout now terminates the entire process tree (003 §11.2/§11.7) — Refs #303

`command-poll`'s timeout handling previously signaled only the direct child (`child.kill()`). A
command that invokes a shell backgrounding a worker — `['sh', '-c', 'sleep 30 & wait']`, the
supported pipeline idiom from §11.1 — left the backgrounded process running after the shell was
killed: a resource leak across repeated polls, and a direct violation of §11.7's "no orphan
process" requirement. Worse, the prior implementation (`execFile`, whose completion is gated on the
child's stdio streams closing) could **hang the observation indefinitely**: an orphaned descendant
that inherited stdout/stderr keeps those pipes open even after the direct child is dead, so waiting
for `close` never resolves.

Fixed by spawning each command as the leader of its own POSIX process group/session
(`detached: true`) and signaling the **negative PID** on timeout (SIGTERM, then SIGKILL after the
existing 5s grace) — targeting the whole tree, not just the direct child. Resolution is driven by
the direct child's own `exit` event rather than stream `close`, so a descendant holding stdio open
can never hang the call; the same bounded-fallback principle also covers ordinary (non-timeout)
completions as a defensive measure, at no cost to well-behaved commands. Windows has no
process-group-signal equivalent and no reliable graceful signal for a non-console-attached spawned
process, so the documented choice there is `taskkill /PID <pid> /T /F` (forceful, tree-wide) at both
the timeout expiry and the grace follow-up — §11.2 now states this explicitly as a normative
platform-specific mechanism rather than leaving it undefined.

§11.7 gained a new validation bullet naming the regression test (`sh -c 'sleep 30 & wait'`,
asserting the descendant is dead by captured PID — not by process-tree membership, since an orphan
is reparented away the instant its true parent dies) and the end-to-end daemon-run/daemon-stop
integration test proving the same guarantee holds across a real daemon's own shutdown, not just a
single `observe()` call. No change to the failure-transition semantics of §11.5: a timeout still
keeps prior state and fires exactly one `ok → failing` observation.

## 2026-07-16 — Manual/no-docs CLI-path papercuts: hook-deliver stderr, events/history hints, session acks, scan exit code (005 §4, §10, §11, §12) — Refs #420

Six small, thematically-unified CLI-ergonomics fixes for the surface a user hits when driving
events/hooks by hand rather than via `verify` — making the manual/no-docs path self-explanatory. No
change to runtime notify/debounce timing, delivery semantics, or any hook **stdout** wire format.

- **§12.2 `hook deliver` — two new always-on stderr diagnostics (P1).** Alongside the existing
  unresolvable-`session_id` warning (#329), the command now writes one stderr line — **without
  `--debug`** — when the stdin payload carries no `session_id` (malformed / non-hook payload) or when
  `hook_event_name` maps to no delivery lifecycle. Both were previously silent-empty (exit 0),
  indistinguishable from "nothing pending" — the single most-repeated "looks broken, user gives up"
  moment on the manual path. **stdout stays byte-identical** and the exit code is unchanged; untrusted
  payload values are control-safe-escaped and length-bounded. The plugin only wires `hook deliver`
  into `UserPromptSubmit` with a well-formed payload, so neither fires in normal operation.
- **§11 `events list` / `events ack` — `--session` discovery hint (P2).** The bare `error: required
option '--session <id>' not specified` now gets a second stderr line, `Run \`agentmonitors session
  list\` to find a session id.`, and `--help` repeats the pointer. Default error line + exit
  unchanged.
- **§10.4/§10.5 `session start` / `session end` — success acks on stderr (P3).** On successful
  registration/deregistration each prints a one-line stderr ack (`AgentMon: session <id> registered;
daemon at <socket>` / `session <id> ended`). Silent success previously forced a second `session
list` to confirm. **stdout stays wire-clean** (`session start`'s recap JSON is untouched); the acks
  never fire on the quiet-exit paths.
- **§4 `scan` — meaningful exit code (P4).** Previously always exited 0. Now exits **0** on a clean
  scan (empty `errors` + empty `duplicateIds`, any format) and **1** when the scan surfaces a real
  problem (a parse error or a duplicate monitor id), so `scan && <next-step>` scripts are meaningful.
  A missing/invalid scan directory still exits 1 via the shared directory check.
- **§10 `monitor history` — `--dir` remediation, not a silent alias (P5).** `--dir` (the monitors
  directory, per `init`/`validate`/`monitor explain`) is a different concept from history's
  `--workspace` (the project root), so aliasing it would resolve the wrong workspace. Instead the
  `unknown option '--dir'` error gains a second stderr line pointing at `--workspace`.
- **getting-started + skill Phase-5 docs — durable-proof note for `verify --use-workspace-daemon`
  (P6).** The "presentable proof" recipe now states that `verify`'s synthetic PASS is a scratch probe
  and is **not** persisted as a durable event (so it won't appear in `events list`/`doctor`), and
  directs a security-proof user who wants a durable, queryable artifact to make one real edit + deliver
  it. Documentation-only; `verify`'s suppression behavior (Refs #418) is unchanged.

## 2026-07-16 — `verify` gains a decoupled `--trigger-cmd` mode for non-auto-triggerable sources (005 §16) — Refs #413

`agentmonitors verify --manual` — the verification path for sources `verify` can't fabricate a
change for (`command-poll`, `api-poll`, `schedule`, `incoming-changes`) — **blocks** for the detect
budget waiting for an out-of-band change and is **not** an interactive stdin prompt. A human
switches windows and edits a file; a persistent-shell agent backgrounds the run. But an agent
harness that runs one shell command per tool call (call-and-return) can't make the change while
`--manual` blocks, so its honest first attempt FAILs `budget-exceeded` on a correctly-configured
monitor (usability evidence, #413).

Resolved by adding a third **trigger mode** to §16 (`auto` | `command` | `manual`). The new
**command** mode, `--trigger-cmd '<shell>'`, has `verify` run the given shell command itself (via
the OS default shell — `/bin/sh -c` on POSIX — `cwd` = the workspace) after baseline to cause the watched change, then
observes/materializes/delivers — so any non-auto-triggerable source is verifiable in a single,
self-contained, non-interactive invocation, exactly like file-fingerprint's auto-trigger. A
`--trigger-cmd` that exits non-zero is a `setup` failure on the `trigger` stage (fix the command),
distinct from `no-change` (the command ran but changed nothing observed). Its effects are not
reverted (an arbitrary command has no known inverse); because they are real operator-caused changes
(not a verify scratch artifact), they are never swept by the `--use-workspace-daemon` retraction
(#407). `--manual` and `--trigger-cmd` are mutually exclusive. The `--manual` `budget-exceeded` FAIL
message now names `--trigger-cmd` and the background-and-interleave workaround instead of a bare
"did you make a change?", and the getting-started + skill Phase-5 guides document `--manual`'s
blocking, stdin-less nature with `--trigger-cmd` as the recommended path for non-interactive /
call-and-return agents. No change to runtime notify/debounce timing or the file-fingerprint
auto-trigger happy path.

## 2026-07-16 — `verify` cleanup uses two mechanisms with non-overlapping safe domains (005 §16) — Refs #418

The #414 tombstone (below) is a **by-object-key sweep**: on the tick a suppressed key's event
materializes, the daemon deletes _every_ event for that `(monitor, key)`. That is safe **only** for a
synthetic scratch key no real monitored file shares. But the previous change routed **both**
verify-created cases through it — including the **literal single-file glob whose watched file verify
created**, whose object key is a **real** monitored path. A later genuine event at that real path,
within the tombstone's TTL window, would then be swept and **silently lost** — event loss, the
highest-severity class of defect the runtime is meant to prevent. It also left #407's id-scoped
`retractObjectEvents` (added the release before) as dead code.

- Split §16 **step 9** (renamed **"Clean up"**) into the **two mechanisms** by object-key nature:
  - **Synthetic scratch key** (`…/agentmonitors-verify-<token><ext>`) → the durable, **non-blocking
    tombstone** (#414). Safe precisely because the key is synthetic.
  - **Real watched path** (a literal single-file glob verify created) → the **id-scoped
    `retractObjectEvents`** (#407): wait for verify's own create + delete, retract only those exact
    ids. Never a by-key sweep at a real path. A literal file that pre-existed (edited + restored) is
    still never erased.
- Enforced the invariant at the **trust boundary**: `AgentMonitorRuntime.suppressObjectEvents` and
  the `events.suppressObject` IPC verb now **reject a non-synthetic object key** outright (the shared,
  now-exported `isVerifyScratchObjectKey` predicate — fixed to recognize both `/` and `\` separators
  so a Windows object key resolves). A real path can never reach the by-key sweep.
- Scope correctness: `suppressObjectEvents` normalizes an omitted `workspacePath` to the **NULL scope
  once** and passes the same value to both the tombstone upsert and the immediate retraction, so an
  omitted workspace no longer retracts across **every** workspace (it would have been broader than the
  tombstone it installs). The unscoped by-key sweep stays an explicit opt-in of `retractObjectEventsByKey`.
- Reap-backstop TTL: the orphan-session tombstone's life is now derived from the object's **own
  monitor cadence** (`max(5min, interval + settle + margin)`), so a long-interval monitor's late
  deletion still lands inside the window instead of undershooting a flat 5-minute floor.
- No new public runtime capability beyond #414/#407; `isVerifyScratchObjectKey` is newly exported.

## 2026-07-16 — `verify --use-workspace-daemon` suppresses (not waits-to-retract) its scratch events (005 §16) — Refs #414

The #407 retraction (below) fixed the leak but WAITED a full extra poll interval + settle for the
scratch file's deletion event to re-materialize before retracting it — so `--use-workspace-daemon`
ran ~2× as long as plain `verify` (≈120s vs ≈59s) while still displaying plain `verify`'s ETA
(`~68s`). That reads as a hang and overran default 2-minute command/CI timeouts; a run killed
mid-cleanup left a permanently `active` verify session plus dangling scratch events that `doctor`
never flagged — the workspace ended up dirtier than before, the opposite of #407's intent.

- Rewrote §16 **step 9** (renamed **"Suppress"**): under `--use-workspace-daemon`, verify now deletes
  the scratch file and, in one non-blocking call, retracts the create event it already delivered AND
  installs a durable, self-expiring **object-event suppression** (tombstone) keyed to the synthetic
  scratch object. It no longer waits for the deletion — the daemon's tick sweeps the pending
  `File deleted: …/agentmonitors-verify-…` on the tick it materializes, before any later session sees
  it. So the mode finishes in ≈plain-`verify` time and its ETA is honest (criterion 1), while #407's
  no-leak guarantee is preserved.
- The suppression sweep deletes **by the scratch object key** — safe only because that key is a
  synthetic `…/agentmonitors-verify-<token><ext>` path no real object shares; a non-synthetic trigger
  (a real watched file verify merely edited) is never suppressed.
- **Interruption-safety** (criterion 2): the durable tombstone + verify's signal handler (which now
  runs the same teardown — revert, tombstone, close session — on `SIGINT`/`SIGTERM`) + a daemon
  **reap backstop** (when a stale `agentmonitors-verify-*` session is reaped to dormant, its scratch
  objects are tombstoned + retracted) together guarantee an interrupted run leaves no permanent stray
  session or event.
- Behavioral, not just clarifying: new runtime capability `suppressObjectEvents` (core service +
  store `object_event_suppressions` table, key-scoped `retractObjectEventsByKey`, and a per-tick
  suppression sweep), exposed over the daemon socket as the `events.suppressObject` IPC verb.

## 2026-07-16 — `verify --use-workspace-daemon` retracts its own scratch-file events (005 §16) — Refs #407

`verify --use-workspace-daemon` targets the persistent workspace daemon and leaves it running. Its
teardown deletes its own scratch trigger file, which the live daemon observed as a real change and
queued as an event — so a later session's `hook deliver`/`events list` saw a spurious `File deleted:
…/agentmonitors-verify-….md` **first**, ahead of the user's real change. (Default isolated mode is
unaffected: its throwaway daemon/db are torn down.)

- Added **step 9 "Retract"** to §16: under `--use-workspace-daemon`, verify now deletes the scratch
  file, waits for **its own monitor** to materialize the resulting deletion event, then retracts the
  exact events its own scratch file produced (create AND delete) across all sessions. The wait and
  retraction are scoped to the verified monitor's id, and the retraction deletes **by the observed
  event ids** (not a `(monitor, path)` sweep), so a real pre-existing event at the same watched path
  survives and a second monitor at that path is unaffected. Real monitored changes — and any
  pre-existing watched file verify merely edited and restored — are never retracted. §16 also records
  the residual crash window (a daemon death between materialization and retraction).
- Behavioral, not just clarifying: a new runtime capability `retractObjectEvents` (core service +
  store) removes a caller-supplied SET of a monitor's events by id — plus their per-recipient
  `session_event_state` projections, snapshots, and the affected sessions' seeded cursors — exposed
  over the daemon socket as the `events.retractObject` IPC verb.

## 2026-07-16 — `init`'s post-scaffold guidance points at `agentmonitors verify`, not the unavailable `setup-monitors` skill (005 §2) — Refs #408

`init`'s "Verify the monitor fires" summary (both the named `init <name>` scaffold path and the
bare-init `--yes` bootstrap path) previously named only the `setup-monitors` skill's "Verify It
Fires" section as the "full fire-and-deliver recipe" — a dead end for a no-plugin/no-docs CLI user,
who has no way to reach that skill. Blind usability evidence: the no-docs subject followed exactly
that pointer, found it unusable, and only discovered the real answer — `agentmonitors verify`
(merged in #403) — afterward, by scanning `--help`.

Fixed by pointing both paths at `agentmonitors verify <name> --dir <dir>` (with `--manual` appended
for any `--type` other than `file-fingerprint`, since `verify`'s auto-trigger today only fabricates a
change for `watch.globs`-based sources — 005 §16). The `setup-monitors` skill reference is kept, but
now clearly labeled as a Claude-Code-plugin-only supplement alongside `verify`, never the only
pointer.

## 2026-07-16 — `verify`'s auto-derived budget now accounts for the high-urgency default debounce settle (002 §9, 005 §16) — Refs #399, #406

`agentmonitors verify`'s auto-derived budget (`apps/cli/src/verify-budget.ts`, introduced for #399)
spuriously FAILed on the **recommended default monitor configuration** —
`file-fingerprint` + `urgency: high` with no explicit `notify:` block — on the very first
invocation. `resolveSettleMs` returned `0` whenever a monitor had no `notify` block, but the
runtime (`defaultNotifyConfigForUrgency`, `service.ts`) still applies a default 15s debounce
settle to a `high`-urgency observation with no explicit `notify` override before it
materializes (002 §9 / CLAUDE.md invariant: "`high` defaults to a 15s debounce settle"). For
the recommended default's 30s `file-fingerprint` interval, the computed `detectMs` undershot
real end-to-end delivery (~60s) by exactly the omitted 15s term (~53s vs ~60s), FAILing a
config that actually works.

Fixed by having `resolveSettleMs` delegate to `defaultNotifyConfigForUrgency` (now exported
publicly from `@agentmonitors/core`) instead of reading `monitor.frontmatter.notify` directly
— the same function the runtime tick uses to resolve the effective notify config, so the
budget can no longer drift from the engine's actual default. The default settle value itself
is now a named constant, `schedulingDefaults.highUrgencyDefaultDebounceSettleMs` (15s),
distinct from `highUrgencyClaimSettleMs` (both currently 15s, but independent knobs: one
delays materialization, the other delays hook-surfacing after materialization). An explicit
`notify.settle-for` still overrides the default outright; non-high urgency with no `notify`
still resolves `settleMs` to `0`.

## 2026-07-16 — Escape embedded quotes in `doctor`'s printed remediation; `--socket` row corrected for the `doctor.report` RPC (005 §15) — Refs #387

Two follow-on fixes to the `lead-session` remediation shipped below (#387).

- **Unrunnable command for a workspace path containing `'`.** The remediation embeds
  `JSON.stringify({ session_id, cwd: workspacePath })` between hard-coded shell single-quotes for the
  printed `echo '<payload>' | agentmonitors session start`. `JSON.stringify` never escapes an
  embedded `'` (it isn't special in JSON), so a workspace path containing one closes the shell's
  quote early, breaking the very command the fix exists to make copy-paste runnable. Fixed with a
  `shellSingleQuote` helper (`apps/cli/src/commands/doctor.ts`) applying the standard POSIX
  close-escape-reopen idiom (`'\''`) to the payload before interpolation.
- **Stale `--socket` row.** The flag table still described `--socket` as only a
  "daemon-reachability ping", predating the #382 fix (above) that made `doctor` call the real
  `doctor.report` RPC over that socket, falling back in-process only when unreachable. Corrected.

## 2026-07-15 — `doctor` lead-session remediation points at `session start`, a runnable command (005 §15) — Refs #387

`doctor`'s `lead-session` remediation previously recommended `agentmonitors session open --role lead
--workspace <path>`. That command is not runnable as printed: `session open`'s `--host-session-id`
is a required option, so a copy-paste fails immediately with `error: required option
'--host-session-id' not specified`, and a manual/no-plugin CLI user has no meaningful value to supply
for it ("host session id from the integrating runtime"). In a blind usability evaluation this was the
first dead end a manual CLI user hit — reached by following the tool's own printed advice.

Fixed by pointing the remediation at `agentmonitors session start` — the flagless lazy-boot path that
matches real usage (the `SessionStart` hook runs exactly this command; 005 §10.4): it boots the
project daemon if needed and registers a lead session in one shot, and has no required options so it
can never fail with a missing-required-option error. For the manual case the hint now prints the exact
stdin payload `session start` reads (`session_id` + `cwd`, delivered as JSON on stdin like a real hook)
with an explicit `manual-cli-session` placeholder, so the printed command runs verbatim. The existing
issue #335 self-diagnosing invariant is preserved: the `detail` and remediation still name the exact
workspace path doctor searched. `session open`'s own required-flag contract is unchanged (non-goal).

## 2026-07-16 — `doctor` survives version-skew daemons; a down daemon with a registered lead session fails instead of idling (005 §15) — Refs #382

Two follow-on bugfixes to `agentmonitors doctor`'s exit-code contract (§15), both discovered by
review after the #373 fix above.

- **Version-skew crash.** A still-running **older** daemon build that predates a request method the
  current CLI's schema knows about (e.g. `doctor.report` itself) can only reply with the socket
  protocol's legacy unparseable-request sentinel (`{ id: "invalid", error: "Invalid JSON request." }`).
  `doctor`'s daemon-vs-in-process fallback only recognized `DaemonConnectionError` (unreachable), so
  this sentinel surfaced as a fatal, user-visible crash instead of the intended graceful fallback to
  persisted state. Fixed in two parts: `callDaemon` (`apps/cli/src/daemon-ipc.ts`) now recognizes
  this exact sentinel — matched precisely on `id` **and** `error` text, never a substring/prefix
  check, so a genuine daemon-side application error is never misclassified — and raises a dedicated
  `DaemonUnsupportedRequestError` instead of a plain `Error`; going forward, a current daemon also
  attaches a machine-distinguishable `code: "unsupported_request"` alongside the unchanged legacy
  `id`/`error` pair (additive — an old client's schema simply ignores the new field, so a new daemon
  talking to an old client is unaffected). `doctor`'s fallback catch now accepts both
  `DaemonConnectionError` and `DaemonUnsupportedRequestError`, falling back to
  `doctorReportInProcess` for either.
- **Down daemon + registered lead session should fail, not idle.** `daemon-reachable`'s `idle`
  classification (added by the #373 fix) was previously unconditional — a down daemon was always
  `idle`, even when a lead session **is** registered for the workspace. But a registered lead session
  means an agent session is actually open right now; a down daemon in that state is not "nothing's
  open yet" (the case `idle` exists for) — it is almost certainly a mid-session daemon crash, a real
  problem that should not exit 0. `buildChecks` now classifies `daemon-reachable` as `fail` (not
  `idle`) precisely when `!daemonRunning && report.hasLeadSession`, with a `detail` naming the
  registered lead session instead of the "expected when no agent session is currently open" wording
  (which would be false in this state); the `idle` classification remains for the no-lead-session
  case. As a low-cost improvement in the same change, `daemon-reachable`'s `detail` also threads the
  underlying `DaemonConnectionError`/`DaemonUnsupportedRequestError` message through so a timeout
  ("daemon present but not answering") reads differently from no daemon process at all or a
  version-skewed daemon that rejected the request.
- **Verified by** `apps/cli/src/daemon-ipc.test.ts` (sentinel recognition, precise non-substring
  matching against a real application error, and the server-side `code` field) and
  `apps/cli/src/commands/cli.integration.test.ts` (`describe('doctor (issue #267)')`): a fake
  old-daemon server answering the legacy sentinel for `doctor.report` proves `doctor` falls back and
  exits 0 without ever printing the raw sentinel text; a real daemon killed while a lead session is
  registered proves `daemon-reachable` fails (exit 1) while `lead-session` itself still passes.

## 2026-07-15 — `init --command` seed for command-poll + untouched-default `validate` warning (005 §2, §3) — Refs #388

`init <name> --type command-poll` always scaffolded the fixed default command `git ls-remote origin
refs/heads/main`, regardless of the author's intent. Because that default still **validates** and
still **runs**, a scaffold left untouched silently watched the wrong thing for any other intent
(e.g. an author wanting "uncommitted changes" — `git status --porcelain`) — worse than a hard
failure, which is at least visible (blind usability evaluation, issue #388).

- **005 §2 — new `--command` seed flag.** Mirrors `--glob`: repeatable, scaffold-form only, seeds
  `watch.command` **one argv token per flag, order-preserving** (`--command git --command status
--command --porcelain` → `command: [git, status, --porcelain]`). Each token is emitted as a
  single-quoted YAML scalar so leading-dash tokens / spaces / `#` / `:` round-trip verbatim; the CLI
  never whitespace-splits, so it never invents shell semantics the source lacks (spec 003
  command-poll is argv, no shell). Rejected for any `--type` other than `command-poll` with a clear
  stderr message and no directory created, mirroring `--glob`'s guard.
- **005 §2/§3 — untouched-default is no longer a silent trap.** The template keeps the illustrative
  upstream-tip default when `--command` is omitted (so it still validates and runs), but `validate`
  now emits a **soft, non-fatal warning** for a `command-poll` monitor whose `watch.command` still
  equals the exact untouched default. The warning does not change the valid/invalid counts or the
  exit code; it is safe to ignore when upstream-tip polling is the real intent.
- **005 §3 — additive `warnings` output.** Text output gains an optional `Warnings: <n>` section
  (omitted when empty); JSON output gains a `warnings: [{ id, warning }]` array (`[]` when none).
  Additive only — the valid/invalid counts, exit code, and existing JSON keys are unchanged, so
  existing consumers are unaffected.

## 2026-07-15 — `init <name>` always seeds a derived `name:` (005 §2 current) — Refs #375

`init <name>`'s scaffold path previously left `name:` as the chosen `--type`'s literal template
placeholder (`My monitor`, `Upstream branch monitor`, …) whenever `--name` was omitted, so a
rushed author could commit a monitor that was never renamed to describe what it watches.

- **005 §2 — current.** `--name` is no longer the only way `name:` gets seeded: when omitted, the
  scaffold now derives a readable value from the positional `[name]` (`-`/`_`-separated segments
  joined with spaces, first segment capitalized — e.g. `watch-docs` → `Watch docs`) and seeds that
  instead. `--name` still overrides with its own value, verbatim. This only affects the named
  scaffold path (`init <name>`); the bare bootstrap path (`init`, no name) is unaffected, per the
  issue #330 non-goal that bootstrap scaffolding stays untouched by seed-flag work.
- **005 §2 — current.** The `command-poll` template's inline comment previously warned that local
  commands "such as `git status`" can stay stale until a fetch — backwards advice that
  contradicted the `skill.md` authoring guide's own recommended minimal `command-poll` example,
  `git status --porcelain`. The comment now scopes that staleness caveat to a local read of a
  remote-tracking ref (e.g. `git rev-parse origin/main`); the scaffold's own `git ls-remote`
  queries the remote live and is always current, and `git status --porcelain` is local
  working-tree state with no fetch lag — so the comment no longer discourages a correct,
  guide-recommended setup.

## 2026-07-16 — First-class `verify` command replaces the manual Phase-5 proof recipe (005 §16, new) — Refs #399

The manual "prove it, right now" verification recipe (getting-started + skill.md Phase 5) was the
single most concentrated DX liability across four rounds of blind usability evaluation: it demanded
an expert shell dance (custom `--socket`, scratch `AGENTMONITORS_DB`, backgrounded daemon with
`trap` cleanup, hand-built hook JSON payloads, two poll loops with two different budgets, two
session-id concepts) and broke down for nearly every struggling subject — fixed-40s poll loops that
under-shot the 30s-default interval, an undocumented `suppressed` state, a `doctor` false-negative
against the recipe's throwaway socket, and silent daemon death. Two subjects explicitly asked for a
single command.

- **005 — new §16, "`verify` — Prove a monitor delivers end-to-end."** Adds a **top-level**
  `agentmonitors verify [monitor]` (sibling of `doctor`, not a `monitor` subcommand — it is an
  active, stateful, daemon-booting proof, not a read-only inspector). It boots a **supervised
  isolated daemon** (temp socket + db, reaping disabled) by default, registers a throwaway lead
  session, triggers a **real** change (auto scratch-file for file-fingerprint pattern globs, a
  restored-on-exit edit for literal globs, or `--manual` watch mode), polls with an
  **interval-aware budget derived from the monitor's own `interval` + notify settle (+ high-urgency
  15s claim-settle) + margin** (not a fixed 40s) while printing elapsed/ETA to stderr, interprets
  the observation pipeline in plain language (`triggered` = success; `no-files-matched` = fail-fast;
  `no-change` = fail-fast **unless** a `debounce`/`throttle` settle is holding the change, in which
  case a `suppressed` row keeps the wait alive until the flush `triggered` rather than being a
  distinct reported outcome; **`daemon-died`** surfaces the daemon's own error), confirms delivery
  via the **real `hook deliver` claim path**, and prints one clean **PASS** (echoing the delivered
  `additionalContext`) or **FAIL** (naming the failing stage — the stage that was actually in flight
  on a mid-run daemon crash). It tears down everything it created; `--use-workspace-daemon` instead
  targets and leaves running the real workspace daemon so a follow-up `doctor` reflects the delivery.
  The detection-budget override flag is `--timeout-ms` (milliseconds, matching the `--poll-ms` /
  `--reap-after-ms` convention).
- **005 §16 → §17 renumber.** The former "Exit codes & diagnostics" section is now §17 (no other
  doc references it by number; mirrors the earlier §15/§16 renumber when `doctor` was added).
- **Fix (current).** Implemented in `apps/cli/src/commands/verify.ts` with pure helpers in
  `verify-budget.ts` (interval/settle budget, scratch-path derivation) and `verify-report.ts`
  (PASS/FAIL renderers), wired into the CLI command tree next to `doctor`. The budget's interval /
  settle inputs come from a new canonical `schedulingDefaults` export in `@agentmonitors/core` (the
  same values `service.ts` schedules against), so the estimate can't drift from real scheduling;
  literal-vs-pattern glob classification and scratch-path derivation use the real `glob` matcher's
  `hasMagic` (so `?`, `[…]`, and `{…}` are recognized as wildcards, not just `*`). The
  getting-started / skill.md recipe replacement (demoting the manual recipe to an appendix) is a
  deliberate follow-up, not part of this change.
- **Verified by** `apps/cli/src/verify-budget.test.ts` (spec-derived budget math + glob→scratch-path
  derivation, including non-`*` glob magic), `apps/cli/src/verify-report.test.ts` (PASS / stage-named
  FAIL / distinct `daemon-died` rendering), `apps/cli/src/commands/verify.test.ts` (mid-run crash
  blames the in-flight stage), `libs/core/src/runtime/scheduling-defaults.test.ts` (defaults pinned
  to 002 §4.4/§9.1), and `apps/cli/src/commands/verify.integration.test.ts` (real file-fingerprint
  change → PASS with delivered `additionalContext` and scratch cleanup; a `debounce` monitor still
  reaching PASS despite `no-change` ticks while it settles; `no-change` and `budget-exceeded` FAILs
  naming the correct stage; monitor-not-found / ambiguous setup errors).

## 2026-07-15 — Test-bearing packages must fail on a zero-test suite (004 §2.8, new) — Refs #288

Every test-bearing package (`libs/core`, `apps/cli`, `apps/agentmonitors`, every
`plugins/source-*`) configured `passWithNoTests: true`, so an accidentally emptied, renamed away
from, or excluded test suite left that package's Nx `test` target reporting green instead of
failing — a silent, high-leverage false pass for a repo that relies on package-level suites as
executable evidence for durable-state and delivery invariants. Only `apps/cli`'s serial
daemon-spawn suite (`vitest.serial.config.ts`) already had this correctly
(`passWithNoTests: false`).

- **004 — new §2.8, "Suite-discovery integrity (zero-test guard)".** Every test-bearing package's
  vitest config MUST reject an empty/misconfigured run (vitest's own default,
  `passWithNoTests: false`) rather than opting into `passWithNoTests: true`. `apps/cli`'s default
  and serial suites additionally MUST partition the package's test files without overlap or gaps.
- **Fix (current).** Flipped `passWithNoTests` to `false` (explicit, matching the already-correct
  serial-config pattern) in `libs/core`, `apps/cli`, `apps/agentmonitors`, and all five
  `plugins/source-*` vitest configs. No intentionally-testless project exists among the current
  test-bearing packages, so no documented exception was needed.
- **Verified by** `scripts/vitest-pass-with-no-tests.test.ts`: dynamically imports every guarded
  vitest config (the real module `vitest run` loads, not a hand-parsed approximation of the file's
  source text) and asserts none resolve to `passWithNoTests: true`; the guarded set derives from
  the authoritative `PACKAGE_DIRS` list (`scripts/publish-release-packages.mjs`) plus the serial
  CLI config, so a newly added publishable package is covered automatically and can't silently
  reintroduce `passWithNoTests: true`. `scripts/cli-suite-partition.test.ts`: runs the real
  `vitest list --filesOnly --json` resolution against both `apps/cli` vitest configs and asserts
  the result partitions the package's git-tracked test files with no overlap or gaps. Empirically
  confirmed pre-fix behavior by temporarily emptying a plugin's test directory and observing
  `vitest run` exit 0 with `passWithNoTests: true`, then exit 1 once flipped to `false`.

## 2026-07-15 — Declaring a watch is session activity; ephemeral read-isolation scoped to unscoped enumeration (002 §6.2 / 007 §4.4, §4.6) — Refs #312

Two clarifications to the ephemeral-monitor contract, both surfaced while hardening the
per-session dormancy path against event loss.

- **002 §6.2 / 007 §4.4 — declaring a watch resets the dormancy clock (behavior change).**
  Per-session dormancy previously advanced a session's `lastActiveAt` only on `claimDelivery` and
  recap. A session that declared an ephemeral monitor and then blocked on one long, hook-silent
  tool call (exactly what a watch is declared to wait for) could therefore cross the dormancy
  window with no activity signal and have its just-declared watch reaped mid-wait — silently
  losing the finishing event. Declaring an ephemeral monitor is now itself session activity and
  advances `lastActiveAt`. Additionally, the dormancy trigger considers a session's effective
  last-activity to be `max(lastActiveAt, newest active ephemeral declaredAt)`: a session with an
  ephemeral monitor declared **within** the dormancy window is not treated as dormant, so its
  watches survive at least one window past the declaration. A crashed session stops declaring, so
  its newest declaration ages out and cleanup still bounds. **Open (deferred):** whether a live
  session should hold its watches for an arbitrarily long blocking wait — longer than one dormancy
  window — is an unresolved spec decision, tracked as a follow-up to #312.
- **007 §4.6 — ephemeral read-isolation binds unscoped enumeration only (decision).** The read
  half of ephemeral isolation applies to **unscoped** (session-less) enumeration, not to a
  `monitorId`-targeted read that names a specific ephemeral id. A `monitorId`-targeted
  observation-history read is an operator-level diagnostic (`monitor explain` / `doctor`), not a
  session-isolated surface: knowing the full `ephemeral:<sessionId>/<ulid>` id is itself operator
  knowledge, and under the local single-operator trust model (PP10) it MAY return that monitor's
  observation-history audit rows across session boundaries. The **events** surface is stricter by
  design — an ephemeral event body carries the declaring session's private free-text instruction,
  so `events list` excludes ephemeral rows on any session-less read, including one naming the id.

## 2026-07-15 — `doctor` reads the live daemon first; expected-idle checks no longer force exit 1 (005 §15) — Refs #373

Two bugfixes to `agentmonitors doctor`, both in 005 §15.

- **Transport (root cause of the under-reporting bug).** `doctor` previously read its per-monitor
  rollup **always** in-process (`doctorReportInProcess`), even when a live daemon was reachable. A
  separate SQLite reader connection opened fresh against the same on-disk file as a live writer's
  connection can observe that writer's commits with a lag — WAL visibility across processes is not
  the same immediacy guarantee same-connection reads get — so against a genuinely running daemon that
  had just materialized a real event, `doctor`'s rollup could freeze `last-observed`/`last-event` at
  an earlier tick and under-count `unread`/`claimed`/`acked`, while `events list`/`monitor history`
  (served straight from the live daemon's own connection) already showed the current, real state.
  Fixed by adding a `doctor.report` daemon-socket RPC method and preferring it whenever the daemon is
  reachable — mirroring the existing `monitor explain`/`monitor history` socket-first,
  in-process-fallback pattern — so the rollup is read from the exact connection that wrote the data.
  The in-process path (`doctorReportInProcess`) remains the fallback for when there genuinely is no
  live daemon to ask.
- **Exit-code semantics.** `daemon-reachable` and `lead-session` previously counted as `fail` even
  though both checks' own `detail` text (added by issue #331) already says failing is "expected when
  no agent session is currently open" — so a scripted/agent caller doing `agentmonitors doctor && …`
  treated a healthy idle workspace as broken. Both checks now use a new `idle` status (glyph `◇`,
  distinct from `pass` ✓ / `fail` ✗ / `skip` ○) instead of `fail` when they don't pass, and `idle`
  does not count toward the non-zero exit code — only a genuine `fail` does. Their remediation and
  "expected when idle" wording are unchanged; only the status classification and exit-code weight
  changed. Text/JSON summaries report a fourth `idle` count.
- **Verified by** `apps/cli/src/commands/cli.integration.test.ts` (`describe('doctor (issue #267)')`):
  a live-daemon test fires a real file-fingerprint change against a running daemon and asserts
  `doctor`'s JSON rollup (`lastObservedAt`/`lastEventAt`/`delivery.unread`) equals the newest rows
  from `monitor history`/`events list` for the same workspace; idle-only scenarios (daemon down, no
  lead session) assert exit 0 and the `◇`/`idle` status; a genuine failure (project not enabled)
  combined with idle checks still asserts exit 1, proving idle never masks a real problem.

## 2026-07-15 — `monitor history`/`monitor explain` unified with `doctor`/`daemon status`/`session open` socket auto-discovery (005 §1, §6) — Refs #374

`monitor history` and `monitor explain` previously resolved their daemon socket via the bare
`resolveSocketPath()` global default, bypassing `resolveManualDaemonSocketPath()` — the
per-workspace auto-discovery every other manual daemon command (`doctor`, `daemon status`,
`session open`, etc.) already used (issue #335/#349). A daemon booted for the current workspace
(e.g. lazily by a Claude Code session) was therefore invisible to `monitor history`/`monitor
explain` unless `--socket` was passed explicitly — surfacing as a factually wrong "No daemon
running and no persisted state to show" even while `doctor`/`daemon status` confirmed a live
daemon seconds earlier (blind usability evaluation, subjects F3/F4).

- **005 §1 "Socket path resolution" — updated.** `monitor history` and `monitor explain` added to
  the list of commands that insert the enabled workspace's socket via
  `resolveManualDaemonSocketPath()`, keyed off `--workspace` (defaulting to the process cwd, same
  as `doctor`). For `monitor history`, the existing opt-in `--workspace` row filter (issue
  #345/#307) now also selects which workspace's daemon/db to reach.
- **005 §6 "monitor history"/"monitor explain" — updated.** Their no-daemon in-process SQLite
  fallback (`explainMonitorInProcess`/`listObservationHistoryInProcess` in `runtime-client.ts`,
  now both **require** a `dbPath`, matching `doctorReportInProcess`) reads the same
  workspace-resolved db (`resolveWorkspaceDbPath()`) `doctor` reads, instead of the bare global
  default — so the fallback's "nothing persisted" diagnosis is no longer looking at the wrong
  database. Requiring (rather than defaulting) `dbPath` keeps a future caller from silently
  skipping that resolution.
- **005 §6 — remediation text updated (review follow-up).** The "daemon down, nothing persisted"
  message is now worded according to whether the workspace is actually enabled — i.e. whether
  `resolveManualDaemonSocketPath()` really derived a workspace-scoped socket, or the probe fell
  through to the bare global default: an enabled workspace reads "No daemon running **for this
  workspace** and no persisted state to show. ... if the daemon you want lives at a different
  socket, point at it with `--socket <path>`."; a not-enabled workspace reads "No daemon running
  **at the default socket** and no persisted state to show. ... enable this workspace so its
  socket is auto-discovered (`agentmonitors init --enable-only`), or point at the daemon you want
  with `--socket <path>`." The original single wording overclaimed workspace scoping in the
  not-enabled case.
- **Non-goals (unchanged):** the per-workspace socket/db derivation mechanism itself
  (`workspacePaths()`, `resolveWorkspaceDbPath()`) and `--socket`'s explicit-override precedence
  are untouched (#349/#335) — this entry only extends which commands feed their workspace into
  that existing mechanism.

## 2026-07-15 — `file-fingerprint` filters directory entries from glob matches (003 §3.2) — Refs #377

A globstar pattern like `docs/**` matches the directory entry `docs/` itself, in addition to every
path under it — `glob`'s documented globstar behavior, not a pattern-authoring mistake. The source
previously passed every matched path (including directory entries) to `fs.readFile`, crashing with
an unhandled `EISDIR` the first time an author wrote the most natural "watch a folder" glob. Two
independent usability-evaluation subjects hit this as their top blocker.

- **003 §3.2 — behavior fix (current).** `expandGlob` now calls `globSync` with `nodir: true` (in
  addition to the existing `absolute: true`), for both `globs` and `ignore` expansion. Directory
  entries never enter the matched-files set, so `docs/**` behaves as "every file under `docs/`,
  recursively" and no longer crashes. This is a **fix**, not a new contract: the intended behavior
  was always "hash the files a glob matches," and a directory was never meant to be treated as a
  file to hash. `nodir` alone is incomplete: it is `lstat`-based, so a symlink whose target is a
  directory survives it unfiltered. A second, `stat`-based (symlink-following) directory check
  (`isDirectory`) now runs immediately before hashing each matched path, closing that gap so the
  same `EISDIR` can't recur via a symlinked directory.
- **003 §3.2 — clarification (current).** A glob that matches only directory entries (e.g. an empty
  directory watched with `**`) already fell into the existing `no-files-matched` outcome path once
  directory entries are filtered — this was already specified as a healthy non-error outcome, and no
  contract change was needed there.
- **CLI diagnosability (`apps/cli/src/commands/monitor-test.ts`).** `agentmonitors monitor test`'s
  `no-files-matched` message now names the configured `watch.globs` value (e.g. `No files matched this monitor's globs (globs: **/*.ts). Check watch.globs and watch.cwd relative to workspace: <path>`),
  so an author can tell "bad glob" from "no changes since baseline" without opening `MONITOR.md`.

## 2026-07-15 — Onboarding-doc corrections: baseline race, one-shot hook-deliver, isolated-socket `doctor` (Refs #376)

No numbered-spec behavior change — the runtime already behaved as described below; only
`apps/website/public/skill.md` and `apps/website/src/pages/docs/getting-started.md` were corrected
to say so accurately. A blind usability evaluation found three gaps in the Phase 5 ("prove it
fires") verification recipes:

- **Baseline race, undocumented for every source but `command-poll`.** Confirmed against
  `libs/core/src/runtime/service.ts`'s `scheduleForMonitor` (a monitor with no prior observation is
  always "due," so a source's very first tick runs immediately when the daemon starts, before
  waiting `--poll-ms`) and each bundled source's `observe()`: `file-fingerprint`, `api-poll`, and
  `incoming-changes` — like `command-poll` — treat that first tick as a silent baseline (no _change_
  observation emitted; `command-poll` is a partial exception — a first-ever command that fails still
  surfaces a health observation on that tick); a change that lands before it completes is folded
  into the baseline and never detected. `schedule` has no baseline concept. Both docs now state this
  per source and the verify recipes wait one full poll interval after daemon start before
  triggering, for every source.
- **The `hook deliver` step in the "Prove it" recipe was a single invocation**, not a retry loop,
  even though a `high`-urgency monitor's ~15s claim-settle window (002 §9.1) makes an
  empty first result expected. It's now a retry loop mirroring the `events list` poll loop above it,
  confirmed against `apps/cli/src/commands/hook.ts` (`hook deliver` prints nothing at all —
  zero-byte stdout, not an empty JSON object — when nothing is yet claimable).
- **`doctor`/`monitor explain` after the isolated-socket recipe.** Both docs now note that the
  Phase 5 / "Prove it, right now" recipes run against an explicit `--socket`/`AGENTMONITORS_DB`, so
  a plain `agentmonitors doctor` right after a successful verify is expected to still report the
  monitor unobserved — confirmed against `apps/cli/src/commands/doctor.ts` and
  `apps/cli/src/commands/monitor-test.ts`'s `explain` subcommand, both of which auto-discover the
  workspace's own socket/database (falling back to the shared global default only when the
  workspace isn't enabled) and never resolve the recipe's throwaway `--socket`/`AGENTMONITORS_DB`,
  though both still honor `AGENTMONITORS_DB` when it's set in their environment.

## 2026-07-15 — `channel serve` resolves the per-workspace socket `session start` binds, ahead of a stale `AGENTMONITORS_SOCKET` (006 §4.1, 005 §13) — Refs #358

`channel serve` — the MCP server the `agentmonitors` plugin's `.mcp.json` spawns with no
flags — previously resolved its daemon socket directly (explicit `--socket` → `AGENTMONITORS_SOCKET`
→ the bare global default), never consulting an **enabled** workspace's persisted-or-derived
per-workspace socket the way every other workspace-aware command does
(`resolveManualDaemonSocketPath`, issue #335). So a `channel serve` process spawned exactly as the
plugin spawns it silently talked to a socket with no daemon listening, for the only supported
activation flow — the channel transport never pushed, though hook-state delivery (§3/§5) was
unaffected.

Fixed by giving `channel serve` its own socket resolution (`resolveChannelSocketPath` in
`apps/cli/src/commands/channel.ts`), **deliberately different** from `resolveManualDaemonSocketPath`:
an explicit `--socket` still wins outright, but an **enabled** workspace's persisted-or-derived
per-workspace socket now wins over `AGENTMONITORS_SOCKET` too — not just over the bare global
default. This is intentionally not the same precedence as the manually-typed `session`/`events`/
`hook`/`daemon` commands (where an explicitly-set env var is a deliberate interactive override and
correctly wins): `channel serve` has no interactive moment, so a stale `AGENTMONITORS_SOCKET` left
over from a different workspace must never win over the current, enabled workspace's own socket —
letting it do so would cross-connect the channel to another workspace's daemon (a session-isolation
break) or reproduce this issue's dead-socket symptom. A not-enabled workspace is unaffected: it still
falls back to `AGENTMONITORS_SOCKET`, then the global default, exactly as before. This mirrors the
isolation guarantee `hook deliver` already enforces (005 §12) by refusing to fall back past an
enabled workspace's own socket at all.

- **006 §4.1 — current.** The channel-server mechanism bullets now document the corrected,
  channel-serve-specific precedence (workspace socket before `AGENTMONITORS_SOCKET`) and why it
  differs from `resolveManualDaemonSocketPath`.
- **005 §13 — current.** `channel serve`'s `--socket` flag documentation and `--help` text now match
  the actual (fixed) resolution order, including the isolation rationale.
- **docs/uat/channel-transport.md** — the known-issue callout is updated to reflect the fix; step
  3's pre-seed workaround remains documented (harmless to keep) per the recipe's own guidance.

## 2026-07-15 — Ephemeral-monitor isolation + reap-race hardening (007 §4.2/§4.6, 005 §14.4) — Refs #312, #259

Follow-up hardening of the ephemeral-monitor primitive (below). Behavior changes, all _current_:

- **007 §4.6 — isolation is now a read invariant, not only a projection one.** An ephemeral
  monitor's instruction is the declaring session's private free-text guidance, so its events **MUST
  NOT** be returned by an **unscoped** (session-less) read that bypasses the projection gate. The
  runtime store now excludes ephemeral-monitor rows (recognised by the reserved `ephemeral:` id
  prefix, §4.3) from an unscoped `listEvents` and from the unscoped observation-history enumeration;
  the declaring session still reads its own ephemeral events via its session-scoped read.
  Persistent-monitor reads are unchanged. (Previously an unscoped `events list` could return a
  sibling session's ephemeral event body.)
- **007 §4.6 — reap-race: an in-flight tick must not deliver for a reaped watch.** A tick pre-fetches
  its active ephemeral monitors before `observe()` yields, so a `watch cancel` (or session
  close/dormancy) that races the observation could still project. Materialization now re-checks, at
  insert time, that the ephemeral monitor is still `active` and its declaring session is still
  `active`; if either was reaped, the observed event is retained (§4.4) but projected to **nobody**.
- **007 §4.2 — lead-only binding.** Projection delivers to lead sessions only, so a binding to a
  subagent session would observe forever but never deliver. A declaration against a non-lead session
  is now **rejected** at declaration time with a clear error (previously registered as a silently-dead
  watch).
- **005 §14.4 / 007 §4.2 — scope-parity claim made true by sharing the wrapper.** `watch declare`
  previously called `validateScope` directly and skipped the CLI `validate` command's BP3
  `change-detection.collection` friendly-error wrapper, so the "rejected with the identical diagnosis"
  claim was untrue for the keyed-collection case. Both paths now call one shared core helper,
  `validateWatchScope` (schema check + the collection wrapper), so the diagnosis is genuinely
  identical.
- **007 §4.2 — doc correction.** The `EphemeralMonitorRecord.instruction` / §4.2 "surfaced verbatim
  as the body" wording overclaimed: the instruction is a **fallback** body
  (`observation.body ?? monitor.instructions`), overridden when a source supplies its own body.
- **Verified by** the new cases in `libs/core/src/runtime/ephemeral-monitors.test.ts` (unscoped-read
  isolation, close-during-tick and cancel-during-tick reap races, retention-after-tick-then-reap,
  non-lead rejection, scope key `type` cannot override the source, and the keyed-collection parity
  diagnosis).

## 2026-07-15 — Ephemeral (agent-declared, session-scoped) monitors implemented (007 §4 target → current; 002 §6.2 added) — Refs #312, #259

The ephemeral-monitor model of 007 §4 (landed as _target_ via #282, the foundational primitive of
Epic #259) is now implemented. Agents declare session-scoped monitors that flow the **same** pipeline
as persistent `MONITOR.md` monitors (AP7). All entries below are _current_.

- **007 §4 — target → current.** A new `agentmonitors watch <source> --session <id> --scope <spec>
[--urgency] [--instruction] [--display-name]` declares an ephemeral monitor; `watch list` /
  `watch cancel <id>` (both session-scoped) manage them. The declaration binds to a resolved AgentMon
  session, is persisted in a durable `ephemeral_monitors` table, and returns — the daemon does all
  observation/scheduling/notify/persist/project/deliver (PP9/PP10). The CLI is thin over the daemon
  IPC (`watch.declare|list|cancel`, Zod at the boundary; AP6).
- **007 §4.2 — current, scope parity.** An ephemeral declaration is validated by the **same** core
  `validateScope` path as `agentmonitors validate`, so it cannot express a config a persistent
  monitor could not; an invalid scope is rejected with the identical diagnosis (proven in both paths).
  An **unbindable** declaration (unknown or non-active session) is **rejected**, never silently made
  global.
- **007 §4.3 — decision resolved (ephemeral-id scheme).** Reserved prefix
  `ephemeral:<sessionId>/<ulid>`. Collision with a persistent id is **impossible by construction**: a
  directory-derived persistent id (SP1) is a single path segment and can never contain a `/`, while
  every ephemeral id does. The prefix keeps `monitor_events.monitor_id` / `monitor explain` /
  `queryScope` unambiguous; the id is assigned once and never mutated (stable, SP5).
- **007 §4.4 — current, lifecycle + retention decision.** Active on declaration and evaluated on the
  normal tick. Reaped on explicit session close, on `watch cancel`, and on **per-session dormancy**
  (below). Reaping flips the record `active → reaped` (stamping `reaped_at`) and stops observation but
  **retains** its already-materialized events and projections (the declaring session goes dormant, not
  deleted) — so a late delivery is never dropped (PP1) and a reaped record is **never resurrected** on
  a later restart. While the session lives, the definition + durable state **survive a daemon
  restart** and re-hydrate on the next tick.
- **002 §6.2 — new rule (per-session dormancy trigger).** 002 previously specified only an explicit
  session close (§6.1). §6.2 adds an **inactivity** trigger: an `active` session whose `lastActiveAt`
  has not advanced for at least `DEFAULT_SESSION_DORMANCY_MS` (default 30 min) is transitioned to
  `dormant` at the start of the next tick (and its ephemeral monitors reaped) — a backstop for a
  session that vanished without an explicit close. This is a **per-session** transition, distinct from
  the daemon-wide idle self-termination of 002 §10.2. Overridable in-process for tests.
- **007 §4.6 — current, projection isolation.** An ephemeral monitor's events project into the
  **declaring session only**, never a sibling lead session in the same workspace — the runtime threads
  the declaring session id through materialization to a `restrictToSessionId` projection gate in
  `insertEvent`. This deliberately differs from persistent monitors' all-lead-session projection. Same
  pipeline stages and delivery transports (hook-state, `hook claim`) otherwise.
- **005 §14.4 — target → current.** The `watch` command section is now current; its earlier signature
  listed a `--until <cond>` fire-condition flag, which is deferred to the dependent-chain work (#124)
  and dropped from the current signature (the flag remains _target_).
- **007 §8 — decisions resolved.** The ephemeral-id scheme, per-session dormancy trigger, and event
  retention on reap are all resolved (above); `--until`/fire-conditions and the `snapshot`/`diff`/
  `summary`/`inspect` verbs remain _target_.
- **Verified by** `libs/core/src/runtime/ephemeral-monitors.test.ts` (declaration validity + scope
  parity, namespaced/unique/stable identity with impossible persistent collision, lifecycle —
  active-on-declare, reap-on-close, `watch cancel` immediate reap, restart survival while active, no
  resurrection after session end, dormancy reap and the non-reap of a live session — and projection
  isolation) and the real-daemon-IPC + real-CLI-contract
  `describe('ephemeral monitors: watch declare/list/cancel (007 §4 / 005 §14.4)')` suite in
  `apps/cli/src/commands/cli.integration.test.ts` (declare → tick → declaring-session-only event →
  hook-state + `hook claim` delivery → cancel; plus invalid-scope parity with `validate`).
- **Roadmap:** G17 retired to a shipped blockquote.

## 2026-07-14 — Watch-mode source-state checkpointing implemented (002 §2.4 target → current) — Refs #278

The watch-checkpoint core contract (002 §2.4, landed as _target_ via the #192 design pass) is now
implemented, unblocking a durable `file-fingerprint` watch mode: an active `watch()` source can now
durably write back its advancing change-detection state so a mid-watch daemon crash reconciles from
the last checkpointed baseline instead of re-emitting already-delivered changes. All entries below
are _current_.

- **002 §2.4 — target → current.** `ObservationContext` gains the optional
  `checkpoint?: (nextState: unknown) => Promise<void>` callback, supplied **only** on the `watch()`
  path (never `observe()`, which keeps using `ObservationResult.nextState`). Calling it durably
  writes the updated state into `monitorState.sourceState` for the watcher's own
  `(monitorId, workspacePath)` scope (002 §3, #345/#307), leaving notify state and
  `lastObservationAt` untouched. A checkpoint is a **state write only** — it never materializes or
  delivers an observation.
- **002 §2.4 — current, G14 serialization.** The runtime enqueues **both** checkpoint writes and
  `ingest()` on a single per-watcher promise chain, so a checkpoint whose durable write is in flight
  when an observation arrives completes **before** that observation is ingested (the G14
  durable-write-before-ingest ordering), and an ingest's read-modify-write of `sourceState` never
  interleaves with a checkpoint write of the same row.
- **002 §2.4 — current, failure isolation.** A checkpoint whose durable write throws MUST NOT abort
  the watcher: the runtime logs a `process.stderr` warning naming the monitor and resolves the
  callback, so even a source that does not guard `checkpoint()` keeps watching (a transient
  durability gap, not a protocol violation).
- **002 §2.4 — current, post-stop rejection.** A checkpoint delivered after the watcher's
  `AbortSignal` is aborted, or after the watcher is no longer the current active watcher for its
  monitor id, is **rejected** (one warning, no write) so a straggling `checkpoint(staleState)` can
  never clobber a newer baseline. Watcher shutdown flushes the serialization chain to a stable
  reference, so an in-flight checkpoint enqueued as shutdown begins is still awaited.
- **002 §2.3 — behavior fix (current).** A watcher **MUST** be released from the active-watcher set
  whenever it exits for **any** reason, including the `watch()` iterable completing normally — not
  only on error or `stop()`/abort. Previously a normally-completing (finite) `watch()` left its id
  permanently pinned, starving `observe()` forever and blocking any future `watchMonitors()` from
  re-establishing it. Each active-watcher slot now carries a per-watcher identity token
  (`Map<string, symbol>`) so a superseded watcher only ever releases its **own** slot, never a newer
  watcher's — this is also what makes the §2.4 post-stop rejection safe against a watcher that was
  superseded (not aborted). The "runtime does not persist a watcher's in-memory state" note also now
  cross-references §2.4: a source that opts into checkpointing has its state reconciled from the last
  checkpointed baseline on restart.
- **002 §2.4 — bugfix, pre-`try` setup leaked the active-watcher slot on a synchronous throw.**
  `consumeWatch`'s `getMonitorState` read, `watchConfig`, and the `watch()` invocation itself
  originally ran BEFORE the function's `try`, so a synchronous throw there (e.g. `SQLITE_BUSY`, or a
  source whose `watch()` validates its config and throws before ever returning an iterable — legal
  per the `ObservationSource.watch` type) rejected the watcher task's promise without ever reaching
  the `finally`, leaking the slot forever (silently darkening the monitor, with `onError` never
  firing). Fixed by hoisting that setup inside the `try`.
- **Verified by** `libs/core/src/runtime/service.test.ts`
  (`describe('watch-mode source-state checkpointing (002 §2.4)')`): checkpoint supplied on `watch()`
  and persisted-before-resolve; absent on the `observe()` path; in-flight, genuinely-delayed
  checkpoint ordered before a following ingest (the G14 serialization); checkpoint materializes no
  `monitor_events`; a failing checkpoint warns and the watcher survives; a real-SQLite restart
  round-trip reconciles a re-established watcher from the checkpointed baseline; a per-workspace
  checkpoint never mutates another workspace's row for the same monitor id; a post-stop checkpoint is
  rejected with a warning and no write; a normally completing `watch()` releases its active-watcher
  slot so `observe()` resumes; a `watch()` that throws synchronously before returning an iterable also
  releases its active-watcher slot (rather than leaking it) and is still reported via `onError`; and a
  superseded (non-aborted) watcher's stale checkpoint is rejected by the token comparison alone
  without touching its successor's persisted baseline. Public-type change shipped with an
  api-extractor rollup regeneration and a minor `@agentmonitors/core` changeset (the umbrella
  `agentmonitors` launcher re-exports nothing from `@agentmonitors/core`, so it is not part of this
  changeset; `updateInternalDependencies: "patch"` cascades it a patch bump automatically).

## 2026-07-15 — Document + harden the hook-deliver warning's untrusted-id rendering (005 §12.2.1, 006 §5.2.1) — Refs #329

The always-on unknown-session stderr warning (issue #329) renders an id taken from untrusted
stdin. Two follow-ups from a post-merge review:

- **005 §12.2.1 / 006 §5.2.1 — clarified (current).** Both sections now state the rendering
  contract the implementation applies: the id is JSON-string-escaped (control characters never
  reach the terminal raw) and truncated at 128 characters with a trailing `…` — matching how the
  same specs document the analogous `additionalContext` truncation contract with precision.
- **Not a contract change — CLI hardening:** the truncation now cuts at a Unicode code-point
  boundary (a raw `slice` could split a surrogate pair straddling the cap, leaving a lone
  surrogate rendered as a garbled escape), following the same rationale as `hook deliver`'s
  render-side `truncateForCap`. The escaping also covers what `JSON.stringify` alone leaves
  raw — DEL, the C1 controls (U+0080–U+009F, e.g. CSI), and the U+2028/U+2029 line/paragraph
  separators — so the "control-safe one line" wording holds for the full range, matching the
  C0/C1 handling in the render-side `sanitize`.

## 2026-07-14 — Namespace persisted monitor runtime state + observation history by workspace (002 §3, `monitor_state`/`observation_history` schema) — Refs #345, #307

Persisted `monitor_state` was keyed by `monitor_id` alone (it was the PRIMARY KEY, no
`workspace_path` column), and `observation_history` had no workspace column. Because the database
is global and the same monitor id can exist in unrelated workspaces (the getting-started default
`my-first-monitor` is the common collision), a second project reusing the id read the first
project's `source_state` and reported `descoped`/`deleted` changes for files that only ever existed
in the other workspace — a durable-state / workspace-isolation defect (issue #345; same mechanism
as #307).

- **002 §3 + `monitor_state` schema — changed (current).** State is now keyed by
  `(monitor_id, workspace_path)`: a surrogate `id` PK plus a UNIQUE index on
  `(monitor_id, COALESCE(workspace_path, ''))` (the NULL-safe pattern already used by
  `session_object_cursor`). Every runtime read/write threads its workspace scope — the tick loop,
  `ingest()`, `scheduleForMonitor()`, the watch path, and `explain`/`doctor`. Verified:
  `libs/core/src/inbox/schema.ts` (`monitorState`), `libs/core/src/inbox/db.ts` (DDL + unique index
  - legacy-table migration), `libs/core/src/runtime/store.ts` (`getMonitorState`/`setMonitorState`
    keyed by `(monitorId, workspacePath)`), and
    `apps/cli/src/workspace-isolation.integration.test.ts` (two-workspace/same-id/shared-DB repro,
    restart-safe).
- **`observation_history` schema — changed (current).** Adds a nullable `workspace_path`; scoped
  readers (`monitor explain`, `doctor`, `monitor history --workspace`) filter by exact workspace, so
  a same-id monitor elsewhere cannot leak its audit trail. An unscoped `monitor history` still tails
  across all workspaces.
- **Migration — one-time re-baseline (documented).** A pre-namespacing `monitor_state` was keyed by
  `monitor_id` alone, so the first open after upgrade **rebuilds** the table under the surrogate
  `id` PK (SQLite can't add it in place). The rebuild resets only `source_state` — which cannot be
  safely attributed to a workspace — so every monitor re-baselines cleanly on its first post-upgrade
  tick, emitting no spurious created/deleted/descoped events. The durable `notify_state` batch
  (`pendingDebounce`/`pendingRollup` — already-detected observations the runtime MUST redeliver,
  002 §4.4 / #109) is **preserved**, attributed to the workspace derived from each observation's
  monitor `filePath`, so no pending batch is silently dropped. Legacy `observation_history` rows are
  migrated additively (they keep `NULL` `workspace_path` and fall out of workspace-scoped queries),
  not reset by the drop. The rebuild runs inside one immediate transaction so concurrent first-opens
  serialize. This resolves the mechanism #307 tracks.

## 2026-07-14 — `hook deliver` warns on stderr, unconditionally, for an unresolvable `session_id` (005 §12.2/§12.2.1, 006 §5.2/§5.2.1) — Refs #329

`agentmonitors hook deliver` exited 0 with byte-empty stdout when the hook payload's `session_id`
matched no tracked AgentMon session — identical to the _expected_ empty output during the ~15s
high-urgency claim-settle window (002 §9.1). Issue #334 already added `--debug` for exactly this
class of ambiguity, but it is opt-in; an operator who does not know to reach for `--debug` cannot
tell "will never resolve" from "still settling" and ends up polling forever against a session that
can never deliver.

- **006 §5.2 step 6 / 005 §12.2 step 5 — changed (current).** When no tracked session matches the
  payload's `session_id`, the command now ALSO writes one line to **stderr**, unconditionally (not
  gated behind `--debug`): `hook deliver: no session registered for host session id "<id>"`. Stdout
  and the exit code are byte-for-byte unchanged — the Claude Code host never sees this line.
- **006 §5.2.1 / 005 §12.2.1 — clarified (current).** Documents this as the ONE quiet-return branch
  that is not silent by default, and why: every other branch (disabled workspace, unreachable
  daemon, settle-window hold, nothing pending, …) either resolves itself or reflects a genuinely
  idle state, so those remain `--debug`-gated exactly as issue #334 shipped them. An unresolvable
  `session_id` cannot resolve on its own, which is what makes silence there actively misleading
  rather than merely uninformative.
- **Implementation:** `apps/cli/src/hook-deliver-warnings.ts` (new) holds the pure line formatter,
  deliberately kept separate from `hook-deliver-debug.ts` (issue #334) since that module's lines are
  ALL gated behind `--debug` — a different concern from an always-on diagnostic. `apps/cli/src/commands/hook.ts`
  writes the line to `process.stderr` directly in the `!match` branch, before the existing (still
  `--debug`-gated) `describeNoSessionMatch` diagnosis.
- **No behavior change to stdout, exit codes, or the settle-window/holding branches** — those stay
  exactly as silent as before; only the never-resolvable unknown-session branch gained a signal.

## 2026-07-15 — Add the channel-transport manual UAT recipe (006 §4) — Refs #277

The channel transport's "Status: implemented" note has named an outstanding manual UAT
(channels are research-preview, not CI-able) since it shipped, but no written recipe existed —
"did the channel path regress" depended on whoever remembered how to test it by hand.

- **006 §4 — clarified (current), one-line pointer added.** The UAT-gating note now links
  [`docs/uat/channel-transport.md`](../uat/channel-transport.md), a numbered, copy-runnable recipe
  covering setup, the `<channel>` push and its field schema (§4.2), cross-transport dedup (§4.5),
  in-session acknowledgement via `agentmon_ack` (§4.3) verified through `events list`, and a
  blocked-channel step proving hooks-only delivery with a silent no-op (§6/NP-CH). No behavior
  changed; this is documentation-only.
- **Not a spec change — discovered while grounding the recipe in the real code.** `channel serve`,
  spawned with no `--socket` flag exactly as the plugin's `.mcp.json` spawns it, does not resolve
  the same per-workspace socket a `session start`-lazy-booted daemon binds to for an enabled
  project (it falls back to the stale global-default socket, where nothing is listening), so the
  channel push silently never arrives in the real, unmodified plugin flow. Filed as #358 with a
  confirmed repro and suggested fix; the UAT recipe documents a pre-seed workaround so the rest of
  the recipe (ack, dedup, blocked-channel) remains fully runnable in the meantime.

## 2026-07-14 — Local-data permission hardening: no split-brain, no daemon crash, degrade gracefully (002 §3.1, §10.3) — Refs #292

Review of the owner-only permission work surfaced correctness gaps in the same change; these
clarifications keep 002 §3.1/§10.3 _current_.

- **002 §10.3 — changed (current).** The long-socket-path fallback location _moved_ in #292
  (`/tmp/agentmonitors-<hash>.sock` → `/tmp/agentmonitors-<uid>/…`). `resolveSocketPath`'s fallback
  branch now **probes the legacy path** and, if a live daemon still answers there, returns it so
  upgraded clients keep talking to the pre-upgrade daemon instead of lazy-booting a second daemon on
  the same database (split-brain). The daemon only ever binds the new path, so one restart of the
  legacy daemon completes the migration.
- **002 §3.1 — clarified (current), degrade-gracefully rule.** Tightening is best-effort: when an
  artifact exists but is owned by another user (`EPERM`/`EACCES` — e.g. a hook-state path aimed into
  a shared group-writable directory), the helpers emit one structured stderr warning per path per
  process and continue rather than throwing. A single malformed/unexpected IPC request is answered
  with an error response, never allowed to crash the daemon.
- **002 §3.1 — clarified (current), socket birth + `:memory:` + per-process tightening.** The socket
  is bound under a restricted (`0o077`) umask so it is born `0600` (the post-bind `chmod` is
  defense-in-depth; the owner-only parent directory is the load-bearing guard because `chmod` follows
  symlinks). The Agent-Monitors-owned default socket directory is re-tightened on startup even for a
  `:memory:` database (no `createDb` file-tighten call site). Re-application is idempotent and
  performed once per process, so steady-state hook-state writes skip the `lstat`/`open`/`fchmod`
  cycle after first verification.

## 2026-07-14 — Local-data permission model: owner-only db/WAL/hook-state/lock/socket (000 §5 BP4, 002 §3.1, §10.2–§10.3) — Refs #292

Agent Monitors persisted its database, WAL/SHM sidecars, hook state, and IPC socket with
umask-derived default modes, and the long-socket-path fallback wrote a predictable
`/tmp/agentmonitors-<hash>.sock`. On a multi-user host with permissive home/XDG modes another local
user could read the database or connect to the unauthenticated socket. All entries below are
_current_.

- **000 §5 — new BP4 (current).** Added the boundary property "Local artifacts are owner-private":
  the single-user local trust boundary requires owner-only creation (dirs `0700`, files `0600`,
  owner-only sockets inside owner-only directories) and symlink-safe tightening of pre-existing
  world-readable artifacts on startup. Added to the 000 §7 cross-reference row for 002.
- **002 §3.1 — new normative section (current).** Defines the local-data permission model: which
  artifacts are `0700`/`0600`, the restricted-umask creation invariant, the tighten-on-startup
  migration, and the symlink-safe (`lstat` + `O_NOFOLLOW` + `fchmod`) rule. Notes that a
  user-chosen (`--socket`/`AGENTMONITORS_SOCKET`) or shared system socket directory is _not_
  tightened, and that Windows has no mode enforcement.
- **002 §10.3 — changed (current).** The long-socket-path fallback now resolves to
  `/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock` — an owner-only per-uid directory
  (atomic-`mkdir`-or-verify-owned) — instead of a predictable socket directly under world-writable
  `/tmp`. The base stays `/tmp` (not the platform temp root) so the substituted socket stays under
  the 100-char AF_UNIX limit on macOS.
- **002 §10.2 — clarified (current).** `daemon run`'s socket, socket directory, and startup-lock
  directory are owner-only.

## 2026-07-14 — Fresh-environment install-to-first-signal E2E, hooks path (004 §2.7, §3.5) — Refs #276

Added a new validation surface: a global-install, no-workspace-`node_modules` E2E proof
(`scripts/test-e2e-fresh-install-hooks.mjs`) that packs every publishable package, installs the
`agentmonitors` launcher from those tarballs into an isolated npm prefix, bootstraps a fresh
project with `agentmonitors init`, fires a `file-fingerprint` monitor, and confirms delivery
through the real `agentmonitors hook deliver` stdin/stdout contract ([006 §5](./006-agent-integration.md))
with a genuine `UserPromptSubmit` payload. Not a behavior change — the runtime/CLI contract is
unchanged; this closes a coverage gap (every other proof surface in 004 §2 runs inside the repo's
own workspace). Wired into CI per-PR (`.github/workflows/ci.yml`); measured runtime ~50-70s, in
line with the existing standalone-consumer step and the Docker-backed daemon tests
(`*.docker.test.ts`) that already run inside the generic Test step gating every PR.

Follow-up fixes from review: every CLI invocation now runs through the launcher package's own
installed entry point (`<prefix>/lib/node_modules/agentmonitors/bin/agentmonitors.cjs`) rather than
the `<prefix>/bin/agentmonitors` symlink, because `@agentmonitors/cli` and the `agentmonitors`
launcher both declare that bin name and npm's global install links it to whichever package sorts
first (`@agentmonitors/cli` always wins) — the symlink alone was silently testing the CLI's own
bin, never the launcher's `require.resolve` indirection this surface exists to prove. The baseline
sleep before mutating the watched file was replaced with a forced tick through the `daemon.tick`
socket method ([002 §10.4](./002-runtime-delivery.md), §10.5), which is deterministic rather than
racing the daemon's own poll interval.

## 2026-07-14 — DX papercut sweep: `events list` delivery state, `session open --format id`, symmetric file/directory redirects, bootstrap wording (005 §2, §6, §10.1, §11.1) — Refs #338

A blind DX study batch (S1 F3, S2 F4/F5, S5 F3/F4/F5/F7) found five small, independently-minor
frictions in CLI output and help text.

- **005 §11.1 — clarified (current).** `events list --unread` filters on an unacknowledged event
  (`acknowledgedAt IS NULL`, 002 §7), which **includes** claimed-but-unacknowledged events — a
  surprise for a debugger reading "unread" as "never seen" (S1 F3). Each returned
  `MonitorEventRecord` now carries an optional
  `deliveryState: 'unread' | 'claimed' | 'acknowledged'` field (only present for the session-scoped
  `events list` query) so a caller can tell the two apart; the CLI's text output gained a visible
  `deliveryState` column.
- **005 §10.1 — new `--format id` choice (current).** `session open --format id` prints just the
  bare session id — no JSON parsing needed to pull `.id` out of the `--format json` payload in a
  verification script (S2 F4).
- **005 §6, §3 — cross-referenced (current).** `monitor test` (a single-file command) given a
  directory now redirects to `agentmonitors validate`, symmetric with `validate`'s existing
  file-argument redirect to `monitor test` (S5 F3); previously it surfaced a raw `EISDIR` error.
- **005 §2 — reworded (current).** The bootstrap's "what happens next" summary no longer claims
  unconditionally that "monitoring starts automatically when you open a Claude Code session" (S5
  F5) — that's true only with the Claude Code plugin installed. It's now conditioned on the plugin
  being present, with the manual `agentmonitors daemon run` alternative stated on the next line.
- **Not a spec change — CLI-only:** required options (`session open --host-session-id`,
  `events list`/`ack --session`, `hook claim --session`/`--lifecycle`) now render `(required)` in
  their own `--help` description text (S5 F4); the `agentmonitors doctor` text-output banner now reads
  `agentmonitors doctor` instead of `AgentMon doctor`, matching the same command's own remediation
  text elsewhere in its output (S5 F7 — "AgentMon" stays the prose product name, never a command
  reference).
- **Verified, not changed:** S2 F5's "`command-poll` baselines on the first tick, detects on the
  second" claim (skill.md) is accurate for a fresh runtime database. The one observed run that
  contradicted it traced to the verification recipe reusing one database across runs
  (`daemon run`/`daemon once` defaulted to the machine-wide `~/.local/share/agentmonitors/inbox.db`
  at the time; since #349 they derive a per-workspace path, which reruns in the same directory
  still share) rather than a source-source bug; the recipe now exports an isolated
  `AGENTMONITORS_DB` per run, matching the pattern already used for its throwaway `$SOCKET`.

## 2026-07-14 — Add `hook deliver --debug`: opt-in stderr diagnosis for the silent-on-idle hook path (005 §12.2.1, 006 §5.2.1) — Refs #334

Blind DX study S3 F3 (High): `agentmonitors hook deliver` emits empty stdout + exit 0 both when
nothing is pending AND when the stdin payload is misconfigured (unknown session, workspace not
enabled, urgency held) — indistinguishable failure modes for the command most often run by an
invisible hook system. §5.1's silence-on-idle stdout contract is correct and unchanged; the gap was
that there was no way to ask "why" without breaking it.

- **006 §5.2.1 — new (current).** `--debug` writes a step-by-step diagnosis to **stderr only**,
  naming which §5.2 resolution step stopped (or succeeded) and, once a session is resolved, pending
  event counts by urgency plus a per-band hold reason: `settle-window` (002 §9.1), `already-claimed` /
  `coalesced-until-ack` (the SAME vocabulary the `monitor explain` reminder-suppression diagnosis
  uses, 002 §9.2/§9.3/§10.7, issue #333), or `deferred-by-cap` (issue #299's transport-owned cap
  sizing). Stdout is required to be byte-identical between a `--debug` run and a non-`--debug` run of
  the same payload against the same daemon state.
- **005 §12.2.1 — new (current).** The CLI-reference mirror of the above, plus the flag added to
  §12.2's option table.
- **No behavior change to stdout, exit codes, or hook wiring** (explicit non-goal) — `--debug` adds
  one extra read-only daemon call (`hook.diagnose`, a new pure `AgentMonitorRuntime.diagnoseHookDelivery`)
  before the existing claim; it never claims or mutates state.

## 2026-07-14 — Document `.agentmonitors/` and gitignore it from `init` (002 §11.3) — Refs #336

A blind DX study found `.agentmonitors/` — the project-root runtime directory the core creates the
moment a session opens (`defaultHookStatePath()` derives the location; `refreshHookState()` creates it when writing per-session `hook-state.json`) — was entirely
undocumented: no spec, skill, or getting-started doc mentioned it, so following the setup docs
exactly left `?? .agentmonitors/` in `git status`.

- **002 §11.3 — new status paragraph (current).** States explicitly that `.agentmonitors/` is
  host-agnostic runtime state, not source-controlled project content; every file under it is a
  materialized, regenerable projection of the runtime's SQLite store (never the source of truth),
  so it is always safe to delete; and it is project-local, so it is a `.gitignore` concern
  alongside `.claude/*.local.*`.
- **`agentmonitors init` (bare and `--enable-only`) now also gitignores `.agentmonitors/`** —
  `ensureGitignore()` checks/appends each required line independently, so a `.gitignore` that
  already has one line but not the other only gets the missing one appended.
- **No behavior change to where the directory is rooted or what it contains** — this only makes
  its existence, purpose, and gitignore status documented and automatic.

## 2026-07-14 — Explicit `--socket` substitution is announced; hash-collision risk documented (002 §10.3) — Refs #337

`resolveSocketPath()` now takes a `ResolveSocketPathOptions.explicit` flag. When a caller-supplied
override came from a literal `--socket` CLI flag (as opposed to `AGENTMONITORS_SOCKET`, a
`.claude/agentmonitors.local.md`-derived value, or the computed default) and the resolved path
exceeds the 100-character AF_UNIX limit, one warning line is now printed to stderr naming the
requested path, the limit exceeded, and the substituted path, before the existing hash-fallback
substitution proceeds unchanged. `daemon run`, `daemon status`, `daemon stop`, `session open/close/
list`, `events list/ack`, `hook claim`, `hook deliver` (only when `--socket` — not the
`.local.md`-derived socket — is the over-limit value), `channel serve`, `monitor explain`, and
`monitor history` all thread this through their own `--socket` flag. Env/default/local-state-derived
candidates continue to hash silently (unchanged).

Acceptance criterion 3 (stale-daemon safety for hash collisions) is satisfied at its documented
minimum bar rather than its preferred bar: the daemon IPC does not expose a single "this daemon's
workspace" identity a caller could check against without breaking the already-supported case of one
daemon serving sessions for multiple workspaces on the global default DB (§10.2), so an automatic
"error on workspace mismatch" was scoped out as a follow-up rather than risk a false-positive
regression. The risk itself, and why a wider fix needs a real per-daemon workspace handshake, is
documented in §10.3.

- **Proof:** `apps/cli/src/daemon-ipc.test.ts` — `resolveSocketPath()` unit coverage (explicit
  over-limit warns with requested/limit/substituted path; explicit under-limit is silent; non-explicit
  over-limit stays silent as before). `apps/cli/src/commands/cli.integration.test.ts` — a real
  `daemon run --socket <over-limit path>` subprocess: the pre-fix silent substitution now fails, and
  the stdout "listening on" line (§10.2) is unchanged.
- Patch changeset: `@agentmonitors/cli` (new stderr diagnostic on an existing CLI code path; no
  behavior change to what socket is ultimately used).

## 2026-07-14 — `init` scaffold form: seed flags `--glob`/`--name`/`--urgency` (005 §2) — Refs #330

A blind DX study (5 subjects) found 4 of 5 independently discarded and rewrote the scaffolded
`MONITOR.md` body because `init <name> --type <source>` had no way to seed the fields the user
had already stated — only `--type` was configurable, so every author hand-edited `name:`,
`urgency:`, and the source's path-pattern field by hand (error-prone, per the issue's cited
frontmatter-authoring footguns).

- **005 §2 — new optional flags on the scaffold form (current).** `--glob <pattern>`
  (repeatable), `--name <name>`, `--urgency <low|normal|high>` each replace the corresponding
  template field (value-preserving; `--name`/`--glob` re-emitted as single-quoted YAML scalars) when passed; omitting all three keeps `init <name>` byte-for-byte
  unchanged (unaffected regression coverage: `apps/cli/src/commands/cli.integration.test.ts`
  "AC4 regression"). `--glob` seeds `watch.globs` for `file-fingerprint` and `watch.paths` for
  `incoming-changes` — the two source types whose template has a path-pattern list — and is
  rejected with a clear stderr message (no directory created) for any other `--type`.
- **Bootstrap form unaffected (non-goal).** The bare `init` bootstrap path (§2 "Bootstrap form")
  accepts but does not consume the three seed flags — only the named scaffold form does.
- **Template audit (current, no spec change needed).** The per-source template table (005 §2
  "Templates") was re-verified against this entry's DX-study finding: each of the five
  `--type` templates already produces a source-appropriate `watch:` block with no cross-type
  leftover fields (`apps/cli/src/commands/cli.integration.test.ts` "AC1" parametrized
  regression, one case per source).

## 2026-07-14 — Make `doctor` the advertised front door (005 §2, §15; 006 §5.6) — Refs #331

A blind DX study (5 subjects) found 3 of 5 discovered `agentmonitors doctor` only by `--help`
spelunking — nothing pointed to it: not `init`'s closing summary, not error messages, not
remediation texts. Separately, running `doctor` right after the `setup-monitors` skill's
documented manual-verify recipe produced a scary-looking failing summary with no cue that
`lead-session`/`daemon-reachable` failing is expected once the recipe's throwaway daemon/session
are torn down.

- **005 §2 — both `init` forms' closing output (current).** The bootstrap form's "What happens
  next" summary (and its idempotent "nothing to change" re-run) and the named `init <name>`
  scaffold form's closing hint now both name `agentmonitors doctor` as the health-check next step.
- **005 §1 — manual daemon-unreachable message (current).** The shared "no daemon running for this
  workspace" stderr line (`session open/close/list`, `events list/ack`, `hook claim`) now also
  points at `agentmonitors doctor` for the full picture, alongside the existing `daemon run`
  fix-it command.
- **006 §5.6 — `SessionStart` monitors-found-but-disabled advisory (current).** The advisory text
  now also names `agentmonitors doctor`, not just the enable step.
- **005 §15 — `daemon-reachable`/`lead-session` fail-line wording (current).** Both checks' fail
  `detail` text gains one clause of context: this state is expected when no agent session is
  currently open (the common post-manual-verify state), not evidence of a broken setup. The
  exit-code contract is unchanged (issue #331 non-goal) — only the wording changed.

## 2026-07-14 — Clarify: the normal/low reminder is coalesced-until-ack, and its suppression is explainable (002 §9.2, §9.3, §10.7, §13.3) — Refs #333

A blind DX study subject reported that a durable, unread `urgency: normal` event produced **no**
surfacing at any lifecycle: `hook claim --lifecycle turn-interruptible` returned `null` and
`turn-idle` returned "No pending delivery." Investigation verdict: **not a delivery bug.** §9.2's
guard was working exactly as written — the subject had run an _earlier_ `turn-interruptible` claim
that surfaced the reminder **and** claimed the event; the second identical claim was then correctly
suppressed because the reminder coalesces until acknowledgment. The real defect was that the
suppression presented as bare silence, indistinguishable from "nothing was ever pending."

- **002 §9.2 / §9.3 — clarified (current).** Spell out that delivering the generic reminder _claims_
  the underlying events, so once any unread normal/low event is claimed-but-not-acknowledged the
  guard no longer holds and the reminder is suppressed until acknowledgment or a fresh unclaimed
  event. A repeat claim returning `null` is intended coalescing, not a lost signal (the events stay
  unread and durable). No behavior change — the guard is unchanged; this documents what it already
  does.
- **002 §10.7 — extended (current).** The `monitor explain` projection-and-delivery stage now reports
  a `reminderSuppression` finding per session-and-band naming the reason (`already-claimed` /
  `coalesced-until-ack`) when the coalesced reminder is currently suppressed, so a `null` claim is
  inspectable (the silent-failure-honesty invariant, §1.1.8 / capability C12). The stage stays `ok`
  — a paused reminder is expected behavior, not a fault.
- **002 §13.3 — new example flow (current).** Documents the exact study sequence (first claim
  surfaces + claims; second claim `null`; `monitor explain` names the reason).
- **Core (current).** New pure `diagnoseReminderSuppression` (`libs/core/src/runtime/reminder-diagnosis.ts`),
  wired into the `delivery` stage of `explainMonitor`. No public-type or schema change; the finding
  rides the existing `MonitorExplainStage.details` record. Proven at three layers:
  `reminder-diagnosis.test.ts` (pure), the issue-#333 case in `service.test.ts` (real tick + explain),
  and the issue-#333 case in `cli.integration.test.ts` (real daemon + IPC `hook claim` + `monitor
explain`).

## 2026-07-14 — Unify per-workspace db/socket defaulting across `daemon run`/`once`, `doctor`, `daemon status`/`stop` (002 §10.2, 005 §9, §10.1, §15) — Refs #335

A directly-invoked `agentmonitors daemon run` — the Getting Started guide's own documented usage,
with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — bound to the bare global
default db/socket, while `doctor` (and `session start`'s lazy boot) already assumed an enabled
workspace gets its own isolated, derived-per-workspace db/socket. `session open`/`session list`/
`daemon status` all talked to the live daemon (or its actual default socket) and agreed the lead
session was active; `doctor` independently re-derived a _different_, empty SQLite file and reported
no lead session at all — three commands disagreeing about the exact same durable state (DX study S3
F5). Spec 002 §10.2 and 005 §15 already documented "the same way the daemon resolves them" as the
intended contract; the bug was that `daemon run`/`daemon once` never actually implemented it.

- **002 §10.2 — clarified (current).** "Per-workspace isolation" now states explicitly that the
  convention applies regardless of how the daemon was started — a directly-invoked `daemon run`/
  `daemon once` now resolves the identical per-workspace db/socket an enabled workspace's `doctor`/
  `session open` assume, not just the lazy-boot path. Updated the `Verified:` citation to include
  the new shared resolvers.
- **005 §"Socket path resolution" / "Database path resolution" — rewritten (current).** Documents
  the full, now-symmetric resolution order (env var → enabled workspace's persisted-or-derived
  per-workspace value → global default) and names every command that shares it: `session
open/close/list`, `events list/ack`, `hook claim`, `doctor`, `daemon run`/`once`, and — newly —
  `daemon status`/`daemon stop`, which previously used only `--socket`/the bare global default and
  would have silently disagreed with the other commands once this fix made `daemon run` bind
  elsewhere.
- **005 §9.1/§9.2 (`daemon once`/`daemon run`) — updated (current).** The `--workspace` flag rows
  now state it is resolved to an absolute path and drives per-workspace db/socket resolution.
- **005 §10.1 (`session open`) — updated (current).** The `--workspace` flag is now resolved via
  `path.resolve()`, the same way `doctor`/`daemon once`/`daemon run` resolve theirs, so a relative
  or trailing-slash value cannot silently diverge from `doctor`'s exact-string workspace match.
- **005 §15 (`doctor`) — updated (current).** The lead-session check's failure `detail` and
  remediation now name the exact workspace path doctor searched, so a future db/socket-derivation
  mismatch is self-diagnosing (compare directly against `session list`'s workspace column) rather
  than a bare "No lead session is registered for this workspace."
- **Implementation.** New shared `apps/cli/src/workspace-db-path.ts` (`resolveWorkspaceDbPath()`),
  used by `doctor.ts` and `daemon.ts`; `apps/cli/src/manual-daemon.ts`'s
  `resolveManualDaemonSocketPath()` now falls back to the derived per-workspace socket (not
  `undefined`/the global default) for an enabled workspace with no persisted socket yet;
  `daemon.ts`'s `run`/`once`/`status`/`stop` actions all resolve db/socket through these shared
  helpers instead of the bare global default. `MonitorDoctorReport.workspacePath` (core) tightened
  from optional to required, matching `DoctorReportInput.workspacePath`'s existing required field.
  Regression coverage: `apps/cli/src/commands/cli.integration.test.ts` `describe('daemon run/once
workspace-scoped defaulting (issue #335)')` drives the exact study sequence (init --enable-only →
  direct `daemon run` with no overrides → `session open` → `session list`/`daemon status`/`doctor`)
  end-to-end against the real built CLI; unit coverage in `workspace-db-path.test.ts` and
  `manual-daemon.test.ts` locks down the resolution order directly.

## 2026-07-14 — Cap-bounded hook redelivery: the claimed set must equal the rendered set (006 §5.5) — Refs #299

Spec 006 §5.5 promised that a high-urgency event truncated out of the 4000-char hook
`additionalContext` "re-delivers via the next context event", but the implementation claimed the
**full** settled candidate set before the render truncated it. A truncated-away event therefore had
`first_notified_at` set (claimed) while the pending-turn delivery selects only rows whose
`first_notified_at` is NULL — so it stayed unread yet was **never** re-surfaced automatically. That
is silent P1 signal loss for exactly the sessions with the most pending work, and it contradicted
the section's own guarantee.

- **006 §5.5 — rewritten & retitled (current).** "Unread-recoverability" is now
  "Unread-recoverability & cap-bounded redelivery" and states the contract explicitly: **the claimed
  set MUST equal the rendered set.** A length-bounded transport PREVIEWS the settled high-urgency
  delivery without mutating state (`previewSettledHighDelivery`), sizes how many WHOLE event blocks
  fit under the cap (reserving marker room; never a partial block), then claims exactly that many
  (`claimDelivery`'s `maxEvents`). The deferred remainder stays pending (`first_notified_at` NULL)
  and re-delivers in order at the next context event; every event also remains unread (claiming ≠
  acking, BP2 / SP4) until explicitly acknowledged. The truncation marker is appended whenever any
  pending event is omitted (block did not fit or transport deferred more). Non-high branches
  (reminders, `post-compact` recap) and uncapped callers (the channel transport) are unchanged.
- **No behavior change to acknowledgement, urgency, or projection** — only which events a capped
  `turn-interruptible` claim marks claimed now matches what it renders.

## 2026-07-14 — Plugin manifest must not re-reference the auto-discovered hooks/hooks.json (006 §hooks transport)

Claude Code auto-loads a plugin's conventional `hooks/hooks.json` and **rejects** a manifest
`hooks` entry that resolves to that same file ("Duplicate hooks file detected"), which failed the
plugin's hook load on install. The manifest `hooks` field may only name _additional_ hook files.

- **006 — clarified (current).** The lifecycle hooks remain authored as host-native
  `hooks/hooks.json`, but the doc now states the file is auto-discovered and that a manifest
  reference to it is a load-failing duplicate.
- **Implementation.** Removed `"hooks": "./hooks/hooks.json"` from
  `agent-plugins/agentmonitors/.claude-plugin/plugin.json`. Regression coverage added to the
  plugin config-drift UAT (`apps/cli/src/commands/cli.integration.test.ts`): the suite parses the
  real manifest and fails if any `hooks` reference resolves to the auto-discovered path.

## 2026-07-12 — Add `agentmonitors doctor`: one unified workspace health surface (005 §15, Appendix A) — Refs #267

Answering "is my monitoring working, and if not, where is it broken?" required stitching together
`daemon status`, `monitor explain`, `events list`, and `session list` and knowing non-obvious
distinctions (host vs AgentMon session ids; `monitor explain` verdicts that can disagree with
`events list`). There was no single health surface and no per-monitor last-observed / next-due
rollup — the #1 gap for "easy to see that it's working". `doctor` formalizes the ad-hoc probes the
setup-monitors skill performs into a first-class diagnose-only command.

- **005 §15 — new section (current).** Documents `agentmonitors doctor`: the named check sequence
  (`project-enabled`, `monitors-directory`, `monitors-valid`, `daemon-reachable`, `lead-session`,
  and per-monitor `monitor:<id>`), each with a pass/fail/skip status and an actionable remediation;
  exit 0 iff all checks pass. The per-monitor rollup (id, source type, cadence, last-observed,
  next-due, last-event, and unread/claimed/acknowledged counts for the workspace lead session, or an
  explicit never-observed / no-lead-session marker) and the stable `--format json` shape are
  specified here. `doctor` reads durable state **in-process** (accurate whether or not a daemon is
  running, like `daemon status` and `monitor explain`'s #150 read); the socket is used only for the
  `daemon-reachable` ping.
- **005 §15/§16 — renumber.** The former "Exit codes & diagnostics" section is now §16 (no other doc
  cross-references it).
- **Deliberately narrow (current).** Diagnose-only: no `--fix`, no host-plugin/MCP/channel checks,
  and no change to `monitor explain` (issue #267 non-goals). The `project-enabled` remediation names
  the same enable step as the `SessionStart` monitors-found-but-disabled advisory (006 §5.6) —
  creating `.claude/agentmonitors.local.md` with `enabled: true` — but leads with `agentmonitors init
--enable-only` (005 §2, Refs #268), the one-shot bootstrap command that now does that for you, so
  all three onboarding surfaces agree.
- **Core (current).** The workspace-wide durable-state diagnosis lives in
  `AgentMonitorRuntime.doctorReport()` (host-agnostic, per AP6), reusing the same store reads and
  scheduling logic as `explainMonitor`. The CLI layers the project-enabled and daemon-reachable
  checks (CLI-only concerns) and renders.

## 2026-07-12 — Bare `init` becomes a one-shot project bootstrap (005 §2) — Refs #268

`init <name>` only scaffolded a `MONITOR.md`; onboarding still required hand-creating
`.claude/agentmonitors.local.md` with `enabled: true`, fixing `.gitignore`, and knowing to do both
— steps documented only in the `setup-monitors` skill. Since time-to-first-signal is the product's
core adoption metric, that manual gap is now automated.

- **005 §2 — extended (current).** The section is now "Bootstrap the project, or scaffold a
  monitor". The `<name>` argument is documented as optional: with a name, `init` keeps its exact
  prior scaffold behavior (byte-for-byte); with no name, `init` runs a bootstrap that (1) enables
  the project using the skill's minimal `enabled: true` shape, (2) ensures `.gitignore` ignores
  `.claude/*.local.*`, (3) optionally scaffolds a first monitor (interactive on a TTY, `--yes`
  non-interactively, `--enable-only` to skip), (4) validates the result in-process, and (5) prints
  a next-steps + verify-firing summary. Added the `--enable-only` and `--yes` flags to the flag
  table and an idempotency note (a re-run on an already-set-up project changes nothing).
- **Non-goals (unchanged behavior):** no host-plugin install, no daemon start/persistence (lazy
  boot via `session start` already covers it — §10.4), no MCP, no changes to the monitor schema or
  the `validate` command. `init <name> --type …` output is unchanged.

## 2026-07-12 — 006 §6.1: "Operating without MCP" formalized and proven (006 §6.1, §9) — Refs #270

NP-CH (006 §2) already asserted that channels must be additive, never a dependency, but the hooks-only
mode itself was not named, and the claim that hooks + CLI form a _complete_ substitute for the
`agentmon_ack` MCP tool was undemonstrated. Added §6.1 "Operating without MCP", marked **current**,
stating the guarantee in one paragraph and pointing at the new proof:

- `apps/cli/src/commands/cli.integration.test.ts` — describe block `hooks-only delivery parity
(issue #270)` drives the full lifecycle (daemon boot via `session start`, monitor fire, delivery
  claim via `hook deliver`, acknowledgement via `events ack`, confirmation via `events list`), each
  step fed a real Claude Code hook stdin payload, with zero import/start/reference of the
  channel/MCP code path (`apps/cli/src/commands/channel.ts`).
- `apps/cli/src/commands/channel-hooks-ipc-parity.test.ts` — a separate static check (never imports
  or executes `channel.ts`; reads its source text only) confirming the `agentmon_ack` tool handler
  and the channel's outbound push route through the identical daemon-IPC client functions
  (`acknowledgeEventsClient`, `claimDeliveryClient`) that the hooks-only `events ack`/`hook deliver`
  CLI commands already call — the structural basis for the capability-parity claim.

§9 (Validation Implications) gained a matching bullet for the new proof. No behavior changed; this
is documentation + test coverage of an existing invariant (NP-CH), not a new capability.

## 2026-07-12 — Multi-host agent-facing interaction, ephemeral monitors & observability (new 007; 006 §11; 005 §14) — Refs #259

Formalizes the "Decided shape (2026-06-19)" of Epic #259 into normative spec text. **Spec-only; every
new rule is marked _target_** (nothing here ships yet), grounded on the ratified invariants PP9, PP10,
AP7, NP5 (000-principles, #191). Scope is **local hosts only** — the web-agent defer stands (closed
#126); push-not-poll is unchanged.

### New doc: 007 — Agent-Facing Interaction, Ephemeral Monitors & Observability (target)

Owns the **agent → daemon** direction (the complement of 006's daemon → agent delivery), given its
own numbered doc because request/declaration and delivery are opposite directions with different
contracts:

- **§2–§3 — agent-facing act-on-signal verbs.** Read-only `snapshot` / `diff` (point-to-point) /
  `summary` that read durable state (snapshots, events, cursors) without re-observing and without
  touching delivery state (no claim/ack/cursor move, SP4/BP2). Async-biased; transport (loopback
  HTTP vs the Unix socket) is an implementation detail. An agent acts **in response to a pushed
  signal**, never on a timer of its own (PP9, new non-property NP-AF).
- **§4 — ephemeral monitors.** Agent-declared, session-scoped monitors on the **same daemon and
  pipeline** as persistent `MONITOR.md` monitors (AP7): declared via `watch`, validated by the same
  `validateScope` path, namespaced runtime identity, reaped when the declaring session ends, durable
  across restart while the session lives, all deterministic work daemon-owned (PP9/PP10). Composes
  with dependent chains (#124) and per-binding fan-out (#258) rather than diverging.
- **§5 — observability surface.** `inspect` returns three **distinct** buckets — received / pending /
  **armed-but-not-yet-fired** — where "armed" is derived from the already-durable hold substrate
  (settle/debounce/throttle/rollup windows, `net`/Interpret suppression), a pure read that introduces
  no new watching.

### 006 §11 — Multi-host adapter matrix (target)

Generalizes the single `claudeCodeAdapter` to Claude Code / Codex / Cursor, each CLI + desktop. Fixes
the per-host adapter contract (lifecycle mapping, delivery lifecycle points, session identity,
workspace binding, delivery-surface state, availability/fallback), a **host-generic vs
Claude-specific** classification table of the current 006, the six-surface matrix (Claude current;
Codex/Cursor cells pinned by a per-host probe), the CLI-vs-desktop single-adapter rule, and the
invariant that delivery semantics never change across hosts. A new host is a new adapter, never a
runtime-core change (AP3).

### 005 §14 — Agent-facing verb command sections (target)

Concise target command sections for `snapshot`, `diff`, `summary`, `watch` (declare/list/cancel), and
`inspect`, each referencing 007 for the contract (mirroring how §13 channel references 006 §4). The
prior §14 (Exit codes & diagnostics) is renumbered §15; no external cross-reference targeted the old
§14.

### Supporting updates

- **000 §7** cross-reference index — new 007 row; AP3 added to the 006 row.
- **README** reading-order table + normative range (000–007).
- **glossary** — new terms: agent-facing verb, ephemeral monitor, armed (condition-met-but-not-fired),
  multi-host adapter matrix.
- **roadmap** — gaps G16 (act-on-signal verbs), G17 (ephemeral monitors), G18 (observability),
  G19 (Codex adapter), G20 (Cursor adapter), each with governing property, files, and proof.

Spec-only — no implementation or published-package behavior change, so no changeset. Concrete child
implementation issues are filed from this landed spec per the epic's "spec precedes build" gate.
Refs #259.

## 2026-07-12 — Fix silent opt-in dead-end: `SessionStart` advisory when monitors exist but the project is disabled (006 §5.6, 002 §10.2) — Refs #269

`session start`'s quick-exit for a not-enabled project was **fully silent** in every case,
including when the workspace already has `.claude/monitors/**` definitions and the user simply
never flipped `enabled: true` in `.claude/agentmonitors.local.md`. That combination was the worst
onboarding dead-end: monitors sit unobserved and nothing ever says why, forever.

- **006 §5.6 — extended (current).** Added a "Monitors-found-but-disabled advisory" bullet
  alongside the existing CLI-absent-guard bullet: `session start` now scans `.claude/monitors`
  before quick-exiting on a disabled project. Zero definitions found → unchanged fully-silent
  quick-exit (never nag a user who hasn't opted in at all). One or more found → a single
  `additionalContext` advisory (monitoring disabled, N monitors found, the exact enable step),
  still exiting 0 without opening a session or booting a daemon.
- **002 §10.2 — clarified (current).** The "Lazy boot" section's quick-exit description now
  cross-references 006 §5.6 for this case rather than leaving the reader to infer "not enabled"
  always means silent.
- This is a deliberately narrow fix: no auto-enabling, no advisory on any hook other than
  `SessionStart`, no change to the enabled-path behavior. See the non-goals in issue #269.

## 2026-07-12 — 005 catch-up: `init --type`, `command-poll` enumeration, full command inventory (005 §1, §2, §3, Appendix A) — Refs #265

005 had drifted behind the shipped CLI: it documented `init --source` (the real flag has been
`--type` since the source/scope → watch migration) and its bundled-source enumerations omitted
`command-poll`. Corrected by re-deriving every section from the built CLI's `--help` output and the
`apps/cli/src/commands/*.ts` sources rather than memory.

- **005 §1 — corrected.** "four bundled source packages" → five, adding
  `@agentmonitors/source-command-poll`. The `--version` note no longer hardcodes a literal (it drove
  stale immediately — the doc said `0.0.0` while the shipped CLI was already on `0.7.0`); it now
  states that `getVersion()` reads `package.json` at runtime.
- **005 §2 — corrected.** `init`'s flag table now documents `--type <type>` (not `--source`) with
  all five choices, matching `apps/cli/src/commands/init.ts`; added the missing `command-poll` row
  to the templates table.
- **005 §3 — corrected.** `validate --format json`'s documented shape was missing the `duplicateIds`
  field that `apps/cli/src/commands/validate.ts` has always emitted (same shape as `scan`'s
  `duplicateIds`).
- **005 Appendix A — corrected.** Added the missing `monitor explain` row (present in body prose,
  absent from the inventory table) and corrected `monitor history`'s transport to note its
  in-process no-daemon fallback, matching the already-documented behavior in §6 and matching the
  wording already used on the `daemon status` row.
- Full inventory pass against `apps/cli/src/index.ts` and every `apps/cli/src/commands/*.ts` file
  confirmed no other command/flag drift; the `source search|install|update|remove` placeholders were
  already correctly marked (§7.2–§7.5 headers and Appendix A `Placeholder / not implemented (NP3)`).

## 2026-06-30 — User-level monitor glob scoping: sigil-based syntax + workspace-agnostic events (001 §6.1, §7.5, §8; 003 §2.2, §3.5) — Refs #194

Formalizes the 2026-06-30 design-session decision on user-level monitor glob scoping for the
`file-fingerprint` source. All new rules are marked **target**; project-level behavior is
unchanged.

### Decision summary (v1 — this issue)

1. **Sigil-based scope, no discriminator field.** Leading `/` ⇒ absolute path; leading `~` ⇒
   home-relative; bare relative ⇒ project-relative. Matches universal Unix intuition and requires
   no new vocabulary.
2. **`~` / `~/…` expand to `os.homedir()`.** `~user` (other users' homes) is **not** supported
   and is rejected at validate time.
3. **No mixing of scope classes within one monitor.** Absolute + project-relative and
   home-relative + project-relative mixes are rejected by `agentmonitors validate`. Mixing
   absolute + home-relative is warned but not rejected.
4. **Ship the project-independent forms** (absolute / home / fixed file) — they emit
   workspace-agnostic (`workspacePath: null`) events that project into all lead sessions, reusing
   the existing `sessionsForWorkspace(null)` path.
5. **Bare-relative globs in a user-level monitor are rejected at `agentmonitors validate`** until
   project-relative fan-out is implemented (issue #258). Project-level monitors keep their
   existing behavior: bare-relative = workspace-relative, unchanged.

### Spec changes

- **001 §6.1 — new (target).** Authoring-level spec for the sigil syntax: leading-character
  scope table, `~` expansion rule, no-mixing rule, and the bare-relative-user-level rejection.
  Concrete `globs` authoring examples for all four cases (home-relative user-level, absolute
  user-level, bare-relative project-level, bare-relative user-level rejected). Cross-reference
  to 003 §3.5.

- **001 §7.5 — new (target).** A `~/notes/**/*.md` user-level monitor example that proves the
  home-relative form is the correct authoring pattern for files in the user's home directory; the
  resulting events are workspace-agnostic and project into all lead sessions.

- **001 §8 — extended.** Additional validate obligations listed for the three new rejection cases
  (bare-relative + user-level, `~user`, mixed scope classes).

- **003 §2.2 — clarified.** `context.workspacePath` note updated: for user-level monitors using
  absolute or home-relative globs, `workspacePath` is `null` and the source MUST NOT use the
  daemon process `cwd` as a fallback. Cross-reference to §3.5 added.

- **003 §3.5 — new (target).** Full source-level spec for sigil-based glob scope resolution:
  - §3.5.1 — scope-class determination table (per-pattern, leading-character sigil)
  - §3.5.2 — `~` expansion rule and `~user` rejection
  - §3.5.3 — no-mixing rule with accepted/rejected combinations and rationale
  - §3.5.4 — user-level monitor bare-relative rejection (validate guard + mechanism)
  - §3.5.5 — workspace-agnostic events (`workspacePath: null`, `sessionsForWorkspace(null)`)
  - §3.5.6 — six concrete `globs` examples (valid and invalid)
  - §3.5.7 — required test/validation matrix (8 scenarios drawn from the decision memo Proof)

### Follow-up

Project-relative fan-out (one user-level definition → N workspace-scoped runtime instances,
each with its own baseline and event stream) is tracked in issue #258, sequenced after #192.
This release ships the cheap, high-value project-independent forms only.

## 2026-06-30 — Event-driven file watching for `file-fingerprint`: `watch()` opt-in, `backend` field, reconcile-on-start, and watch-checkpoint contract (003 §3.1, §3.8–§3.10; 002 §2.4) — Refs #192

Ratifies the 2026-06-30 design-session decision. All new rules are marked **target** (not current);
none of this is implemented yet. The `file-fingerprint` source graduates to the first production
adopter of the `watch()` path.

### 003 §3.1 — `backend` scope field added (target)

The `file-fingerprint` scope schema gains an optional `backend` field
(`auto` | `fs-events` | `watchman` | `inotify` | `kqueue` | `windows`, defaulting to `auto`).
The field controls which `@parcel/watcher` backend is used for the watcher. Its failure-policy
semantics are specified in §3.9.

### 003 §3.8 — `watch()` opt-in and reconcile-on-start (target)

`file-fingerprint` MUST implement `watch()`, making it the default change-detection mechanism for
long-lived monitors. The watcher uses `@parcel/watcher` in auto mode (FSEvents / inotify /
ReadDirectoryChangesW / Watchman transparently, in-process, no mandatory external daemon).
`observe()` is retained — non-negotiably — for `daemon once` and for filesystems that cannot
deliver reliable events.

**Reconcile-on-start**: at watcher boot the source MUST run a one-shot `observe()` diff against
the persisted fingerprint baseline to surface changes that occurred while the daemon was offline.
No downtime loss.

### 003 §3.9 — Backend failure policy (target)

Two distinct policies:

- **`auto` (default)**: watcher-init failure → fall back to polling + **loud warning** on the
  monitor (visible in `agentmonitors monitor explain`). Never silent.
- **Pinned backend** (`fs-events`, `watchman`, etc.): unavailable → **fail the monitor** with a
  clear error. No silent swap to another native backend, no silent poll fallback. The implementation
  MUST check backend availability itself before delegating to `@parcel/watcher`, because the library's
  own behavior is to fall back to its default backend when the pinned one is unavailable.

### 003 §3.10 — Periodic source-state checkpointing during watch (target)

During `watch()`, the source MUST periodically write back its updated `FingerprintState` to the
runtime via a new `context.checkpoint(nextState)` callback. This prevents mid-watch crash from
causing duplicate deliveries on restart. The checkpoint MUST be durable before any subsequent
observation is processed (G14 ordering).

### 002 §2.4 — Watch-mode source-state checkpointing contract (target, new section)

The runtime MUST support a `context.checkpoint?: (nextState: unknown) => Promise<void>` callback
on `ObservationContext`, available only to `watch()` implementations. The runtime MUST:

- Persist the provided `nextState` into the monitor's `monitorState.sourceState` durably before
  processing further observations from the same watcher (G14 ordering invariant).
- Serialize checkpoint writes with `ingest()` calls per-watcher to uphold this ordering.
- NOT deliver or materialize any observation as a side effect of a checkpoint.

A checkpoint failure MUST NOT abort the watcher; the source logs a warning and continues.

The former `### 2.4 Tick result` is renumbered `### 2.5 Tick result`; cross-references in §10.1
and §10.2 updated accordingly.

## 2026-06-29 — `api-poll` follow-ups: warning URL redaction and validation docs (003 §4.2, §4.7; 004 §3.2; 005 §2) — Refs #240

Resolved follow-ups from the `api-poll` change-detection cluster.

- **Warning redaction.** The explicit `json-diff` / non-JSON warning now strips URL username,
  password, query, and fragment before diagnostic text is returned, so embedded credentials or
  request tokens are not echoed in `monitor test` output or logs.

- **Scaffold decision.** `agentmonitors init --type api-poll` intentionally omits
  `change-detection.strategy`; the source infers `json-diff` for JSON `Content-Type`s and `text-diff`
  otherwise. 005 now reflects that current template.

- **Spec drift and validation matrix.** 003 §4.7 now matches §4.8: body-diffing strategies reject
  non-2xx responses instead of baselining them. 004 §3.2 now includes required rows for non-2xx
  errored behavior and explicit `json-diff` / non-JSON warnings.

## 2026-06-29 — `file-fingerprint` `cwd` default documentation corrected (003 §3.1) — Refs #245

Clarified that project-level `file-fingerprint` monitors default `cwd` to the workspace/config root,
not the monitors directory.

- **003 §3.1 — clarified.** When `cwd` is omitted, relative `globs` match project files under the
  workspace/config root (`ObservationContext.workspacePath`, the project directory containing
  `.claude`). Relative `cwd` values resolve against that root; absolute `cwd` values are used as-is.
- **Source schema/docs.** The `cwd` field description now exposes the default through
  `source list`, and the authoring guide no longer says "monitors root."

## 2026-06-29 — Upstream branch watching and delivery verification docs (003 §6.4, §11.8) — Refs #244

Documented the source-agnostic upstream-branch recipe and the end-to-end delivery verification path.

- **003 §11.8 — added.** `command-poll` with
  `git ls-remote origin refs/heads/<branch>` and `text-diff` is the recommended way to watch a
  remote branch tip without fetching or mutating local refs.
- **003 §6.4 — clarified.** `incoming-changes` observes local commit-graph advances after pull,
  merge, fast-forward, or local commit; it is not a remote-ahead detector.
- **Authoring docs/scaffold.** `authoring-monitors` now links `api-poll` and `command-poll` authors
  to the shared `.claude/agentmonitors.local.md` enable + `session start` + `hook deliver`
  verification recipe. The `command-poll` init template now uses the upstream-safe `git ls-remote`
  example instead of a local `git status --porcelain` command.

## 2026-06-29 — `file-fingerprint` bare-string `ignore` shorthand (003 §3.1) — Refs #241

`file-fingerprint` now accepts `ignore` as either a bare string or a string array, matching the
existing `globs` shorthand.

- **003 §3.1 — clarified.** A single exclude glob may be written as `ignore: '**/x.txt'` and is
  normalized to the same internal `string[]` representation as `ignore: ['**/x.txt']`.

- **Parser/schema parity.** Both `parseScopeConfig` and `scopeSchema` accept the string form and
  still reject blank or whitespace-only patterns. `schema-parity.test.ts` pins the accepted
  bare-string case and rejected blank-string case.

## 2026-06-29 — `file-fingerprint` ignore exclude globs (003 §3.1, §3.2) — Refs #232

`file-fingerprint` now accepts an optional `ignore: string[]` exclude-glob array alongside `globs`.

- **003 §3.1 — clarified and extended.** A path that matches `globs` but also matches any `ignore`
  pattern is omitted from both the initial baseline and later change detection. Ignore patterns are
  resolved against the same base as `globs`; there is no gitignore-style negation or separate base.

- **Self-trigger guidance.** The docs now call out the common footgun where a monitor watching a
  broad glob writes its own notification artifact back into that glob, causing a re-fire loop. The
  recommended fixes are to write outside the watched tree or exclude generated outputs with `ignore`.

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` ("ignore exclude globs") asserts an
  ignored matching file is absent from baseline and does not emit on change, while a non-ignored
  matching file still emits normally. `apps/cli/src/commands/cli.integration.test.ts` pins
  `source list` exposure of the new field.

## 2026-06-29 — `api-poll` status-page HTML volatility guidance (003 §4.2) — Refs #234

Clarified that rendered HTML pages can be unsuitable `api-poll` inputs even when `text-diff` is
correctly inferred from `Content-Type`.

- **003 §4.2 — status-page caveat.** Many rendered status pages embed volatile per-request content
  such as timestamps, CSRF tokens, nonces, or build metadata. Raw `text-diff` can therefore fire on
  every poll even when service status has not changed.

- **Recommended authoring path.** Prefer machine-readable status endpoints when available, such as a
  Statuspage-style `/api/v2/status.json` URL. If only rendered HTML is available, expect noise and
  consider `notify.strategy: debounce`.

- **Authoring docs.** The `api-poll` section now includes a concrete JSON status endpoint example and
  explains why it is preferable for status-page monitoring.

## 2026-06-28 — `api-poll` infers change-detection strategy from `Content-Type` (003 §4.1, §4.2) — Refs #230

`change-detection.strategy` is now **optional** for `api-poll`. Builds on the #219/#220 robustness work.

- **003 §4.2 — new (Refs #230).** When `change-detection.strategy` is **omitted**, the source infers
  it from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
  `+json` suffix, per RFC 6838) → `json-diff`; everything else (`text/html`, `text/plain`, a
  missing/unknown `Content-Type`) → `text-diff`. This makes the common "watch a web page" case
  zero-config. The previous omitted-path behavior was a static `text-diff` default; it is now this
  Content-Type inference.

- **Explicit always wins.** An explicitly configured `strategy` is used **verbatim** — no inference,
  no override (user specification is absolute). Explicit `json-diff` against an HTML page stays
  `json-diff`; explicit `text-diff` against a JSON body stays `text-diff`.

- **#219 warning narrowed.** The json-diff-on-non-JSON warning now fires **only** for the _explicit_
  `json-diff` case. An _inferred_ strategy never warns, because inference picks `json-diff` solely for
  JSON `Content-Type`s and so never mismatches the body.

- **003 §4.1 + scaffold + authoring docs.** The §4.1 example marks `change-detection` optional and
  adds a no-`change-detection` "watch a web page" example; the `api-poll` scaffold
  (`apps/cli/src/commands/init.ts`) and `apps/website/.../authoring-monitors.md` do the same.

- **No public-type change.** Inference is internal to the source; `ObservationResult` is unchanged.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (omitted + `application/json` → json-diff;
  omitted + `application/ld+json` → json-diff; omitted + `text/html` → text-diff; omitted + missing
  `Content-Type` → text-diff; inferred json-diff does not warn; explicit `json-diff` + `text/html` →
  json-diff honored AND warns; explicit `text-diff` + JSON body → text-diff honored).

## 2026-06-28 — `api-poll` change-detection robustness: non-2xx errors, json-diff-on-non-JSON warning, content-type strategy steering (003 §4.2, §4.5, §4.8) — Refs #219, #220

Two related corrections to the `api-poll` source contract, plus authoring guidance.

- **003 §4.8 — new (Refs #220).** A non-2xx HTTP response is now an **errored** observation for the
  `text-diff`/`json-diff` strategies (the source throws a status-bearing error
  `api-poll received HTTP <status> from <url> — check auth/url; not establishing a baseline on an error response`),
  so the runtime records `errored`, `daemon once`/`run` report it, `monitor history`
  shows `errored`, and `monitor test` shows `Observation failed: …`. It no longer silently baselines
  on an error body, which previously masked broken auth/URL (a bad token produced `HTTP 401` yet the
  monitor "observed successfully"). 2xx responses baseline/diff exactly as before. **Exception:** the
  `status-code` strategy still treats a non-2xx as a legitimate observed signal (the status is the
  watched object), so it does not throw — preserving 200 → 5xx detection.

- **003 §4.2 — clarified (Refs #219).** The existing silent `json-diff` → text fallback now also
  emits a **non-fatal warning** (`ObservationResult.warnings`) when `strategy: json-diff` is
  configured against a body that does not parse as JSON. `agentmonitors monitor test` prints it so the
  author is steered to `text-diff` for HTML/plain pages instead of getting quietly wrong diffing. The
  observation outcome is unchanged (still the text fallback). The change-detection table and the
  `api-poll` scaffold (`apps/cli/src/commands/init.ts`) now state strategy-by-content-type inline:
  `text-diff` for HTML/plain pages, `json-diff` for JSON APIs.

- **New public type field.** `ObservationResult.warnings?: string[]` — non-fatal source diagnostics,
  surfaced by `monitor test`; does not mark the cycle errored.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (401/500 → errored, no baseline; 2xx →
  baseline ok; `status-code` non-2xx still observes; json-diff on non-JSON → warning; json-diff on
  JSON → no warning; text-diff non-JSON → no warning); `apps/cli/src/commands/cli.integration.test.ts`
  (`monitor test` surfaces the status-bearing error and the json-diff warning).
- Minor changeset: `@agentmonitors/source-api-poll` behavior change; patch: `@agentmonitors/core`
  (new optional `ObservationResult.warnings`), `@agentmonitors/cli` (`monitor test` warning output).

## 2026-06-28 — `hook deliver` accepts `--format text|json` and documents no-output preconditions (005 §12.2, 006 §5) — Refs #203

`agentmonitors hook deliver` now accepts the same `--format text|json` shape as the sibling
hook-delivery inspection command while preserving the installed hook wire behavior by default.

- **005 §12.2 — clarified.** The command reference now lists `--format <format>`, explains that the
  omitted/default format and `--format json` emit compact Claude Code hook wire JSON, and documents
  `--format text` as an inspection mode that prints only the rendered `additionalContext`.
- **005 §12.2 / CLI help — clarified.** Emission preconditions are explicit: an enabled project, a
  per-workspace socket in `.claude/agentmonitors.local.md` or `--socket`, a reachable daemon, and a
  matching tracked session. Empty output means nothing is pending or the workspace/session is not
  configured.
- **006 §5.1-§5.3 — clarified.** Hook registration continues to use the default/json wire object, all
  no-op paths remain empty stdout + exit 0, and `--format text` is only for manual inspection.

The always-exit-0 hook safety contract is unchanged. Affects published-package behavior
(`@agentmonitors/cli`), so a changeset accompanies this change.

## 2026-06-28 — Manual daemon commands use the enabled workspace socket (005 §1) — Refs #199

`session open`, `session close`, `session list`, `events list`, `events ack`, and `hook claim` now
resolve the enabled workspace's persisted `.claude/agentmonitors.local.md` `socket:` when no explicit
`--socket` and no `AGENTMONITORS_SOCKET` are present. This aligns manual CLI inspection with the
plugin hook path: in an enabled project, manual commands reach the per-workspace daemon that
`session start` booted; outside an enabled project, the global default socket remains unchanged.

When those manual commands cannot reach the resolved daemon, they now print one actionable stderr
line telling the author how to start a daemon and exit non-zero, rather than exposing a raw
`DaemonConnectionError` stack. Daemon-side application errors remain surfaced normally and still honor
JSON error output where applicable.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` covers manual commands reaching the
  per-workspace socket after `session start`, explicit `--socket` / `AGENTMONITORS_SOCKET`
  precedence over that local socket, plus daemon-unavailable remediation for `session open`,
  `session close`, `session list`, `events list`, `events ack`, and `hook claim` with no stack trace.
- Patch changeset: `@agentmonitors/cli` user-visible command resolution/error behavior.

## 2026-06-28 — `hook deliver` emits a reminder line for pending `normal`/`low` changes (006 §5.4, 005 §12.2) — Refs #198

Resolves a contradiction between the spec and the implementation. The spec already said a
`turn-interruptible` `normal`-urgency claim returns `events: []` with **"reminder text only"**, but
`renderHookDelivery` short-circuited to `null` whenever `events.length === 0`, so the wired
`agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
`normal`-urgency change. A default file-fingerprint monitor was therefore silent mid-session —
`hook claim` reported the reminder while `hook deliver` did not.

- **006 §5.4 — clarified.** "Reminder text only" is explicitly **not** silence: `hook deliver`
  renders the claim's advisory `message` (sanitized and length-capped) into
  `hookSpecificOutput.additionalContext` for a
  `normal`/`low` claim (`events: []`), producing a visible mid-turn reminder with no per-event body
  block. Body injection stays reserved for high-urgency settled events and the post-compact recap.
  `renderHookDelivery` returns `null` only for a `null` claim or one carrying neither events nor a
  reminder message.
- **005 §12.2 — clarified.** Step 7 and the closing note now state the reminder-line behavior
  precisely, with a reminder-only wire-output example. The claimed rows are **not** acknowledged
  (BP2 / SP4), so the event stays unread and re-discoverable via `events list --unread`.

High-urgency body injection and the post-compact recap are byte-unchanged. Affects published-package
behavior (`@agentmonitors/cli`), so a changeset accompanies this change. Refs #198.

## 2026-06-28 — file-fingerprint observe interval is surfaced in schema, CLI, and docs (003 §3.1; 005 §7, §9) — Refs #204

`file-fingerprint` now documents `watch.interval` in its source schema with the effective `30s`
default. `agentmonitors source list` includes source field descriptions, so the interval knob is
visible alongside `globs` and `cwd`.

Docs now distinguish the per-monitor observe interval from daemon `--poll-ms`: `watch.interval`
controls when a specific monitor is due to re-check files, while `--poll-ms` is only the daemon
loop-wake cadence. No default timing behavior changed.

## 2026-06-28 — file-fingerprint project globs resolve from config root, not daemon cwd (002 §10.7, §15; 003 §3.1, §3.2; 005 §6) — Refs #193

Project-level `file-fingerprint` monitors now resolve relative `globs` and relative `cwd` from the
runtime workspace/config root (`ObservationContext.workspacePath`), not from the daemon process cwd.
Absolute `cwd` values and absolute glob patterns remain unchanged.

When a run matches zero files, `file-fingerprint` sets
`ObservationResult.outcome: "no-files-matched"`. The runtime records that distinct
`observation_history` outcome instead of ordinary `no-change`, so authors can diagnose a broken
glob/cwd separately from a watched file set with no content changes.

- **Core API:** `ObservationContext` gained optional `workspacePath`; `ObservationResult.outcome`
  gained `"no-files-matched"`; `ObservationOutcome` gained `"no-files-matched"`.
- **Runtime/CLI:** `tick()` and `watch()` pass `workspacePath` into source contexts, and
  `monitor test` derives the config root from the supplied `MONITOR.md` path for direct source
  dry-runs. `monitor test` also short-circuits `no-files-matched` results as an authoring
  diagnostic: it exits 1, prints an explicit `watch.globs` / `watch.cwd` message, and does not
  establish a baseline.
- **Tests:** `plugins/source-file-fingerprint/src/index.test.ts` covers relative glob/cwd
  resolution, absolute path preservation, and zero-match outcome. `libs/core/src/runtime/service.test.ts`
  covers runtime context propagation and the distinct history outcome.

## 2026-06-28 — `file-fingerprint` `globs` accepts a string or an array (003 §3)

Ergonomics: the single-file/single-glob case can now be written as `globs: notes.md` instead of
`globs: ['notes.md']`. [003 §3.1](./003-source-plugins.md) updated to state that `globs` accepts a
bare string (a single pattern) or an array of strings (OR-ed), with the string form normalized to a
one-element array. Empty patterns are rejected. Backward compatible. Part of the "simple cases feel
simple" authoring-ergonomics pass.

## 2026-06-28 — `urgency` is now optional, defaulting to `normal` (001 §3, §3.2)

Ergonomics: `urgency` was a required frontmatter field; it is now **optional** and defaults to the
degenerate band `normal..normal` when omitted, so the minimal valid monitor is a `watch:` block plus
a body. [001 §3](./001-monitor-definition.md) (field table + verified note) and §3.2 updated.
Backward compatible — every monitor that declares `urgency` (a level or a `lo..hi` band) is
unchanged. The default is intentionally `normal` (not `high`): the simplest monitor does not
interrupt the current turn; an author opts into mid-session interruption with `urgency: high`
(gradual reveal). Per maintainer decision, 2026-06-28. Part of the "simple cases feel simple"
authoring-ergonomics pass.

## 2026-06-28 — `command-poll` teaches the inline pipeline idiom (003 §11.1)

Ergonomics/discoverability (no contract change): the argv-only rule for `command` is unchanged, but
a bare-string `command` is now rejected with a message that names the supported inline form,
`['sh', '-c', '<pipeline>']`, and the `init --type command-poll` template documents it in a comment.
[003 §11.1](./003-source-plugins.md) clarifies that shell features are opt-in via an explicit
`['sh','-c',…]` argv (the shell is `argv[0]`, author-chosen, not silently interposed). Part of the
"simple cases feel simple" authoring-ergonomics pass.

## 2026-06-19 — Four invariants added to 000: PP9, PP10, AP7, NP5 — Refs #126

Ratified in the 2026-06-19 product call. Four new principles added to
[000 — Principles & Properties](./000-principles.md):

- **PP9 (agents declare and move on):** An agent may declaratively express monitoring intent but
  performs no watching mechanics itself and never polls or blocks waiting for a signal. The daemon
  owns all observation and waiting; signals are pushed to the agent when ready.
- **PP10 (deterministic daemon floor / ships no model):** The daemon performs only deterministic
  work — observe, shape, diff, persist, project, deliver — and ships no model and holds no
  model-provider credentials. Any summarization or interpretation runs via the user's own installed
  AI tool, opt-in and behind an adapter, never in the daemon core.
- **AP7 (one pipeline, two authoring paths):** Ephemeral, agent-declared, session-scoped monitors
  and persistent `MONITOR.md` monitors are the same runtime machinery. Ephemeral monitors are an
  additional authoring and lifecycle path into the one pipeline, not a parallel system.
- **NP5 (local-agent-only delivery, current scope):** Agent Monitors delivers to local agent hosts
  only; cloud-hosted agents are out of scope while the only known integration path is a polling loop
  that contradicts the push model (pairs with NP1). Revisit only if a host exposes a local
  push/hook primitive.

These invariants ground the multi-host, local-agent-facing direction (#126, recast in the
2026-06-19 product call from "defer web/cloud-agent support" to active multi-host local-agent
support) and dependent chains (#124). The §7 cross-reference index is updated: PP9, PP10, and AP7
added to the `002` row; PP9, PP10, AP7, and NP5 added to the `006` row; PP10 added to the `005`
row.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #126.

## 2026-06-19 — Default `baseline-strategy` changed from `incremental` to `net` (001 §3.7, 002 §1.1.7) — Refs #110

Implements the 2026-06-19 strategy-call decision: the standard delivery contract is now
**one before/after delta per changed object per notification window** (consolidate by object, not by
monitor; zero reasoning in the daemon).

- **001 §3.7 — default changed.** `baseline-strategy` now defaults to `net`. Omitting the field
  yields per-object consolidation (one delta per changed object per window). `incremental` is the
  explicit opt-out — declare it when the full ordered history of changes matters (e.g. comment
  threads where each reply is a discrete step).
- **002 §1.1.7 — contract updated.** The default-is-`net` semantics are now the normative contract.
  The mechanism is unchanged (per-recipient `collapseNetForClaim` at claim time, G10 PR-B): the
  shared `monitor_events` chain still records every observation (the incremental substrate), and the
  `net` collapse groups pending events per `(monitorId, objectKey, workspacePath)`, delivering only
  the newest per object — delta recomputed against the recipient's own cursor → endpoint — with older
  intermediates recorded claimed-but-suppressed.
- **Schema:** `baselineStrategySchema` (`libs/core/src/schema/monitor-schema.ts`)
  `.default('incremental')` → `.default('net')`.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` ("defaults to net when omitted"),
  `libs/core/src/runtime/service.test.ts` ("omitting baseline-strategy defaults to net"),
  `libs/core/src/runtime/object-consolidation.test.ts` (new — canonical 15-saves case + two-object
  envelope + incremental opt-out, all end-to-end through the real runtime tick).
- **No runtime logic change** — only the schema default and the surrounding documentation. The
  per-recipient `net` collapse machinery (G10 PR-B, Refs #182) is unchanged.

## 2026-06-16 — `net` collapse + Interpret rewired onto the per-recipient seam; roadmap G10 complete (002 §1.1.2, §1.1.7, §1.1.8) — Refs #182

Implements roadmap **G10 PR-B** (the final G10 PR), moving the right-of-seam stages of
[002 §1.1](./002-runtime-delivery.md) from the shared baseline onto each recipient's own baseline
cursor. With PR-A's substrate, this flips [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)
and [§1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)
to fully _current_ and **retires roadmap G10**.

- **002 §1.1.7 — `net` collapse is now per-recipient at claim time (Decision Q3).** The shared
  `monitor_events` chain records **every** observation in order regardless of `baseline-strategy`
  (the incremental substrate — precise over cheap), so an away recipient can be served a correct net
  delta against **its own** cursor. `collapseToNetSpan` is removed from the shared `materializeSpan`
  path. At claim, `RuntimeStore.collapseNetForClaim` (driven by `AgentMonitorRuntime.claimDelivery`)
  groups a recipient's unclaimed events per `objectKey`; for a `net` monitor it delivers only the
  **newest** event per object — with its per-recipient `diff_text` recomputed as
  `buildTextDiff(cursor.baselineContent, newestArtifact)` when the group actually collapsed — and
  records the older intermediates **claimed-but-suppressed** on the new
  `session_event_state.net_suppressed_at` column: retained and explainable via `monitor explain`
  (§10.7), excluded from delivery (unread/pending/recap), never a silent drop. `incremental` (default)
  delivers all in order. The per-recipient cursor still advances to the newest claimed artifact
  (`markClaimed`) even when intermediates are suppressed. A within-tick multi-observation burst for one
  object collapses the same way on the per-recipient side (preserving the same-tick semantics the old
  shared `collapseToNetSpan` provided).

- **002 §1.1.8 — Interpret runs once per distinct per-recipient delta (Decision Q4).** `runInterpret`
  groups projected sessions by their distinct `session_event_state.diff_text` and invokes the adapter
  once per distinct delta, recording the verdict on every session in that group. Interpret runs at
  materialize on the per-recipient single-event delta (the common case); a claim-time `net` re-diff
  re-anchors the delivered delta but **does not re-invoke the adapter** unless the collapsed delta
  string differs from what was already interpreted.

- **Persistence.** New `monitor_events.baseline_strategy` (the author-declared strategy persisted on
  each event so the claim-time net decision needs no monitor re-scan) and
  `session_event_state.net_suppressed_at` (the claimed-but-suppressed marker). Both migrate additively
  (`addColumnIfMissing`); legacy rows keep `NULL` (treated as `incremental` / never net-suppressed).
  `monitor_events` ids now use a monotonic ULID factory so `(created_at, id)` ordering reflects
  insertion order within a single tick — the deterministic "newest event per object" tiebreak the net
  collapse and cursor advance both rely on.

- **Backward compatibility.** A `net` monitor with a single (or co-registered) session that never
  misses a window behaves exactly as before — one event per window, `net` ≡ `incremental` in the
  degenerate single-observation span (no diff is rewritten to empty for a baseline event). The
  shared `monitor_events` chain now keeps every intermediate for a `net` monitor (the visible change:
  `listEvents`/`emittedEventIds` report N, not the collapsed 1 — the collapse is per-recipient at
  delivery). The G13 `net` and issue-#180 rollup/`net` runtime tests were updated to assert this
  intentional shared-chain change plus the per-recipient claim-time collapse.

- **Proof.** `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-3 → one net delta + 2
  suppressed/explainable; `incremental` 3-ordered-deltas contrast; missed-nothing degenerate;
  backward-compat degenerate equivalence; co-registered never-miss; shared-chain keeps all N; cursor
  advances past suppressed intermediates; divergent-baseline Interpret → 2 calls, identical → 1
  fanned). Plus the updated `libs/core/src/runtime/service.test.ts` baseline-strategy and rollup tests.
  Files: `libs/core/src/runtime/{service,store,types}.ts`, `libs/core/src/inbox/{schema,db}.ts`.

## 2026-06-16 — Per-recipient baseline seam + per-recipient Diff shipped (roadmap G10 PR-A; 002 §1.1.2, §5.2, §6) — Refs #182

Implements roadmap **G10 PR-A**, moving the per-recipient Diff substrate of
[002 §1.1.2](./002-runtime-delivery.md#112-the-shared--per-recipient-seam) from _target_ to
_current_. PR-B (rewiring the `net` collapse, §1.1.7, and Interpret, §1.1.8, to span per recipient)
remains open under G10.

- **002 §1.1.2 — per-recipient Diff (current substrate).** The runtime materializes **one** shared
  `monitor_events` row carrying the shaped artifact (the shared object-level diff is retained on
  `monitor_events.diff_text` for `events list`/history), then computes a **per-recipient** delta for
  each projected lead session — the artifact diffed against **that session's own baseline cursor** —
  recorded on the new `session_event_state.diff_text`. Two sessions at divergent stored baselines
  each receive the correct span from one shared observation (capability C15). The per-recipient diff
  is computed inside `insertEvent`'s projection loop, so all durable writes complete **before** any
  Interpret await (the `ingest()` ordering invariant is preserved).

- **New durable table `session_object_cursor`.** One row per
  `(session_id, monitor_id, object_key, workspace_path)`, unique on those keys
  (`COALESCE(workspace_path, '')` collapses the global/`NULL` case). `baseline_content` is
  **denormalized** (the full artifact text) so a recipient's baseline is prune-immune. Cursor
  semantics (product decisions): a recipient's **first** projection of an object seeds its cursor to
  the **pre-event** state, so a session that registered late hears only changes **after** it
  registered (not a full-current-state first delta); the cursor **advances at claim** (`markClaimed`
  moves it to the artifact the recipient was just shown) — materialization only **seeds**, never
  advances; cursors **persist across dormancy and restart** (002 §3, BP1).

- **Backward compatibility.** A single lead session (or sessions co-registered at the same point)
  reproduces the pre-G10 shared diff **byte-for-byte** (the degenerate single-baseline case). Old
  DBs migrate additively (`CREATE TABLE IF NOT EXISTS session_object_cursor` + a unique index +
  `addColumnIfMissing(session_event_state, diff_text)`); a legacy `NULL`
  `session_event_state.diff_text` falls back to the shared `monitor_events.diff_text`. G13 (`net`)
  and G14 (Interpret) are **behaviorally unchanged** — they keep operating over the shared baseline
  on top of this substrate (PR-B rewires them per recipient).

- **Proof.** `libs/core/src/runtime/per-recipient-diff.test.ts`: divergent-baseline fan-out (THE
  proof — A spans artifact2→artifact3, B spans artifact1→artifact3 from one shared obs3), cursor
  restart-safety, session isolation, single-session backward-compat + legacy-`NULL` fallback, and
  the late-joiner new-session seed. The full G11–G15 core suite stays green unchanged.

## 2026-06-16 — Conformance fix: rollup not-due window flush now honors `net` + records audit history (002 §1.1.7, §10.7, §4.4) — Refs #180

No contract change — this records that the **implementation** was brought into conformance with the
existing spec, not a clarification of the spec itself.

- **002 §1.1.7 (net baseline strategy) + §4.4 (scheduled-rollup Pace mode).** A `notify.strategy:
rollup` monitor flushes its accumulated batch via two runtime-tick paths: the source-interval-
  elapsed ("due") path through `ingest()`, and the "not-due" path where the delivery `window` opens
  on a tick whose source poll interval has not elapsed. Per §4.4 the not-due path is the _normal_
  operating mode (authors SHOULD relax `watch.interval` to match the window). The not-due path had
  drifted from `ingest()` and skipped the `net` collapse, so a `rollup` + `baseline-strategy: net`
  monitor delivered the full play-by-play (N events) instead of one net delta. Now both paths route
  through one shared span-materialization helper, so §1.1.7's "one net delta for a missed span"
  holds on both.

- **002 §10.7 / §1.1.6 (audit history).** The same not-due flush wrote no `triggered`
  `observation_history` row, so a real windowed delivery was invisible to `monitor explain` /
  `history`. The shared helper now records the `triggered` row on both paths.

## 2026-06-15 — Interpret stage shipped: cheap agentic digest + significance gate via the user's own AI tool (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #178

Implements roadmap **G14**, moving the optional Interpret stage from _target_ to _current_. This
completes the G11–G15 post-processing-pipeline wave.

- **002 §1.1.8 — Interpret (current).** The runtime runs an optional Interpret stage **after** the
  per-recipient Diff/projection, on the per-recipient delta, **only** for `payload.form: prose`
  (built on G15's `PayloadForm`/`payloadSchema`). A non-`prose` monitor never invokes the adapter.
  The stage produces a cheap, natural-language digest sized to the span and may apply an agentic
  significance gate that suppresses a not-substantive delta. It is **best-effort and never on the
  critical path**: an adapter failure (tool missing / errors / times out) falls back to the
  deterministic §1.1.5 `rendered` artifact (the already-projected delivery) and records the failure —
  delivery correctness never depends on a model call succeeding (PP4, AP3).

- **Host-agnostic adapter boundary (002 §11.1, 006 §2.1 — current).** The AI-tool invocation lives
  behind a new `InterpretAdapter` interface in `libs/core/src/adapter/interpret.ts`; the concrete
  `claude -p` (argv-only, never a shell) invocation is `createClaudeInterpretAdapter`. The runtime
  core (`libs/core/src/runtime/`) owns _when_ Interpret runs (after Diff, before Deliver), _whether_
  it runs (the `prose` gate), and the recording of its decision — never the tool's command string. A
  new host wiring a different AI CLI is a new adapter, not a core change.

- **Ships no model, holds no credentials (C45 — current).** Interpret is disabled unless an
  `InterpretAdapter` is explicitly injected into `AgentMonitorRuntime`; the runtime reads no model
  credential. Summarization runs through the user's own installed tool, inheriting their existing
  data-governance and egress posture by construction.

- **Every decision recorded and explainable (C12 — current).** The per-recipient Interpret verdict
  (`deliver` / `suppress` / `failed`) plus its reason/digest is recorded on `session_event_state`
  (right of the seam) and surfaced by the projection-and-delivery stage of `monitor explain` (§10.7),
  so "why nothing fired" is inspectable — an agentic suppression is a deliberate, recorded outcome,
  never a silent drop. A suppressed projection is retained for explainability but excluded from
  delivery (`unreadEventsForSession` / `pendingEventsForSession`).

Verified: `libs/core/src/adapter/interpret.ts` (`InterpretAdapter`, `createClaudeInterpretAdapter`);
`libs/core/src/runtime/service.ts` (`processObservation` post-Diff Interpret + `runInterpret`
best-effort fallback); `libs/core/src/runtime/store.ts` (`recordInterpretDecision`,
`notInterpretSuppressed` delivery exclusion); `libs/core/src/inbox/schema.ts` +
`libs/core/src/inbox/db.ts` (`session_event_state.interpret_*` columns + additive migration);
`libs/core/src/runtime/interpret-stage.test.ts` (proof criteria a–e);
`libs/core/src/adapter/interpret.test.ts` (concrete adapter argv/parse contract).

## 2026-06-15 — Deterministic Shape stage shipped: derived facts + render-then-diff + payload form (001 §5.1–§5.2; 002 §1.1.4–§1.1.6; 003 §2.7; roadmap G15) — Refs #172

Implements roadmap **G15**, moving the deterministic Shape stage from _target_ to _current_.

- **001 §5.1 — Shape declaration (current).** The `shape` frontmatter field is accepted by the
  schema: `shape.derive` is an ordered list of `{ name, when }` derived-fact rules whose `when` is a
  CEL boolean predicate over `(snapshot, now)`; `shape.render: rendered` opts into the diffable
  artifact. A malformed CEL predicate is rejected at validate. Statically rejecting a predicate that
  _references an identifier outside `(snapshot, now)`_ remains **target** (CEL is structurally pure,
  so determinism holds regardless; such a reference evaluates to "fact does not hold").

- **001 §5.2 — Payload form (current).** The `payload` frontmatter field is accepted: `payload.form`
  is `prose | structured | artifact | rendered`, exported as the stable named type `PayloadForm`
  (a contract the follow-on G14 Interpret stage builds on). For `form: structured`, `payload.transform`
  runs a `jq` reshape or a `cel` gate over the canonical JSON snapshot; a transform under any other
  form, a malformed `jq`/`cel` expression, or an unknown form/language/encoding is rejected.

- **002 §1.1.4 — derived facts (current).** Computed as a pure function of `(shaped snapshot, injected
now)` on the shared side of the seam, before Pace and Diff. `now` is the injected tick clock, never
  an ambient `Date.now()`.

- **002 §1.1.5 — render-then-diff (current).** When `shape` is declared, the runtime renders the
  shaped state (snapshot + facts) to a byte-stable, markdown-ish artifact and diffs **that artifact**,
  not the raw source. The same shaped state renders byte-identically (no phantom diff); a newly-held
  fact is exactly one added line.

- **002 §1.1.6 — payload form (current).** `jq` reshapes the delivered payload; a `cel` gate of
  `false` **suppresses delivery entirely** (no event materialized). The optional Interpret stage that
  `prose` invokes remains **target** (§1.1.8, G14).

- **003 §2.7 — sources surface raw facts (current).** A source surfaces raw timestamps/fields; the
  runtime Shape stage derives the relative facts against `now`.

**Transform evaluator (CSP/Workers-safe).** Both `cel-js` (Chevrotain parser/interpreter) and
`jq-in-the-browser` (PEG parser-combinator) evaluate expressions without the `Function` constructor
or `eval` — the same constraint that drove `@cfworker/json-schema` over `ajv`. `jq-in-the-browser`
implements a practical jq subset (explicit object keys, `map(...)` for array collection); the §5.2
example is updated to that syntax.

Implementation + published-package behavior change — `@agentmonitors/core` minor changeset added.
Refs #172.

## 2026-06-15 — Source contract: snapshots-not-diffs (§2.5) made current; composite observation (§2.6) shipped (003 §2.5–§2.6; roadmap G11) — Refs #173

Implements roadmap **G11**. Both rules were **target**; both are now **current** with `verified:`
references. Capability study rows C2/C6/C40/C43,
[§S1, §S4](../product/monitoring-capability-exercises.md).

- **003 §2.5 — snapshots-not-diffs, now current.** The contract that sources return current-state
  snapshots + `nextState` and the runtime is the sole producer of the consumer-baseline diff is now
  documented on the `Observation` / `ObservationResult` types (`libs/core/src/observation/types.ts`,
  doc-comments only — no type-shape change) and proven against a **bundled** source: a
  `file-fingerprint` unit test asserts the observation is the full current file content with no diff
  field, and an end-to-end test drives the source through the real runtime and asserts the runtime —
  not the source — materializes the `diffText`
  (`plugins/source-file-fingerprint/src/index.test.ts`, "snapshots-not-diffs (003 §2.5)" block;
  reinforced by `libs/core/src/runtime/service.test.ts` "computes a diff against the prior snapshot").

- **003 §2.6 — composite observation, shipped.** The bundled `api-poll` source gains a
  `change-detection.composite` mode that assembles **one** observation from **many** sub-resource
  calls under **one** `object-key`. Parts are rendered sorted by `id` so call ordering never churns
  the snapshot (deterministic, per §2.6); a failed underlying call fails the whole observation
  (baseline preserved, 002 §3); composite and keyed-collection (§12) are mutually exclusive. Verified:
  `plugins/source-api-poll/src/composite.ts` + wiring in `plugins/source-api-poll/src/index.ts`;
  `plugins/source-api-poll/src/index.test.ts` (the "composite observation (003 §2.6)" unit block and
  the "composite × runtime integration" block reducing N calls into one event under one `objectKey`
  with the runtime computing the diff).

- **Roadmap G11** retired (both proof criteria met). A changeset bumps
  `@agentmonitors/source-api-poll` (minor — new authoring surface). `@agentmonitors/core` changes are
  doc-comment-only, so no core changeset and no api-report drift (api-report generation is disabled in
  the base config).

## 2026-06-15 — Author-declared baseline strategy shipped: `incremental` vs `net` (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #171

Moves roadmap **G13** from _target_ to _current_. The `baseline-strategy` frontmatter field is now
implemented; the spec sections that described it as target are flipped to current with `Verified:`
references.

- **001 §3.7 / §7.4 — now current.** The `baseline-strategy` field is an optional
  `z.enum(['incremental', 'net'])` defaulting to `incremental`; omitting it is backward compatible
  with today's sequential, one-event-per-observation delivery. The frontmatter table row drops its
  _Target_ label. Section anchors changed from `#37-baseline-strategy-target` to
  `#37-baseline-strategy-current` (and the §7.4 example from target to current); all cross-references
  in 001/002 were updated to match.
- **002 §1.1.7 — now current.** The two Diff modes are enforced by the runtime: `incremental`
  materializes each observation in a catch-up span as its own ordered delta; `net` collapses the
  span per `objectKey` to a single net delta (the last observation of each object's run, diffed
  against the prior snapshot baseline). Anchor changed to
  `#117-baseline-strategy-per-recipient-diff-semantics-current`.
- **Scope (implementation vs. desired behavior).** The catch-up span collapsed by `net` is the set
  of observations emitted into a single delivery over the runtime's **shared** snapshot baseline. The
  full **per-recipient-baseline seam** — divergent-baseline recipients each receiving an
  independently-spanned Diff — remains _target_ under roadmap **G10**; `baseline-strategy` is the
  author-declared mode that seam will apply per recipient. §1.1.7 and §5.2 say so explicitly.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` (accept/default/reject),
  `libs/core/src/runtime/service.test.ts` ("baseline strategy (G13, 002 §1.1.7)"),
  `apps/cli/src/commands/cli.integration.test.ts` (`validate` accept/reject).

## 2026-06-15 — Scheduled-rollup Pace mode (`notify: rollup`) shipped: target → current (001 §3.6, §7.3; 002 §3, §4.4, §4.5; roadmap G12) — Refs #170

Implements roadmap **G12** (capability C44, §S5.2). The third Pace mode is now **current**, not
target. Behavior change to the published `@agentmonitors/core` package and its public types, so a
changeset accompanies this change.

- **001 §3.6 — `notify: rollup` (now current).** `agentmonitors validate` accepts a `rollup`
  monitor that supplies a required five-field cron `window` (optional IANA `timezone`, default
  `UTC`) and rejects `strategy: rollup` without `window`. Verified against `rollupNotifySchema` in
  `libs/core/src/schema/monitor-schema.ts` (third arm of the `notifySchema` discriminated union).
  The §7.3 daily-digest example and the §3.4 shape list are updated to reference it.

- **002 §4.4 — runtime semantics (now current).** `dispatchRollup()` in
  `libs/core/src/runtime/service.ts` accumulates each observation into a durable
  `notifyState.pendingRollup` batch (no settle-driven `dueAt` reset), evaluates the author's
  `window` cron each tick via `cronMatchesDate` in the configured timezone, and flushes the whole
  batch as a composite delivery — clearing accumulation — only on a non-empty window. An empty
  window produces no delivery (no empty pings). One `monitor_events` row per accumulated
  observation.

- **002 §3 / §4.5 — persisted state + Pace reference (now current).** The accumulation batch is
  the new `PendingRollupState` (`libs/core/src/runtime/types.ts`), persisted in
  `monitor_state.notify_state`. It survives a daemon restart and reuses the §3 `effectiveUrgency`
  hydration backfill (issue #109) so a restart-recovered envelope never materializes an undefined
  urgency. The §4.5 four-mode Pace table is now fully current.

- **Tests** enforce all five G12 proof criteria: schema accept/reject
  (`libs/core/src/schema/monitor-schema.test.ts`), `validate` accept/reject through the real CLI
  (`apps/cli/src/commands/cli.integration.test.ts`), and durable accumulation, window flush+clear,
  empty-window no-delivery, and restart-safety of the batch
  (`libs/core/src/runtime/service.test.ts`, "rollup Pace mode").

## 2026-06-15 — Roadmap gap dedupe: Deterministic Shape gap renumbered G12→G15 (roadmap) — Refs #168

The roadmap contained two `### G12` headings introduced by separate PRs (#144 and #147), making gap
IDs non-unique and non-monotonic (sequence read G10, G11, G12, G12, G13, G14). No behavior change.

- The Deterministic Shape stage gap (originally G12 from #144) is **renumbered to G15** and
  **relocated** to appear after G14 (Interpret stage), making it the last gap in the sequence.
- The Scheduled-rollup Pace gap (#147) **retains G12**; G13 and G14 are unchanged.
- This file's reference to the Shape gap (the `Post-processing pipeline…` entry below) is updated
  from G12 to G15 to match.
- Gap IDs are now unique and monotonic: G10, G11, G12, G13, G14, G15.

Docs-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Author-declared baseline strategy: `incremental` vs `net` per-recipient Diff (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #146

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S5.1; ledger rows **C6** and **C7**). Spec-only; all new rules are marked **target**, not current.
Builds on the per-recipient seam already formalized in [002 §1.1.2](./002-runtime-delivery.md).

- **001 §3.7 — `baseline-strategy` authoring field (target).** A new optional frontmatter field
  with two values: `incremental` (default) — each intermediate observation since the recipient's
  baseline delivered in order (play-by-play); `net` — a single net delta of where things stand
  now vs. the recipient's baseline (intermediate churn collapsed). Omitting the field is
  equivalent to `incremental` — backward compatible with today's sequential delivery. The field
  is per-monitor author intent; the runtime enforces it in the per-recipient Diff stage right of
  the seam (§1.1.2). Motivation and cross-references to C6 / C7 / E1 / E2 / §S5.1 included.

- **001 §7.4 — net-delta spec-doc authoring example (target).** Illustrates `baseline-strategy: net` for a shared spec-doc monitor serving a fleet of agents at divergent baselines (the E2
  scenario), paired with `notify: debounce` — the field works alongside any Pace mode.

- **002 §1.1.7 — Diff: catch-up span and baseline-strategy semantics (target).** Defines the
  **catch-up span** (the set of shaped observations between a recipient's last-seen baseline and
  the current delivery point) and specifies how the Diff stage processes it under each strategy.
  `incremental` delivers _N_ deltas in order for a span of _N_ observations; `net` delivers one
  net delta by comparing the baseline snapshot against the endpoint observation's snapshot,
  collapsing all intermediate observations. Backward compatibility named: the current runtime's
  sequential delivery is the degenerate `incremental` case. Interaction with Pace (independent),
  interaction with the seam (per-recipient concern, right of seam), and test implications included.

- **Roadmap G13** — implementation gap for `baseline-strategy`, P2, with four proof criteria:
  validate acceptance, `net` collapse of a multi-observation span, `incremental` delivery of _N_
  deltas, and omit-equals-incremental backward compatibility. Governs
  [001 §3.7], [002 §1.1.7], C6/C7/§S5.1.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #146.

## 2026-06-15 — Interpret stage: cheap agentic digest + significance gate via the user's own AI tool, formalized as _target_ (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #145

Formalizes the **cheap agentic Interpret tier** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S4, resolved §S5 item 3; ledger rows **C45/C10/C11/C38/C12**, with E5 as the flagship). Spec-only;
**every new rule is marked target**, not current. Builds on the locked pipeline order (002 §1.1.1,
where Interpret is already a named per-recipient stage after Diff, before Deliver), the
author-declared payload form (002 §1.1.6 / 001 §5.2, where `prose` is the form that invokes
Interpret), and the deterministic `structured`-`cel` significance gate (002 §1.1.6). It does **not**
contradict any _current_ rule: today every monitor delivers its textual diff with no agentic reading,
so an absent Interpret stage is the degenerate, default case, and the host-agnostic-core invariant
(002 §11.1, AP3) is reaffirmed, not changed.

- **002 §1.1.8 — Interpret stage (target).** An **optional** stage that runs **after** the
  per-recipient Diff, on the **per-recipient delta** (right of the seam, §1.1.2), invoked **only** when
  the author declares `payload.form: prose`. It produces a **cheap natural-language digest** sized to
  the span (C10) and **may** apply an **agentic significance gate** that suppresses
  not-substantive changes (C11/C38). Key rules: (a) it runs via the **user's own installed AI tool**
  (e.g. `claude -p …`) — **Agent Monitors ships no model and holds no credentials**, inheriting the
  user's data-governance/egress posture by construction (C45, a first-class trust principle); (b) the
  tool invocation is **host-agnostic, behind an adapter interface, never in the runtime core** (like
  the Claude hook adapter, §11.1, AP3); (c) it is **never on the critical path** — an Interpret
  failure falls back to the deterministic `rendered` artifact (§1.1.5) and is recorded as explainable,
  so delivery correctness never depends on a model call; (d) it **judges the change against author
  criteria, never the recipient's private state** (the stable E2/E5 boundary); (e) the **agentic**
  significance gate is **distinct from** the deterministic shared `cel` gate (§1.1.6) — a comparison
  table fixes the difference and the "deterministic-first, agentic-second" composition; (f) **every
  suppress/deliver decision is recorded and explainable** so "why nothing fired" is inspectable (C12,
  the silent-failure-honesty invariant) — recorded on the **per-recipient** projection surface
  (`session_event_state`, surfaced by `monitor explain` §10.7), **not** the shared tick-level
  `observation_history` where the deterministic `cel`-gate suppression lands.

- **006 §2.1 — the Interpret adapter is upstream of transports, not a transport (target).** Pins the
  boundary: the AI-tool invocation lives behind an adapter (like `claudeCodeAdapter`) and is **not** a
  delivery transport — it helps **produce** the `prose` packet (and may suppress it) **before** any
  transport surfaces it, where a transport (§2) only **surfaces** an already-produced `DeliveryClaim`.

- **roadmap G14** — implementation gap for the Interpret stage, P2, with five proof criteria
  (prose-only invocation, fake-adapter digest, agentic suppression recorded + explainable via
  `monitor explain`, best-effort fallback on tool failure, no-model/no-credentials boundary). Governs
  [002 §1.1.8], [006 §2.1], C45/C10/C11/C38/C12 / §S5 item 3.

Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Scheduled-rollup Pace mode formalized as _target_ (001 §3.6, §7.3; 002 §4.4–§4.5; roadmap G12) — Refs #147

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
capability C44; resolved §S5.2). Spec-only; all new rules are marked **target**, not current.

- **001 §3.6 — `notify: rollup` authoring surface (target).** The third `notify` strategy,
  `rollup`, is specified: `strategy: rollup` plus a five-field `window` cron expression and an
  optional `timezone` (defaulting to UTC). A `rollup` monitor accumulates observations between
  window openings and delivers them as a single composite batch when the window fires. Authors
  **SHOULD** relax `watch.interval` to match the delivery frequency — polling every 30 s is wasteful
  when delivery is a daily digest. The current schema rejects `strategy: rollup`; this section
  documents the intended authoring surface for the implementation ticket.

- **001 §7.3 — daily digest rollup authoring example (target).** Illustrates `strategy: rollup`
  with a 9am weekday `window` paired with `interval: 1h`, demonstrating the cadence-relaxation
  principle.

- **002 §4.4 — scheduled-rollup Pace mode semantics (target).** Full runtime semantics:
  accumulation in durable `notifyState` across restarts; window evaluation on each tick (five-field
  cron + timezone, same guard as the schedule source); non-empty batch → flush and clear; empty
  window → no delivery (no empty pings, C14). Key clarifications: the flushed batch enters the
  normal materialization → projection → delivery pipeline (§5 → §6 → §9); rollup is entirely on
  the shared side of the seam (§1.1.2); the delivery clock (§9) is independent of the window clock
  (§1.1.3). Three-clocks analysis applied: observation cadence **SHOULD** be relaxed independently,
  reducing token and observation cost (C44, §S5.2 primary motivation).

- **002 §4.5 — complete Pace mode reference (target row for rollup; others current).** A
  four-row comparison table: **immediate** (no notify) / **settle/debounce** (`debounce`) /
  **throttle** (`throttle`) / **scheduled rollup** (`rollup` ⚑). This completes the Pace set:
  no further Pace modes are anticipated. The table frames rollup as the lowest-cost delivery mode
  and the natural pairing with relaxed observation cadence.

- **roadmap G12** — implementation gap for `strategy: rollup`, P2, with five proof criteria
  (validate acceptance, accumulation-between-windows, flush-on-window, empty-window-no-delivery,
  restart-safety). Governs [001 §3.6], [002 §4.4–§4.5], C44/§S5.2.

Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Deterministic Shape stage: derived facts, render-then-diff, author-declared payload form (001 §5.1–§5.2, 002 §1.1.4–§1.1.6, 003 §2.7) (#144)

Formalizes the **deterministic Shape stage** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S2 areas C/E/G, §S3 Tier 1, §S5 item 5; ledger rows **C41/C42/C43/C46**, with C3/C4/C5/C21 as
the surrounding Shape area and E8 as the flagship cost story). Spec-only; **every new rule is marked
target**, not current. Builds directly on the just-formalized pipeline-shape framing (002 §1.1) and
does **not** contradict any _current_ rule: today's object-level textual diff (002 §5.2) is the
degenerate case where Shape does no compute/render, and the source/runtime split (PP3, AP3, 003 §2.5)
is reaffirmed, not changed.

- **002 §1.1.4 — Shape: deterministic derived facts (target, C41).** The Shape stage MAY compute
  derived/relative facts (timestamp → "past due"/"due soon", all-tasks-blocked → "stalled",
  defer-threshold-crossed → "revealed", priority+proximity → "urgent") as a **pure function of
  `(shaped snapshot, injected now)`** — no model, no ambient clock — on the **shared** side of the
  seam, **before** Pace and Diff (so a fact appearing/changing is itself a diffable delta). Author-
  declared and optional. Kills the E8 "≈100% waste" of an agent re-deriving these every poll.
- **002 §1.1.5 — Shape: render to a stable artifact, then diff the artifact (target, C42/C43).** Shape
  MAY render the shaped state to a stable, token-efficient, markdown-ish (not JSON) artifact, and the
  runtime MUST diff **that rendered artifact**, never the raw source — pinning the order
  `Observe → [Compose] → Shape(compute → render) → Pace → ⟦seam⟧ → Diff(of the artifact) → …`. Render
  is deterministic (byte-stable, or it produces phantom diffs) and shared; the diff **baseline** is
  per-recipient. Deterministic render is a prerequisite for a useful diff — the structural reason
  Shape precedes Diff.
- **002 §1.1.6 — author-declared payload form (target, C46).** The author declares the payload form —
  `prose | structured | artifact | rendered`. `prose` is the only form that invokes the optional
  Interpret stage; the others are deterministic-floor forms (`structured` is the explicit way to avoid
  a lossy digest for a computing recipient, E6). `structured` is produced by a **turnkey declarative
  transform** — **jq** (reshaping) or **CEL** (predicate) — evaluated over the **canonical JSON** form
  of the shaped snapshot (output `encoding` — json/yaml/toon/toml — is a downstream serialization
  concern, not part of predicate semantics); the transform is constrained, **not** arbitrary code, and
  runs once on the shared side of the seam.
- **001 §3 / §5.1 / §5.2 — authoring surface (target).** Adds optional `shape` (derived facts +
  render) and `payload` (form + transform + encoding) frontmatter blocks, with authoring rules,
  examples, and validation obligations. The §3 frontmatter table gains `shape` and `payload` rows
  marked _target_. Omitting both preserves today's textual delivery.
- **003 §2.7 — sources surface raw facts; the runtime computes derived facts (target, C41).** Draws
  the source/runtime line for **facts** (mirroring §2.5 for diffs): a source surfaces the raw
  primitives (a `due` timestamp, child task states) **as observed** and MUST NOT bake in time-relative
  or aggregate derived facts (which depend on runtime-`now` and would churn the diff); the runtime
  Shape stage derives them. This is where the raw facts the §1.1.4 rules consume originate.
- Glossary entries added (derived fact, rendered artifact, payload form). Roadmap gains target gap
  **G15** (deterministic Shape: derived facts + render-then-diff + payload form), with proof criteria;
  it is the per-stage detail under the §1.1 umbrella that G10 names.
- **Acceptance (004 §6):** every rule is normative + marked _target_; each tricky rule carries an
  example (E8 derived facts, E6↔E8 payload poles) and a test implication (fixed-`now` reproducibility,
  byte-stable render, jq-projection output). No contradiction resolved beyond reaffirming the existing
  split, so the resolution is recorded here per 004 §5.
- Spec-only — no implementation or published-package behavior change, so no changeset. Refs #144.

## 2026-06-15 — Post-processing pipeline shape + source/runtime diff split formalized as _target_ (002 §1.1, 003 §2.5–§2.6)

Formalizes resolved decisions from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S4, §S5; ledger rows C40/C6/C43/C15). Spec-only; every new rule is marked **target**, not
current — the current runtime implements a subset under different names and is reaffirmed, not changed.

- **002 §1.1 — locked pipeline stage order (target).** Names the conceptual stages an observation
  flows through and fixes their order:
  `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` (bracketed
  stages optional). Each stage's responsibility and side of the seam is defined. Shape runs before
  Pace and before Diff (settle and diff the shaped/rendered artifact, not the raw source).
- **002 §1.1.2 — shared / per-recipient seam (target).** Everything left of the seam (Observe…Pace)
  is computed **once** and shared across all recipients; everything right (Diff…Deliver) is **per
  recipient**, against that recipient's baseline/cursor. Identical baselines may dedupe. This is the
  structural reason fan-out is cheap (C15). The current object-level diff (§5.2) is named as the
  degenerate **shared-baseline** case of the target per-recipient Diff — a refinement, not a
  contradiction. §5.2 gains a back-reference.
- **003 §2.5 — sources return snapshots, not diffs (target; reaffirms PP3/AP3).** The source contract
  now states explicitly that a source observes **current state** (+ its own `nextState`
  change-detection state) and the **runtime is the sole producer of the delivery diff**, parameterized
  by the consumer's baseline. A source's `nextState` is its internal "did anything change" cursor, not
  any recipient's baseline; a source MUST NOT compute "what is new for recipient X."
- **003 §2.6 — composite observation (target, C40).** One `Observation` MAY be assembled from many
  source queries/calls into a single stable whole-state snapshot under one `objectKey` — the
  `[Compose]` stage, on the shared side of the seam. Modeling, determinism, and partial-failure rules
  specified.
- Glossary entries added (post-processing pipeline, the seam, composite observation). Roadmap gains
  target gaps **G10** (pipeline stages + per-recipient seam) and **G11** (snapshots-not-diffs +
  composite observation), each with proof criteria.
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — CLI: `--format toon|json|text` with agent/human auto-detection on structured-output commands (#121)

**005 §1 (output formats), §4 (scan), §7.1 (source list), §11.1 (events list), §6 (monitor history / explain):**

- Added `toon` as a `--format` choice on all five structured-output commands (`events list`, `scan`, `monitor history`, `monitor explain`, `source list`). All three choices — `toon`, `json`, `text` — are now available on every command.
- **Default is auto-detected per invocation context** (via `is-agentic-tui`): agent-driven invocations (e.g. `CLAUDECODE=1`, `CURSOR_AGENT=1`) default to `toon`; interactive human terminals default to `text`. An explicit `--format` flag always overrides detection. Per-command `Default` column in §4, §6, §7.1, §11.1 updated to `auto (see §1)`.
- `--format json` output is **byte-for-byte identical** to the pre-change behaviour — no regressions for JSON consumers.
- TOON is a rendering-only transform at the CLI output edge. Durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire stay JSON everywhere.
- Round-trip safety: `decode(encode(value))` equals the original JSON value; asserted by tests for each command.
- Libraries: `@toon-format/toon@^2.3.0` (MIT, no deps) and `is-agentic-tui` (ISC, no deps). Both confirmed free of `new Function`/`Function(` — pass the CSP/Workers constraint.
- Layer B (delivered observation payload) is explicitly out of scope — deferred pending a standard-level design decision in §006 / the Monitor Standard.

## 2026-06-15 — DX polish: validate output, urgency error wording, api-poll feedback (#153)

Several author-facing DX improvements shipped as a cluster:

- **005 §3 (validate output consistency):** `validate` now displays the monitor ID (folder/stem
  name) for both valid and invalid monitors in text output, not the full file path for errors.
  Passing a file path to `validate` shows a `monitor test` pointer in the error. (Previously,
  invalid monitors printed the full absolute path; valid monitors printed the ID — inconsistent.)

- **core (urgency error wording):** The inverted-range error no longer repeats the field name.
  Before: `urgency: urgency range "high..normal" is inverted …`. After: `urgency: range
"high..normal" is inverted …`. (The Zod path prefix already includes `urgency:` as context.)

- **003 §4.6 (api-poll network error propagation):** Node `fetch` wraps real network errors
  (ECONNREFUSED, ENOTFOUND, …) as `err.cause`. The plugin now catches, extracts the cause
  message, and re-throws `"fetch failed: <cause>"` so `monitor explain` shows the real reason.

- **003 §4.7 (api-poll `monitor test` baseline output):** `monitor test` now prints the HTTP
  status code and UTF-8 response body size after the baseline for `api-poll` sources. This makes
  transport-level successes with unexpected responses (e.g. a 404 on a mistyped-but-resolvable URL,
  or an empty 200) immediately visible. Network-level failures (ECONNREFUSED, ENOTFOUND, …) are a
  separate case: they throw before a baseline exists and are surfaced via §4.6 error propagation
  (visible in `monitor explain`), not via the status/size line.

## 2026-06-15 — `monitor explain` / `monitor history` read the persisted DB in-process when no daemon is running (005 §6, 002 §10.7, #150)

`monitor explain` and `monitor history` were socket-only: with no daemon running — including right
after `daemon once` materialized events — both failed, and `monitor explain` reported a false
`✗ Scheduling: failure` for a monitor that had actually fired. On a genuine `DaemonConnectionError`
the CLI now runs the same read-only `explainMonitor` / `listObservationHistory` **in-process**
against the persisted SQLite store (the `daemon once` pattern) and renders the real diagnosis,
prefixed with the banner _"No daemon running — showing persisted state from the last tick."_ (text)
or annotated with a `"notice"` field (JSON). Only when the daemon is down **and** there is genuinely
nothing persisted (no `observation_history` and no `monitor_events` rows) does the CLI print an
actionable remediation line (`agentmonitors daemon run`, or `monitor test` for a one-shot) instead
of a raw `connect ENOENT …`. A daemon-side application error is still surfaced verbatim, never masked
as "daemon not running" (the #94/#98 distinction holds).

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('monitor explain / history
without a live daemon (issue #150)')`: after `daemon once` with no daemon, `monitor explain` shows
  the real diagnosis + banner and **no** false scheduling failure (text and `--format json`);
  `monitor history` returns the persisted rows; daemon-down-with-nothing-persisted yields the
  remediation message, not an `ENOENT`.
- Minor changeset: `@agentmonitors/cli` (CLI behavior change; no core public-surface change).
- Refs: issue #150 (relates to #94, #149).

## 2026-06-15 — file-fingerprint salience policy: `deleted` → `high`, others → default (003 §3.4)

`file-fingerprint` now emits `salience: 'high'` on `deleted` observations (information permanently
lost) and no `salience` on `created`, `modified`, or `descoped` observations (file still exists or
no information lost). This makes RANGE urgency reachable end-to-end with a bundled source: a monitor
authored with `urgency: normal..high` will receive a `high`-urgency delivery on file deletion and a
`normal`-urgency delivery for all other change kinds. Monitors with a bare scalar `urgency` are
unaffected (the degenerate band `x..x` is never escalated — backward compatible per 003 §2.3).

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` — unit tests asserting `salience:
'high'` on `deleted` and absent salience on `modified`, `created`, `descoped`; end-to-end
  integration tests proving the runtime materializes `urgency: 'high'` for a deletion on a
  `normal..high` band monitor and `urgency: 'normal'` for a modification on the same monitor.
- Minor changeset: `@agentmonitors/source-file-fingerprint` (new salience behavior).
- Refs: issue #151.

## 2026-06-15 — monitor explain verdict uses severity ranking, not first-non-ok (005 §6.4, regression #149)

`explainVerdict()` previously selected the _first_ stage whose status `!== 'ok'`. After the `healthy`
idle status was introduced in #98, a healthy Observation stage (not `'ok'`) short-circuited the scan
and masked a downstream `failure` or `pending` stage (#149 regression).

**Fix (005 §6.4):** the verdict now selects the _highest-severity_ stage. Severity order:
`failure(3) > pending(2) > healthy(1) > ok(0)`. A `healthy` or `ok` observation stage can never
mask a downstream fault. The `verdict.status` field in JSON output may now be `"healthy"` for a
fully idle monitor (spec corrected from `"ok|pending|failure"` to `"ok|pending|healthy|failure"`).

**Related fix (005 §6.4):** when the Notify stage is `pending` (debounce/throttle holding a batch)
and no event has materialized yet, the Materialization stage now reports `pending`/⏳ instead of
`failure`/✗ — the absence of materialized events is correct behavior when the notify layer is
holding, not a fault.

## 2026-06-15 — `daemon once` distinguishes skipped-not-due monitors from no-monitors-found (002 §2.4, 005 §9.1)

`RuntimeTickResult` gains a `skippedMonitors: { monitorId, nextDueAt }[]` field, populated from the
same scheduling decision that gates evaluation — never recomputed separately. `daemon once` appends a
parenthetical suffix when non-empty: `(N not yet due — next due in Xs)`, reporting
the soonest next-due time. Previously a second `daemon once` run within a monitor's interval printed
`Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, giving
the author a silent dead end (issue #152). The genuine empty/no-monitors path is unchanged.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once skipped-not-due
visibility (issue #152)')`: three tests cover (a) skipped suffix on second run, (b) empty-dir
  unchanged, (c) mixed evaluated + skipped counts reported accurately.
- Patch changesets: `@agentmonitors/core` (new `skippedMonitors` field + `SkippedMonitor` type in the
  public surface) and `@agentmonitors/cli` (user-visible tick output suffix).

## 2026-06-14 — Hydration backfill for pre-upgrade debounce batches (002 §3, restart-safety)

`hydrateStoredObservationEnvelope` now backfills a missing `effectiveUrgency` field (present on envelopes serialized before the range-urgency upgrade) by recomputing it from `effectiveObservationUrgency(monitor, observation)`. Without this, the first daemon restart after upgrade would materialize an invalid (undefined) urgency row. Degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax`: returns the base urgency via `URGENCY_BY_RANK[NaN] ?? lo`.

## 2026-06-14 — Range urgency band + per-observation salience (001 §3.2, 002 §4.1/§5.1, 003 §2.3)

A monitor's `urgency` frontmatter is now an authored **band** `lo..hi`; a bare level is the degenerate
band `x..x` (unchanged behavior — fully backward compatible). A source observation may carry an
optional `salience`, and the runtime resolves the effective urgency as
`clamp(salience ?? band.lo, band.lo, band.hi)`.

- **Authored band (001 §3.2):** `urgency: normal..high` authorizes escalation within the band; a bare
  scalar can never be escalated. The schema rejects unknown bounds, malformed ranges, and inverted
  ranges (`lo > hi`). Parsed to `frontmatter.urgency` (low bound — the base/default) +
  `frontmatter.urgencyMax` (high bound).
- **Salience is observation, not policy (003 §2.3):** the per-observation field is named `salience`
  (PP3 — domain observation), reserving `urgency` for the monitor-level policy knob (PP5).
- **Effective urgency + debounce (002 §4.1, §5.1):** notify timing and the materialized
  `monitor_events.urgency` both use the clamped effective urgency. An escalated observation (effective
  urgency above the band's low bound) arriving in a held debounce batch flushes the **whole** batch
  early — it is not split (held-first ordering preserved).
- **Supersedes** the earlier "ceiling" design (min(monitor, source)): a source may now escalate within
  an explicitly authored band, not only de-escalate under a fixed ceiling.
- **Proof:** `libs/core/src/schema/monitor-schema.test.ts` (band parse + inverted/invalid rejection);
  `libs/core/src/parser/parse-monitor.test.ts` (YAML round-trip of a range band, inverted rejection);
  `libs/core/src/runtime/service.test.ts` (salience within band escalates; clamp above/below band;
  degenerate band never escalates; escalation flushes the whole held debounce batch without splitting).
- Minor changeset: `@agentmonitors/core` (public `Observation.salience`, `MonitorFrontmatter.urgencyMax`,
  and the banded-urgency / salience runtime semantics).

## 2026-06-13 — Tick reports errored observations instead of a silent `emitted 0` (002 §2.4, §10.1, §10.2)

`RuntimeTickResult` gains an `erroredObservations: { monitorId, message }[]` field, populated from the
same code path that writes each `errored` row to `observation_history` (single source of truth, no
re-scan). `daemon once` and the `daemon run` periodic tick log now surface a non-zero errored count and
each errored monitor's id + message without a verbose flag — e.g.
`Evaluated 3 monitor(s), emitted 0 event(s), 1 errored:` followed by `  <monitorId>: <message>` lines.
Previously the tick printed a clean `emitted 0 event(s)` even when a monitor's `observe()` threw, so an
author could not distinguish a genuine no-change (not a bug) from a broken source. The genuine
no-change case is unchanged (no errored line — the command must not "cry wolf").

- **Proof:** `libs/core/src/runtime/service.test.ts` (errored monitor surfaced on the tick result with
  its message, including the non-Error throw fallback; a no-change tick has empty `erroredObservations`);
  `apps/cli/src/commands/cli.integration.test.ts` (`daemon once error visibility (issue #117)`: error-only,
  genuine no-change, and a mixed errored/emitted/no-change tick all reported truthfully).
- Minor changeset: `@agentmonitors/core` (new `erroredObservations` field + `ErroredObservation` in the
  public surface) and `@agentmonitors/cli` (user-visible tick output).

## 2026-06-13 — `monitor explain` healthy/idle status, workspace scoping, and connection-only fallback (002 §10.7, 005 §6)

Three corrections to the #94 `monitor explain` command (review of PR #98):

- **Healthy/idle is not a failure.** A `no-change` or `rebaselined` observation outcome now maps to a
  new `healthy` stage status (rendered `○`, distinct from `✓` delivered and `✗` failure) with an
  affirmative verdict ("Source ran, observed 0 changes — your watched target genuinely hasn't changed
  (not a bug)."). Previously a perfectly idle monitor rendered as an error (`✗`/`failure`),
  contradicting #94's contract that "your watched thing genuinely didn't change" is not a bug. When
  the latest observation is `healthy`, the downstream materialization and delivery stages report
  `healthy` for the expected absence of events/projections rather than `✗`. `failure` is reserved for
  real faults (errored observe, invalid definition, missing projection, daemon down). The new status
  is carried in `--format json` as `"status": "healthy"`.
- **Workspace scoping (session isolation).** The inbox DB is global, so the same `monitorId` can
  exist in multiple workspaces. `explainMonitor()` now scopes the materialization stage to the
  explained workspace's `monitor_events` (plus workspace-agnostic events) and the delivery stage to
  that workspace's sessions (plus global sessions), so one workspace's report never counts another
  workspace's events or projections.
- **Connection-only fallback.** The daemon-unavailable fallback now fires only for a genuine
  connection failure (socket refused/absent or request timeout, surfaced as a typed
  `DaemonConnectionError`). A daemon-side application error is surfaced verbatim
  (`Explain failed: <message>`, exit 1) instead of being masked as "daemon not running".
- **Proof:** `libs/core/src/runtime/service.test.ts` (no-change + rebaselined → `healthy`/affirmative
  verdict, no downstream `✗`; cross-workspace event/projection isolation);
  `apps/cli/src/daemon-ipc.test.ts` (application error → plain `Error`, connection failure →
  `DaemonConnectionError`); `apps/cli/src/commands/cli.integration.test.ts` (live daemon application
  error surfaced, not masked).
- Minor changeset: `@agentmonitors/core` (new `healthy` value in the public `MonitorExplainStageStatus`
  union and workspace-scoped explain queries).

## 2026-06-12 — `command-poll` top-level json-diff ignore paths (003 §11.3)

Resolved issue #106 in [003 §11](./003-source-plugins.md): plain `command-poll` `json-diff`
monitors may now set top-level `change-detection.ignore-paths` to remove noisy fields before output
comparison, without requiring keyed-collection mode.

- **Behavior:** `change-detection.ignore-paths: [duration]` under `strategy: json-diff` suppresses
  changes that only affect the parsed JSON `duration` field, while changes to non-ignored fields
  still emit the ordinary command-output `modified` observation.
- **Validation:** `command-poll` `change-detection` now has an explicit allow-list. Unknown keys
  such as `bogus-nonsense-key` fail `agentmonitors validate` instead of validating cleanly and
  silently no-oping. Top-level `ignore-paths` is valid only with `strategy: json-diff`.
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the plain `json-diff`
  suppression path, and `apps/cli/src/commands/cli.integration.test.ts` covers rejection of unknown
  `change-detection` keys.

## 2026-06-12 — Keyed-collection paths accept bare dotted authoring form (003 §12)

Resolved an authoring compatibility gap in [003 §12](./003-source-plugins.md): keyed-collection
`path` and `ignore-paths` now accept either explicit-root dotted paths (`$.items`, `$.duration`) or
bare root-relative dotted paths (`items`, `duration`). The two forms are equivalent. This preserves
the original minimal dotted grammar (no wildcards, array indices, filters, or recursive descent)
while matching the monitor-author shorthand used in real `command-poll` configurations.

- **Behavior:** `change-detection.collection.path: items` now resolves to the root `items` array and
  emits per-object `modified`/`created`/`descoped` observations the same way `$.items` does.
  `ignore-paths: [duration]` is treated as element-relative `$.duration`.
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` covers bare `path` and
  `ignore-paths`; `plugins/source-command-poll/src/index.test.ts` covers the issue #105
  modify/create/descope sequence with `path: items`.

## 2026-06-12 — Keyed-collection change detection shipped (003 §12 target→current; G9 retired)

The `change-detection.collection` mode now turns a poll source's parsed JSON output into a
collection of keyed objects, promoting [003 §12](./003-source-plugins.md) from **target** to
**current** with `verified:` references.

- **Shared core helper.** The per-object diff is implemented **once** as `diffKeyedCollection`
  (`libs/core/src/observation/keyed-collection.ts`, exported from `libs/core/src/index.ts` alongside
  `parseKeyedCollectionConfig` and `resolveDottedPath`) and consumed by **both** `api-poll` and
  `command-poll`. The create/modified/descoped semantics are identical across the two sources;
  sharing the helper avoids a divergence risk that per-plugin copies would carry.
- **Semantics (§12 verbatim).** Each array element becomes a tracked object with
  `objectKey = <monitor-objectKey>#<key-value>`; per-object observations use the existing
  `ChangeKind` vocabulary — `created` (key appears), `modified` (present in both, content differs
  after `ignore-paths` removal), `descoped` (key disappears — never `deleted`). The baseline run
  records the keyed snapshot and emits nothing; reordering and whitespace are inherently ignored
  (comparison is per-key, not positional).
- **`path` syntax (resolving §12's open design point).** `path` is a **minimal `$.`-prefixed dotted
  path** (root `$`, then `.field` segments — `$.tasks`, `$.data.items`); no wildcards, indices,
  filters, or recursive descent. It MUST select exactly one array (a non-array/missing resolution is
  an error). `ignore-paths` entries use the same syntax, relative to each element.
- **BP3 rejection.** A `collection` block is only valid under `strategy: json-diff`. Under
  `text-diff`/`exit-code` (or a defaulted strategy) it is rejected by `agentmonitors validate` with
  `change-detection.collection requires strategy: json-diff` — enforced both by each source's
  generated schema (`if/then`) and by the shared `validate` path (for the actionable message).
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` (re-sorted → zero observations;
  one element changing → one `modified` with the keyed `objectKey`; addition → `created`; removal →
  `descoped`, not `deleted`; `ignore-paths` suppression; path-not-an-array error); per-source
  integration tests in `plugins/source-api-poll/src/index.test.ts` and
  `plugins/source-command-poll/src/index.test.ts`; and the `validate` rejection/acceptance tests in
  `apps/cli/src/commands/cli.integration.test.ts`. Roadmap **G9** retired.
- Minor changesets: `@agentmonitors/core` (new exported helper), `@agentmonitors/source-api-poll`
  and `@agentmonitors/source-command-poll` (new collection mode).

## 2026-06-12 — Clarify source config wording and old-shape validation hints (003 §7.3, 004 §2.1–§2.3/§3.5, 005 §3/§7.1)

Issue #92 resolves the remaining author-facing ambiguity after the `watch: { type, ... }` migration.
`source list` text now says `Config fields` instead of `Scope fields`, JSON output includes
`configFields` while keeping `scopeFields` as a backwards-compatible alias, and `validate` appends a
targeted hint when a monitor still uses the old top-level `source:` + `scope:` shape. The specs now
distinguish the plugin API term `scopeSchema` from the authoring surface: source config is written
flat inside `watch:` alongside `type`.

- CLI behavior/docs/tests; patch changeset for `@agentmonitors/cli`.

---

## 2026-06-12 — `command-poll` source shipped (003 §11 target→current; G8 retired)

The local-process sibling of `api-poll` is now a bundled source, promoting
[003 §11](./003-source-plugins.md) from **target** to **current** with `verified:` references.

- **New package `@agentmonitors/source-command-poll`** implements §11.1–§11.6 verbatim: argv-only
  `command` spawned directly (`execFile`, `shell: false` — never a shell, so metacharacters pass
  through as literal arguments); `cwd`/`env`/`timeout`/`key`/`interval` scope; `text-diff` (default) /
  `json-diff` / `exit-code` strategies; a 1 MiB stdout cap marking `truncated: true` and diffing
  stably on the capped leading slice; SIGTERM→SIGKILL-after-5s timeout handling that leaves no orphan
  process; `stateful` baseline (first successful run records `{ stdout, exitCode }` and emits
  nothing); and transition-edge failure health (`ok ↔ failing` observations only on the edge — a
  nonzero exit **with** output is a result that gets diffed, while spawn failure and timeout are
  failures that keep prior state). `env` values are never written to any payload, snapshot, or state
  row.
- **Registered** via `registerCoreSources` (`apps/cli/src/sources.ts`) and scaffolded by
  `agentmonitors init --type command-poll` (`apps/cli/src/commands/init.ts`).
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the §11.7 list (no-shell
  metacharacter pass-through, per-strategy detection, nonzero-exit-is-a-result, spawn/timeout
  transition edges, env-not-persisted, 1 MiB stable truncation, no-orphan-on-timeout);
  `apps/cli/src/commands/cli.integration.test.ts` covers registration, the init template, and
  `validate` accepting/rejecting a `command-poll` monitor. Roadmap **G8** retired.
- Keyed-collection (§12) and the cursor protocol (§13) remain unbuilt targets (roadmap G9).
- Minor changesets: `@agentmonitors/source-command-poll` (new package) and `@agentmonitors/cli` (new
  source registered + init template).

## 2026-06-12 — `command-poll` implementation correction: `snapshot.command` is the argv array (003 §11.4)

Corrected `changedObservation()` in `plugins/source-command-poll/src/index.ts`: `snapshot.command`
was incorrectly set to `scope.objectKey` (the joined-argv string or `key` override) instead of the
argv array (`scope.command`). §11.4 specifies `snapshot: { command, exitCode, stdoutLength,
strategy }` where `command` is the argv array — matching `payload.command`. This was a behavioral
deviation from the spec; the spec wording is unchanged (it was always correct).

Also tightened `isCommandState()` to require `typeof truncated === 'boolean'`, preventing a
malformed `previousState` (e.g. `truncated: "yes"`) from being accepted and re-persisted through
the failure-path state carry-forward.

## 2026-06-12 — Activation skill authors verified-firing monitors from intent (006 §5.6)

Issue #95 upgrades the activation plugin's bundled `setup-monitors` skill from setup/scaffolding
guidance into an intent-to-working-monitor workflow. The skill frontmatter now triggers on plain
language authoring requests ("watch this file", "tell me when...", "notify me when..."), and the
body instructs agents to select the smallest shipped source type, ask only for required config,
write the monitor body as user judgment, run `agentmonitors validate`, and verify that the monitor
fires before calling setup done. The debug playbook now routes "it didn't fire" reports through
`agentmonitors monitor explain` rather than ad hoc guessing.

- Plugin-skill/test/docs only; no published package changeset.

## 2026-06-12 — `monitor explain` diagnosis command and read-only IPC report (002 §10.5–§10.7, 005 §6)

Issue #94 adds an author-facing pipeline diagnosis command:
`agentmonitors monitor explain <monitorId>`. The command returns a staged report for definition,
scheduling, observation, notify state, materialization, and projection/delivery, with text output
using `✓` / `✗` / `⏳` and a JSON report for agents. The daemon exposes a read-only
`monitor.explain` IPC method that composes the report from existing persisted runtime state:
`monitor_state`, `observation_history`, `monitor_events`, `session_event_state`, and
`agent_sessions`. The CLI also has a daemon-unavailable fallback that validates the local
definition, then reports scheduling as failed because the daemon is not running or unreachable.

- Minor changesets for `@agentmonitors/core` (new public explain report/runtime API) and
  `@agentmonitors/cli` (new command and IPC wrapper).

## 2026-06-11 — Steel-thread UAT now drives the plugin's literal `hooks.json` command strings (004 §3.5 config-drift coverage)

Follow-up to the steel-thread entry below (issue #89, review point 2 of #83, deferred at merge). The
existing steel-thread UAT drives `['session','start']` / `['hook','deliver']` as **argv** with
hand-built stdin — it proves the CLI's stdin contract but skips the seam the #83 bug actually lived
in: the mismatch between the plugin's `hooks.json` command **strings** and that contract (the
now-removed vestigial `&& agentmonitors hook deliver` chain was dead precisely because the first
command had already consumed stdin — invisible to an argv-level test).

A new **plugin hooks.json config-drift UAT** (`apps/cli/src/commands/cli.integration.test.ts`) closes
that gap: it parses the real
[`agent-plugins/agentmonitors/hooks/hooks.json`](../../agent-plugins/agentmonitors/hooks/hooks.json)
at test time (no copies) and runs each `SessionStart` / `UserPromptSubmit` / `SessionEnd` command
**verbatim** through `/bin/sh -c`, with an `agentmonitors` PATH shim satisfying the commands' own
`command -v agentmonitors` guard. It asserts the same end-to-end outcomes as the steel thread (daemon
boots + session registers; the dropped monitor's body arrives as `additionalContext`; session
deregisters; no orphan daemons) plus the missing-CLI fallback branch (empty PATH → the printed
fallback JSON parses and carries the `npm i -g @agentmonitors/cli` install hint). The test therefore
fails if a command string drifts incompatibly (a flag re-added, the binary renamed, the chain
broken), if the stdin contract regresses, or if the fallback emits invalid JSON. Recorded as a new
[004 §3.5](./004-validation-testing.md) scenario row.

- Test-and-spec only — no implementation or published-package behavior change, so no changeset.

## 2026-06-11 — `command-poll` source specified as target (003 §11–§13); 003 examples migrated to `watch:` syntax

Issue #81's problem framing is resolved into a normative **target** design (PP7) in
[003](./003-source-plugins.md):

- **§11 `command-poll`** — the local-process sibling of `api-poll`. Field-level scope (`command`
  argv array, `cwd`, `env`, `timeout`, `key`, `interval`, `change-detection`), execution model
  (1 MiB stdout cap, SIGTERM→SIGKILL timeout), strategies (`text-diff` default / `json-diff` /
  `exit-code`), identity and stateful baseline mirroring `api-poll`, and transition-edge failure
  semantics (`ok ↔ failing` health observations; **nonzero exit with output is a result, not a
  failure**). #81's open questions are decided in-spec: argv-only (no shell form, ever);
  env = inherit + literal overrides, never persisted; v1 executes without acknowledgment (a
  `MONITOR.md` is workspace code, same trust class as `package.json` scripts) with a
  command-acknowledgment ledger designed as target (§11.6); `exit-code` stays first-class;
  `observe()`-only in v1.
- **§12 keyed-collection change detection** — generic `change-detection.collection` mode
  (`path`/`key`/`ignore-paths`) emitting per-object observations with
  `created`/`modified`/`descoped`; applies to `api-poll` and `command-poll`; separable.
- **§13 caller-held cursor protocol** — sketch-only target ({{state}} argv templating +
  `next-state` extraction), deliberately not scheduled; the mtime pre-gate and monitor-chaining
  alternatives are recorded as rejected (003 §11.8), adopting #81's reasoning.
- **Roadmap:** new items G8 (`command-poll`, P2) and G9 (keyed collections, P3) with proofs.
- **Migration cleanup:** 003's YAML examples and schema-generation description still used the
  pre-migration `source:`/`scope:` authoring syntax; all examples now use the current
  `watch: { type, … }` shape ([001 §3.1](./001-monitor-definition.md)) and §7.2 reflects the
  actual generated schema (`watch`/`urgency` required, `watch.type` enum + conditional config).
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-11 — Follow-up: §10 session-id-equality question marked resolved (006 §10)

Review follow-up to the entry below (the PR merged before the review comment was addressed): the
2.1.160 re-verification already answered the **next** §10 open question — "confirm
`CLAUDE_CODE_SESSION_ID` equals the `hostSessionId` the `SessionStart` hook passes to
`session open`". The env var equals the live session id (verified), and the hook passes the stdin
`session_id`, which is by the hooks contract that same live id — so both transports resolve the same
identifier. The bullet is now marked **Resolved (2.1.160)** with the same observed-not-contracted
caveat. Docs-only; no changeset.

## 2026-06-11 — Channel session binding re-verified; `CLAUDE_CODE_SESSION_ID` is observed-not-documented (006 §4.4)

Prompted by the just-merged session-lifecycle stdin fix (hooks read `session_id` from stdin, **not**
an env var): does the same "no session-id env var" trap apply to the channel server, which runs as an
**MCP server** rather than a hook? Verified it does **not**.

- **Confirmed: an MCP-server subprocess receives `CLAUDE_CODE_SESSION_ID`.** Re-confirmed live against
  Claude Code 2.1.160 (the variable is present in MCP/child-process environments and its value exactly
  equals the live session id), corroborating the 2026-05-31 `experiments/channel-probe` run on 2.1.157.
  So `agentmonitors channel serve` resolving its session via `process.env['CLAUDE_CODE_SESSION_ID']`
  (`apps/cli/src/commands/channel.ts`) is correct — **no code change**. The hooks/stdin trap does not
  transfer: a hook is a short-lived per-event command (session id arrives on stdin), whereas the
  channel server is a long-lived MCP subprocess that inherits Claude Code's process environment.
- **Doc-precision correction.** The previous §4.4 cited <https://code.claude.com/docs/en/mcp.md> in a
  way that implied all three signals are documented. They are not: the current MCP reference documents
  only `CLAUDE_PROJECT_DIR` and `roots/list`; it is **silent** on `CLAUDE_CODE_SESSION_ID`. §4.4 now
  marks the two workspace signals **documented** and the session-id signal **empirically observed but
  undocumented** (host-version-dependent), with workspace binding (§4.4 #2) as the documented-safe
  fallback. Added an explicit hooks-vs-MCP contrast citing <https://code.claude.com/docs/en/hooks.md>
  (hook session id = stdin `session_id`; documented hook env vars do not include it).
- Updated the §10 open-question note to record the 2.1.160 re-confirmation and the observed-not-
  contracted caveat. Docs-only; no published-package behavior change, no changeset.

## 2026-06-11 — `session start`/`session end` read the host session id from stdin; steel-thread UAT

**Correction (production bug).** `session start` and `session end` previously read the host session
id from `process.env['CLAUDE_CODE_SESSION_ID']` and quick-exited when it was absent. That env var
**does not exist** in a real Claude Code hook invocation (input arrives as JSON on stdin — the same
issue [`hook deliver`](./006-agent-integration.md) was already corrected for). The effect was severe:
in a real session `session start` returned before booting the daemon, so the session never
registered, and the entire activation chain (lazy daemon boot + delivery) silently no-opped in
production. Plan B's tests passed only because they set the env var manually.

Both commands now read the **stdin hook payload** (006 §5.0): `hostSessionId = payload.session_id`
(no env fallback), `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? process.cwd()`. The shared
stdin reader (`readHookPayload` + `HookPayload`) is extracted to `apps/cli/src/hook-payload.ts` and
imported by `hook deliver`, `session start`, and `session end`. Documented in
[006 §5.0/§5.6](./006-agent-integration.md) and [005 §10.4/§10.5](./005-cli-reference.md).

- **Single-process `SessionStart` (one stdin stream).** A Claude Code hook invocation provides **one**
  stdin stream, and both `session start` and `hook deliver` consume all of stdin via
  `readHookPayload()`. So a chained `agentmonitors session start && agentmonitors hook deliver`
  (the previous SessionStart hook form) is broken: `session start` consumes the payload and the
  chained `hook deliver` sees EOF, parses `{}`, and silently no-ops — killing the post-compact recap.
  Fixed by folding the recap into `session start`: it reads the payload **once**, registers, then
  claims `post-compact` and prints the rendered `additionalContext` itself. The SessionStart hook
  (`agent-plugins/agentmonitors/hooks/hooks.json`) now runs the single command
  `agentmonitors session start`. Documented in [006 §5.6](./006-agent-integration.md).
- **Steel-thread UAT added** (Plan D Task 4): an end-to-end CLI integration test that drives the
  `UserPromptSubmit` delivery path over **stdin** — a dropped file-fingerprint monitor + a
  watched-file change ends with the agent handed that monitor's own body-instruction as
  `additionalContext` at the turn boundary. A companion test drives the **actual shipped SessionStart
  command form** (one subprocess, one stdin payload) and asserts the post-compact recap is surfaced by
  that single command — the regression guard for the single-stdin-stream bug above. The Plan B
  lifecycle tests were migrated from `CLAUDE_CODE_SESSION_ID` to stdin payloads so they fail against
  the old env-reading code, locking the stdin contract so the env-var regression cannot return.
- **Follow-up — now resolved (see the channel-binding entry above):** the question of whether
  `channel serve` (`apps/cli/src/commands/channel.ts`) shares the same "no session-id env var" trap was
  verified separately and answered **no** — an MCP-server subprocess _does_ receive
  `CLAUDE_CODE_SESSION_ID` (re-confirmed against 2.1.160), so the channel server's
  `process.env['CLAUDE_CODE_SESSION_ID']` resolution is correct and needs no change. The hooks/stdin
  trap does not transfer (hook = short-lived per-event command with the id on stdin; channel = long-lived
  MCP subprocess that inherits the process environment).
- `@agentmonitors/cli` patch changeset included.

## 2026-06-10 — Activation plugin via a colocated aipm marketplace; `channel-plugin/` folded in

Activation now ships as a single installable Claude Code plugin (`agentmonitors`) in a colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace embedded in this repo
(`agent-plugins/`, with `aipm.repo.ts` relocating `pluginsRoot` off the package `plugins/` glob).
The plugin wires the host lifecycle to the already-built CLI verbs — `SessionStart` →
`agentmonitors session start` then `agentmonitors hook deliver`, `UserPromptSubmit` →
`agentmonitors hook deliver`, `SessionEnd` → `agentmonitors session end` — and bundles the channel
MCP and a `setup-monitors` skill. Install once; thereafter a project opts in with project-local
state (no reinstall per monitor). Documented in [006 §5.6](./006-agent-integration.md).

- **Folded + retired `channel-plugin/`.** The standalone root `channel-plugin/` is removed; its
  `.mcp.json` (server key `agentmonitors`, preserving the `<channel source="agentmonitors">` tag)
  now lives at `agent-plugins/agentmonitors/.mcp.json` inside the activation plugin. The 2026-06-01
  entry below remains as a historical record of the original standalone packaging.
- **`PreToolUse`/`Stop` deliberately unwired** (they ignore `additionalContext`); `PostToolUse` left
  as a documented future tunable (per-tool firing → too many daemon round-trips for v1).
- **Targets: `claude` only.** aipm v0.3.0 does not generate Codex hooks and only Claude Code has the
  channel transport, so a non-Claude target would ship no working delivery path.
- **Hooks authored as host-native `hooks/hooks.json`.** aipm v0.3.0's Claude hooks transform only
  models `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`, so the lifecycle events
  (`SessionStart`/`SessionEnd`) are authored directly as a Claude-native `hooks/hooks.json`
  referenced from the plugin manifest, rather than via aipm's YAML→JSON generation.
- CLI/plugin-content only — no published-package behavior change, so no changeset.

## 2026-06-10 — Correction: `hook deliver` reads stdin JSON; corrected event support; truncation marker

Supersedes the input/event-support details of the Plan D entry below after verifying against the
current Claude Code hooks docs (<https://code.claude.com/docs/en/hooks.md>). Three corrections:

- **Input is stdin JSON, not env vars.** Claude Code delivers hook input as a JSON object on stdin
  (`session_id`, `cwd`, `hook_event_name`, …). There is **no `CLAUDE_CODE_SESSION_ID` environment
  variable** — the prior `hook deliver` relied on one and would silently no-op in real sessions. The
  command now reads stdin (robust against a TTY/empty/unparseable stream — it never hangs), derives
  `sessionId = payload.session_id` (no env fallback), `hookEventName = payload.hook_event_name`, and
  `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`.
- **`additionalContext` is honored only by context events.** Per the docs, only `UserPromptSubmit`,
  `SessionStart`, and `PostToolUse` honor `hookSpecificOutput.additionalContext`; `PreToolUse` (uses
  `permissionDecision`) and `Stop` (uses a top-level `decision`) do **not**. The old default
  `--hook-event-name PreToolUse` therefore targeted an event that ignores the context. The
  `--hook-event-name` flag is **removed**; the lifecycle is now **derived** from `hook_event_name`
  (`UserPromptSubmit`/`PostToolUse` → `turn-interruptible`, `SessionStart` → `post-compact`; any
  other event → emit nothing). `--lifecycle` remains as an optional override (mainly for tests). One
  command line — `agentmonitors hook deliver` — now works for every registered event.
- **Code-point-safe truncation with an explicit marker.** When the rendered context exceeds the
  4000-char cap it is truncated at a Unicode code-point boundary (never splitting a surrogate pair)
  and an explicit `[truncated — … run "agentmonitors events list --unread" …]` marker is appended
  (final string still ≤ cap). Truncation does **not** lose events: claiming marks rows claimed, not
  acknowledged (`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), so a
  truncated-away event stays **unread** and re-delivers via the next context event.

Docs updated: [006 §5.0/§5.1/§5.2/§5.3/§5.4/§5.5](./006-agent-integration.md),
[005 §12.2](./005-cli-reference.md). Tests: stdin-driven `hook deliver` integration tests, a
truncation-recoverability integration test (truncated-away events still in `events list --unread`),
and renderer truncation-marker + surrogate-pair unit tests.

---

## 2026-06-09 — Package scope rename: `@mike-north/*` → `@agentmonitors/*`; public npm publish

All published packages now use the `@agentmonitors` npm scope published to public npm
(`https://registry.npmjs.org`), replacing the previous `@mike-north` GitHub Packages scope.
The CLI (`@agentmonitors/cli`) is now a publishable package (no longer `private: true`); the
canonical install is `npm install -g @agentmonitors/cli`.

Packages renamed:

- `@mike-north/core` → `@agentmonitors/core`
- `@mike-north/source-file-fingerprint` → `@agentmonitors/source-file-fingerprint`
- `@mike-north/source-api-poll` → `@agentmonitors/source-api-poll`
- `@mike-north/source-schedule` → `@agentmonitors/source-schedule`
- `@mike-north/source-incoming-changes` → `@agentmonitors/source-incoming-changes`
- `@mike-north/cli` → `@agentmonitors/cli`
- `@mike-north/website` → `@agentmonitors/website`

Release pipeline: `release.yml` now uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (repo
owner must add the `NPM_TOKEN` secret). Changeset `access` set to `"public"`.

No spec behavior changes. All package references in docs, source files, and tooling updated.

---

## 2026-06-10 — Plan D Tasks 2–3: hook-deliver renderer + `hook deliver` command

- Added `apps/cli/src/hook-deliver-render.ts` — a **pure, side-effect-free renderer** that maps a
  `DeliveryClaim` to the Claude Code hook wire shape
  `{ continue: true, hookSpecificOutput: { hookEventName, additionalContext } }`. Returns `null`
  when the claim is null or has no events. `additionalContext` is capped at 4000 characters; unlike
  the channel transport (§4.6), it is a plain JSON string that is **not** tag-delimited, so
  markdown/code punctuation (`<>`, `[]`, `;`) and newlines are preserved verbatim (a monitor body is
  trusted, user-authored markdown) — only raw C0/C1 control characters (except tab/newline) are
  stripped. The rendered context includes a lead line and one block per event: monitorId, urgency,
  title, and the monitor's `body`-instructions from `DeliveryEventSummary.body`.
- Added `hook deliver` subcommand to `apps/cli/src/commands/hook.ts`. Designed to run as a Claude
  Code lifecycle hook (`PreToolUse`, `Stop`, `PostCompact`). Reads `CLAUDE_CODE_SESSION_ID` +
  `CLAUDE_PROJECT_DIR` from env, resolves the daemon socket via `.local.md`, looks up the session,
  claims pending deliveries at the given `--lifecycle`, renders, and writes the wire JSON to stdout.
  **Always exits 0** — any internal error is swallowed (a hook that exits non-zero would interrupt
  the user's session). Prints nothing when there is nothing pending.
- [005 §12.2](./005-cli-reference.md) added (`hook deliver` command reference, flags, wire output,
  always-exit-0 contract).
- [006 §5](./006-agent-integration.md) added (hook-deliver transport spec: wire contract, behavior
  steps, lifecycle-to-delivery mapping, and hook registration examples).
- `.changeset/hook-deliver-command.md`: `@agentmonitors/cli` minor (new `hook deliver` command).

---

## 2026-06-09 — Plan D Task 1: `DeliveryEventSummary` carries the monitor `body`

- A new required field `body: string` is added to `DeliveryEventSummary`
  (`libs/core/src/runtime/types.ts`). It carries the raw monitor body-instructions
  (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`), so a delivery
  transport can surface what the agent should **do** when a monitor fires — not just the
  `title`/`summary`.
- `claimDelivery()` in `service.ts` populates `body: event.body` in both places that map events to
  `DeliveryEventSummary`: the settled-high (`turn-interruptible`) path and the recap
  (`post-compact`) path. The `normal` and `low` paths return `events: []` and are unaffected.
- `DeliveryEventSummary` is re-exported from the public index; the api-extractor rollup
  (`dist/public.d.ts`) is updated to include the new field.
- [002 §9.1](./002-runtime-delivery.md) and [002 §9.4](./002-runtime-delivery.md) updated to
  document the `body` field. [006](./006-agent-integration.md) updated to reflect the enrichment.

## 2026-06-09 — Lazy project-scoped daemon (Plan B)

CLI-only change (no `@agentmonitors/core` public API change; no changeset needed).

**New files:**

- `apps/cli/src/workspace-paths.ts` — `workspacePaths(workspacePath)` derives a stable per-workspace
  `{ dir, db, socket }` under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`.
- `apps/cli/src/local-state.ts` — `readLocalState`/`writeLocalState` for
  `.claude/agentmonitors.local.md` (minimal YAML frontmatter: `enabled`, `socket`, `db`,
  `reap-after-ms`). Absent/unparseable → `{ enabled: false }` (quick-exit).
- `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()` spawns `daemon run` with
  `detached: true, stdio: 'ignore'`, `.unref()`. The spawner exits; the daemon runs in the background.

**Modified files:**

- `apps/cli/src/commands/session.ts` — adds `session start` (lazy-boot daemon + `session.open`) and
  `session end` (finds session by `hostSessionId`, calls `session.close`). Both are no-ops when
  `CLAUDE_CODE_SESSION_ID` is absent or `enabled: false`.
- `apps/cli/src/commands/daemon.ts` — adds `--reap-after-ms <ms>` to `daemon run` (default 300000;
  0 disables). After each tick, the daemon counts active sessions for the workspace; if zero for
  `reapAfterMs` ms continuously, it stops itself.

**Spec updates:**

- [002 §10.2](./002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server) — lazy
  boot, per-workspace isolation, idle reaping.
- [005 §9.2](./005-cli-reference.md#92-daemon-run--continuous-loop), [§10.4](./005-cli-reference.md#104-session-start--lazy-boot-daemon-and-register-session),
  [§10.5](./005-cli-reference.md#105-session-end--deregister-session) — `session start`/`session end` + `--reap-after-ms`.

## 2026-06-09 — `rebaselined` observation outcome and `ObservationResult.outcome` diagnostic

- A new optional field `outcome?: 'rebaselined'` is added to `ObservationResult`
  (`libs/core/src/observation/types.ts`). A source can set this to signal that it advanced its
  persisted baseline to the current point but could not compute a delta (e.g. a gc'd or
  force-pushed prior ref), as opposed to a genuine quiet tick.
- A new `ObservationOutcome` member `'rebaselined'` is added to the union in
  `libs/core/src/runtime/types.ts` and to the drizzle enum in `libs/core/src/inbox/schema.ts`.
- `ingest()` in `service.ts` maps `sourceOutcome: 'rebaselined'` to the new history result, with
  correct precedence: emitted > 0 → `triggered`; else if `rebaselined` → `rebaselined`; else
  observed > 0 → `suppressed`; else → `no-change`.
- The `incoming-changes` source (`plugins/source-incoming-changes`) now sets `outcome: 'rebaselined'`
  on the diff-failure re-baseline path (the `entries === undefined` branch). The other early-return
  paths (not-a-repo, initial baseline, genuine no-advance) are left unchanged.
- `agentmonitors monitor history` help text updated to include `rebaselined` in the result legend.
- [002 §`observation_history`](./002-runtime-delivery.md) and [005 §6](./005-cli-reference.md) updated.
- Issue: [#56](https://github.com/mike-north/AgentMonitors/issues/56).

## 2026-06-08 — Authoring surface → `watch: { type }` (closes #41)

Replace the mechanism-first `source:` + `scope:` frontmatter pair with an
intent-first `watch:` block carrying an explicit `type` discriminator. This is a
**hard cut** — the old `source:`/`scope:` shape no longer validates.

### New canonical shape

```yaml
name: ...               # optional, unchanged
watch:
  type: <source-name>   # e.g. file-fingerprint, api-poll, schedule, incoming-changes
  <...per-source config flat here...>
urgency: normal         # unchanged
notify: {...}           # optional, unchanged
tags: [...]             # optional, unchanged
```

Per-source config keys (including `interval`) live **flat inside `watch:`** as
siblings of `type`. There is no nested `scope:` object.

### Files changed

- `libs/core/src/schema/monitor-schema.ts`: replaced `source` (string) + `scope`
  (record) with `watch` (object with validated `type` + `.catchall(z.unknown())`
  for per-source config).
- `libs/core/src/runtime/service.ts`: all `frontmatter.source` → `frontmatter.watch.type`;
  all `frontmatter.scope` → `watchConfig(frontmatter.watch)` (helper that returns the
  `watch` block minus `type`).
- `libs/core/src/schema/validate-scope.ts`: unchanged — callers now pass the watch config
  object (watch minus type) instead of `scope`.
- `libs/core/src/observation/schema-generator.ts`: updated to discriminate on
  `watch.type` instead of `source`; required fields are now `['watch', 'urgency']`.
- `apps/cli/src/commands/init.ts`: all templates rewritten to `watch:` shape; `--source`
  option renamed to `--type`.
- `apps/cli/src/commands/validate.ts`, `scan.ts`, `monitor-test.ts`: updated to read
  `frontmatter.watch.type` instead of `frontmatter.source` and pass watch config to
  `validateScope`.
- `.claude/monitors/spec-changes/MONITOR.md`: dogfood monitor converted to `watch:` shape.
- All test fixtures in `libs/core/src/` and `apps/cli/src/` updated.
- `docs/specs/001-monitor-definition.md` §3 updated to document `watch:` block.

### api-extractor

`monitorFrontmatterSchema` and `MonitorFrontmatter` public API changed; report
regenerated.

## 2026-06-08 — Reconcile `changeKind` vocabulary (closes #42)

The `changeKind` vocabulary is now canonical across the standard and the codebase. The
four values `created | modified | deleted | descoped` were already the implementation
contract in `libs/core/src/observation/types.ts`; this entry records the corresponding
update to the outward standard.

- `docs/standard/monitor-md-standard.md` §2: replaced the five-row table (which listed
  `appeared` and `elapsed`) with the four canonical values; folded "a new member of a
  collection/feed appeared" into the `created` row; removed the "being reconciled"
  caveat blockquote (the vocabularies now agree).
- `libs/core/src/observation/types.ts`: rewrote the `ChangeKind` doc-comment to make
  `created` and `descoped` crisply distinct. `created` = a new object or member entered
  the monitor's scope (including new items in a watched collection/feed); `descoped` =
  still exists upstream but left the monitor's scope (no information lost).
- No runtime behavior change — the type was already `created | modified | deleted | descoped`.

## 2026-06-08 — Per-monitor `observe()` failure isolation and `errored` outcome

- The runtime now **isolates per-monitor failures in `tick()`**: if a source's `observe()` throws
  or rejects, the failure is caught, an `errored` observation-history row is recorded, and the tick
  continues to the next due monitor. A single buggy source can no longer abort the entire tick and
  starve all other monitors ([002 §`observation_history`](./002-runtime-delivery.md)).
- The same isolation is applied to the **watch path** (`consumeWatch()`): an `ingest()` failure on
  one yielded observation records an `errored` history row and the watcher continues consuming
  subsequent observations. The outer catch (for errors from the async iterator itself) is unchanged.
- **State preservation on failure**: `ingest()` is not called for a failing monitor, which means
  `setMonitorState()` is never reached. The persisted `sourceState` is left exactly as it was after
  the last successful tick, so the next tick's diff spans from the last good baseline rather than
  from an empty state — no subsequent delta is dropped.
- **New `ObservationOutcome` member**: `'errored'` is added to the
  `ObservationOutcome` union (`libs/core/src/runtime/types.ts`) and the drizzle enum in
  `libs/core/src/inbox/schema.ts`. The raw SQL in `libs/core/src/inbox/db.ts` uses `result TEXT NOT
NULL` with no CHECK constraint and needed no change.
- Minor `@agentmonitors/core` changeset (new public `ObservationOutcome` member + runtime guarantee).
- Issue: [#46](https://github.com/mike-north/AgentMonitors/issues/46).

## 2026-06-08 — New bundled source `incoming-changes`

- Added `@agentmonitors/source-incoming-changes` as the fourth bundled observation source
  ([003 §6](./003-source-plugins.md)). The source detects per-file changes when a git ref advances
  (pull, merge, fast-forward, or local commit) and reports them as `Observation` records with a
  `changeKind` (`created`/`modified`/`deleted`), `objectKey` (file path), `snapshotText` (new text
  content for created/modified non-binary files), and `payload: { path, status, fromRef, toRef }`.
- **Resumption token** = last-seen commit SHA (`nextState: { ref: '<sha>' }`). Restart-safe: on wake
  the diff spans `<stored-sha>..<current-head>` — the net change across all missed commits is
  reported in one batch (PP6).
- **v1 scope boundary**: fires on any ref advance touching `paths`; "fetch-only" filtering is a
  planned later refinement.
- **Error resilience**: `rev-parse` failures return an empty result with no `nextState`; `git diff`
  failures (gc'd SHA, history-rewritten range) trigger a silent re-baseline. Neither propagates to
  the tick loop.
- CLI registration and `init` scaffolding land with issue #39.
- Minor `@agentmonitors/source-incoming-changes` changeset (initial `minor`).

## 2026-06-07 — Remove `event-kind` frontmatter field

- `event-kind` (and its runtime counterparts `eventKind` / `event_kind`) are **removed** from the
  schema and the entire pipeline. The field was never surfaced in a delivered signal and served no
  runtime purpose. Affected: frontmatter schema ([001 §3](./001-monitor-definition.md)), required
  fields for JSON Schema generation ([003 §2](./003-source-plugins.md)), `monitor_events` and
  `inbox_items` DB columns ([002 §5/§12](./002-runtime-delivery.md)), delivery meta key table
  ([006 §4.2](./006-agent-integration.md)), CLI scan output and filter options
  ([005 §5/§9](./005-cli-reference.md)). No DB migration — a local no-users project. Minor
  `@agentmonitors/core` changeset.

## 2026-06-04 — Flat-file monitor authoring; `name` optional

- Monitors may now be authored as a flat `.claude/monitors/<id>.md` file (id = filename), in
  addition to the folder form `<id>/MONITOR.md` (id = directory). The scanner discovers both;
  markdown assets nested inside a folder monitor are not treated as monitors
  ([001 §scanning](./001-monitor-definition.md)). Verified: `parse-monitor.ts` id derivation and
  `scan-monitors.ts` combined glob.
- `name` is now **optional** in frontmatter and defaults to the monitor id. Minor
  `@agentmonitors/core` changeset.

## 2026-06-02 — Channel transport, automated end-to-end UAT

- Added `experiments/channel-uat/` — an MCP-client harness that verifies the channel **push** path
  ([006 §4](./006-agent-integration.md)) end to end without a live Claude session or a
  channels-enabled org. It starts a real daemon + monitor, spawns `agentmonitors channel serve`,
  connects to it over stdio as the MCP host (injecting `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR`
  exactly as Claude Code would), mutates the watched file, and asserts the `<channel>` push.
- Confirmed both delivery shapes: `normal` urgency pushes the coalesced reminder; `high` urgency
  pushes the concrete event (`event_count: 1`, `monitor_id`, `event_id`) after the ~15s settle.
- Retires the last G7 follow-up (the previously "manual, not CI-able" end-to-end UAT). Experiment-only
  (outside the workspace globs); no changeset.

## 2026-06-02 — Watch-mode source execution (G5)

- The runtime now drives continuous `watch()` for opt-in sources:
  `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` consumes each watch-capable
  source's `AsyncIterable<Observation>` and funnels every yielded observation through the **same**
  notify dispatch → materialization → projection pipeline as `observe()` (extracted into a shared
  `ingest()` helper, which also records the `observation_history` audit row, so watch-mode
  observations are audited identically to ticked ones). Returns a `WatchHandle` whose `stop()` aborts
  and awaits the watchers ([002 §2.3](./002-runtime-delivery.md)). `daemon run` starts/stops watchers
  around its tick loop.
- A watched monitor is skipped by the tick loop's `observe()` (no double-processing); a watcher that
  throws outside its own abort is surfaced via `onError` and released so the tick loop resumes it.
- Added `ObservationContext.signal?: AbortSignal` (passed to `watch()` for teardown) and the exported
  `WatchHandle` type. Promoted **NP4** from "the runtime does not define watch-mode" to
  "watch-mode is opt-in and additive" ([000](./000-principles.md), [003 §2](./003-source-plugins.md)).
- Closes roadmap **G5**. No bundled source opts into `watch()` yet, but the path is exercised
  end-to-end (`libs/core/src/runtime/service.test.ts`). Minor `@agentmonitors/core` changeset
  (new `watchMonitors` method, `WatchHandle` type, `ObservationContext.signal` field).

## 2026-06-01 — Observation history audit trail (G6)

- The runtime now **writes `observation_history`** — for each due monitor per tick it records the
  outcome (`triggered` / `suppressed` / `no-change`) plus a `{ observed, emitted }` summary, via the
  new `RuntimeStore.recordObservationHistory` / `listObservationHistory`
  ([002 §"Persistence Schema"](./002-runtime-delivery.md)).
- Added a daemon IPC method `history.list` and the `agentmonitors monitor history [monitorId]`
  command to read it ([005 §6](./005-cli-reference.md)) — a "why didn't my monitor fire?" diagnostic.
- Closes roadmap **G6** (the dead table now has a write path **and** a reader). Runtime + CLI
  integration tests added; minor `@agentmonitors/core` changeset (new `RuntimeStore` methods, exported
  `ObservationHistoryRecord` / `ObservationHistoryQuery` / `ObservationOutcome` types, runtime write).

## 2026-06-01 — Channel transport, stage 3 (plugin packaging); G7 shipped

- Added `channel-plugin/` — a Claude Code channel plugin (`.claude-plugin/plugin.json` + `.mcp.json`)
  that runs `agentmonitors channel serve`, plus a README with the prerequisites and the manual UAT
  command. Lives at the repo root (outside the `plugins/*` workspace glob, since it is a plugin
  manifest, not an npm package).
- Marks the channel transport ([006 §4](./006-agent-integration.md)) implemented and retires roadmap
  **G7**. Non-blocking follow-ups remain: the end-to-end manual UAT (channels are research-preview)
  and optional `object_key` meta (needs `DeliveryEventSummary` enrichment).

## 2026-06-01 — Channel transport, stage 2 (two-way ack)

- `agentmonitors channel serve` is now two-way: it declares `capabilities.tools` and exposes the
  **`agentmon_ack`** tool (`apps/cli/src/channel-ack.ts`), which routes through `events.ack` for the
  bound session — the bound session id is the "outbound gate" (006 §4.3). Tool arguments are
  validated defensively at the MCP boundary (`parseAckArgs`, unit-tested). Session resolution is
  shared between the poll loop and the ack tool. Marked [006 §4.3](./006-agent-integration.md)
  implemented; updated roadmap G7 (remaining: plugin packaging + manual UAT). CLI-only; no changeset.

## 2026-06-01 — Channel transport, stage 1 (one-way push)

- Shipped `agentmonitors channel serve` ([005 §13](./005-cli-reference.md)): an MCP **channel**
  server that binds via `CLAUDE_CODE_SESSION_ID`, polls `claimDelivery('turn-interruptible')` over
  the daemon socket, and pushes each settled claim as a `<channel>` event. Reuses the claim path, so
  claimed-state and cross-transport dedup come for free; a missing daemon is handled quietly (the
  hook path still delivers). The claim→event renderer is unit-tested.
- Clarified [006 §2](./006-agent-integration.md): the transport seam needs **no in-process
  `DeliveryTransport` refactor** — the channel transport is realized out-of-process over the daemon
  IPC surface. Marked [006 §4.1](./006-agent-integration.md) one-way push as implemented; updated
  roadmap G7 (stage 1 done; remaining: ack tool + packaging + manual UAT).
- `apps/cli` is changeset-exempt, so no changeset. Also corrected a stale `validate` status in the
  005 command inventory (full schema validation since G2).

## 2026-06-01 — Closed remaining test gaps (T2, T4; T1 retired)

- **T2** — added `RuntimeStore` snapshot tests (save/retrieve + isolation by
  `(workspace, monitor, objectKey)`, SP5) and a runtime test asserting `diffText` is computed
  against the prior snapshot when an object changes.
- **T4** — added standalone CLI integration tests for `schema generate` (and `-o` output) and the
  `session list` → `session close` lifecycle.
- Retired the already-shipped **T1** (`low` urgency, #21) from the roadmap; all tracked test gaps
  (T1–T4) are now closed. Test-only change — no changeset.

## 2026-06-01 — First-class observation change-kind; file-fingerprint create/delete (G3)

- Introduced a **source-agnostic `changeKind`** primitive on the core `Observation` contract
  (`created` / `modified` / `deleted` / `descoped`), exported as the `ChangeKind` type. `deleted`
  (information lost upstream) and `descoped` (still exists upstream, left the monitor's scope) are
  deliberately distinct so agents react differently — e.g. a pull request _deleted_ vs _closed_.
  See [003 §2.3](./003-source-plugins.md).
- The runtime copies `observation.changeKind` into the materialized event's `queryScope.changeKind`
  ([002 §5.1](./002-runtime-delivery.md)), so it is filterable without each source duplicating it.
- `file-fingerprint` is the first emitter: it now reports `created` / `modified` / `deleted` /
  `descoped` (stat-ing the path to distinguish a true disk deletion from a glob/config change),
  closing roadmap G3 — promoted [003 §3.3](./003-source-plugins.md) from limitation to current
  behavior. Minor changesets for `@agentmonitors/core` and `@agentmonitors/source-file-fingerprint`.

## 2026-05-31 — Channel transport binding confirmed (006 §4.4)

- Ran the `experiments/channel-probe` diagnostic against Claude Code 2.1.157 with the probe spawned
  **as an MCP server** (`--mcp-config`). Confirmed: the server receives `CLAUDE_PROJECT_DIR`
  (= workspace), its cwd is the workspace, it **inherits `CLAUDE_CODE_SESSION_ID`**, and `roots/list`
  returns the workspace root.
- Resolved the [006 §4.4](./006-agent-integration.md) open question: **session-level binding is
  available** (the MCP subprocess inherits the host session id), so it is now the documented
  preferred strategy, with workspace binding as fallback. Updated roadmap G7 (binding proof done;
  remaining work is the transport seam + channel server). The channel transport itself is still
  target (unbuilt); only the binding mechanism is confirmed.

## 2026-05-31 — Full per-source scope validation in `validate` (G2)

- Promoted [004 §2.2](./004-validation-testing.md) and [001 §8](./001-monitor-definition.md)
  from target to **current**: `validate` now performs full JSON Schema (draft-07) validation of
  each monitor's `scope` against its source's `scopeSchema`, not just required-field presence.
  Closes roadmap G2 (and test gap T3).
- Added the exported core helper `validateScope(scope, scopeSchema)`
  (`libs/core/src/schema/validate-scope.ts`); the CLI calls it (AP4/AP6).
- Validator is **`@cfworker/json-schema`**, chosen over ajv specifically because it validates by
  walking the schema at runtime rather than compiling with the `Function` constructor — safe under
  restrictive CSP / Workers-style environments. Minor `@agentmonitors/core` changeset.

## 2026-05-31 — Duplicate monitor IDs are now rejected (G1)

- Promoted [001 §4](./001-monitor-definition.md) from target to **current**: duplicate
  folder-derived monitor IDs are now a hard error, closing roadmap item G1.
- `scanMonitors` surfaces collisions via a new `ScanResult.duplicateIds`
  (`DuplicateMonitorId[]`) field; the runtime tick refuses to run on duplicates; `validate`
  exits non-zero and `scan` reports them. Enforces SP2. Regression tests added at the scanner,
  runtime, and CLI layers; minor `@agentmonitors/core` changeset included.

## 2026-05-31 — Agent integration & delivery transports

- Added normative [006-agent-integration.md](./006-agent-integration.md): a delivery-**transport**
  abstraction behind the adapter seam, covering the current hook-state transport and a **target**
  Claude Code **channel** transport. Recorded as roadmap item G7.
- Scoped the channel transport's binding model from evidence. A spawned MCP server can recover its
  **workspace** (`CLAUDE_PROJECT_DIR` / MCP `roots/list`). For **session** identity there is no
  `CLAUDE_SESSION_ID`, but a probe found `CLAUDE_CODE_SESSION_ID` present in Claude Code's process
  environment; whether MCP-server subprocesses inherit it is the open question the one-way prototype
  (`experiments/channel-probe/`) resolves. Binding therefore prefers **session** scope when that
  variable is available and falls back to **workspace** scope (single-active-lead-session assumption,
  degrade on multi-lead); the hook-state transport remains the per-session-accurate surface either way.
- Established that channels are **optional and additive** (NP-CH): research-preview, version- and
  org-gated, so they must never become a delivery dependency. The hook-state transport stays the
  always-available default.

## 2026-05-31 — In-repo authoring pass

The numbered draft set was promoted into `docs/specs/` as the
canonical contract, verified against the code, and enriched. See
[maintainer-migration-notes.md](./maintainer-migration-notes.md) for the source mapping.

### Structure

- Established `docs/specs/` as the canonical location (previously only referenced as a plan).
- Added supporting docs: [README.md](./README.md), [glossary.md](./glossary.md),
  [roadmap.md](./roadmap.md).
- Added normative [005-cli-reference.md](./005-cli-reference.md) covering the full
  `agentmonitors` command surface.

### 001-monitor-definition.md

- Verified the `source` field constraint against `monitor-schema.ts`: the regex is
  `^[a-z][a-z0-9-]*$` (first character must be a lowercase letter), which is stricter than
  the prose "kebab-case". The doc now states the exact regex.

### 002-runtime-delivery.md

- Enriched with verified sections for the **daemon/IPC** layer, **agent-integration
  adapters** (`claudeCodeAdapter` lifecycle→hook mapping), and a **persistence-schema
  appendix** covering the real Drizzle/SQLite tables.
- Clarified that `daemon once` / a single tick runs **in-process without the Unix socket**;
  only `daemon run` serves the socket that `session`/`events`/`hook` round-trip through.
- Clarified that lead-only event projection is enforced as a post-query role filter, that
  `latestHighTitles` is capped at 5, and that computed diffs are capped at 20 changed lines.
- Recorded that `observation_history` is defined in the schema but has **no runtime write
  path** (current-vs-target; tracked as roadmap G6).

### 003-source-plugins.md

- Verified `api-poll` is **stateful**, that `text-diff` is its **default** change-detection
  strategy, that its `method` scope enum is limited to `GET`/`POST`, and that its
  `snapshot` carries `{ url, status, bodyLength, strategy }` rather than the full body.
- Clarified that `schedule` omits the `stateful` field entirely (rather than setting it
  `false`), and that `queryScope` values may be `string | string[]`.

### 004-validation-testing.md

- Replaced the external "FormSpec" style reference (from the source author's other project)
  with project-local guidance, since FormSpec does not exist in this repo.
- Mapped each required test scenario to the test file that covers it and flagged the
  uncovered ones (`low` urgency, snapshot persistence/isolation, `validate` failure paths,
  `schema generate` and standalone `session list|close` wiring). Tracked in
  [roadmap.md](./roadmap.md) as T1–T4.

### Carried forward from the prior draft set (2026-04-06)

- **000-principles.md** — established the numbered spec set as the canonical implementation
  contract; recorded the runtime/session event pipeline as authoritative delivery; recorded
  the legacy inbox lifecycle as a separate still-implemented model; made `low` urgency
  first-class.
- **001-monitor-definition.md** — split monitor authoring/frontmatter into its own doc; made
  duplicate monitor IDs a normative correctness requirement even though the scanner does not
  yet reject them; clarified single-root (no multi-root merge) evaluation.
- **002-runtime-delivery.md** — split runtime polling, persistence, session projection, and
  hook delivery into a dedicated contract; clarified unread/claimed/acknowledged as distinct;
  clarified that high urgency defaults to debounced delivery rather than immediate interrupt.
- **003-source-plugins.md** — split the source contract and bundled-source behavior into a
  dedicated doc; recorded `file-fingerprint` create/delete limitations; recorded
  plugin-management CLI commands as placeholders.
- **004-validation-testing.md** — clarified that `agentmonitors validate` performs partial
  source-specific validation rather than full per-source JSON Schema validation; defined the
  evidence hierarchy for resolving drift during the transition to the internal numbered specs.
