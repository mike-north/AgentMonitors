# pipeline/post-processing Specification

## Purpose

Names the post-processing stages an observation passes through between acquisition and delivery,
fixes their order and the one shared/per-recipient seam, and specifies the deterministic Shape
stage, author-declared payload forms, per-recipient baseline strategy, and the optional agentic
Interpret stage. Notify timing internals live in `runtime/notify-dispatch`; event rows and the shared
diff live in `runtime/event-materialization`.

## Requirements

### Requirement: Locked stage order

The system SHALL pass every observation through the stages Observe → [Compose] → Shape → Pace →
per-recipient seam → Diff → Interpret → Deliver, in that order, where bracketed stages are optional.
Observe is owned by the source (per `sources/contract`, PP3) while the runtime decides when it runs
(AP3); Pace is the runtime's notify timing (per `runtime/notify-dispatch`); Deliver hands a packet to
a recipient at a delivery lifecycle (per `delivery/lifecycles`).

#### Scenario: Shape and its suppression gate precede Pace

- **GIVEN** a monitor with `payload.form: structured` whose `cel` transform evaluates `false` for an observation
- **WHEN** the runtime ingests that observation
- **THEN** the observation is removed before notify dispatch runs
- **AND** it never enters a pending debounce or rollup batch and never advances notify state

#### Scenario: Diff precedes Interpret

- **WHEN** a `prose` monitor with an injected Interpret adapter materializes an event
- **THEN** the per-recipient diff is computed and recorded first
- **AND** the Interpret adapter receives that per-recipient delta, never the raw source snapshot

### Requirement: Compose is an optional shared stage

The system SHALL treat Compose — assembling one observation from multiple source queries or calls
into a single composite snapshot — as optional and as running before every downstream stage, on the
shared side of the seam. A monitor whose single call already yields the whole observation omits it.
The source-side contract for composite observations is owned by `sources/contract`.

#### Scenario: Composite observation flows as one observation

- **WHEN** a source composes several calls into one composite snapshot
- **THEN** the runtime shapes, paces, and diffs that composite as a single observation

### Requirement: Runtime delivery contract ends at Deliver

The system SHALL end its delivery contract at the Deliver stage: an executor agent acting on a
delivered packet (the React position after Deliver, which may be the recipient itself) is outside
the runtime's contract, and the runtime SHALL NOT guarantee or perform any downstream side effect on
the recipient's behalf (per NP2).

#### Scenario: No runtime-driven reaction

- **WHEN** a packet is delivered to a recipient session
- **THEN** the runtime's work for that packet is complete at delivery
- **AND** any action taken on the packet is performed by the recipient agent, not the runtime

### Requirement: Stages left of the seam run once and are recipient-independent

The system SHALL compute Observe, Compose, Shape, and Pace exactly once per observation, shared
across every recipient session regardless of how many recipients a monitor fans out to, and none of
these stages SHALL depend on recipient identity.
Rationale: this seam is what makes fan-out cheap (one acquisition, render, and settle decision).

#### Scenario: One shared computation for many recipients

- **GIVEN** a monitor whose events project into three lead sessions
- **WHEN** one observation is processed
- **THEN** the source is observed once, the Shape render runs once, and one Pace decision is made
- **AND** exactly one shared `monitor_events` row is materialized for that observation

### Requirement: Diff is computed per recipient against its own baseline cursor

For each lead session an event projects into, the system SHALL diff the shared shaped artifact
against that session's own baseline cursor (`session_object_cursor`, whose denormalized
`baseline_content` makes it immune to snapshot pruning) and record the result on
`session_event_state.diff_text`. Claiming SHALL advance a recipient's cursor to the artifact it was
just shown.

#### Scenario: Divergent baselines receive independently spanned diffs

- **GIVEN** two lead sessions of one workspace whose stored cursors point at different prior artifacts
- **WHEN** one shared observation materializes
- **THEN** each session's `session_event_state.diff_text` spans from its own cursor to the new artifact
- **AND** the two recorded deltas differ

#### Scenario: Cursor survives restart

- **GIVEN** a session that claimed an event, advancing its cursor
- **WHEN** the runtime restarts and a further change materializes
- **THEN** that session's delta is computed from the cursor persisted before the restart

#### Scenario: Recipients are isolated

- **WHEN** one session claims and advances its cursor
- **THEN** no other session's cursor changes

### Requirement: First-time recipient is seeded to the pre-event state

When a lead session has no stored cursor for an object, the system SHALL seed that session's
baseline to the pre-event state so a late-joining recipient hears only changes made after it
registered, never the object's whole history.

#### Scenario: Late joiner hears only the newest change

- **GIVEN** an object with several prior materialized changes and a newly registered lead session
- **WHEN** the next change materializes
- **THEN** the new session's per-recipient delta covers only that change

### Requirement: Shared object-level diff is the degenerate per-recipient case

The system SHALL keep the shared object-level diff on `monitor_events.diff_text` (for `events list`
and history display) and SHALL make the per-recipient delta of a session at the shared baseline
byte-identical to it; a session whose cursor is legacy-NULL SHALL fall back to the shared diff.

#### Scenario: Single session at the shared baseline

- **GIVEN** exactly one lead session that has seen every prior event
- **WHEN** a change materializes
- **THEN** its `session_event_state.diff_text` equals `monitor_events.diff_text` byte-for-byte

### Requirement: Identical-baseline recipients may share per-recipient work

The system MAY deduplicate per-recipient work (Diff span, `net` collapse, Interpret) across
recipients that hold the identical baseline and therefore compute the identical span; per-recipient
work SHALL multiply only where baselines genuinely differ.

#### Scenario: Co-registered recipients share one computation

- **GIVEN** two lead sessions registered at the same point
- **WHEN** a change materializes
- **THEN** both record the same delta and any Interpret call for it is made once

### Requirement: Three independent clocks

The system SHALL treat observation cadence, Pace timing, and per-recipient delivery timing as three
independent clocks: none SHALL be derived from another, and they compose without conflict.

#### Scenario: Clocks compose

- **GIVEN** a source that observes every 30s and a `high` monitor holding a debounce batch for a 15s settle
- **WHEN** the batch flushes while a recipient is mid-turn
- **THEN** the recipient receives it only at its next appropriate delivery lifecycle
- **AND** neither the observation interval nor the settle window is altered by the recipient's timing

### Requirement: Derived facts are a pure function of snapshot and injected now

The system SHALL compute each derived fact as a pure function of the shaped snapshot plus the
runtime-supplied `now` (the observation's tick time): no model call, no network, and no wall-clock
read other than the injected `now`. The same inputs SHALL yield the same facts on every run.

#### Scenario: Crossing a defer threshold reveals exactly one fact

- **GIVEN** a monitor declaring a single derived fact `revealed` with predicate `defer-until ≤ now`, and a fixed `now`
- **WHEN** the snapshot's single task has `defer-until` equal to `now`
- **THEN** exactly the `revealed` fact holds and no other
- **AND** evaluating the same snapshot with `now` one minute earlier yields no facts

#### Scenario: Illustrative E8 rule shapes

- **GIVEN** author-declared rules for `past due` (`due < now`), `due soon` (`now ≤ due ≤ now + 48h`), `revealed` (`defer-until ≤ now`), and `urgent` (`priority = high ∧ due ≤ now + 24h`)
- **WHEN** a task with `priority: high` and `due` 10 hours after the injected `now` is shaped
- **THEN** the facts `due soon` and `urgent` hold and `past due` does not
- **AND** the recipient reads the markers rather than a raw timestamp to subtract `now` from

#### Scenario: A source cannot smuggle a wall clock

- **WHEN** a snapshot carries its own field named `now`
- **THEN** predicates see the runtime-injected `now`, not the snapshot's value

### Requirement: Derived facts are author-declared

The system SHALL compute only the derived facts the monitor declares in its Shape declaration
(`shape.derive`, each a `name` marker and a CEL boolean `when` predicate over the snapshot and
`now`), including their thresholds; it SHALL NOT apply any built-in derived-fact policy. A monitor
that declares no derived facts gets none. The authoring surface is owned by `monitor/definition`.

#### Scenario: No declaration, no facts

- **WHEN** a monitor without `shape.derive` is shaped
- **THEN** no derived facts are computed or rendered

#### Scenario: Unevaluable predicate does not abort the tick

- **WHEN** a `when` predicate references a field the snapshot does not carry
- **THEN** that fact does not hold and the tick continues

### Requirement: Derived facts are computed before Diff

The system SHALL compute derived facts on the shared snapshot and bake them into the rendered
artifact before the per-recipient Diff, so a fact appearing or changing is itself a diffable delta.

#### Scenario: A newly held fact is a delta

- **GIVEN** a monitor with `shape.render: rendered` whose raw source bytes are identical across two ticks
- **WHEN** a task's defer threshold is crossed between the ticks
- **THEN** the diff between the two rendered artifacts is exactly one added `revealed` line

### Requirement: Rendered artifact is the diff input when rendering is declared

When a monitor declares `shape.render: rendered`, the system SHALL render the shaped snapshot plus
the facts that hold into a markdown-ish text artifact (not JSON) and SHALL use that artifact — never
the raw source snapshot — as the text it diffs and stores. Without `shape.render: rendered` the
observation's own `snapshotText` remains the diff input.

#### Scenario: Rendered monitor diffs the artifact

- **WHEN** a `shape.render: rendered` monitor observes a JSON body whose irrelevant keys were reordered
- **THEN** the stored snapshot is the rendered artifact and no phantom delta is produced

#### Scenario: Undeclared render keeps raw bytes

- **WHEN** a monitor declares `shape.derive` without `shape.render: rendered`
- **THEN** the observation's raw `snapshotText` is diffed and stored unchanged

### Requirement: Render is deterministic and byte-stable

The system SHALL render the same shaped state to byte-identical text on every run: object keys in
stable sorted order, array elements in index order, derived facts one marker per line in authored
order, and no transient fields or embedded wall-clock unless it is a derived fact.
Rationale: render instability surfaces downstream as phantom diffs.

#### Scenario: Same state renders identically

- **WHEN** the same shaped state is rendered twice
- **THEN** the two artifacts are byte-identical and their diff is empty

### Requirement: Render is shared and the diff baseline is per recipient

The system SHALL render the artifact once on the shared side of the seam and diff that one artifact
against each recipient's own baseline, so recipients at different last-seen points see different
spans of the same rendered artifact.

#### Scenario: One render, two spans

- **GIVEN** two recipients at different cursors of a `shape.render: rendered` monitor
- **WHEN** one observation is rendered
- **THEN** the render runs once and each recipient's delta is a span of that same artifact

### Requirement: Payload form is author-declared

The system SHALL take a monitor's payload form from its declared `payload.form` — one of `prose`,
`structured`, `artifact`, `rendered` (the exported `PayloadForm` type) — and SHALL NOT infer it from
the source. Omitting `payload` SHALL preserve the textual delivery of the diff plus monitor body.

#### Scenario: Two poles of the same pipeline

- **GIVEN** a workout monitor declaring `payload.form: structured` with a `jq` projection and an overview monitor declaring `payload.form: rendered`
- **WHEN** each processes a fixed shaped snapshot
- **THEN** the first delivers exactly the projected fields and the second delivers the rendered text artifact

### Requirement: Only the prose form invokes Interpret

The system SHALL invoke the Interpret stage only for `payload.form: prose`; `structured`, `artifact`,
and `rendered` are deterministic-floor forms that SHALL deliver without Interpret.

#### Scenario: Structured skips the lossy digest

- **WHEN** a `payload.form: structured` monitor materializes an event while an Interpret adapter is injected
- **THEN** the adapter is not invoked

### Requirement: A jq transform reshapes the structured payload

When `payload.form: structured` declares a `payload.transform` with `language: jq`, the system SHALL
evaluate the expression deterministically over the canonical JSON form of the shaped snapshot and
deliver its output as the structured payload.

#### Scenario: jq projection yields the projected fields

- **GIVEN** a shaped snapshot of sets with `weight`, `reps`, `rpe`, and extra fields, plus a session `heartRate`
- **WHEN** a `jq` transform projecting `{ weight, reps, rpe }` per set and `heartRate` is applied
- **THEN** the persisted payload contains exactly those projected fields

### Requirement: A cel transform gates delivery

When `payload.form: structured` declares a `payload.transform` with `language: cel`, the system SHALL
evaluate it to a boolean: `true` SHALL deliver the canonical, un-reshaped shaped snapshot as the
payload; `false` SHALL suppress delivery entirely, materializing no event. To both gate and reshape,
an author uses `jq` with a condition.

#### Scenario: False gate suppresses and is recorded

- **WHEN** a `cel` gate evaluates `false` for every observation in a tick
- **THEN** no `monitor_events` row is materialized
- **AND** the tick's `observation_history` row records `suppressed`, so the suppression is explainable rather than silent

#### Scenario: True gate delivers unreshaped snapshot

- **WHEN** a `cel` gate evaluates `true`
- **THEN** the payload is the canonical shaped snapshot unchanged

### Requirement: Transforms are shared, declarative, and defined on canonical JSON

The system SHALL evaluate `jq`/`cel` transforms once per observation on the shared side of the seam,
over the canonical JSON form of the shaped snapshot regardless of the declared `payload.encoding`,
using constrained declarative evaluators that never execute arbitrary user code (no `eval` or
`Function` constructor).

#### Scenario: Encoding does not change predicate semantics

- **WHEN** two monitors differ only in `payload.encoding` (`json` vs `yaml`)
- **THEN** their `jq`/`cel` transforms produce the same result over the same snapshot

### Requirement: Omitted baseline strategy behaves as net

The system SHALL treat a monitor that omits `baseline-strategy` exactly as one declaring
`baseline-strategy: net`; `incremental` is the explicit opt-out. The authoring field is owned by
`monitor/definition`.

#### Scenario: Omitted equals net

- **GIVEN** a monitor without `baseline-strategy` and a recipient that missed three observations of one object
- **WHEN** the recipient claims
- **THEN** it receives one net delta, identical to the result under explicit `net`

### Requirement: Net collapses the catch-up span per recipient at claim time

Under `net`, when a recipient claims, the system SHALL group its unclaimed events per
`(monitorId, objectKey, workspacePath)` and deliver only the newest event per object, recomputing its
delta from that recipient's cursor to the endpoint when the group collapsed; older intermediates
SHALL be recorded claimed-but-suppressed (`session_event_state.net_suppressed_at`), never delivered.

#### Scenario: Away across three observations

- **GIVEN** a `net` monitor and a recipient that missed three observations of one object
- **WHEN** the recipient claims
- **THEN** it receives exactly one delta equal to diffing its baseline against the final observation's artifact
- **AND** the two older events are recorded claimed-but-suppressed and are explainable via `monitor explain`

#### Scenario: Collapsed recomputation honors the diff strategy

- **WHEN** a collapsed group's object declares `change-detection.strategy: json-diff`
- **THEN** the recomputed delta is rendered structurally (per `runtime/event-materialization`) and survives a persistence round-trip

#### Scenario: Within-tick burst collapses the same way

- **WHEN** one tick emits several observations for one object and an away recipient claims
- **THEN** the newest observation of the burst is the surviving net delta

### Requirement: Net delivers one delta per changed object in one envelope

Under `net`, the system SHALL produce one before/after delta per changed object per notification
window, and a single claim envelope SHALL carry one event per changed object when several objects
changed.

#### Scenario: Two objects, two deltas

- **WHEN** two objects of a `net` monitor each change several times before a claim
- **THEN** the claim envelope carries exactly two events, one per object

#### Scenario: Fifteen saves collapse to one

- **WHEN** one object of a `net` monitor is saved 15 times before a claim
- **THEN** the recipient receives one delta

### Requirement: Incremental delivers every step in order

Under `baseline-strategy: incremental`, the system SHALL deliver each observation in the recipient's
catch-up span individually, in the order the events were materialized.

#### Scenario: Away across three observations, incremental

- **GIVEN** an `incremental` monitor and a recipient that missed three observations
- **WHEN** the recipient claims
- **THEN** it receives three deltas in materialization order

### Requirement: Shared event chain records every observation regardless of strategy

The system SHALL materialize every emitted observation on the shared `monitor_events` chain in order
regardless of `baseline-strategy`, and SHALL persist each row's strategy on
`monitor_events.baseline_strategy` so the claim-time decision needs no monitor re-scan.

#### Scenario: Shared chain keeps all N

- **WHEN** a `net` monitor emits N observations of one object
- **THEN** N `monitor_events` rows exist, each carrying `baseline_strategy` = `net`

### Requirement: Cursor advances past suppressed intermediates

The system SHALL advance a recipient's cursor to the newest claimed artifact on claim even when
intermediate events were suppressed by the `net` collapse.

#### Scenario: Next delta starts after the endpoint

- **GIVEN** a recipient whose `net` claim suppressed two intermediates
- **WHEN** a further change materializes
- **THEN** that recipient's next delta starts from the newest artifact it was shown

### Requirement: Strategies coincide for a single-step span

The system SHALL deliver the standard single-step delta under both `net` and `incremental` when a
recipient's catch-up span contains exactly one observation.

#### Scenario: Missed nothing

- **WHEN** a recipient that was live for every settled observation claims a span of one observation
- **THEN** `net` and `incremental` deliver the same single delta

### Requirement: Baseline strategy is independent of Pace

The system SHALL apply the baseline strategy only right of the seam: Observe, Shape, and Pace run
once and unchanged whatever the strategy, so a `net` monitor using `debounce` settles first and its
catch-up span is collapsed afterwards at claim time.

#### Scenario: Debounce then net

- **GIVEN** a `net` monitor with `notify.strategy: debounce`
- **WHEN** a burst settles and flushes, and an away recipient later claims
- **THEN** the burst is held and flushed by Pace first, and the recipient's span is collapsed at claim

### Requirement: Interpret runs only when an adapter is injected

The system SHALL run Interpret only for a `payload.form: prose` monitor and only when an
`InterpretAdapter` is injected into the runtime; with no adapter injected the runtime SHALL make no
AI call and deliver the deterministic diff as before.

#### Scenario: No adapter, no AI call

- **WHEN** a `prose` monitor materializes an event and no adapter is injected
- **THEN** no adapter call is made and the event is delivered as its deterministic text

#### Scenario: Non-prose never invokes the adapter

- **WHEN** a monitor without `payload.form: prose` materializes an event with an adapter injected
- **THEN** the adapter is never invoked

### Requirement: Interpret reads the per-recipient delta and author criteria only

The system SHALL pass Interpret the per-recipient delta (falling back to the shared diff, then the
artifact) together with author-supplied criteria (the monitor's instructions body), and SHALL NOT
pass the raw source snapshot or any of the receiving agent's private runtime context.
Rationale: Interpret stays a pure, portable function of (delta, author criteria).

#### Scenario: Same delta, same input

- **WHEN** two recipients compute the identical delta
- **THEN** the adapter input for both is the same delta and the same monitor instructions

### Requirement: Interpret runs once per distinct per-recipient delta

At materialization, the system SHALL group the lead sessions an event projected into by their
distinct per-recipient delta, invoke the adapter once per distinct delta, and record that verdict on
every session in the group.

#### Scenario: Divergent baselines invoke twice

- **GIVEN** two recipients at divergent baselines of a `prose` monitor
- **WHEN** an event materializes
- **THEN** the adapter is invoked twice and a distinct digest is recorded per session

#### Scenario: Identical baselines invoke once

- **GIVEN** two recipients at identical baselines
- **WHEN** an event materializes
- **THEN** the adapter is invoked once and its verdict is recorded on both sessions

### Requirement: Durable writes precede any Interpret await

The system SHALL complete the event's durable writes — the shared event row and every per-recipient
projection and delta — before awaiting any Interpret call, so a slow or failing Interpret can never
lose a materialized change.

#### Scenario: Slow adapter does not delay durability

- **WHEN** the adapter is still pending
- **THEN** the `monitor_events` row and its `session_event_state` projections are already persisted

### Requirement: Interpret verdicts are recorded per recipient

The system SHALL record each recipient's Interpret verdict on `session_event_state`
(`interpret_decision` = `deliver` | `suppress` | `failed`, with `interpret_reason` and
`interpret_digest`), surfaced by the projection-and-delivery stage of `monitor explain`, never on the
shared `observation_history`.

#### Scenario: Why nothing fired is inspectable

- **WHEN** a recipient asks `monitor explain` why a delta did not surface
- **THEN** it receives the recorded verdict and reason for that recipient, never silence

### Requirement: Substantive verdict delivers the digest

When the adapter returns a `deliver` verdict, the system SHALL deliver the recorded
`interpret_digest` as the `prose` reading of that recipient's delta.

#### Scenario: Question classified as substantive

- **GIVEN** a fake adapter that classifies a delta as a question
- **WHEN** the event is delivered
- **THEN** the `prose` delivery carries the fake adapter's digest

### Requirement: Agentic gate suppresses non-substantive deltas without dropping them

When the adapter returns a `suppress` verdict, the system SHALL exclude that recipient's projection
from delivery while retaining the row and its recorded reason, so the suppression is a deliberate,
explainable outcome and never a silent drop.

#### Scenario: Passing chatter is suppressed

- **GIVEN** a fake adapter that classifies a delta as passing chatter
- **WHEN** the recipient next claims
- **THEN** nothing is delivered for that event
- **AND** `monitor explain` returns the recorded suppression reason for that recipient

### Requirement: Interpret failure falls back to the deterministic delta

The system SHALL treat Interpret as best-effort: when the adapter throws, errors, or times out, the
system SHALL record `interpret_decision` = `failed` with the error as reason and SHALL leave the
projection deliverable as the deterministic rendered delta (per PP4, AP3).

#### Scenario: Tool throws

- **GIVEN** a fake adapter that throws
- **WHEN** the event is claimed
- **THEN** the recipient receives the deterministic rendered delta
- **AND** the failure is recorded and explainable

### Requirement: Interpret runs through the user's own tool behind an adapter

The system SHALL ship no model and hold no model credentials (PP10): Interpret SHALL invoke the
user's already-installed AI tool, and which tool, its command, and how the delta is passed in and the
digest read out SHALL live behind the `InterpretAdapter` boundary, never in the runtime core (AP3).
The bundled Claude adapter invokes `claude -p` with arguments only (no shell).

#### Scenario: A new host is a new adapter

- **WHEN** a different AI CLI is wired for Interpret
- **THEN** only a new `InterpretAdapter` implementation is added; the runtime core is unchanged

### Requirement: Agentic and deterministic gates are distinct

The system SHALL keep the shared, deterministic `cel` gate (Shape, recorded on `observation_history`
as `suppressed`) distinct from the per-recipient agentic gate (Interpret, recorded on
`session_event_state`); an author MAY use both, the `cel` gate pre-filtering on the shared side and
the agentic gate judging what survives per recipient.

#### Scenario: Deterministic first, agentic second

- **GIVEN** a `prose` monitor whose shared pre-filter drops non-principal mentions and whose adapter suppresses passing chatter
- **WHEN** one dropped mention and one passing mention are observed
- **THEN** the first is recorded only as a shared `suppressed` outcome and the second only as a per-recipient `suppress` verdict

### Requirement: Claim-time net collapse does not re-invoke Interpret

The system SHALL invoke the Interpret adapter only at materialization; a later claim-time `net`
collapse that re-diffs the surviving delta SHALL NOT invoke the adapter and SHALL carry the digest
already recorded for the surviving event into delivery.

#### Scenario: Claim reuses the recorded digest

- **GIVEN** a `prose`, `net` monitor whose recipient missed two observations
- **WHEN** the recipient claims
- **THEN** no adapter call is made at claim and the surviving event's recorded digest is delivered
