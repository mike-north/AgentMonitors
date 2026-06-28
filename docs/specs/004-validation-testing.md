# 004 — Validation & Testing

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md)
> **Covers:** validation surfaces, CLI verification behavior, required test scenarios, ambiguity handling

## 1. Overview

This document specifies how the Agent Monitors spec should be validated and how the repository should handle ambiguity, drift, and contradictory evidence. The implementation already contains useful tests across parser, runtime, CLI, and bundled sources. This document turns those scattered checks into a coherent, traceable test obligation tied back to the numbered specs.

### Principles Satisfied

| Section                 | Principles             |
| ----------------------- | ---------------------- |
| Validation surfaces     | PP7, PP8, AP4, AP6     |
| Required test scenarios | PP1, PP5, PP6, AP1–AP4 |
| Ambiguity handling      | PP7, PP8               |

## 2. Validation Surfaces

The repository currently exposes several different validation surfaces. They do not all prove the same thing.

### 2.1 Parse-time validation

`parseMonitor()` proves: the file can be read; YAML frontmatter parses; top-level monitor schema is valid; the body is extracted as instructions. It does **not** prove that source-specific watch config is fully valid.

**Verified in:** `apps/cli/src/commands/validate.ts` calls `scanMonitors()` which calls `parseMonitor()` internally. The parser rejects invalid top-level fields (wrong `urgency` value, missing `watch`, malformed `notify`) but accepts any object inside `watch` without source-specific validation.

### 2.2 `agentmonitors validate`

The `validate` command proves: the monitor directory exists; monitor files parse; monitor IDs are unique within the tree (see [001 §4](./001-monitor-definition.md)); the selected source name is known; and each monitor's watch config (the `watch` block minus `type`) is **fully valid** against its source's `scopeSchema`.

**Verified implementation detail (current):** source config validation runs full JSON Schema (draft-07) checks — types, enums, `required`, `items`, and other keywords — via the exported core helper `validateScope(scope, scopeSchema)` (`libs/core/src/schema/validate-scope.ts`), which `apps/cli/src/commands/validate.ts` calls after extracting `watch` minus `type`. A monitor with `watch: { type: file-fingerprint, globs: 42 }` is now **rejected** (validate exits non-zero) because `globs` must be an array of strings.

When parse-time validation sees the old top-level `source:` + `scope:` shape, `validate` keeps the parse error but appends a targeted hint to move those fields into `watch: { type, ... }`.

The validator is `@cfworker/json-schema`, which walks the schema at runtime rather than compiling with the `Function` constructor, so validation is safe under restrictive CSP / Workers-style environments.

> **Target extension (not yet implemented).** Validation of `shape` predicate determinism and
> `payload.form` / `payload.transform` / `payload.encoding` is a **_target_** obligation for the
> `validate` surface. When implemented, `validate` will additionally reject: a `shape.derive.when`
> CEL predicate that references symbols outside `(snapshot, now)`; a `payload.transform` under any
> `form` other than `structured`; a malformed `jq` or `cel` expression; and an unknown `form`,
> `language`, or `encoding` value. The cross-references from
> [001 §5.1](./001-monitor-definition.md#51-shape-target) and
> [001 §5.2](./001-monitor-definition.md#52-payload-form-target) point at this _target_ guarantee,
> not the current `watch`/`scopeSchema` validation already in place.

### 2.3 `agentmonitors schema generate`

The schema-generation path proves that the source registry can produce a combined editor-facing schema for monitor authoring. It is a contract surface for: allowed top-level monitor fields; allowed urgency values; source-discriminated watch config shapes.

**Verified in:** `libs/core/src/observation/schema-generator.ts` — `generateMonitorSchema()` produces a JSON Schema draft-07 document with `if/then` conditionals per source, a `source` enum drawn from registered source names, `urgency` constrained to `['low', 'normal', 'high']`, and a `notify` `oneOf` covering `debounce` and `throttle` strategies.

### 2.4 `agentmonitors monitor test`

`monitor test` is a source exerciser, not a proof of long-running runtime correctness. For stateful sources, it proves: the source can establish a baseline; a follow-up observe call can run without losing state inside the command. It does **not** prove that a real change occurred during that command invocation.

**Verified in:** `apps/cli/src/commands/monitor-test.ts` — when the first observe call returns zero observations and `source.stateful` is true, the command calls `createFollowupObservationContext()` (which reuses `previousState` from the baseline result) and runs a second observe call. Both calls happen within the same process. No file-system or external change can realistically occur in the 100 ms `setTimeout` between calls, so "no changes detected" is the expected and documented outcome.

### 2.5 Runtime tests

Runtime tests are the primary proof surface for: state persistence across runtime restarts; due scheduling; delivery lifecycle semantics; session projection; hook state correctness.

**Verified in:** `libs/core/src/runtime/service.test.ts`

### 2.6 CLI integration tests

CLI integration tests are the primary proof surface for: command wiring; output shape and argument validation; round-trip behavior through the daemon/runtime interface.

**Verified in:** `apps/cli/src/commands/cli.integration.test.ts`

## 3. Required Test Scenarios

The spec set is incomplete unless each major rule has at least one concrete testable scenario. The table below maps each scenario to the test file that covers it, or flags it as a gap.

### 3.1 Monitor authoring and parsing

| Scenario                                         | Coverage                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid full monitor parses successfully           | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses valid full monitor")                                                                                                                                                                                                                                                      |
| Minimal valid monitor parses successfully        | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses minimal valid monitor")                                                                                                                                                                                                                                                   |
| Body trimming is preserved                       | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns body content as instructions (trimmed)")                                                                                                                                                                                                                                 |
| Invalid top-level schema fields fail clearly     | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid frontmatter values"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects invalid urgency", missing-required-field cases)                                                                                                                          |
| Invalid notify config fails clearly              | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid notify config"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects debounce without settle-for", "rejects throttle without suppress-for")                                                                                                        |
| File path and directory-derived ID are preserved | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "derives id from parent folder name", "preserves filePath in error result")                                                                                                                                                                                                       |
| `low` urgency is accepted as valid               | **TEST GAP** — `libs/core/src/schema/monitor-schema.test.ts` "accepts all urgency values" iterates only `['high', 'normal']`; `low` is absent from the loop despite being defined in the schema and being a first-class value per spec [000-principles.md](./000-principles.md) and [002-runtime-delivery.md](./002-runtime-delivery.md). |

### 3.2 Source-specific behavior

| Scenario                                                                | Coverage                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateful baseline returns no first-run observations (file-fingerprint)  | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations on first run (baseline)")                                                                                                                                                                                                                                                                                                   |
| Stateful baseline returns no first-run observations (api-poll)          | Covered (`plugins/source-api-poll/src/index.test.ts` — "returns no observations on first poll (baseline)")                                                                                                                                                                                                                                                                                                          |
| Changed file content emits file-fingerprint observations                | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "detects file changes on subsequent runs")                                                                                                                                                                                                                                                                                                           |
| Unchanged file content does not emit observations                       | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations when files have not changed"; `plugins/source-api-poll/src/index.test.ts` — "returns no observations when response is unchanged")                                                                                                                                                                                           |
| `text-diff` strategy detects response body changes                      | Covered (`plugins/source-api-poll/src/index.test.ts` — "detects response changes on subsequent polls (text-diff)")                                                                                                                                                                                                                                                                                                  |
| `json-diff` strategy ignores whitespace differences                     | Covered (`plugins/source-api-poll/src/index.test.ts` — "json-diff: ignores whitespace differences in JSON")                                                                                                                                                                                                                                                                                                         |
| `status-code` strategy detects status change, ignores body              | Covered (`plugins/source-api-poll/src/index.test.ts` — "status-code: detects status change, ignores body change")                                                                                                                                                                                                                                                                                                   |
| Non-2xx `api-poll` responses are observation errors and do not baseline | Covered (`plugins/source-api-poll/src/index.test.ts` — "rejects a 401 response before establishing a baseline", "rejects a 500 response instead of diffing or advancing state"; `apps/cli/src/commands/cli.integration.test.ts` — "surfaces non-2xx api-poll responses as monitor-test errors without establishing a baseline", "surfaces a non-2xx api-poll response in daemon once output and persisted history") |
| Schedule source emits one observation whenever invoked                  | Covered (`plugins/source-schedule/src/index.test.ts` — "fires an observation when called")                                                                                                                                                                                                                                                                                                                          |
| Missing required source config field throws clearly                     | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "throws on missing globs config"; `plugins/source-api-poll/src/index.test.ts` — "throws on missing url"; `plugins/source-schedule/src/index.test.ts` — "throws on missing cron config")                                                                                                                                                              |

### 3.3 Runtime delivery

| Scenario                                                                             | Coverage                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source state survives runtime restart                                                | Covered (`libs/core/src/runtime/service.test.ts` — "persists source state across runtime restarts and emits changes later")                                                                                                                                         |
| High urgency waits for settle window before interruptible delivery                   | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; "emits all debounced high-urgency observations after the settle window")                                                      |
| Normal urgency coalesces — second delivery not offered until session is acknowledged | Covered (`libs/core/src/runtime/service.test.ts` — "coalesces normal-urgency reminders until unread events are acknowledged")                                                                                                                                       |
| Low urgency delivers only at idle lifecycle points                                   | Covered (`libs/core/src/runtime/service.test.ts` — "defers low-urgency delivery until idle lifecycle points")                                                                                                                                                       |
| Recap emits recent unread events and command hints                                   | Covered (`libs/core/src/runtime/service.test.ts` — "returns recap deliveries after post-compact with recap messaging")                                                                                                                                              |
| Events project only into matching workspace sessions                                 | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters"; `apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists") |
| Scope filters query `queryScope` correctly                                           | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters")                                                                                                                              |
| Hook state reflects pending and unread counts correctly                              | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; `libs/core/src/hook-bridge/bridge.test.ts` — `computeHookState` suite)                                                        |
| Cron timezone matching works correctly                                               | Covered (`libs/core/src/runtime/service.test.ts` — "matches schedule cron expressions in the configured timezone")                                                                                                                                                  |
| Subagent sessions do not receive events projected to the lead session                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists")                                                                                                                               |

### 3.4 Persistence and snapshotting

The `RuntimeStore.saveSnapshot()` and `RuntimeStore.latestSnapshot()` methods (in `libs/core/src/runtime/store.ts`) implement snapshot storage keyed by `(workspacePath, monitorId, objectKey)`. The `processObservation` method in `libs/core/src/runtime/service.ts` uses these to retrieve the prior snapshot and compute a `diffText` before saving the event.

| Scenario                                                     | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotText` stores a later-retrievable snapshot           | **TEST GAP** — The `RuntimeStore` methods `saveSnapshot` and `latestSnapshot` have no dedicated unit tests. The integration path through `processObservation` is exercised in `service.test.ts` only for the case where `snapshotText` is `null` (all manual `insertEvent` calls pass `snapshotText: null`). No test asserts that a `snapshotText` provided by a source observation is stored, retrieved, and used to produce `diffText` on a subsequent observation. |
| A prior snapshot produces diff text on later change          | **TEST GAP** — No test verifies that `diffText` is populated when the same `(monitorId, objectKey)` pair has a prior snapshot.                                                                                                                                                                                                                                                                                                                                        |
| Snapshots are isolated by workspace, monitor, and object key | **TEST GAP** — No test verifies that `latestSnapshot` with different workspace paths, monitor IDs, or object keys returns independent values.                                                                                                                                                                                                                                                                                                                         |

### 3.5 CLI behavior

| Scenario                                                                                           | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate` accepts a directory of valid monitors                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "validates monitors in a directory")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `validate` rejects a nonexistent directory                                                         | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "errors on nonexistent directory")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `validate` emits structured JSON when `--format json`                                              | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "returns JSON error when --format json and path missing")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `validate` rejects an invalid `--format` value                                                     | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects invalid --format value")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validate` rejects a monitor with an unknown source name                                           | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects an unknown source name")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validate` rejects a monitor with invalid source config                                            | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects a scope that violates the source schema")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `validate` hints for old top-level `source:` + `scope:` frontmatter                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "hints when a monitor uses the old top-level source/scope shape")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scan` lists discovered monitors and parse failures                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "scans monitors and returns JSON"; `libs/core/src/parser/scan-monitors.test.ts` — "reports parse errors without aborting")                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source list` reflects bundled registry contents                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "lists sources in text format", "lists sources in JSON format")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `schema generate` emits source-discriminated monitor schema                                        | **TEST GAP** — No CLI integration test invokes `agentmonitors schema generate` and inspects the output. The `generateMonitorSchema` unit tests in `libs/core/src/observation/schema-generator.test.ts` cover the function directly, but the `schema generate` command wire-up has no end-to-end coverage.                                                                                                                                                                                                                                                                                                                             |
| `session open/close/list` reflects runtime session records                                         | Partially covered (`apps/cli/src/commands/cli.integration.test.ts` — `session open` is exercised as part of the runtime flow test; `session close/list` as standalone commands have no dedicated tests). **PARTIAL GAP** — `session list` and `session close` command invocations are not independently verified.                                                                                                                                                                                                                                                                                                                     |
| `events list/ack` round-trips through daemon runtime behavior                                      | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "opens a session, detects file changes through the daemon, claims a hook delivery, and acknowledges events")                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `hook claim` returns lifecycle-appropriate payloads                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — `hook claim --lifecycle turn-interruptible` in the runtime flow test; `libs/core/src/runtime/service.test.ts` — various `claimDelivery` lifecycle tests)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `monitor test` stateful baseline flow                                                              | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "tests a valid file-fingerprint monitor"; `apps/cli/src/commands/monitor-test.test.ts` — "preserves previousState and refreshes now")                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor test` errors on missing or unparseable file                                               | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "errors on missing file", "errors on invalid MONITOR.md content")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `inbox list` argument validation                                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects invalid --state value", "rejects invalid --urgency value", "rejects invalid --since date")                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Activation plugin `hooks.json` command strings stay wired to the CLI stdin contract (config drift) | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "drives the plugin's literal hooks.json command strings end to end (boot, deliver body, deregister)"; "SessionStart command falls back to the install-hint JSON when agentmonitors is not on PATH"). The suite parses the real `agent-plugins/agentmonitors/hooks/hooks.json` and runs each `SessionStart`/`UserPromptSubmit`/`SessionEnd` command verbatim via `/bin/sh -c` with an `agentmonitors` PATH shim, so a drifted command string (flag re-added, binary renamed, chain broken), a regressed stdin contract, or an invalid missing-CLI fallback breaks the test. |

## 4. Test Style Guidance

Each tricky rule should have a named example plus explicit assertions. Agent Monitors tests MUST prefer:

- Structural assertions for event shape, hook state, and projection rules — assert on the specific fields that the spec defines, not on a serialized whole.
- Hand-authored scenario checks for subtle lifecycle behavior — write expected values by reading the spec, not by capturing current output.
- Direct assertions on current behavior when a limit is intentionally preserved (e.g., asserting that a second `claimDelivery` returns `null` after coalescing).

Snapshot-only approval is too weak for the subtler runtime rules in this repo. A test that passes solely because captured output matches a stored snapshot can never detect a regression in the rule it is meant to guard.

When tests depend on timing (settle windows, debounce), use fake timers (`vi.useFakeTimers()` / `vi.setSystemTime()`) rather than real `setTimeout` waits. Exceptions are integration tests that must exercise real process boundaries; these SHOULD use the shortest feasible polling intervals and document why fake timers cannot be used.

## 5. Ambiguity and Drift Handling

When sources disagree, the spec process MUST NOT silently average them together. The required process is:

1. Identify the contradiction explicitly.
2. Distinguish current implementation behavior from desired future behavior.
3. Record the resolution in `spec-changelog.md`.
4. Update the relevant numbered spec doc.
5. Update or add tests so the decision is enforced.

### 5.1 Current known mismatches that the spec already resolves

- `low` urgency is real and MUST be treated as first-class. The schema generator correctly includes it in the `urgency` enum (`schema-generator.ts` line 31). The `monitor-schema.test.ts` "accepts all urgency values" test currently omits `low` from its loop — this is a test gap, not an implementation gap.
- The runtime/session event pipeline is the primary delivery path.
- The inbox item lifecycle is separate from the event pipeline, not merely another view of the same data.
- Duplicate monitor IDs are a correctness hazard even though explicit rejection is not yet implemented at scan or validate time.
- Source-specific validation is only partially enforced by the current `validate` command: required field presence is checked but full JSON Schema validation (type checking, format constraints, enum values within scope) is not yet enforced. This limitation is intentional current behavior.

### 5.2 Evidence priority during this transition

Until the repository is fully realigned with the new spec set:

1. The internal numbered specs are the desired contract.
2. Existing implementation and tests are the evidence for current behavior.
3. Older public website docs are explanatory and MAY lag.

If a future implementation change intentionally diverges from current behavior, that MUST be called out as a target change rather than described as if it were already implemented.

## 6. Acceptance Checklist For Spec Changes

Any substantive spec addition or change MUST answer all of the following:

- Is the rule normative or informative?
- Does it say whether the behavior is current or target?
- Is there at least one concrete example for the tricky part?
- Is there at least one test or validation implication attached to it?
- If it resolves a contradiction, is that recorded in `spec-changelog.md`?

If any answer is "no", the change is underspecified.
