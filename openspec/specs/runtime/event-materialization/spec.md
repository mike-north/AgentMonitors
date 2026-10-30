# runtime/event-materialization Specification

## Purpose

Defines how each emitted observation becomes a durable `monitor_events` row: required fields,
derived defaults, the runtime-chosen title, and the shared object-level snapshot history and diff
rendering. Per-recipient deltas are owned by `pipeline/post-processing`; the table layouts by
`persistence/schema`.

## Requirements

### Requirement: One durable event per emitted observation

The system SHALL persist each emitted observation as exactly one `monitor_events` row carrying at
least `id`, `workspacePath`, `monitorId`, `sourceName`, `urgency`, `title`, `body`, `summary`,
`payload`, `snapshotMetadata`, `snapshotText`, `diffText`, `objectKey`, `queryScope`, `tags`, and
`createdAt`.

#### Scenario: Two emitted observations

- **WHEN** notify dispatch emits two observations on a tick
- **THEN** two `monitor_events` rows exist, each with every required field populated or explicitly null

### Requirement: Materialization is one atomic durable unit

The system SHALL commit an observation's event row, every matching lead-session projection, any
first-recipient cursor seed, and its snapshot in one immediate SQLite transaction, or roll all of
them back. Optional Interpret work SHALL begin only after that transaction commits and stays
best-effort (per `pipeline/post-processing`), so an Interpret failure cannot undo the committed
event.

#### Scenario: Cursor-seed failure rolls back the whole observation

- **GIVEN** a lead session matching the monitor and a cursor-seed write that fails
- **WHEN** the observation is materialized
- **THEN** no event row, projection, cursor seed, or snapshot for it remains
- **AND** the tick records it as `errored` and omits it from `emittedEventIds`

#### Scenario: Snapshot failure rolls back the event

- **WHEN** the snapshot write fails after the event row and projections were written in the same transaction
- **THEN** no event row, projection, cursor seed, or snapshot for the observation remains

#### Scenario: A later projection failure rolls back earlier recipients

- **GIVEN** two lead sessions match the monitor and the second projection insert fails
- **WHEN** the observation is materialized
- **THEN** neither session has a projection or cursor seed for it and no event row remains

#### Scenario: Interpret runs only after the commit

- **GIVEN** a monitor with an Interpret stage
- **WHEN** an observation is materialized
- **THEN** the adapter is invoked only once the event, projections, and snapshot are committed and visible to another connection
- **AND** when the deterministic transaction rolls back, the adapter is not invoked

### Requirement: Missing body and summary are derived

When an emitted observation omits them, the system SHALL derive `body` from the observation body,
otherwise the monitor's instructions, and `summary` from the observation summary, otherwise the
observation body, otherwise the title.

#### Scenario: Body falls back to monitor instructions

- **WHEN** an observation has a title but no body or summary
- **THEN** `body` is the monitor's instructions and `summary` is the title

### Requirement: Persisted urgency is the effective urgency

The system SHALL persist `urgency` as the observation's effective urgency,
`clamp(observation.salience ?? band.lo, band.lo, band.hi)` (per `runtime/notify-dispatch`), the same
value notify timing used, so a held batch and its event rows agree.

#### Scenario: Escalated observation persists high

- **WHEN** a `normal..high` monitor's observation with `salience: high` is materialized
- **THEN** its `monitor_events.urgency` is `high`

### Requirement: Missing object key, query scope, and snapshot metadata are derived

When an emitted observation omits them, the system SHALL derive `objectKey` as the monitor ID,
`queryScope` as `{}`, and `snapshotMetadata` as the observation's `snapshot`, otherwise `{}`. When
the observation sets `changeKind`, the system SHALL add `changeKind` to the stored `queryScope`.

#### Scenario: changeKind becomes filterable

- **WHEN** an observation with `queryScope: { path: "a.md" }` and `changeKind: modified` is materialized
- **THEN** the stored `queryScope` is `{ path: "a.md", changeKind: "modified" }`

#### Scenario: objectKey defaults to the monitor id

- **WHEN** monitor `spec-watch` emits an observation without `objectKey`
- **THEN** the event's `objectKey` is `spec-watch`

### Requirement: Snapshots are stored and diffed per workspace, monitor, and object

When an emitted observation includes `snapshotText`, the system SHALL look up the latest stored
snapshot for the same `(workspacePath, monitorId, objectKey)`, compute a diff if one exists, and
store the new snapshot in the same transaction as the event, projections, and cursor seeds (per
SP5).

#### Scenario: snapshotText stores a later-retrievable snapshot

- **WHEN** an observation with `snapshotText` is materialized
- **THEN** a later lookup for its `(workspacePath, monitorId, objectKey)` returns that text

#### Scenario: A prior snapshot produces diff text on later change

- **GIVEN** a stored snapshot for an object
- **WHEN** a changed `snapshotText` for the same object is materialized
- **THEN** the new event's `diffText` is non-empty and reflects the change

#### Scenario: Snapshots are isolated by workspace, monitor, and object key

- **GIVEN** snapshots stored for `(A, m1, o1)`
- **WHEN** a snapshot is looked up for `(B, m1, o1)`, `(A, m2, o1)`, or `(A, m1, o2)`
- **THEN** none of them returns the `(A, m1, o1)` snapshot

#### Scenario: First snapshot has no diff

- **WHEN** an object's first `snapshotText` is materialized
- **THEN** its `diffText` is null

### Requirement: Empty snapshot text is a present snapshot

The system SHALL treat `snapshotText: ""` as a present snapshot: it MUST be persisted, MUST produce
the prior-to-empty deletion delta in both the shared history and a newly projected recipient's
delta, and MUST serve as the baseline for the next observation. Only a `null` or absent
`snapshotText` SHALL mean no snapshot.

#### Scenario: Removing all content yields a deletion delta

- **GIVEN** a stored snapshot `a\nb\n` for an object
- **WHEN** an observation with `snapshotText: ""` for the same object is materialized
- **THEN** its `diffText` shows lines `a` and `b` removed, and the empty snapshot is stored

#### Scenario: Content returning diffs from the empty baseline

- **GIVEN** the latest stored snapshot for an object is `""`
- **WHEN** an observation with `snapshotText: "c\n"` is materialized
- **THEN** its `diffText` shows line `c` added, not a first-snapshot null diff

#### Scenario: Late-joining lead session sees the deletion

- **GIVEN** a lead session that opens after the object's `a\n` snapshot was stored
- **WHEN** an observation with `snapshotText: ""` is materialized and projected to it
- **THEN** the delta that session receives shows line `a` removed

### Requirement: Snapshots have a total materialization order

The system SHALL give snapshots a strictly increasing (monotonic ULID) `id` and resolve "latest
stored snapshot" by `(created_at, id)`, so snapshots written in the same epoch second resolve to the
most recently materialized one. Newest-first listings ordered by `created_at` (`events list`,
`monitor explain` events and history) SHALL apply the same `id` tie-break.

#### Scenario: Same-second burst keeps the diff chain intact

- **GIVEN** three snapshots for one object written within the same second
- **WHEN** a fourth change is materialized
- **THEN** its diff is computed against the third snapshot, never an older tied one

### Requirement: Default diff rendering is line-level text

For an object whose `change-detection.strategy` is omitted, `text-diff`, `exit-code`, or any value
not recognized, the system SHALL render `diffText` as a line-level representation (`- <line>: <old>`
/ `+ <line>: <new>`) that stops once 20 diff lines have been emitted, and SHALL render an empty string
when the previous and current text are identical.

#### Scenario: Identical text

- **WHEN** the previous and current snapshot text are identical
- **THEN** the rendered diff is the empty string

#### Scenario: Large change is capped

- **WHEN** 50 lines differ between snapshots
- **THEN** the rendered diff stops at 20 emitted lines

### Requirement: json-diff objects get a structural diff

For `change-detection.strategy: json-diff`, the system SHALL render a structural diff of added,
removed, and changed elements or key paths (for example `- removed[number=430]: {...}`), capped at
20 entries plus a `… N more changes elided` marker, with each rendered value truncated at 300
characters (issue #437).

#### Scenario: One array element removed from compact JSON

- **GIVEN** a single-line JSON snapshot listing PRs where PR 430 disappears
- **WHEN** the change is materialized with `strategy: json-diff`
- **THEN** `diffText` contains a single `removed[number=430]` entry rather than a whole-line remove-all/add-all

#### Scenario: Entry cap

- **WHEN** 25 structural changes occur
- **THEN** 20 entries render followed by `… 5 more changes elided`

### Requirement: json-diff matches array elements by identity

When diffing arrays of objects, the system SHALL match elements by the first of `id`, `key`, `uuid`,
`_id`, `slug`, `sha`, `number`, `name` that is a unique scalar on every element of both sides;
otherwise by whole-element deep equality (added/removed only). Arrays of non-object elements SHALL
diff positionally by index.

#### Scenario: Changed element reported by key

- **WHEN** an element with `id: 7` changes its `title`
- **THEN** the diff reports a changed entry identified by `id=7`

#### Scenario: No identity field

- **WHEN** array elements share no unique scalar identity field and one element changes
- **THEN** the diff reports one removed and one added element

### Requirement: Detected change implies non-empty diff text

The system SHALL report a pure element reorder as an explicit `reordered` entry, preserving the
invariant that a change detected by the array-order-sensitive comparison always yields non-empty
`diffText`.

#### Scenario: Pure reorder

- **WHEN** a JSON array's elements are reordered without other change
- **THEN** `diffText` contains a `reordered` entry

### Requirement: json-diff falls back to text when JSON does not parse

When either side of a `json-diff` object fails to parse as JSON, the system SHALL render the default
line-level text diff, the same fallback the `json-diff` source's own change comparison uses.

#### Scenario: Non-JSON snapshot

- **WHEN** a `json-diff` object's new snapshot is not valid JSON
- **THEN** `diffText` is rendered by the line-level text renderer

### Requirement: Diff rendering of command-poll ignore-paths fields

The system SHALL render `diffText` over the raw stored `snapshotText` without applying
`command-poll`'s `change-detection.ignore-paths`, so churn in an ignored field still appears in
`diffText` and can push a real change past the 20-entry cap, even though that field did not decide
whether a change occurred. This is a known limitation.

#### Scenario: Ignored field and a real field change together

- **GIVEN** a `command-poll` monitor with `strategy: json-diff` and `ignore-paths` covering `duration`
- **WHEN** both `duration` and a real field change
- **THEN** the change is detected and `diffText` includes both the `duration` change and the real change

### Requirement: Event title is chosen by the runtime

The system SHALL set a materialized event's `title` to the monitor's authored frontmatter `name`
when present, otherwise to the source-provided observation `title` unchanged (issue #449). Source
identity remains on `objectKey` and `payload`.

#### Scenario: Named monitor

- **WHEN** a monitor named `Release checklist` emits an observation titled `command-poll: ./check.sh`
- **THEN** the event `title` is `Release checklist`

#### Scenario: Nameless monitor

- **WHEN** a monitor without `name` emits an observation titled `docs/a.md modified`
- **THEN** the event `title` is `docs/a.md modified`

### Requirement: Source title survives only through summary for named monitors

For a named monitor the system SHALL surface the source's text through the detail line from
`summary`: with `title` only or `title` equal to `summary`, the detail is the source title; with a
distinct `summary`, the detail is that `summary` and the source title does not appear; with `title`
and `body` but no `summary`, the detail line is suppressed.

#### Scenario: Distinct summary drops the source title

- **WHEN** a named monitor's observation has `title: X` and `summary: Y`
- **THEN** delivered text shows the monitor name and `Y`, and `X` does not appear

#### Scenario: Title equals summary

- **WHEN** a named monitor's observation has `title` equal to `summary`
- **THEN** the detail line is the source title

### Requirement: Title is transport-independent

The system SHALL choose the title once at materialization so every delivery transport and `events
list`/history display show the same title.

#### Scenario: Hook and channel agree

- **WHEN** the same event is delivered via the hook transport and the channel transport
- **THEN** both render the same title
