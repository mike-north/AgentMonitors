# monitor/definition Specification

## Purpose

Defines the authored monitor definition — the root object of the delivery pipeline (PP2, SP1, AP6):
where a `MONITOR.md` lives and how it is discovered, how its stable ID is derived, the frontmatter
schema (`name`, `watch`, `urgency`, `notify`, `shape`, `payload`, `baseline-strategy`, `tags`), the
meaning of the Markdown body, and the single-directory scope contract. Runtime semantics of the
declared fields live in the `runtime/*` and `pipeline/post-processing` capabilities; the `validate`
command surface lives in `monitor/validation` and `cli/authoring-commands`.

## Requirements

### Requirement: Monitor file forms

A monitor SHALL live at one of exactly two forms relative to the monitors root being scanned or
validated: a folder monitor `<monitors-root>/<monitor-id>/MONITOR.md`, or a flat monitor
`<monitors-root>/<monitor-id>.md`. A monitor file MUST contain YAML frontmatter followed by a
Markdown body; the body MAY be empty.

#### Scenario: Folder monitor form

- **WHEN** a monitors root contains `build-drift/MONITOR.md` with valid frontmatter
- **THEN** it is recognized as a folder monitor

#### Scenario: Flat monitor form

- **WHEN** a monitors root contains `build-drift.md` with valid frontmatter
- **THEN** it is recognized as a flat monitor

#### Scenario: Empty body is permitted

- **WHEN** a monitor file has valid frontmatter and nothing after the closing `---`
- **THEN** the monitor parses successfully with instructions equal to the empty string

### Requirement: Form-aware monitor ID derivation

The parser SHALL derive the monitor's stable machine ID from the file path (SP1): for a folder
monitor (basename `MONITOR.md`) the ID is the basename of the parent directory; for a flat monitor
the ID is the filename without its extension. Monitor IDs are never declared in frontmatter.

#### Scenario: Folder-derived ID

- **WHEN** `/repo/.claude/monitors/build-config-drift/MONITOR.md` is parsed
- **THEN** the monitor `id` is `build-config-drift`

#### Scenario: Flat-file-derived ID

- **WHEN** `/repo/.claude/monitors/weekly-review.md` is parsed
- **THEN** the monitor `id` is `weekly-review`

#### Scenario: Nested folder monitor uses its immediate parent directory

- **WHEN** `<monitors-root>/team/pr-watch/MONITOR.md` is discovered and parsed
- **THEN** the monitor `id` is `pr-watch`

### Requirement: Underivable monitor ID is a parse error

The parser MUST reject a monitor file whose derived ID is empty or begins with `.`, returning a
parse error with the message `Could not derive a monitor id from the file path`.

#### Scenario: Dot-prefixed flat file

- **WHEN** a file at `<monitors-root>/.foo.md` is passed to the parser
- **THEN** the parse fails with error `Could not derive a monitor id from the file path`

### Requirement: Frontmatter is validated at parse time

The parser SHALL validate the YAML frontmatter against the monitor frontmatter schema and MUST
return a parse error (not throw) when it fails. Unparseable YAML MUST yield the error
`Failed to parse YAML frontmatter`; schema failures MUST yield each issue as `<field path>: <message>`,
joined by `; `.

#### Scenario: Invalid top-level schema fields fail clearly

- **WHEN** a monitor declares `urgency: critical`
- **THEN** parsing returns an error result whose message names the `urgency` field
- **AND** no monitor definition is produced

#### Scenario: Missing required field fails clearly

- **WHEN** a monitor's frontmatter omits the `watch` block
- **THEN** parsing returns an error result whose message names `watch`

#### Scenario: Invalid notify config fails clearly

- **WHEN** a monitor declares `notify: { strategy: debounce }` with no `settle-for`
- **THEN** parsing returns an error result whose message names the `notify` field

#### Scenario: Malformed YAML

- **WHEN** a monitor's frontmatter is not valid YAML
- **THEN** parsing returns the error `Failed to parse YAML frontmatter`

### Requirement: Body stored as trimmed instructions

The parser SHALL store the Markdown body after the frontmatter as the monitor's `instructions`
(on `MonitorDefinition`), with outer leading and trailing whitespace trimmed. There is no minimum
length; an all-whitespace body yields the empty string.

#### Scenario: Body trimming is preserved

- **WHEN** a monitor body is `\n\n  Review the change.\n\n`
- **THEN** the parsed `instructions` is exactly `Review the change.`

### Requirement: Absolute source file path is preserved

The parser SHALL preserve the absolute path of the source monitor file as `filePath` on both a
successful `MonitorDefinition` and a parse error result.

#### Scenario: File path preserved on success

- **WHEN** `/abs/monitors/a/MONITOR.md` parses successfully
- **THEN** the definition's `filePath` is `/abs/monitors/a/MONITOR.md`

#### Scenario: File path preserved in error result

- **WHEN** `/abs/monitors/b/MONITOR.md` fails schema validation
- **THEN** the error result's `filePath` is `/abs/monitors/b/MONITOR.md`

### Requirement: Folder monitor discovery

The scanner SHALL discover folder monitors by matching `**/MONITOR.md` relative to the monitors
root, excluding any match whose directory is the monitors root itself (depth 0). A bare
`<monitors-root>/MONITOR.md` MUST NOT be treated as a monitor.

#### Scenario: Depth-0 MONITOR.md ignored

- **WHEN** a monitors root contains `MONITOR.md` directly and `a/MONITOR.md`
- **THEN** only the monitor with ID `a` is discovered

#### Scenario: Multiple folder monitors discovered

- **WHEN** a monitors root contains `monitor-a/MONITOR.md` and `monitor-b/MONITOR.md`
- **THEN** both are discovered with IDs `monitor-a` and `monitor-b`

### Requirement: Flat monitor discovery

The scanner SHALL discover flat monitors by matching `*.md` at depth 1 of the monitors root only,
excluding any file named `MONITOR.md`. Markdown files nested inside a folder monitor's directory
MUST NOT be treated as monitors, and dot-prefixed files (e.g. `.hidden.md`) MUST NOT be discovered.

#### Scenario: Flat and folder monitors together

- **WHEN** a monitors root contains `x.md` and `y/MONITOR.md`
- **THEN** both are discovered, with IDs `x` and `y`

#### Scenario: Nested markdown asset is not a monitor

- **WHEN** a folder monitor directory `y/` also contains `y/notes.md`
- **THEN** `y/notes.md` is not discovered as a monitor

#### Scenario: Dot-prefixed flat file ignored

- **WHEN** a monitors root contains `.hidden.md`
- **THEN** no monitor is discovered for it

### Requirement: Scan results are absolute, deterministic, and non-aborting

The scanner SHALL resolve every discovered path to an absolute path before parsing, SHALL process
matches in sorted order regardless of filesystem order, and MUST report each unreadable or invalid
file as a per-file error (unreadable: `Failed to read file`) without aborting the scan of the other
files. A monitors root that does not exist yields no monitors and no errors.

#### Scenario: One invalid file does not abort the scan

- **WHEN** a monitors root contains one valid and one schema-invalid monitor
- **THEN** the scan returns one monitor and one error

#### Scenario: Missing monitors root

- **WHEN** the scanner is pointed at `/nonexistent/path/monitors`
- **THEN** it returns zero monitors and zero errors

### Requirement: Only watch is required in frontmatter

The frontmatter schema SHALL require only the `watch` object; `name`, `urgency`, `notify`, `shape`,
`payload`, `baseline-strategy`, and `tags` are optional. The minimal valid monitor is a `watch:`
block plus a body.

#### Scenario: Minimal valid monitor parses successfully

- **WHEN** a monitor's frontmatter is only `watch: { type: schedule, cron: '0 9 * * 1' }`
- **THEN** it parses successfully with `urgency` `normal`, `urgencyMax` `normal`, and `baselineStrategy` `net`

#### Scenario: Valid full monitor parses successfully

- **WHEN** a monitor declares `name: Build Config Drift`, `watch: { type: file-fingerprint, globs: ['package.json', 'tsconfig.json'] }`, `urgency: high`, `notify: { strategy: debounce, settle-for: 30s }`, `tags: [build, config]`, and a body
- **THEN** it parses successfully with `displayName` `Build Config Drift`, `urgency` `high`, the debounce notify policy, and the tags preserved
- **AND** the monitor ID is derived from the folder name, not from frontmatter

### Requirement: Display name

The optional `name` field SHALL be the human-readable display name; when omitted the display name
MUST default to the monitor ID. A present `name` MUST be non-empty and contain at least one
non-whitespace character.

#### Scenario: Name omitted

- **WHEN** monitor `weekly-review` omits `name`
- **THEN** its `displayName` is `weekly-review`

#### Scenario: Whitespace-only name rejected

- **WHEN** a monitor declares `name: '   '`
- **THEN** parsing fails with an error on `name`

### Requirement: watch.type names the source

The `watch` block MUST be an object with a `type` key naming the observation source plugin. `type`
MUST match `/^[a-z][a-z0-9-]*$/` (rejected otherwise with `watch.type must be kebab-case`) and is
the key used to resolve the plugin in the source registry and its scheduling defaults. `type` names
the intent (`file-fingerprint`, `api-poll`, `schedule`, `incoming-changes`, …), never a mechanism.

#### Scenario: Kebab-case type accepted

- **WHEN** a monitor declares `watch: { type: file-fingerprint }`
- **THEN** the `watch.type` check passes

#### Scenario: Non-kebab-case type rejected

- **WHEN** a monitor declares `watch: { type: FileFingerprint }`
- **THEN** parsing fails with `watch.type must be kebab-case`

### Requirement: Per-source config is carried flat inside watch

Every key in the `watch` block other than `type` SHALL be per-source configuration, carried flat
alongside `type` and passed to the source's `observe()` / `watch()`. The core frontmatter schema
MUST impose no constraint on these keys beyond their container being an object; their validation is
delegated to the source's `scopeSchema` (per `monitor/validation` and `sources/contract`).

#### Scenario: Unknown per-source keys pass parse-time validation

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: 42 }`
- **THEN** parse-time frontmatter validation succeeds
- **AND** rejecting `globs: 42` is left to the source-scope validation of `agentmonitors validate`

#### Scenario: Schedule config flat inside watch

- **WHEN** a monitor declares `watch: { type: schedule, cron: '0 9 * * 1', timezone: America/Los_Angeles, label: Weekly maintenance review }`
- **THEN** `cron`, `timezone`, and `label` are passed to the `schedule` source as its config

### Requirement: interval lives inside watch

The scheduling hint `interval` (poll frequency used by the scheduling engine) SHALL be authored
inside the `watch:` block as a sibling of `type`, not at the top level of the frontmatter.

#### Scenario: Interval authored in watch

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: ['src/**/*.ts'], interval: 5m }`
- **THEN** `interval` is read as the monitor's scheduling hint per `runtime/tick-scheduling`

### Requirement: Urgency levels

The urgency levels SHALL be exactly `low`, `normal`, and `high`, ordered `low < normal < high`.
All three, including `low`, are first-class authoring values (PP5).

#### Scenario: low urgency is accepted as valid

- **WHEN** a monitor declares `urgency: low`
- **THEN** it parses successfully with `urgency` `low`

#### Scenario: Each level accepted

- **WHEN** monitors declare `urgency: low`, `urgency: normal`, and `urgency: high` respectively
- **THEN** each parses successfully with that level

### Requirement: Urgency defaults to normal

When `urgency` is omitted, the monitor SHALL default to the degenerate band `normal..normal`, i.e.
`urgency` `normal` and `urgencyMax` `normal`.

#### Scenario: Missing urgency defaults to normal

- **WHEN** a monitor omits `urgency`
- **THEN** the parsed frontmatter has `urgency: normal` and `urgencyMax: normal`

### Requirement: Urgency is authored as a band

A present `urgency` SHALL be either a bare level (the degenerate band `x..x`, which a source can
never escalate — the backward-compatible form) or a range `lo..hi`, where `lo` is the base/default
effective urgency and `hi` is the ceiling a source's per-observation `salience` may escalate to.
Whitespace around the value and around each bound MUST be tolerated.

#### Scenario: Bare level is a degenerate band

- **WHEN** a monitor declares `urgency: high`
- **THEN** the parsed frontmatter has `urgency: high` and `urgencyMax: high`

#### Scenario: Range with surrounding whitespace

- **WHEN** a monitor declares `urgency: 'normal .. high'`
- **THEN** the parsed frontmatter has `urgency: normal` and `urgencyMax: high`

#### Scenario: Widest band

- **WHEN** a monitor declares `urgency: low..high`
- **THEN** the parsed frontmatter has `urgency: low` and `urgencyMax: high`

### Requirement: Invalid urgency bands are rejected

The schema MUST reject a bound that is not `low`/`normal`/`high`, an inverted range where `lo > hi`
over `low < normal < high`, and a malformed range (more or fewer than two bounds, or an empty
bound).

#### Scenario: Unknown bound

- **WHEN** a monitor declares `urgency: low..critical`
- **THEN** parsing fails with an error on `urgency`

#### Scenario: Inverted range

- **WHEN** a monitor declares `urgency: high..normal` or `urgency: normal..low`
- **THEN** parsing fails with an error stating the range is inverted

#### Scenario: Malformed range

- **WHEN** a monitor declares `urgency: low..normal..high` or `urgency: ..high`
- **THEN** parsing fails with an error on `urgency`

### Requirement: Parsed urgency band exposure

The parsed band SHALL expose its low bound as `frontmatter.urgency` (kept under that key for
backward compatibility with consumers that read a single level) and its high bound as
`frontmatter.urgencyMax`, which equals `urgency` for a bare level.

#### Scenario: Band flattened into two keys

- **WHEN** a monitor declares `urgency: normal..high`
- **THEN** consumers reading `frontmatter.urgency` see `normal`
- **AND** `frontmatter.urgencyMax` is `high`

### Requirement: Salience escalates only within the authored band

The effective urgency of an observation SHALL be `clamp(salience ?? band.lo, band.lo, band.hi)`, so
a source may only escalate within a band the author wrote and urgency stays user-controlled (PP5).
Runtime application is specified by `runtime/notify-dispatch`; the `salience` contract by
`sources/contract`.

#### Scenario: Salience clamped to ceiling

- **WHEN** a monitor declares `urgency: normal..high` and a source attaches `salience: high`
- **THEN** the effective urgency is `high`

#### Scenario: Bare level never escalates

- **WHEN** a monitor declares `urgency: normal` and a source attaches `salience: high`
- **THEN** the effective urgency is `normal`

### Requirement: Notify strategy shapes

A present `notify` block MUST be exactly one of three shapes discriminated by `strategy`:
`{ strategy: debounce, settle-for: <duration> }`, `{ strategy: throttle, suppress-for: <duration> }`,
or `{ strategy: rollup, window: <cron>, timezone?: <iana> }`. Each required companion key MUST be
present.

#### Scenario: Debounce accepted

- **WHEN** a monitor declares `notify: { strategy: debounce, settle-for: 5m }`
- **THEN** parsing succeeds with that notify policy

#### Scenario: Throttle accepted

- **WHEN** a monitor declares `notify: { strategy: throttle, suppress-for: 30m }`
- **THEN** parsing succeeds with that notify policy

#### Scenario: Throttle without suppress-for rejected

- **WHEN** a monitor declares `notify: { strategy: throttle }`
- **THEN** parsing fails with an error on `notify`

#### Scenario: Unknown strategy rejected

- **WHEN** a monitor declares `notify: { strategy: immediate }`
- **THEN** parsing fails with an error on `notify`

### Requirement: Duration string syntax

The `settle-for` and `suppress-for` durations MUST match `^\d+[smhd]$` — one or more digits followed
by exactly one of `s`, `m`, `h`, `d` (e.g. `30s`, `5m`, `1h`, `2d`); anything else MUST be rejected
with `Must be a duration string (e.g., "5m", "30s", "1h")`.

#### Scenario: Valid duration

- **WHEN** a monitor declares `notify: { strategy: debounce, settle-for: 30s }`
- **THEN** the duration is accepted

#### Scenario: Compound or unitless duration rejected

- **WHEN** a monitor declares `settle-for: 1h30m` or `settle-for: '30'`
- **THEN** parsing fails with `Must be a duration string (e.g., "5m", "30s", "1h")`

### Requirement: Omitted notify uses runtime default delivery

When `notify` is omitted, the monitor SHALL receive the default delivery behavior defined by
`runtime/notify-dispatch`; the definition itself MUST NOT synthesize a notify block.

#### Scenario: No notify block

- **WHEN** a monitor omits `notify`
- **THEN** the parsed frontmatter has no `notify` value and the runtime default applies

### Requirement: Rollup window is a five-field cron

A `notify: { strategy: rollup }` block MUST include `window`, a five-field cron expression
(minute hour day month weekday; same grammar as the `schedule` source) defining the recurring
delivery time. Parse-time validation SHALL check only the field count; an individual malformed field
is not rejected at parse and simply never matches at runtime.

#### Scenario: Rollup with window accepted

- **WHEN** a monitor declares `notify: { strategy: rollup, window: '0 9 * * 1-5' }`
- **THEN** parsing succeeds

#### Scenario: Daily digest rollup monitor

- **WHEN** a monitor declares `watch: { type: api-poll, url: 'https://api.example.com/updates', interval: 1h }`, `urgency: low`, `notify: { strategy: rollup, window: '0 9 * * 1-5', timezone: America/Los_Angeles }`, `tags: [digest, daily]`
- **THEN** it parses successfully as a `rollup` Pace-mode monitor alongside the `debounce` and `throttle` modes

#### Scenario: Rollup missing window rejected

- **WHEN** a monitor declares `notify: { strategy: rollup }`
- **THEN** parsing fails and `agentmonitors validate` exits non-zero

#### Scenario: Wrong field count rejected

- **WHEN** a monitor declares `window: '0 9 * *'`
- **THEN** parsing fails with `Must be a five-field cron expression (e.g., "0 9 * * 1-5")`

### Requirement: Rollup timezone

The optional rollup `timezone` SHALL be the IANA time zone in which `window` is evaluated and MUST
default to `UTC` when omitted. A present value MUST be a name `Intl.DateTimeFormat` accepts and is
otherwise rejected at parse/`validate` time (#297), using the same check as the `schedule` source's
`timezone`.

#### Scenario: Valid timezone accepted

- **WHEN** a rollup monitor declares `timezone: America/Los_Angeles`
- **THEN** parsing succeeds and `window` is evaluated in that zone

#### Scenario: Invalid timezone rejected

- **WHEN** a rollup monitor declares `timezone: Mars/Olympus_Mons`
- **THEN** parsing fails with `Must be a valid IANA time zone name (e.g., "America/New_York", "UTC")`

### Requirement: Rollup accumulates and flushes on the window

A `rollup` monitor SHALL hold all observations produced since the last window opening in durable
accumulation state in `monitorState.notifyState`; at the next window opening the runtime flushes the
whole batch as a single composite delivery and clears it. A window opening with nothing accumulated
MUST produce no delivery. Runtime detail: `runtime/notify-dispatch`.

#### Scenario: Daily digest

- **WHEN** a rollup monitor with `window: '0 9 * * 1-5'` accumulates three observations overnight
- **THEN** at 09:00 on the next weekday one composite delivery carries all three and the batch is cleared

#### Scenario: Empty window

- **WHEN** a rollup window opens with no accumulated observations
- **THEN** no delivery is produced

#### Scenario: Accumulated batch survives restart

- **WHEN** the daemon restarts between accumulating observations and the next window opening
- **THEN** the accumulated batch is flushed at that window opening

### Requirement: Rollup does not couple observation cadence

The runtime MUST NOT enforce any coupling between a `rollup` monitor's `watch.interval` and its
delivery `window`; relaxing observation cadence (e.g. `interval: 1h` for a once-daily window) is the
author's choice and does not change the delivery outcome.

#### Scenario: Tight interval with daily window

- **WHEN** a rollup monitor with a daily `window` declares `watch.interval: 30s`
- **THEN** the monitor is accepted and observes every 30s, still delivering only at the window

### Requirement: Tags

A present `tags` field MUST be an array of strings. Tags SHALL have no runtime semantics; they exist
for filtering.

#### Scenario: Tags accepted

- **WHEN** a monitor declares `tags: [build, config]`
- **THEN** parsing succeeds and the tags are preserved on the definition

#### Scenario: Non-array tags rejected

- **WHEN** a monitor declares `tags: build`
- **THEN** parsing fails with an error on `tags`

### Requirement: baseline-strategy field

A monitor MAY declare `baseline-strategy` with value `net` or `incremental`; any other value MUST be
rejected. When omitted it SHALL default to `net`. The parsed value SHALL be exposed under the
camelCase key `baselineStrategy` (Refs #110).

#### Scenario: Omitted baseline-strategy

- **WHEN** a monitor omits `baseline-strategy`
- **THEN** the parsed frontmatter has `baselineStrategy: net`

#### Scenario: Explicit incremental

- **WHEN** a monitor declares `baseline-strategy: incremental`
- **THEN** the parsed frontmatter has `baselineStrategy: incremental`

#### Scenario: Unknown value rejected

- **WHEN** a monitor declares `baseline-strategy: latest`
- **THEN** parsing fails and `agentmonitors validate` exits non-zero

### Requirement: net baseline strategy delivers one delta per changed object

Under `net` (the default), a recipient SHALL receive, across its catch-up span, a single
before/after delta per changed object representing where things stand now versus its baseline,
with intermediate churn collapsed. Collapse is per object, not per monitor. Runtime semantics:
`pipeline/post-processing`.

#### Scenario: Missed changes collapse to one delta

- **WHEN** a `net` monitor's object changes three times while a recipient is away
- **THEN** that recipient receives one net delta for the object

#### Scenario: Several objects in one window

- **WHEN** two objects of a `net` monitor change in the same window
- **THEN** the claim envelope carries one before/after event per object

#### Scenario: Net spec-doc monitor

- **WHEN** a monitor watches `docs/specs/**/*.md` with `notify: { strategy: debounce, settle-for: 3m }` and no `baseline-strategy`
- **THEN** each agent at a divergent baseline receives the spec's current state versus its own baseline, not a replay of each edit burst

### Requirement: incremental baseline strategy delivers every step in order

Under `incremental` (the explicit opt-out), a recipient SHALL receive every intermediate observation
since its baseline, in order. The baseline strategy is independent of the `notify` strategy.

#### Scenario: Missed changes delivered play-by-play

- **WHEN** an `incremental` monitor's object changes three times while a recipient is away
- **THEN** that recipient receives three deltas, in sequence

### Requirement: Duplicate monitor IDs are reported by scan

Monitor IDs MUST be unique within a scanned monitor tree (SP2). The scanner SHALL report every ID
derived by more than one successfully parsed monitor in `ScanResult.duplicateIds` as
`DuplicateMonitorId` entries `{ id, filePaths }`, and an empty list when all IDs are unique.

#### Scenario: Folder-name collision

- **WHEN** a tree contains `a/dup/MONITOR.md` and `b/dup/MONITOR.md`
- **THEN** `duplicateIds` contains `{ id: 'dup', filePaths: [both absolute paths] }`

#### Scenario: Flat file and folder collide

- **WHEN** a monitors root contains `dup.md` and `dup/MONITOR.md`
- **THEN** `duplicateIds` contains an entry for `dup`

#### Scenario: Unique IDs

- **WHEN** all monitors in a tree derive distinct IDs
- **THEN** `duplicateIds` is empty

### Requirement: Duplicate monitor IDs are a hard error

Because runtime state is keyed by `monitorId`, the runtime tick MUST refuse to run while any
duplicate ID is present, `agentmonitors validate` MUST exit non-zero, and `agentmonitors scan` MUST
report the collisions and exit non-zero. Integrators MUST NOT create two monitors deriving the same
ID in one tree.

#### Scenario: Tick refuses on duplicates

- **WHEN** a runtime tick scans a tree whose `duplicateIds` is non-empty
- **THEN** the tick fails with an error naming each duplicate ID and its file paths and processes no monitor

#### Scenario: validate fails on duplicates

- **WHEN** `agentmonitors validate` runs on a tree with a duplicate ID
- **THEN** it exits non-zero and reports the collision

### Requirement: Body is the default event body

The monitor body SHALL be part of the delivery contract: when a source observation omits its own
`body`, the runtime MUST use the monitor's `instructions` as the event body (per
`runtime/event-materialization`).

#### Scenario: Observation without body

- **WHEN** a source observation for monitor `build-config-drift` has no `body`
- **THEN** the materialized event's body is that monitor's trimmed instructions

#### Scenario: Observation with body

- **WHEN** a source observation supplies its own `body`
- **THEN** the event body is the observation's body, not the instructions

### Requirement: Shape block is optional

A monitor MAY declare a `shape` block describing deterministic post-processing of the shared
snapshot before Pace and Diff. A monitor with no `shape` block SHALL get no derived facts and no
explicit render: the raw `snapshotText` is the diff input. Runtime semantics:
`pipeline/post-processing`.

#### Scenario: No shape block

- **WHEN** a monitor omits `shape`
- **THEN** no derived facts are computed and the raw `snapshotText` is diffed

### Requirement: Shape derive rules

`shape.derive` SHALL be an optional ordered list of named derived facts. Each entry MUST have a
non-empty `name` (the marker surfaced in the rendered artifact) and a non-empty `when`: a CEL boolean
predicate evaluated over `(snapshot, now)`, where `now` is runtime-injected, never an ambient clock.
The predicate is a constrained declarative expression, not arbitrary code.

#### Scenario: Derive rules accepted

- **WHEN** a monitor declares `shape: { derive: [{ name: past-due, when: 'due < now' }, { name: urgent, when: "priority == 'high' && due <= now + 24h" }], render: rendered }`
- **THEN** parsing succeeds and the rules keep their authored order

#### Scenario: Empty name rejected

- **WHEN** a derive entry declares `name: ''`
- **THEN** parsing fails with `shape.derive[].name must be non-empty`

### Requirement: Malformed shape predicate is rejected

Because a `shape` declaration MUST be a pure function of `(snapshot, now)` (instability produces
phantom diffs), a `shape.derive[].when` that fails to parse as CEL MUST be rejected at parse time
and by `agentmonitors validate`, with a `malformed CEL predicate: …` error on that entry's `when`.

#### Scenario: Malformed CEL

- **WHEN** a derive entry declares `when: 'due <'`
- **THEN** parsing fails with an error at `shape.derive.0.when` beginning `malformed CEL predicate:`

### Requirement: Unresolvable predicate identifiers evaluate as not holding

A well-formed `when` predicate that references an identifier absent from the snapshot and `now`
SHALL NOT be rejected at parse time; at evaluation it MUST deterministically yield "fact does not
hold".

#### Scenario: Predicate references a missing field

- **WHEN** a derive rule declares `when: 'missingField > 3'` and the snapshot has no `missingField`
- **THEN** the monitor parses successfully and the fact does not hold for that snapshot

### Requirement: Shape render

`shape.render`, when present, MUST be the literal `rendered`; it opts the monitor into rendering the
shaped state to a stable, markdown-ish (never JSON) text artifact that the runtime diffs instead of
the raw source, per `pipeline/post-processing`.

#### Scenario: Render accepted

- **WHEN** a monitor declares `shape: { render: rendered }`
- **THEN** parsing succeeds and the rendered artifact becomes the diff input

#### Scenario: Unknown render value rejected

- **WHEN** a monitor declares `shape: { render: json }`
- **THEN** parsing fails with an error on `shape.render`

### Requirement: Payload form

A monitor MAY declare a `payload` block; when present, `payload.form` is required and MUST be one of
`prose`, `structured`, `artifact`, `rendered` (the exported `PayloadForm` type). The form is declared,
never inferred from the source. `prose` is the only form that invokes the optional Interpret stage;
the others are deterministic-floor forms (per `pipeline/post-processing`).

#### Scenario: Structured form accepted

- **WHEN** a monitor declares `payload: { form: structured }`
- **THEN** parsing succeeds

#### Scenario: Unknown form rejected

- **WHEN** a monitor declares `payload: { form: summary }`
- **THEN** parsing fails with an error on `payload.form`

### Requirement: Omitted payload keeps textual delivery

When `payload` is omitted, the monitor SHALL keep textual (`rendered`/`prose`) delivery.

#### Scenario: No payload block

- **WHEN** a monitor omits `payload`
- **THEN** its deliveries are textual

### Requirement: Payload transform only under structured form

`payload.transform` MUST be valid only when `payload.form` is `structured`; under any other form it
MUST be rejected with `payload.transform is only valid when payload.form is "structured"`.

#### Scenario: Transform under rendered form

- **WHEN** a monitor declares `payload: { form: rendered, transform: { language: jq, expression: '.a' } }`
- **THEN** parsing fails with `payload.transform is only valid when payload.form is "structured"`

### Requirement: Payload transform language and expression

A `payload.transform` SHALL have `language` `jq` (extraction/reshaping) or `cel` (predicate/boolean
selection) and a non-empty `expression` evaluated over the canonical JSON form of the shaped
snapshot, regardless of `encoding`. An unknown `language` or an expression that fails to parse MUST
be rejected with `malformed <language> transform: …`.

#### Scenario: jq projection accepted

- **WHEN** a monitor declares `payload: { form: structured, transform: { language: jq, expression: '.sets | map({weight: .weight, reps: .reps, rpe: .rpe})' } }`
- **THEN** parsing succeeds

#### Scenario: Malformed jq rejected

- **WHEN** a structured transform declares `language: jq` with `expression: '.sets | map('`
- **THEN** parsing fails with an error at `payload.transform.expression` beginning `malformed jq transform:`

#### Scenario: Unknown language rejected

- **WHEN** a structured transform declares `language: jsonata`
- **THEN** parsing fails with an error on `payload.transform.language`

### Requirement: Transform evaluators are eval-free

The `jq` and `cel` evaluators MUST NOT use the `Function` constructor or `eval` (CSP/Workers safety).
The supported `jq` dialect SHALL be the practical subset this implies: object construction requires
explicit keys (`{weight: .weight}`, not `{weight}`), and array collection uses `map(...)` rather than
`[ … ]` around a pipe.

#### Scenario: Shorthand object construction unsupported

- **WHEN** a structured transform uses `{weight}` shorthand
- **THEN** it is not supported; the author writes `{weight: .weight}` instead

### Requirement: Payload encoding

`payload.encoding` MAY select the output serialization: `json` (default), `yaml`, `toon`, or `toml`;
any other value MUST be rejected. Encoding is a downstream concern and MUST NOT change the
transform's predicate semantics.

#### Scenario: toon encoding accepted

- **WHEN** a monitor declares `payload: { form: structured, encoding: toon }`
- **THEN** parsing succeeds

#### Scenario: Unknown encoding rejected

- **WHEN** a monitor declares `payload: { form: structured, encoding: xml }`
- **THEN** parsing fails with an error on `payload.encoding`

### Requirement: Single monitors directory per operation

Commands and runtime ticks SHALL operate on one supplied monitors directory at a time; that directory
may represent project-level, user-level, or any other integrator-chosen convention. No merge
algorithm across multiple roots is defined (AP5): scope precedence, override order, and multi-root
composition are outside the contract.

#### Scenario: One root per tick

- **WHEN** a runtime tick is invoked with a monitors directory
- **THEN** only monitors discovered under that directory are scanned for that tick

### Requirement: Overlapping monitors deliver independently

The runtime SHALL coalesce events only within a monitor and MUST NOT collapse two independently
authored monitors into one: each monitor materializes its own `monitor_events` row for the same
underlying change (cross-monitor delivery coalescing per `delivery/lifecycles` still applies).
`agentmonitors validate` SHALL NOT detect overlapping monitors.

#### Scenario: Two monitors over the same state

- **WHEN** a "ready-to-merge PRs" monitor and an "all open PRs" monitor both observe one PR gaining the label
- **THEN** two `monitor_events` rows are materialized, one per monitor

#### Scenario: validate accepts overlapping monitors

- **WHEN** `agentmonitors validate` runs on a tree with two monitors over overlapping state
- **THEN** it reports no overlap error
