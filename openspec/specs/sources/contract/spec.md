# sources/contract Specification

## Purpose

The contract every observation source plugin implements (the `ObservationSource` family of types
exported from `@agentmonitors/core`), the division of labor between sources and the runtime (sources
observe current state and own their change-detection state; the runtime owns timing, diffing,
persistence, and delivery per PP3/AP3), the source registry, monitor JSON Schema generation, and the
shared keyed-collection change-detection semantics used by poll sources.

## Requirements

### Requirement: ObservationSource members

Every source plugin SHALL implement the `ObservationSource` interface with the required members `name` (readonly string), `scopeSchema` (readonly `JsonSchema`), and `observe(config, context)` returning `Promise<ObservationResult>`. A source MAY additionally declare `stateful` (readonly boolean, default `false` when absent) and `watch(config, context)` returning `AsyncIterable<Observation>`.

#### Scenario: Minimal source declares only the required members

- **WHEN** a plugin exports an object with `name`, `scopeSchema`, and an `observe()` that resolves to `{ observations: [] }`
- **THEN** it satisfies the `ObservationSource` contract
- **AND** it is treated as non-stateful because `stateful` is absent

#### Scenario: Optional watch member

- **WHEN** a plugin additionally implements `watch(config, context)`
- **THEN** `watch` returns an `AsyncIterable<Observation>` and the source still implements `observe()`

### Requirement: Contract types are exported from the core package

`@agentmonitors/core` SHALL export the types a third-party source author needs: `ObservationSource`, `ObservationContext`, `ObservationResult`, `Observation`, and `JsonSchema`. `JsonSchema` SHALL be typed as `Record<string, unknown>` (a plain object describing a JSON Schema fragment).

#### Scenario: Third-party author imports the contract types

- **WHEN** a plugin author writes `import type { JsonSchema, Observation, ObservationContext, ObservationResult, ObservationSource } from '@agentmonitors/core'`
- **THEN** all five types resolve from the package's public entry point

### Requirement: Source name and scope schema identify the watch block

A source's `name` SHALL be a unique kebab-case plugin name that MONITOR.md authors reference as `watch.type`. A source's `scopeSchema` SHALL be a JSON Schema fragment describing the source's per-source config — the `watch:` block minus `type`, written flat alongside `type`. The code identifiers keep the historical "scope" wording (`scopeSchema`, `validateScope`); renaming them is out of scope because it would break the public plugin API.

#### Scenario: watch.type selects a source by name

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: ['**/*.ts'] }`
- **THEN** the runtime resolves the source whose `name` is `file-fingerprint`
- **AND** `{ globs: ['**/*.ts'] }` (the `watch:` block minus `type`) is the config validated against that source's `scopeSchema`

### Requirement: Runtime drives observe and watch

The runtime SHALL drive `observe()` on the tick loop for every source and SHALL additionally drive `watch()` continuously for sources that implement it (NP4). A watched monitor SHALL be driven only by its watcher; the tick loop skips its `observe()`. Scheduling and watcher lifecycle are specified by the `runtime/tick-scheduling` capability. No bundled source currently implements `watch()`.

#### Scenario: Watched monitor is not double-driven

- **GIVEN** a source that implements `watch()` and a running daemon watching one of its monitors
- **WHEN** the tick loop finds that monitor due
- **THEN** the tick loop does not call `observe()` for it, and observations arrive only through the watcher

### Requirement: Observation context supplies prior state and time

`observe()` SHALL receive `config` (the source-specific monitor config as `Record<string, unknown>`) and a `context` of type `ObservationContext` carrying `previousState?: unknown` (the persisted state from the previous observation cycle, if any) and `now: Date` (a timestamp supplied by the runtime).

#### Scenario: Second cycle sees the first cycle's nextState

- **GIVEN** a source whose previous `observe()` returned `nextState: { cursor: 'abc' }`
- **WHEN** the runtime calls `observe()` again for the same monitor
- **THEN** `context.previousState` equals `{ cursor: 'abc' }` and `context.now` is the runtime-supplied time

### Requirement: Workspace path for project-relative scope

For project monitor evaluation the runtime SHALL supply `context.workspacePath`, the runtime workspace/config root. File-system-oriented sources SHALL use it to resolve project-relative scope instead of depending on the daemon process cwd.

#### Scenario: Project monitor resolution is independent of daemon cwd

- **GIVEN** a daemon whose process cwd is `/` and a project monitor in `/repo/.claude/monitors/x/MONITOR.md`
- **WHEN** the runtime calls the monitor's file-system source
- **THEN** `context.workspacePath` is `/repo` and the source resolves relative scope against `/repo`, not `/`

### Requirement: Watch abort signal

The runtime SHALL supply `context.signal` (an `AbortSignal`) to `watch()` only, and SHALL abort it to tear the watcher down (daemon shutdown, monitor removal). A `watch()` implementation SHOULD stop yielding and release resources when the signal fires. `observe()` does not use it.

#### Scenario: Daemon shutdown stops a watcher

- **GIVEN** a running `watch()` iterator
- **WHEN** the daemon shuts down
- **THEN** the runtime aborts `context.signal` and the watcher stops yielding

### Requirement: Watch checkpoint callback

The runtime SHALL supply `context.checkpoint(nextState)` only on the `watch()` path, letting a long-lived watcher durably write its in-memory change-detection state back to the monitor's persisted source state independent of yielding an observation; `observe()` advances state via `nextState` instead. Write ordering and failure handling are specified by the `runtime/tick-scheduling` capability.

#### Scenario: observe never receives checkpoint

- **WHEN** the runtime calls `observe()` for any monitor
- **THEN** `context.checkpoint` is absent

### Requirement: ObservationResult shape

`observe()` SHALL return an `ObservationResult` with `observations: Observation[]` (zero or more), optional `nextState?: unknown` (source-owned state for the next cycle), optional `outcome?: "rebaselined" | "no-files-matched"`, and optional `warnings?: string[]` (non-fatal diagnostics that do not mark the cycle errored).

#### Scenario: Empty result is valid

- **WHEN** a source returns `{ observations: [] }`
- **THEN** the cycle is a successful no-change cycle

### Requirement: Zero-observation outcome diagnostic

A source MAY set `outcome` to `"rebaselined"` or `"no-files-matched"` to mark a zero-observation run that is meaningfully different from ordinary no-change. The runtime SHALL record the outcome in `observation_history` only when the source returned zero observations and emitted nothing.

#### Scenario: Outcome recorded instead of no-change

- **WHEN** a source returns `{ observations: [], outcome: 'no-files-matched' }`
- **THEN** the runtime's `observation_history` row for that cycle records `no-files-matched` rather than `no-change`

#### Scenario: Outcome ignored when observations exist

- **WHEN** a source returns one observation and also sets `outcome`
- **THEN** the outcome is not recorded as the cycle's history outcome

### Requirement: Observation fields

Each `Observation` SHALL carry a required `title` (string) and MAY carry `body` (string), `summary` (string), `payload` (raw source payload kept for querying), `snapshotText` (textual snapshot for diffing and timelines), `objectKey` (stable object identity), `queryScope` (`Record<string, string | string[]>` read-time scoping metadata), `changeKind` (`ChangeKind`), `salience` (`Urgency`), and `snapshot` (point-in-time metadata captured at fire time).

#### Scenario: Title-only observation

- **WHEN** a source emits `{ title: 'Deploy finished' }`
- **THEN** it is a valid observation with every other field absent

### Requirement: Title is a fallback headline and summary names the object

An observation's `title` SHALL be written to read well as a fallback headline: the runtime uses the monitor's authored `name` as the delivered event title when it has one and falls back to `title` otherwise (per the `runtime/event-materialization` capability). `summary` is the detail line injecting transports render beneath the title, so for a named monitor it, not `title`, names the object that moved.

#### Scenario: Named monitor keeps its name as headline

- **GIVEN** a monitor authored with `name: Release notes`
- **WHEN** its source emits `{ title: 'File changed: /repo/NOTES.md', summary: 'File changed: /repo/NOTES.md' }`
- **THEN** the delivered event title is `Release notes` and the summary line names `/repo/NOTES.md`

### Requirement: ChangeKind vocabulary

`ChangeKind` SHALL be the source-agnostic vocabulary `created` (object entered scope), `modified` (changed while in scope), `deleted` (destroyed upstream — information lost), and `descoped` (still exists upstream but left the monitor's scope — no information lost). `deleted` and `descoped` SHALL remain distinct.

#### Scenario: Deleted versus closed pull request

- **GIVEN** a monitor watching open pull requests
- **WHEN** one PR is deleted upstream and another is closed
- **THEN** the deleted PR is reported with `changeKind: deleted` and the closed PR with `changeKind: descoped`

### Requirement: Runtime copies changeKind into queryScope

When an observation sets `changeKind`, the runtime SHALL copy it into the materialized event's `queryScope.changeKind`, so it is filterable without each source populating `queryScope` itself.

#### Scenario: changeKind becomes filterable

- **WHEN** a source emits `{ title: 't', changeKind: 'deleted', queryScope: { filePath: '/a' } }`
- **THEN** the materialized event's `queryScope` contains `filePath: '/a'` and `changeKind: 'deleted'`

### Requirement: Salience is a source's domain judgment, not urgency

An observation's `salience` (`low` | `normal` | `high`) SHALL express the source's per-observation domain judgment of how interrupt-worthy that observation is (PP3). A source SHALL NOT set urgency directly; `urgency` remains the monitor-level policy authored in MONITOR.md.

#### Scenario: Salience does not replace authored urgency

- **WHEN** a source emits an observation with `salience: 'high'`
- **THEN** the monitor's authored `urgency` still governs the effective urgency through the clamp rule

### Requirement: Effective urgency clamps salience into the authored band

The runtime SHALL compute effective urgency as `clamp(salience ?? band.lo, band.lo, band.hi)` over the monitor's authored urgency band `lo..hi`; a bare scalar `urgency: x` is the band `x..x`. A source can therefore escalate an observation only within the band the author granted, and adding `salience` is always backward compatible.

#### Scenario: Escalation within a band

- **GIVEN** a monitor authored with `urgency: normal..high`
- **WHEN** a source emits an observation with `salience: 'high'`
- **THEN** the effective urgency is `high`

#### Scenario: Absent salience uses the band floor

- **GIVEN** a monitor authored with `urgency: normal..high`
- **WHEN** a source emits an observation with no `salience`
- **THEN** the effective urgency is `normal`

#### Scenario: Out-of-band salience is clamped

- **GIVEN** a monitor authored with `urgency: normal..high`
- **WHEN** a source emits an observation with `salience: 'low'`
- **THEN** the effective urgency is `normal`

#### Scenario: Scalar urgency is never escalated

- **GIVEN** a monitor authored with `urgency: normal`
- **WHEN** a source emits an observation with `salience: 'high'`
- **THEN** the effective urgency is `normal`

### Requirement: Stateful sources establish a baseline

When a source declares `stateful: true`, its first successful `observe()` MAY return an empty `observations` array while storing an initial baseline in `nextState`; this is not an error (PP6). On subsequent calls the stored state SHALL be available via `context.previousState`. Source state is keyed per monitor instance, not per source name.

#### Scenario: First run returns no observations

- **GIVEN** a stateful source and a monitor with no persisted source state
- **WHEN** the runtime calls `observe()` for the first time
- **THEN** the result has zero observations and a non-empty `nextState`
- **AND** a later call with changed upstream state returns observations

#### Scenario: Different configurations do not share baseline state

- **GIVEN** two monitors using the same stateful source with different configs
- **WHEN** each is observed
- **THEN** each receives only its own prior `nextState` as `context.previousState`

### Requirement: Bundled sources declare statefulness

The bundled sources `file-fingerprint`, `api-poll`, `command-poll`, and `incoming-changes` SHALL declare `stateful: true`. The bundled `schedule` source SHALL NOT declare `stateful` (it defaults to `false`).

#### Scenario: Schedule is not stateful

- **WHEN** the bundled `schedule` source is inspected
- **THEN** its `stateful` member is absent

### Requirement: Sources return current-state snapshots, not diffs

A source SHALL acquire the current state of the watched thing and return it as observations — including a `snapshotText` and/or `snapshot` capturing what the thing is now — together with its own change-detection state via `nextState`. A source MUST NOT compute "what is new for recipient X", and a source that emits pre-diffed delta packets for the runtime to pass through is outside this contract.

#### Scenario: Bundled source emits full content, not a diff

- **GIVEN** a `file-fingerprint` monitor whose watched file changed after baseline
- **WHEN** the source observes
- **THEN** the observation's `snapshotText` is the full current file content and the observation has no diff field

### Requirement: Runtime is the sole diff producer

The runtime SHALL be the sole producer of the diff that drives delivery, computed against the consumer's baseline (the latest stored object snapshot per the `runtime/event-materialization` capability, with per-recipient baselines per the `delivery/session-projection` capability). This lets one shared observation fan out to many recipients with divergent baselines.

#### Scenario: Runtime materializes the diff

- **GIVEN** a stored snapshot `a\n` for an object and a new observation with `snapshotText: 'a\nb\n'` for the same `objectKey`
- **WHEN** the runtime materializes the event
- **THEN** the runtime, not the source, produces the event's `diffText`

### Requirement: nextState is source-internal change-detection state

A source's `nextState` SHALL be its own internal change-detection state (e.g. file fingerprints, the last API body, a last-seen commit SHA), used only to decide whether to emit an observation and to advance its own cursor. It SHALL NOT be treated as a per-recipient baseline.

#### Scenario: Source state does not define what is new for a consumer

- **GIVEN** a source whose `nextState` advanced past a change
- **WHEN** a session with an older stored baseline later receives the event
- **THEN** the delivered diff is computed by the runtime against that session's baseline, not from the source's `nextState`

### Requirement: Composite observation assembled inside the source

A single `Observation` MAY be assembled from multiple source queries or calls reduced into one composite whole-state snapshot inside `observe()` (or `watch()`). The composition SHALL run once per observation on the shared side of the pipeline seam (per the `pipeline/post-processing` capability); the runtime sees a single observation and is unaware of the fan-in. The bundled `api-poll` realization (`change-detection.composite`) is specified by `sources/api-poll`.

#### Scenario: N calls reduce to one observation

- **WHEN** a source issues N API calls in one `observe()` to reconstruct one document
- **THEN** it returns one observation whose `snapshotText` is the ordered rendered composite
- **AND** the runtime diffs it against the consumer's baseline exactly as a single-call snapshot

### Requirement: Composite snapshot is deterministic

A composite observation's `snapshotText`/`snapshot` MUST be stable and deterministic: the same underlying state assembled the same way MUST render identically run-to-run, regardless of call completion order or transient fields.

#### Scenario: Part completion order does not churn the snapshot

- **GIVEN** a composite whose parts complete in order A,B on one run and B,A on the next with identical content
- **WHEN** both runs render the composite
- **THEN** both `snapshotText` values are byte-identical and no change is reported

### Requirement: Composite carries one objectKey

A composite observation SHALL carry one `objectKey` identifying the assembled whole, not one per underlying call. A source that tracks many independent objects SHALL instead emit many observations or use keyed-collection change detection.

#### Scenario: Composite under one key

- **WHEN** a composite is assembled from parts `header`, `line-1`, `line-2` with object key `order-42`
- **THEN** exactly one observation is emitted with `objectKey: 'order-42'`

### Requirement: Composite partial failure is never silent

A source MAY treat a failed underlying call as a failed observation (no `nextState` advance, preserving the prior baseline) or as a degraded-but-valid composite, but it MUST NOT silently emit a composite that omits part of its declared whole without that omission being visible in the snapshot.

#### Scenario: Failed part does not yield a silently partial composite

- **GIVEN** a composite of three parts where one call fails
- **WHEN** the source observes
- **THEN** it either fails the observation without advancing `nextState` or emits a composite whose snapshot visibly records the missing part

### Requirement: Sources surface raw facts, not derived facts

A source SHALL surface raw observable facts (e.g. a `due` timestamp, a `defer-until` timestamp, a `priority` field, child task states) as observed in its `snapshot`/`snapshotText`/`payload`. A source MUST NOT compute recipient-facing derived or time-relative facts ("past due", "stalled", "revealed", "urgent") and MUST NOT bake the current wall-clock into the snapshot; the runtime Shape stage derives them (per the `pipeline/post-processing` capability).

#### Scenario: Raw defer timestamp, runtime derives revealed

- **GIVEN** a source that surfaces a raw `deferUntil` timestamp
- **WHEN** the runtime evaluates with an injected `now` later than `deferUntil`
- **THEN** the runtime derives `revealed` and the source's snapshot contains only the raw timestamp

#### Scenario: Pre-computed flag violates the contract

- **WHEN** a source's snapshot embeds a pre-computed "past due" flag that flips purely because time advanced
- **THEN** the source violates this contract because the flag would produce a phantom diff with no underlying change

### Requirement: objectKey is an identity

An `objectKey` SHALL give an observed object a stable identity and MAY be as long as identity requires (e.g. `command-poll`'s default joined argv). The untruncated key SHALL remain on the observation's `objectKey` and in `payload`.

#### Scenario: Long key preserved

- **WHEN** a `command-poll` monitor's default `objectKey` is a 400-character joined argv
- **THEN** the observation's `objectKey` holds all 400 characters

### Requirement: Configuration-identity keys are bounded in human-facing text

A source that interpolates a configuration-identity `objectKey` (`command-poll`'s joined argv, `api-poll`'s URL) into `title` or `summary` MUST bound it with the exported `displayObjectKey` helper, which returns the key unchanged at or below 60 UTF-16 code units and otherwise a prefix followed by `…`, cut at a grapheme-cluster boundary (the result may be shorter than the bound).

#### Scenario: Short key unchanged

- **WHEN** `displayObjectKey` receives a key of exactly 60 UTF-16 code units
- **THEN** it returns the key unchanged

#### Scenario: Long jq argv is bounded

- **WHEN** a nameless `command-poll` monitor's argv key is ~400 characters of a `jq` program
- **THEN** the observation `title` contains a prefix of the key ending in `…` no longer than 60 code units
- **AND** `objectKey` and `payload` still hold the full key

#### Scenario: Truncation never splits a grapheme

- **WHEN** the cut point falls inside a surrogate pair, flag, or ZWJ sequence
- **THEN** the prefix ends at the preceding grapheme boundary and contains no lone surrogate

### Requirement: Path-like and per-item keys are not bounded

`displayObjectKey` bounding SHALL NOT apply to path-like keys (`file-fingerprint`'s absolute file path, `incoming-changes`' repository-relative path), to the per-item key half of a keyed-collection `<scope>#<key>` (only the monitor-scope half is bounded), or to the author-supplied `api-poll` composite `object-key`.

#### Scenario: Nameless file-fingerprint headline keeps the full path

- **GIVEN** a nameless `file-fingerprint` monitor watching a file with a 120-character absolute path
- **WHEN** the file changes
- **THEN** the observation `title` contains the full absolute path

#### Scenario: Keyed-collection item key rendered whole

- **WHEN** a keyed-collection observation's key is `<long-argv>#task-123`
- **THEN** only the `<long-argv>` half is bounded and `task-123` is rendered whole

### Requirement: Sources reject invalid required configuration clearly

A source SHALL fail with a clear error when its required configuration is missing or invalid (e.g. missing `globs` for `file-fingerprint`, missing `url` for `api-poll`, missing `paths` for `incoming-changes`; for `api-poll`, an unresolved bearer token per the `sources/api-poll` capability).

#### Scenario: Missing required field throws

- **WHEN** a source's `observe()` is called with a config lacking its required field
- **THEN** it throws an error naming the missing field

### Requirement: SourceRegistry registration

`@agentmonitors/core` SHALL export `SourceRegistry`, an in-memory registry of source plugins whose `register(source: ObservationSource): void` adds a source and throws an `Error` when a source with the same `name` is already registered.

#### Scenario: Duplicate registration throws

- **GIVEN** a registry with a source named `file-fingerprint`
- **WHEN** another source named `file-fingerprint` is registered
- **THEN** `register` throws an `Error`

### Requirement: SourceRegistry lookup

`SourceRegistry` SHALL expose `get(name): ObservationSource | undefined` (the source, or `undefined` if not found), `has(name): boolean`, `list(): ObservationSource[]` (all registered sources), and `names(): string[]` (all registered names).

#### Scenario: Unknown name

- **WHEN** `get('nope')` and `has('nope')` are called on a registry without that source
- **THEN** they return `undefined` and `false`

### Requirement: Only bundled sources are registered; plugin installation is not implemented

At startup the CLI SHALL register only the bundled sources. Third-party source plugins remain a supported architectural concept, but plugin discovery and installation SHALL NOT be implemented workflows: the `source install`/`update`/`remove`/`search` commands are placeholders that print a manual-install hint (NP3; command surface per the `cli/authoring-commands` capability).

#### Scenario: source install is a placeholder

- **WHEN** a user runs `agentmonitors source install some-plugin`
- **THEN** nothing is installed and the command prints a manual-install hint

### Requirement: Monitor schema generation

`@agentmonitors/core` SHALL export `generateMonitorSchema(sources: ObservationSource[]): JsonSchema`, composing a full monitor JSON Schema from the given sources' `scopeSchema` fragments, with `$schema: 'http://json-schema.org/draft-07/schema#'`, top-level `required: ['watch']`, `watch.type` required and constrained to the enum of the given source names, and an optional `tags` array of strings.

#### Scenario: watch.type enum lists registered sources

- **WHEN** `generateMonitorSchema` is called with the five bundled sources
- **THEN** the schema's `watch.type` enum is exactly those five names and `urgency` is not in `required`

### Requirement: Generated schema applies per-source config conditionally

The generated schema SHALL use `allOf` with one `if`/`then` per source, each `if` requiring `watch` and `watch.type` equal to the source name, and each `then` applying that source's `scopeSchema` to `watch`. It SHALL validate `notify` with a `oneOf` of `debounce` (requires `settle-for`), `throttle` (requires `suppress-for`), and `rollup` (requires `window`).

#### Scenario: Typeless watch does not match every conditional

- **WHEN** a document has `watch: {}` with no `type`
- **THEN** no per-source `then` applies and the error is that `watch.type` is required

#### Scenario: Debounce without settle-for is rejected

- **WHEN** a document has `notify: { strategy: debounce }`
- **THEN** it fails the generated schema

### Requirement: Validation enforces the selected source's scopeSchema

CLI validation SHALL extract the source config from `watch:` minus `type` and enforce the selected source's full `scopeSchema` with the core `validateScope` helper (validate surface per the `monitor/validation` capability).

#### Scenario: Invalid source field fails validate

- **WHEN** a `file-fingerprint` monitor sets `globs: []`
- **THEN** validation fails against the source's `scopeSchema`

### Requirement: Keyed-collection change detection configuration

`api-poll` and `command-poll` SHALL support a `change-detection.collection` block with `path` (where the array lives in parsed output), `key` (field whose value is the per-object identity), and optional `ignore-paths`. Output SHALL be parsed as JSON; the block is valid only under `strategy: json-diff` and `agentmonitors validate` SHALL reject it otherwise with `change-detection.collection requires strategy: json-diff` (BP3).

#### Scenario: Collection under text-diff rejected

- **WHEN** a monitor declares `change-detection: { strategy: text-diff, collection: { path: '$.tasks', key: 'id' } }`
- **THEN** `agentmonitors validate` fails with `change-detection.collection requires strategy: json-diff`

#### Scenario: Collection with absent strategy rejected

- **WHEN** a monitor declares a `collection` block with no `strategy`
- **THEN** `agentmonitors validate` fails with the same message

### Requirement: Keyed-collection per-object identity and change kinds

Each element of the array at `path` SHALL become a tracked object with `objectKey = <monitor-objectKey>#<key-value>`. Per-object observations SHALL use `created` (key appears), `modified` (key present in both and content differs after `ignore-paths` removal), and `descoped` (key disappears from the output), never `deleted`. Comparison SHALL be per key, so element reordering and whitespace are ignored. The per-object diff is one shared exported core helper used by both sources.

#### Scenario: Three tasks become overdue

- **GIVEN** a baseline collection of tasks keyed by `id`
- **WHEN** three tasks' content changes
- **THEN** exactly three `modified` observations are emitted with stable per-task `objectKey`s

#### Scenario: Re-sorted list is not a change

- **WHEN** the output array contains the same elements in a different order
- **THEN** zero observations are emitted

#### Scenario: Removed key is descoped

- **WHEN** an element with `id: 7` is absent from the next output
- **THEN** a `descoped` observation is emitted for `<monitor-objectKey>#7`

#### Scenario: Ignored path does not count as modification

- **GIVEN** `ignore-paths: ['$.fetchedAt']`
- **WHEN** only an element's `fetchedAt` changes
- **THEN** no observation is emitted

### Requirement: Keyed-collection baseline

The first keyed-collection run SHALL record the keyed snapshot and emit nothing.

#### Scenario: Baseline emits nothing

- **WHEN** a keyed-collection monitor runs for the first time
- **THEN** zero observations are emitted and the keyed snapshot is stored

### Requirement: Keyed-collection path syntax

`path` SHALL be a minimal dotted path in explicit root form (`$.tasks`, `$.data.items`) or bare root-relative form (`tasks`, `data.items`), with no wildcards, array indices, filters, or recursive descent. `path` MUST select exactly one array; a path resolving to a non-array or to nothing SHALL be an observe-time error naming the path. `ignore-paths` use the same syntax relative to each element's root.

#### Scenario: Bare and rooted forms are equivalent

- **WHEN** one monitor uses `path: '$.data.items'` and another `path: 'data.items'` against the same output
- **THEN** both select the same array

#### Scenario: Path to a non-array fails clearly

- **WHEN** `path: '$.count'` resolves to a number
- **THEN** the observation fails with an error naming `$.count`

### Requirement: Keyed-collection key values

Each element's `key` value SHALL be a scalar (string, number, or boolean) unique within the collection; a missing or non-scalar key, or a duplicate key value, SHALL be an error.

#### Scenario: Duplicate key fails

- **WHEN** two elements share `id: 3`
- **THEN** the observation fails with an error
