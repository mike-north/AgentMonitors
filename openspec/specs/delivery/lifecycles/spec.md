# delivery/lifecycles Specification

## Purpose

Defines when and in what shape projected session work is surfaced: the delivery lifecycle points, the per-urgency claim rules (settled high-urgency deliveries, coalesced normal and low reminders, post-compact recaps), the `DeliveryClaim` and `DeliveryEventSummary` payload contracts, and the rule that claiming never acknowledges. Transport rendering is owned by the `delivery/hook-transport` and `delivery/channel-transport` capabilities.

## Requirements

### Requirement: Delivery lifecycle points

The runtime SHALL support exactly three delivery lifecycles, the `DeliveryLifecycle` union: `turn-interruptible`, `turn-idle`, and `post-compact`. A claim at any lifecycle SHALL return either a `DeliveryClaim` (with `mode` `delivery` or `recap`) or `null` when nothing is due.

#### Scenario: Claim with nothing due returns null

- **GIVEN** session S has no unread events
- **WHEN** a delivery is claimed for S at `turn-interruptible`
- **THEN** the result is `null`

### Requirement: Agent lifecycle events beyond delivery points

`AgentLifecycleEvent` SHALL be a broader union that also includes `session-opened`, `session-dormant`, `turn-ended`, and `pre-compact`. These additional events are used by adapter hook maps (per the `delivery/host-adapters` capability) and SHALL NOT be delivery claim points.

#### Scenario: Pre-compact is not a claim point

- **WHEN** a caller requests a delivery claim with lifecycle `pre-compact`
- **THEN** the request is rejected because `pre-compact` is not a `DeliveryLifecycle`

### Requirement: Settled high-urgency delivery at turn-interruptible

At `turn-interruptible` the runtime SHALL deliver all pending high-urgency events for the session that have aged at least `DEFAULT_HIGH_URGENCY_SETTLE_MS` (15000 ms), pooled across every monitor. The claim SHALL have `mode: 'delivery'`, `urgency: 'high'`, a populated `events` array, and a `message` summarizing the concrete events (titles and summaries), not a generic reminder.

#### Scenario: High urgency waits for the settle window

- **GIVEN** a high-urgency event projected into session S 5 seconds ago
- **WHEN** S claims at `turn-interruptible`
- **THEN** no high-urgency delivery is returned
- **AND** once the event is 15 seconds old, a claim returns `mode: 'delivery'` with that event in `events`

#### Scenario: Debounced high-urgency burst

- **GIVEN** a high-urgency monitor emits two observations on one tick and they are held in `notifyState.pendingDebounce` with no `monitor_events` rows yet
- **WHEN** a later tick at or after the batch's `dueAt` (15 s later) flushes the batch, persisting and projecting two events into matching lead sessions
- **THEN** after the 15-second settle window has elapsed, a `turn-interruptible` claim returns one delivery whose `events` array carries both events
- **AND** the 15-second window applies twice: once in the default high-urgency notify debounce and once in the claim age filter

#### Scenario: High events from two monitors are pooled

- **GIVEN** two monitors each produced one settled, unclaimed high-urgency event for session S
- **WHEN** S claims at `turn-interruptible`
- **THEN** one claim carries both events

### Requirement: DeliveryEventSummary shape

Each element of a claim's `events` array SHALL be a `DeliveryEventSummary` carrying `eventId`, `monitorId`, `title`, `summary`, `objectDetail` (optional), `urgency`, `createdAt` (ISO 8601 string), `body`, and optional `diffText`. `body` SHALL be the event's monitor body-instructions (`observation.body ?? monitor.instructions`), so transports can surface what the agent should do, not only what changed.

#### Scenario: Delivered event carries the monitor instructions

- **GIVEN** monitor `m` has body instructions `"Re-run the failing test."` and its observation carries no body
- **WHEN** an event from `m` is delivered
- **THEN** its `DeliveryEventSummary.body` is `"Re-run the failing test."`

### Requirement: Recipient-visible summary field

`DeliveryEventSummary.summary` SHALL be the recipient-visible text: the per-recipient Interpret digest when one was produced (per the `pipeline/post-processing` capability), otherwise the deterministic fallback chain `MonitorEventRecord.summary` → `body` → `title`. A digest is a prose reading of the change and is not guaranteed to name the object.

#### Scenario: No digest falls back to the deterministic summary

- **GIVEN** an event with `summary` `""`, `body` `"Check CI"`, title `"Build failed"`, and no Interpret digest
- **WHEN** it is delivered
- **THEN** its `summary` is `"Check CI"`

### Requirement: Deterministic objectDetail for per-object identity

`DeliveryEventSummary.objectDetail` SHALL be the deterministic per-object detail (`MonitorEventRecord.summary`), never replaced by a digest, and the runtime SHALL always populate it for a real delivery (it is optional only for hand-constructed values). A transport rendering per-object identity MUST prefer `objectDetail` over `summary`.

#### Scenario: Multi-object prose monitor keeps object identity

- **GIVEN** a `prose` monitor delivers two events whose digests are identity-free
- **WHEN** a transport renders a per-object detail line
- **THEN** it uses each event's `objectDetail`, which names the object

### Requirement: Recipient-specific diffText

`DeliveryEventSummary.diffText` SHALL be the recipient's own `session_event_state.diff_text`, falling back to the shared `MonitorEventRecord.diffText` only when the per-recipient value is `null`, and SHALL be absent when neither is present. A transport that surfaces `diffText` MUST bound its size (issue #436).

#### Scenario: Recipient diff wins over the shared diff

- **GIVEN** an event whose shared `diff_text` is `"-a\n+c"` and whose per-recipient `diff_text` for S is `"-b\n+c"`
- **WHEN** it is delivered to S
- **THEN** `diffText` is `"-b\n+c"`

### Requirement: Coalesce a due normal reminder into a settled high batch

When a settled high-urgency batch and a normal-urgency reminder are both due in the same `turn-interruptible` claim decision, the runtime SHALL return ONE `DeliveryClaim`: `events` holds only the settled high events, `message` is the high summary followed by the reminder body after a blank line, and `coalescedReminder` is set to the reminder body. `coalescedReminder` SHALL be set only then (issue #441).

#### Scenario: Concurrent high and normal work interrupt once

- **GIVEN** session S has one settled unclaimed high event and one unclaimed normal event, with no claimed normal events
- **WHEN** S claims at `turn-interruptible`
- **THEN** one claim is returned with the high event in `events`, `coalescedReminder` `"Monitored changes are pending."`, and `message` ending in that reminder
- **AND** a second `turn-interruptible` claim returns `null`

### Requirement: Coalesced claim keeps high urgency without escalating the reminder

A coalesced claim's top-level `urgency` MUST remain `'high'`. Coalescing MUST NOT downgrade the reported urgency and MUST NOT escalate the normal reminder: its events are not surfaced as `DeliveryEventSummary` entries and their own urgency is never rewritten. Coalescing decides only when two already-materialized bands are delivered together (issue #451).

#### Scenario: Normal events stay normal when coalesced

- **WHEN** a coalesced claim folds a normal reminder into a high batch
- **THEN** the claim's `urgency` is `'high'`
- **AND** the normal events' stored `urgency` is still `normal` and none appear in `events`

### Requirement: Coalesced rows are claimed together

Both the surfaced high-urgency events and the coalesced normal-urgency events SHALL be marked claimed in the same delivery application, so a later claim does not re-deliver the normal reminder as a second interrupt for the same action.

#### Scenario: Coalesced normal rows are claimed

- **WHEN** a coalesced claim is applied for session S
- **THEN** the folded normal events have `first_notified_at` set alongside the high events

### Requirement: Normal reminder is withheld while high work is unsettled

A normal reminder that is otherwise due MUST NOT fire standalone while any high-urgency event for the session is pending (unclaimed) but not yet settled; it SHALL be withheld until no high-urgency work is pending, and SHALL be folded into the settled-high delivery once that event settles.

#### Scenario: Normal reminder waits for a sibling high event to settle

- **GIVEN** session S has an unclaimed normal event and an unclaimed high event 5 seconds old
- **WHEN** S claims at `turn-interruptible`
- **THEN** the result is `null`
- **AND** a claim after the high event is 15 seconds old returns one coalesced claim carrying both

### Requirement: Coalescing is limited to turn-interruptible

Cross-band coalescing SHALL apply only at `turn-interruptible` (high plus normal). Low-urgency reminders fire at `turn-idle` and SHALL NOT be folded into high deliveries. The fresh-pending-batch policy (Normal-urgency coalesced reminder) still decides whether a normal reminder is due at all.

#### Scenario: Low reminder is not folded into a high delivery

- **GIVEN** session S has a settled unclaimed high event and an unclaimed low event
- **WHEN** S claims at `turn-interruptible`
- **THEN** the claim carries the high event and no `coalescedReminder`
- **AND** the low event remains unclaimed

### Requirement: Bounded transports render the coalesced reminder

An events-rendering, length-bounded transport MUST render a present `coalescedReminder`, sanitized, as a footer after the packed event blocks, followed by its own transport-owned acknowledge step, and MUST reserve room for that footer before packing event blocks (using the coalesced-reminder preview). A transport rendering `message` directly needs no separate handling. Rendering details belong to the transport capabilities.

#### Scenario: Coalesced reminder is never claimed but unrendered

- **WHEN** a hook or channel transport renders a claim with `coalescedReminder` set
- **THEN** the rendered payload ends with the reminder text and that transport's acknowledge step
- **AND** the footer fits within the transport's cap

### Requirement: Hook-delivery diagnosis mirrors coalescing precedence

The hook-delivery diagnosis (`hook deliver --debug`, issue #334) SHALL report a `settle-window` hold on the `normal` band when a due reminder is withheld by an unsettled high event, SHALL report `no-new-work` only when no fresh pending work remains and `reserved-in-flight` while a same-band reservation is active, and SHALL NOT report an older claim as withholding a fresh reminder.

#### Scenario: Withheld reminder is diagnosed as a settle-window hold

- **GIVEN** a due normal reminder withheld by a 5-second-old high event
- **WHEN** hook delivery is diagnosed
- **THEN** the `normal` band reports a `settle-window` hold

### Requirement: Normal-urgency coalesced reminder

At `turn-interruptible`, fresh pending normal-urgency events SHALL be delivered as one coalesced reminder per batch (`mode: 'delivery'`, empty `events`) when pending normal work exists and no same-band reservation is active. Claimed-but-unacknowledged normal events MUST NOT block a fresh batch.

#### Scenario: Normal reminder fires on the first claim

- **GIVEN** an unclaimed, unread normal event projected into session S and no high work pending
- **WHEN** S claims at `turn-interruptible`
- **THEN** a claim with `message` `"Monitored changes are pending."` and an empty `events` array is returned
- **AND** the event is marked claimed but stays unread

### Requirement: Reminder wording contract

The reminder body SHALL be exactly `Monitored changes are pending.` for both the normal and low bands. It MUST NOT embed a product name (attribution is transport-owned), MUST NOT reference the legacy `inbox` model, and SHALL contain no CLI or tool verb. Urgency is carried in the claim's `urgency` field and transport metadata, not the prose (issues #438, #434).

#### Scenario: Reminder text is transport-neutral

- **WHEN** a normal or low reminder claim is produced
- **THEN** its `message` contains neither `AgentMon` nor `inbox` nor any `agentmonitors` command

### Requirement: Reminder self-sufficiency is transport-owned

Each delivering transport SHALL append its own concrete, runnable next step to the shared reminder body, including the acknowledge step with the recipient's real session id: the hook transport names `agentmonitors events list`/`events ack` with an explicit `--socket <path>`; the channel transport points at its `agentmon_ack` tool. The overall rendered payload SHALL name the ack step.

#### Scenario: Channel reminder names its own ack tool

- **WHEN** the channel transport renders a reminder claim
- **THEN** the rendered text references `agentmon_ack` and not the `events ack` CLI verb

### Requirement: Fresh reminder batches do not wait for older acknowledgments

Delivering a reminder SHALL claim only its pending batch, never acknowledge it. With no newly pending work, a repeated claim SHALL return `null` while the older work stays unread and queryable. A fresh pending event SHALL produce a new reminder at the next eligible lifecycle without acknowledgment of older claims, across monitors and after a mixed-band recap. The runtime MUST NOT auto-acknowledge, reset, or re-claim older rows to make progress (#524).

#### Scenario: Repeat claim without new work is quiet and explained

- **GIVEN** a normal event E1 was delivered as a reminder and claimed but not acknowledged
- **WHEN** a second `turn-interruptible` claim runs
- **THEN** it returns `null`
- **AND** `monitor explain` reports the delivery stage `ok` with a `reminderSuppression` reason `no-new-work`

#### Scenario: Fresh event surfaces despite an older claim

- **GIVEN** normal event E1 is claimed but unacknowledged and a new unclaimed normal event E2 arrives, from the same or another monitor
- **WHEN** S claims at `turn-interruptible`
- **THEN** a reminder claim covering E2 is returned and E2 is claimed
- **AND** E1 stays claimed and unread, neither acknowledged nor re-claimed

#### Scenario: Mixed-band recap does not mute later reminders

- **GIVEN** a `post-compact` recap claimed an old normal event alongside high events, and none were acknowledged
- **WHEN** a fresh normal event arrives and S claims at `turn-interruptible`
- **THEN** a reminder claim covering the fresh event is returned

### Requirement: A same-band reservation holds the next reminder

A live same-band delivery reservation SHALL withhold the band's next reminder, so competing transports never surface simultaneous generic reminders. The hold SHALL end on commit, release, or lease expiry; a committed batch then stays unread but SHALL NOT block the next pending batch.

#### Scenario: Reminder resumes after the lease resolves

- **GIVEN** the channel transport holds a reservation on S's normal batch and a fresh normal event arrives
- **WHEN** the hook transport claims at `turn-interruptible` before the reservation resolves
- **THEN** it returns `null` with hold reason `reserved-in-flight`
- **AND** once the reservation commits, releases, or expires, the next claim returns a reminder for the fresh event

### Requirement: Reminder acknowledgment is explicit and handled-item scoped

A reminder tells the recipient to inspect unread events and acknowledge what it handled; it does not identify every handled item, and a new reminder neither erases older unread claims nor certifies their completion. The hook transport's step SHALL name the ack verb; the channel transport's step SHALL instruct listing the session's unread events first and then calling `agentmon_ack` with only the ids actually handled, never the bare no-argument form.

#### Scenario: Channel reminder never suggests a blanket ack

- **WHEN** the channel transport renders a reminder
- **THEN** the step asks the recipient to list unread events and ack only handled ids

### Requirement: Low-urgency reminder only at turn-idle

Low-urgency events SHALL be delivered only at `turn-idle`, as one coalesced reminder per fresh pending batch with empty `events` and the shared reminder body; the normal band's pending, claimed, and reservation rules apply identically, so older claimed low events MUST NOT block a fresh low batch. A `turn-interruptible` claim SHALL NOT deliver low-urgency events, and no low event is promoted to the normal lifecycle.

#### Scenario: Low urgency delivers only at idle lifecycle points

- **GIVEN** a low-urgency event is persisted and projected into session S
- **WHEN** S claims at `turn-interruptible`
- **THEN** the result is `null`
- **AND** a `turn-idle` claim returns a `DeliveryClaim` with `message` `"Monitored changes are pending."` while the event remains unread until acknowledged

### Requirement: Post-compact recap

At `post-compact`, if unread events remain, the runtime MUST return a `mode: 'recap'` claim whose `events` hold the 10 newest unread events (`MAX_RECAP_EVENTS = 10`) as `DeliveryEventSummary` entries with `body`, and whose `message` is `Recap of recent AgentMon activity since your last recap:` plus their summary and two commands, then update the session's `lastRecapAt`.

#### Scenario: Recap emits recent unread events and command hints

- **GIVEN** session S has 12 unread events
- **WHEN** S claims at `post-compact`
- **THEN** the claim has `mode: 'recap'` and the 10 newest events in `events`
- **AND** `message` includes ``Run `agentmonitors events list --session <id> --format json` for recent history.`` and ``Run `agentmonitors events list --session <id> --unread --format json` for unread details.``
- **AND** S's `lastRecapAt` is updated

### Requirement: Claiming marks rows claimed without acknowledging

Claiming any delivery MUST mark the underlying `session_event_state` rows claimed by setting `first_notified_at`, `last_claim_at`, and `last_claim_lifecycle`, and MUST NOT set `acknowledged_at` (per SP4, BP2).

#### Scenario: Recap claim does not acknowledge

- **WHEN** a recap claim is applied for session S
- **THEN** every recapped row has `first_notified_at` and `last_claim_lifecycle` `post-compact` set
- **AND** `acknowledged_at` remains `NULL`
