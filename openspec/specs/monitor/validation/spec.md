# monitor/validation Specification

## Purpose

What each monitor validation surface proves and does not prove: parse-time validation of a
`MONITOR.md` file, the `agentmonitors validate` tree check, the `agentmonitors schema generate`
editor schema, and `agentmonitors monitor test` as a source exerciser. Command flags and output
formats are owned by the `cli/*` capabilities; the frontmatter schema itself by `monitor/definition`.

## Requirements

### Requirement: Parse-time validation proves file, frontmatter, and top-level schema validity

Parsing a `MONITOR.md` file SHALL prove that the file can be read, its YAML frontmatter parses, the top-level monitor schema (per `monitor/definition`) is valid, and the body is extracted (trimmed) as the monitor's instructions. A failure MUST return an error result naming the file path rather than throwing.

#### Scenario: Valid monitor parses with trimmed body

- **WHEN** a `MONITOR.md` with valid frontmatter and body `"\n\nCheck the docs.\n\n"` is parsed
- **THEN** the result is successful
- **AND** the instructions are `Check the docs.`

#### Scenario: Unparseable YAML frontmatter

- **WHEN** a file whose frontmatter is not valid YAML is parsed
- **THEN** the result is an error `Failed to parse YAML frontmatter` carrying the file path

#### Scenario: Monitor ID cannot be derived

- **WHEN** a monitor file whose derived ID would be empty or dot-prefixed (e.g. `.hidden/MONITOR.md`) is parsed
- **THEN** the result is an error `Could not derive a monitor id from the file path`

### Requirement: Parse-time validation rejects invalid top-level fields

Parse-time validation SHALL reject invalid top-level frontmatter, including an invalid `urgency` value, a missing `watch` block, and a malformed `notify` block, with an error that names each failing field path (`<dotted.path>: <message>`, multiple issues joined by `; `).

#### Scenario: Invalid urgency

- **WHEN** a monitor declares `urgency: critical`
- **THEN** parsing fails with an error naming `urgency`

#### Scenario: Missing watch

- **WHEN** a monitor's frontmatter has no `watch` block
- **THEN** parsing fails with an error naming `watch`

#### Scenario: Debounce without settle-for

- **WHEN** a monitor declares `notify: { strategy: debounce }` without `settle-for`
- **THEN** parsing fails

#### Scenario: Throttle without suppress-for

- **WHEN** a monitor declares `notify: { strategy: throttle }` without `suppress-for`
- **THEN** parsing fails

#### Scenario: Rollup with an invalid IANA timezone (issue #297)

- **WHEN** a monitor declares `notify: { strategy: rollup, window: '0 9 * * 1-5', timezone: Not/AZone }`
- **THEN** parsing fails with an error naming `notify.timezone` and the message `Must be a valid IANA time zone name (e.g., "America/New_York", "UTC")`
- **AND** `agentmonitors validate` and `monitor test` reject the monitor at authoring time, before it can reach runtime rollup evaluation

### Requirement: Parse-time validation accepts all three urgency values

Parse-time validation MUST accept `low`, `normal`, and `high` as urgency values (per PP5); `low` is first-class and MUST NOT be treated as an optional or deprecated value by any validation surface.

#### Scenario: Each urgency value parses

- **WHEN** otherwise-identical monitors declare `urgency: low`, `urgency: normal`, and `urgency: high`
- **THEN** all three parse successfully with the declared urgency

### Requirement: Parse-time validation does not check source-specific watch config

Parse-time validation SHALL accept any object inside `watch` (beyond its `type`) without source-specific validation; source-specific config validity is proven only by `validate` and `monitor test` (per BP3).

#### Scenario: Wrong-typed source field still parses

- **WHEN** a monitor with `watch: { type: file-fingerprint, globs: 42 }` is parsed
- **THEN** parsing succeeds

### Requirement: Validate requires an existing monitors directory

`agentmonitors validate` SHALL prove that the monitors directory exists and is a directory, and MUST exit with code 1 when it does not, without scanning.

#### Scenario: Nonexistent directory

- **WHEN** `agentmonitors validate ./missing` is run and `./missing` does not exist
- **THEN** it reports `path "./missing" does not exist` and exits with code 1

#### Scenario: File given instead of directory

- **WHEN** `agentmonitors validate ./mon/MONITOR.md` is run on a file
- **THEN** it reports that the path is a file, not a directory, and points to `agentmonitors monitor test './mon/MONITOR.md'`
- **AND** it exits with code 1

### Requirement: Validate reports every monitor file that fails to parse

`agentmonitors validate` SHALL parse every monitor file in the tree, report each parse failure as an invalid monitor keyed by its derived monitor ID (falling back to the file path when no ID can be derived), and exit with code 1 when any monitor is invalid.

#### Scenario: One bad file among good ones

- **GIVEN** a tree with valid monitors `a` and `b` and a monitor `c` whose frontmatter is malformed
- **WHEN** `agentmonitors validate` runs
- **THEN** `a` and `b` are listed as valid and `c` is listed as invalid with its parse error
- **AND** the exit code is 1

### Requirement: Validate rejects duplicate monitor IDs

`agentmonitors validate` MUST reject a tree in which more than one monitor file derives the same monitor ID (per SP2), reporting each collision with the message `Duplicate monitor id "<id>" -- ids are derived from folder names and must be unique within a tree` and the colliding file paths, and exiting with code 1.

#### Scenario: Two folders with the same name

- **GIVEN** `team-a/build/MONITOR.md` and `team-b/build/MONITOR.md` under one monitors directory
- **WHEN** `agentmonitors validate` runs
- **THEN** it reports `Duplicate monitor id "build"` with both file paths
- **AND** the JSON output's `duplicateIds` lists `{ id: "build", filePaths: [...] }`
- **AND** the exit code is 1

### Requirement: Validate rejects unknown source names

`agentmonitors validate` MUST reject a monitor whose `watch.type` is not a registered source, with the error `Unknown source "<name>". Available sources: <comma-separated registered names>`.

#### Scenario: Misspelled source

- **WHEN** a monitor declares `watch: { type: file-fingerprnt }`
- **THEN** `validate` reports `Unknown source "file-fingerprnt". Available sources: ` followed by the registered source names
- **AND** the exit code is 1

### Requirement: Validate fully checks watch config against the source scopeSchema

`agentmonitors validate` SHALL validate each monitor's watch config (the `watch` block minus `type`) against its source's `scopeSchema` with full JSON Schema draft-07 semantics — types, enums, `required`, `items`, and other keywords — not merely required-field presence (per AP4).

#### Scenario: Wrong-typed globs rejected

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: 42 }`
- **THEN** `validate` reports a `scope` error stating `globs` must be an array
- **AND** the exit code is non-zero

#### Scenario: Missing required source field

- **WHEN** an `api-poll` monitor omits `url`
- **THEN** `validate` reports a `scope` error for the missing required field

### Requirement: Scope validation is CSP-safe

Scope validation MUST walk the JSON Schema at runtime and MUST NOT compile validators with the `Function` constructor or `eval`, so that it runs under restrictive CSP and Workers-style environments.

#### Scenario: Validation under a no-eval policy

- **WHEN** scope validation runs in an environment where `Function` and `eval` are disallowed
- **THEN** it completes and returns the same diagnostics as in an unrestricted environment

### Requirement: Scope diagnostics are identical across authoring paths

`validate`, `monitor test`, and the ephemeral `watch declare` path SHALL reject an invalid watch scope with the identical diagnosis, produced by the exported core helper `validateWatchScope`, which adds actionable messages for known opaque schema failures.

#### Scenario: Collection without json-diff

- **WHEN** a watch config declares `change-detection.collection` without `change-detection.strategy: json-diff`
- **THEN** the diagnosis is `change-detection.collection requires strategy: json-diff`

#### Scenario: Invalid IANA timezone

- **WHEN** a `schedule` monitor declares `timezone: America/New_Yrok`
- **THEN** the diagnosis is `scope.timezone: "America/New_Yrok" is not a valid IANA time zone name (e.g. "America/New_York", "UTC").`
- **AND** both `validate` and `monitor test` reject it, while a valid sibling monitor still validates

#### Scenario: Unrelated source ignores a stray timezone key

- **WHEN** a `file-fingerprint` monitor, whose `scopeSchema` declares no `timezone` property, carries `timezone: not-a-zone`
- **THEN** no timezone error is reported

### Requirement: Validate hints at the legacy source/scope shape

When a monitor fails to parse and its frontmatter has a top-level `source:` value and a `scope:` key but no `watch:` key, `agentmonitors validate` SHALL keep the parse error and append the hint `did you mean to use the current watch shape? Move source/scope into watch:, for example: watch: { type: <source>, ... }`.

#### Scenario: Old top-level shape

- **WHEN** a monitor's frontmatter is `source: api-poll` with a `scope:` block and no `watch:`
- **THEN** the reported error contains the parse error followed by `; did you mean to use the current watch shape?` and `watch: { type: api-poll, ... }`

#### Scenario: Unrelated parse error gets no hint

- **WHEN** a monitor's frontmatter already has a `watch:` key and fails to parse for another reason
- **THEN** no migration hint is appended

### Requirement: Validate surfaces shape and payload declaration errors

`agentmonitors validate` SHALL reject, as parse errors, the `shape` and `payload` declaration errors defined by `monitor/definition`: a malformed `shape.derive[].when` CEL predicate, a `payload.transform` under any `form` other than `structured`, a malformed `jq` or `cel` transform expression, and an unknown `form`, `language`, or `encoding` value.

#### Scenario: Transform under a non-structured form

- **WHEN** a monitor declares `payload: { form: rendered, transform: { language: jq, expression: ".a" } }`
- **THEN** `validate` reports `payload.transform is only valid when payload.form is "structured"`

#### Scenario: Malformed CEL predicate

- **WHEN** a monitor declares `shape: { derive: [{ name: urgent, when: "snapshot.due <" }] }`
- **THEN** `validate` reports an error beginning `shape.derive.0.when: malformed CEL predicate:`

#### Scenario: Unknown payload form

- **WHEN** a monitor declares `payload: { form: summary }`
- **THEN** `validate` rejects the monitor

### Requirement: Validate does not statically check shape predicate identifier scope

`agentmonitors validate` SHALL accept a syntactically valid `shape.derive[].when` CEL predicate even when it references an identifier outside the snapshot and `now`; such a reference is not rejected at validation time.

#### Scenario: Out-of-scope identifier accepted

- **WHEN** a monitor declares `shape: { derive: [{ name: stale, when: "env.HOME != ''" }] }`
- **THEN** `validate` reports the monitor as valid

### Requirement: Schema generate derives the editor schema from the source registry

`agentmonitors schema generate` SHALL emit a JSON Schema draft-07 document (`$schema: http://json-schema.org/draft-07/schema#`) whose only required top-level field is `watch`, whose `watch.type` is an enum of the registered source names, and which applies each source's `scopeSchema` to `watch` through an `if`/`then` conditional keyed on `watch.type` (per AP4).

#### Scenario: Source-discriminated watch config

- **WHEN** `schema generate` runs with `file-fingerprint`, `api-poll`, and `schedule` registered
- **THEN** `properties.watch.properties.type.enum` lists those three names
- **AND** `allOf` contains one conditional per source whose `if` requires `watch.type` to equal that source name and whose `then` applies that source's `scopeSchema` to `watch`

#### Scenario: Minimal monitor is valid against the schema

- **WHEN** a monitor with only `watch` and no `urgency` is checked against the generated schema
- **THEN** it is valid, because `urgency` is not required

### Requirement: Schema generate constrains urgency and notify

The generated schema SHALL constrain `urgency` to `low`, `normal`, or `high` (as a bare level or a `lo..hi` band, per `monitor/definition`), and `notify` to exactly one of: `debounce` requiring `settle-for`, `throttle` requiring `suppress-for` (both matching `^\d+[smhd]$`), or `rollup` requiring a five-field cron `window` with optional `timezone`.

#### Scenario: Each urgency level allowed

- **WHEN** `urgency` is `low`, `normal`, `high`, or `normal..high`
- **THEN** the generated schema accepts it
- **AND** it rejects `urgent`

#### Scenario: Notify alternatives

- **WHEN** `notify` is `{ strategy: debounce, settle-for: 15s }`
- **THEN** the generated schema accepts it
- **AND** it rejects `{ strategy: throttle }` with no `suppress-for`

### Requirement: Monitor test exercises a source without proving a real change

`agentmonitors monitor test` SHALL be a source exerciser, not a proof of long-running runtime correctness: it MUST NOT be read as evidence that a real external change occurred during the invocation.

#### Scenario: Non-stateful source with no observations

- **WHEN** `monitor test` runs a non-stateful source that returns no observations
- **THEN** it reports `No observations produced.`

### Requirement: Monitor test proves a stateful baseline and follow-up observe

For a stateful source whose first observe returns zero observations, `monitor test` SHALL run a second observe in the same process about 100 ms later, reusing the first call's `nextState` as `previousState`, proving the source can baseline and re-observe without losing state.

#### Scenario: Stateful baseline flow

- **WHEN** `monitor test` runs a valid `file-fingerprint` monitor and nothing changes
- **THEN** it reports that a baseline was established and runs a second observation
- **AND** it reports `No changes detected since baseline. This is expected — both observations happened within the same command invocation.`

### Requirement: Monitor test rejects an invalid scope before observing

`monitor test` MUST validate the watch config with the same diagnostics as `validate` before calling the source, reporting `Invalid monitor scope: <diagnostics>` and exiting with code 1 without observing.

#### Scenario: Invalid timezone in monitor test

- **WHEN** `monitor test` runs a `schedule` monitor with `timezone: America/New_Yrok`
- **THEN** it reports `Invalid monitor scope:` followed by the IANA timezone diagnosis
- **AND** it exits with code 1 without calling the source
