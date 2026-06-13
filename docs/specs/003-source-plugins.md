# 003 — Source Plugins

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md), [002-runtime-delivery.md](./002-runtime-delivery.md)
> **Covers:** source contract, bundled sources, current limitations, plugin-discovery notes, and target change-detection capabilities

## 1. Overview

This document specifies the contract implemented by observation source plugins and the current behavior of the bundled sources: `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes`. The runtime depends on sources to detect change, but the runtime owns scheduling, notify dispatch, and delivery timing (PP3).

Section §13 (the cursor protocol) is a normative design that is **not yet implemented** (PP7); it moves to current status, with `verified:` references, when it ships. §11 (`command-poll`) and §12 (keyed-collection change detection) have shipped and are now **current** behavior (verified: `plugins/source-command-poll/src/index.ts`, `plugins/source-command-poll/src/index.test.ts`; the shared helper `libs/core/src/observation/keyed-collection.ts` with `libs/core/src/observation/keyed-collection.test.ts`, consumed by both `plugins/source-api-poll/src/index.ts` and `plugins/source-command-poll/src/index.ts`).

### Principles Satisfied

| Section                 | Principles         |
| ----------------------- | ------------------ |
| Source contract         | PP3, PP6, AP4, NP4 |
| Bundled source behavior | PP6, PP7, BP3      |
| Plugin-management notes | NP3                |

## 2. Source Contract

Every source plugin **MUST** implement the `ObservationSource` interface. The required members are: `name`, `scopeSchema`, and `observe(config, context)`. A source **MAY** also declare `stateful` and `watch(config, context)`. The runtime drives `observe()` on the tick loop for every source, and additionally drives `watch()` continuously for sources that implement it (NP4); a watched monitor is driven only by its watcher (the tick loop skips its `observe()`). No bundled source opts into `watch()` today, but the execution path exists and is exercised end-to-end.

### 2.1 TypeScript types

A third-party plugin author implements the `ObservationSource` interface and uses the supporting types `ObservationContext`, `ObservationResult`, `Observation`, and `JsonSchema`. All five are exported from `@agentmonitors/core` (verified: `libs/core/src/index.ts` lines 39–45).

```typescript
import type {
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';
```

The interface definition (verified: `libs/core/src/observation/types.ts`):

| Member                     | Kind                         | Required | Description                                                                                                                 |
| -------------------------- | ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | `readonly string`            | Yes      | Unique kebab-case plugin name. Matches `watch.type` in `MONITOR.md`.                                                        |
| `scopeSchema`              | `readonly JsonSchema`        | Yes      | JSON Schema fragment describing this source's per-source config (the `watch:` block minus `type`).                          |
| `stateful`                 | `readonly boolean?`          | No       | If `true`, the first successful call establishes a baseline (PP6). Defaults to `false` when absent.                         |
| `observe(config, context)` | `Promise<ObservationResult>` | Yes      | One-shot observation: check for changes and return any observations.                                                        |
| `watch?(config, context)`  | `AsyncIterable<Observation>` | No       | Optional continuous watch mode, driven by the runtime for sources that implement it (NP4). Stops on `context.signal` abort. |

`JsonSchema` is typed as `Record<string, unknown>`, making it a plain object describing a JSON Schema fragment.

> **Naming note ("scope" vs `watch:`).** The TypeScript contract and core helpers retain the
> historical **scope** wording — `scopeSchema`, `validateScope` — from before the authoring surface
> migrated to `watch: { type, … }`. The two describe the same thing: "scope" in code refers to the
> per-source configuration that authors now write flat inside the `watch:` block alongside `type`,
> and `name` is the value authors reference as `watch.type`. Plugin authors reading the `verified:`
> sources should translate accordingly; renaming the code identifiers is deliberately out of scope
> here (it would be a breaking public-API change for plugin authors).

### 2.2 Observation context

`observe()` receives `config` (the source-specific monitor scope as `Record<string, unknown>`) and `context` of type `ObservationContext`:

- `context.previousState?: unknown` — persisted state from the previous observation cycle, if any.
- `context.now: Date` — timestamp supplied by the runtime.
- `context.signal?: AbortSignal` — supplied to `watch()` only; the runtime aborts it to tear the watcher down (daemon shutdown, monitor removal). A `watch()` implementation **SHOULD** stop yielding and release resources when it fires. Unused by `observe()`.

### 2.3 Observation result

`observe()` returns an `ObservationResult`:

- `observations: Observation[]` — zero or more source observations.
- `nextState?: unknown` — optional source-owned persisted state to use in the next cycle.

Each `Observation` **MAY** include the following fields (verified: `libs/core/src/observation/types.ts`):

| Field          | Type                                  | Description                                                                |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `title`        | `string`                              | **Required.** Human-readable title for the inbox item.                     |
| `body`         | `string?`                             | Optional body/description.                                                 |
| `summary`      | `string?`                             | Optional short summary for lightweight delivery surfaces.                  |
| `payload`      | `unknown?`                            | Raw source payload, preserved for later querying.                          |
| `snapshotText` | `string?`                             | Optional textual snapshot for diffing and timeline views.                  |
| `objectKey`    | `string?`                             | Source-defined stable object identity (e.g., a PR number, file path, URL). |
| `queryScope`   | `Record<string, string \| string[]>?` | Source-defined query metadata used for read-time scoping.                  |
| `changeKind`   | `ChangeKind?`                         | The lifecycle transition this observation reports (see below).             |
| `snapshot`     | `unknown?`                            | Point-in-time snapshot metadata captured at fire time.                     |

`ChangeKind` is a **source-agnostic** vocabulary so consumers reason about change uniformly across
sources: `created` (object entered scope), `modified` (changed while in scope), `deleted` (destroyed
upstream — **information lost**), `descoped` (still exists upstream but **left the monitor's scope** —
no information lost). `deleted` and `descoped` are deliberately distinct (e.g., a pull request
_deleted_ vs _closed_ while watching open PRs). When an observation sets `changeKind`, the runtime
copies it into the materialized event's `queryScope.changeKind` so it is filterable without each
source populating `queryScope` itself (see [002 §5.1](./002-runtime-delivery.md)). Verified:
`libs/core/src/observation/types.ts`, `libs/core/src/runtime/service.ts`.

### 2.4 Stateful sources

If `stateful` is `true`, the first successful `observe()` call **MAY** return an empty `observations` array while storing an initial baseline in `nextState`. That is not an error case — it is how baseline-then-detect sources work (PP6). On subsequent calls, the stored state is available via `context.previousState`.

`file-fingerprint`, `api-poll`, `command-poll`, and `incoming-changes` all declare `stateful: true`. `schedule` does not declare `stateful` (defaults to `false`).

## 3. Bundled Source: `file-fingerprint`

Source name: `"file-fingerprint"` (verified: `plugins/source-file-fingerprint/src/index.ts` line 75).

### 3.1 Scope

```yaml
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
  cwd: /optional/base/path
```

Required field: `globs` (array of strings). Optional field: `cwd` (string). Validated by `parseScopeConfig` — throws if `globs` is missing or not an array of strings.

### 3.2 Behavior

The source expands each glob pattern using `globSync` with `absolute: true`, so matched paths are always absolute. For each matched file, it computes a SHA-256 hash using Node.js `crypto.createHash('sha256')`.

Current fingerprints are stored in `nextState.fingerprints` (a `Record<string, string>` keyed by absolute file path). On each call, the source compares each file's current hash against `context.previousState.fingerprints[filePath]`.

When a previously seen file's hash changes, the source emits one `Observation` per changed file (verified: `plugins/source-file-fingerprint/src/index.ts` lines 99–119):

- `title`: `"File changed: <absolute-file-path>"`
- `summary`: `"File changed: <absolute-file-path>"`
- `payload`: `{ filePath, previousHash, currentHash }`
- `objectKey`: `<absolute-file-path>`
- `queryScope`: `{ filePath: <absolute-file-path> }`
- `snapshot`: `{ filePath, previousHash, currentHash }`
- `snapshotText`: file content as UTF-8 string, **only if the file contains no null bytes** (`!content.includes(0)` where `content` is a `Buffer`)

### 3.3 Change kinds

After the baseline run, the source classifies every observed transition and sets the observation's
`changeKind` (see §2.3):

- **`created`** — a glob-matched path with no prior fingerprint (a new file after baseline).
- **`modified`** — a matched path whose hash changed (the original behavior).
- **`deleted`** — a previously-tracked path that is **gone from disk** (a `stat` of the absolute
  path fails). Information is lost.
- **`descoped`** — a previously-tracked path that **still exists on disk** but is no longer matched
  by the globs (only reachable when the monitor's `globs` are edited). No information is lost; the
  file is simply no longer observed.

`deleted` vs `descoped` is decided by stat-ing the absolute path. `created`/`modified` observations
carry `snapshotText` (when the file is not binary); `deleted`/`descoped` do not, as there is no
current content. The **baseline run emits nothing** — it only records fingerprints — so a first run
never reports its matched files as `created`. The baseline is detected by the absence of a valid
prior `FingerprintState` in `context.previousState`. Verified:
`plugins/source-file-fingerprint/src/index.ts`.

## 4. Bundled Source: `api-poll`

Source name: `"api-poll"` (verified: `plugins/source-api-poll/src/index.ts` line 147).

### 4.1 Scope

```yaml
watch:
  type: api-poll
  url: 'https://api.example.com/status'
  method: GET
  headers:
    Accept: application/json
  interval: 5m
  auth:
    type: bearer
    token-env: API_TOKEN
  change-detection:
    strategy: json-diff
```

Required field: `url` (string). Important optional fields: `method`, `headers`, `interval`, `auth`, `change-detection`.

`interval` is declared in the scope schema with pattern `^\d+[smhd]$` but is used by the scheduling engine, not by the plugin directly (verified: scope schema comment at `plugins/source-api-poll/src/index.ts` line 131).

`method` defaults to `GET` in the schema and in the `fetch` call if absent from config.

### 4.2 Change-detection strategies

Supported strategies (verified: `plugins/source-api-poll/src/index.ts`, `ChangeStrategy` type and `hasChanged` function):

| Strategy      | Semantics                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `text-diff`   | Compare raw response body strings. This is the **default** when no strategy is specified or the value is unrecognized.                     |
| `json-diff`   | Parse both bodies as JSON, recursively sort object keys, then compare serialized strings. Ignores key ordering and whitespace differences. |
| `status-code` | Compare only HTTP status codes; body changes are ignored.                                                                                  |

If `json-diff` parsing fails for either body, the implementation falls back to raw text comparison (verified: `plugins/source-api-poll/src/index.ts` lines 96–101).

### 4.3 Authentication

Auth is configured via the `auth.type` field.

**Bearer:** resolves the token from `auth.token` first, then from `process.env[auth['token-env']]`. If neither yields a value, `resolveAuth` throws:

> `Bearer auth requires a token. Set the <VAR> environment variable or add auth.token to your monitor's scope config.`

(Verified: `plugins/source-api-poll/src/index.ts` lines 52–59.)

**Basic:** uses `auth.username` and `auth.password` (both default to empty string if absent), Base64-encodes `username:password`, and sets `Authorization: Basic <encoded>`.

### 4.4 Observation identity

When a change is detected, the source emits one observation (verified: `plugins/source-api-poll/src/index.ts` lines 175–196):

- `title`: `"API response changed: <url>"`
- `summary`: `"API response changed: <url>"`
- `payload`: `{ url, status, strategy, body }`
- `snapshotText`: response body as a string (always set; no binary check)
- `objectKey`: `<url>`
- `queryScope`: `{ url: <url> }`
- `snapshot`: `{ url, status, bodyLength, strategy }`

This treats the polled URL as the source-defined object identity (SP3).

**Note:** Unlike `file-fingerprint`, `api-poll` always sets `snapshotText` to the response body without a binary check. The `snapshot` field records `bodyLength` and `strategy` rather than full body content.

### 4.5 Stateful behavior

`api-poll` declares `stateful: true`. The first call fetches the URL, stores `{ body, status }` as `nextState`, and returns an empty `observations` array. Subsequent calls compare against `context.previousState` and emit an observation only when `hasChanged` returns `true`.

## 5. Bundled Source: `schedule`

Source name: `"schedule"` (verified: `plugins/source-schedule/src/index.ts` line 47).

### 5.1 Scope

```yaml
watch:
  type: schedule
  cron: '0 9 * * 1-5'
  timezone: America/Los_Angeles
  label: Daily review
```

Required field: `cron` (string). Optional fields: `timezone` (string), `label` (string).

### 5.2 Behavior

The `schedule` source does **not** declare `stateful`, so it defaults to stateless.

The source does not decide when it is due — that is the runtime's responsibility. Whenever `observe()` is called, it emits **exactly one observation** (verified: `plugins/source-schedule/src/index.ts` lines 59–77):

- `title` and `summary`: `label` if provided, otherwise `"Scheduled trigger: <cron>"`
- `payload`: `{ cron, timezone: timezone ?? 'UTC' }`
- `objectKey`: `<cron>`
- `queryScope`: `{ cron: <cron>, timezone: <resolved-timezone> }`
- `snapshot`: `{ cron, timezone: <resolved-timezone>, triggeredAt: context.now.toISOString() }`

`timezone` resolves to `'UTC'` when not provided in config. There is no IANA timezone validation in the plugin itself — the scheduling engine owns timezone interpretation.

## 6. Bundled Source: `incoming-changes`

Source name: `"incoming-changes"` (verified: `plugins/source-incoming-changes/src/index.ts`).

Package: `@agentmonitors/source-incoming-changes`. Registered via `registerCoreSources` and available as an `agentmonitors init --type incoming-changes` template (issue #39).

### 6.1 Scope

```yaml
watch:
  type: incoming-changes
  paths:
    - 'src/'
    - 'lib/'
  branch: main # optional — defaults to HEAD
  cwd: /repo/root # optional — defaults to process.cwd()
```

Required field: `paths` (array of strings — path prefixes or globs passed to `git diff -- <paths>`). Optional fields: `branch` (string, git ref to resolve; defaults to `HEAD`), `cwd` (string, repository working directory for all git calls).

### 6.2 Behavior

`incoming-changes` is `stateful: true`. The first call resolves the current commit SHA via `git rev-parse`, stores it as `nextState: { ref: '<sha>' }`, and returns an empty `observations` array — this is the baseline run; it does **not** report the existing tree as changed.

On subsequent calls, the source:

1. Resolves the current commit SHA.
2. Diffs `<previousRef>..<currentRef>` with `git diff -z --name-status -c core.quotePath=false -- <paths>` (NUL-delimited, no C-quoting of non-ASCII paths).
3. Emits one `Observation` per changed file:
   - `objectKey`: the file path (relative, as reported by git)
   - `changeKind`: `created` (status `A` or `C`), `modified` (status `M`, `R`, `T`), or `deleted` (status `D`)
   - `title`/`summary`: `"Incoming change: <path> (<changeKind>)"`
   - `payload`: `{ path, status, fromRef, toRef }`
   - `queryScope`: `{ path: <file-path> }`
   - `snapshotText`: new file content (via `git show <toRef>:<path>`) for `created`/`modified` when the file is text (not binary); absent for `deleted` and binary files
4. Returns `nextState: { ref: currentRef }`.

### 6.3 Resumption token and restart-safety

The resumption token is the last-seen commit SHA. If the daemon is offline across multiple commits, the next `observe()` call diffs from the stored SHA to the current HEAD — the net diff across all missed commits is reported in a single batch. This is deliberate (PP6).

### 6.4 v1 scope boundary

`incoming-changes` v1 fires on **any** ref advance touching `paths` — a pull, merge, fast-forward, or a local commit. Filtering to "only others' changes / only on fetch-merge" is a planned later refinement, not v1. A non-fast-forward advance (rebase, force-push) yields a meaningful net `git diff <prev>..<current>` and will not crash.

### 6.5 Error resilience

- If `git rev-parse` fails (not a git repo, unknown branch, option-injection guard triggered), `observe()` returns `{ observations: [] }` with no `nextState` — it silently waits for the repo/branch to become valid.
- If `git diff` fails (e.g., the stored SHA was gc'd or history-rewritten), `observe()` re-baselines: it returns `{ observations: [], nextState: { ref: currentRef } }` and starts fresh from the current ref.
- `git show` failures (per-file snapshot fetch) are silenced and result in `snapshotText` being absent; the observation is still emitted.

These guards ensure a source error does not propagate to the runtime tick loop.

## 7. Source Registry, Validation, and Schema Generation

### 7.1 SourceRegistry

`SourceRegistry` (exported from `@agentmonitors/core`, verified: `libs/core/src/observation/registry.ts`) is an in-memory registry of source plugins. It exposes:

| Method     | Signature                                        | Behavior                                                                                    |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `register` | `(source: ObservationSource): void`              | Adds the source. **Throws** `Error` if a source with the same `name` is already registered. |
| `get`      | `(name: string): ObservationSource \| undefined` | Returns the source or `undefined` if not found.                                             |
| `has`      | `(name: string): boolean`                        | Returns whether a source with that name is registered.                                      |
| `list`     | `(): ObservationSource[]`                        | Returns all registered sources as an array.                                                 |
| `names`    | `(): string[]`                                   | Returns all registered source names as an array.                                            |

At startup the CLI registers only the bundled sources (via `registerCoreSources`,
`apps/cli/src/sources.ts`); the registry then holds those resolved plugins. Third-party plugin
**discovery and installation are not implemented** — the `source install`/`update`/`remove`/`search`
commands are placeholders that print a manual-install hint (NP3). See §8.

### 7.2 Schema generation

`generateMonitorSchema(sources: ObservationSource[]): JsonSchema` (exported from `@agentmonitors/core`, verified: `libs/core/src/observation/schema-generator.ts`) composes a full JSON Schema from all registered sources' `scopeSchema` fragments.

The generated schema:

- Uses `$schema: 'http://json-schema.org/draft-07/schema#'`
- Declares top-level required fields: `watch`, `urgency`
- Requires `watch.type` and constrains it to the enum of registered source names
- Uses `allOf` with `if/then` conditionals (each `if` requiring `watch.type`) to enforce the correct per-source config shape inside `watch:` for each `type` value
- Validates the `notify` field with a `oneOf` covering `debounce` (requires `settle-for`) and `throttle` (requires `suppress-for`)
- Accepts an optional `tags` array of strings

### 7.3 Validation gap (current vs. target)

The current CLI validation command checks required source scope fields but does not yet enforce full per-source JSON Schema validation against the generated schema. This gap is documented in [004-validation-testing.md](./004-validation-testing.md).

## 8. Plugin Discovery and Installation Notes

The CLI exposes `source search`, `source install`, `source update`, and `source remove`, but those commands are currently placeholders. Therefore:

- Third-party source plugins remain a supported architectural concept.
- Plugin discovery and installation are **not yet implemented** CLI workflows.

This is an explicit non-property of the current product (NP3).

## 9. Examples

### 9.1 File watcher example

```yaml
watch:
  type: file-fingerprint
  globs:
    - 'src/**/*.ts'
  cwd: /workspace
```

**What this example proves:** `file-fingerprint` scope is file-system oriented; `cwd` changes where glob patterns are resolved (passed as the `cwd` option to `globSync`), while `objectKey` and `queryScope.filePath` always use the absolute file path regardless of `cwd`.

### 9.2 Status-code-only API watcher

```yaml
watch:
  type: api-poll
  url: 'https://api.example.com/health'
  change-detection:
    strategy: status-code
```

**What this example proves:** Body changes alone do not trigger this monitor when `strategy: status-code` is set. Object identity is still the URL even when change detection narrows what counts as a change.

### 9.3 Schedule source with label

```yaml
watch:
  type: schedule
  cron: '0 9 * * 1-5'
  timezone: America/New_York
  label: Morning standup reminder
```

**What this example proves:** When `label` is provided, the observation `title` and `summary` use the label rather than the cron expression. `objectKey` is always the cron string, not the label.

## 10. Validation Implications

Source-level tests SHOULD verify:

- Stateful sources (`file-fingerprint`, `api-poll`, `incoming-changes`) return no observations on the first baseline run and return observations on subsequent runs when changes occur.
- Different source configurations do not share baseline state accidentally (state is keyed per monitor instance, not per source name).
- `json-diff` ignores irrelevant JSON key ordering and whitespace differences between responses.
- `status-code` ignores body-only changes.
- Schedule observations are emitted whenever the runtime calls `observe()`, regardless of whether the cron expression would have fired at `context.now`.
- Source errors are surfaced clearly for invalid required config: missing `globs`, missing `url`, or unresolved bearer token (see §4.3 for the exact error message format); missing `paths` for `incoming-changes`.
- `incoming-changes` emits no observations on the baseline run; subsequent runs report net changes since the stored ref; a gc'd or force-pushed ref triggers a silent re-baseline.
- `file-fingerprint` includes `snapshotText` for text files and omits it for binary files (files containing null bytes).

## 11. Bundled Source: `command-poll`

> **Status: current — shipped** (PP7). The source proposed in issue
> [#81](https://github.com/mike-north/AgentMonitors/issues/81) — the local-process sibling of
> `api-poll` — is implemented as the bundled package `@agentmonitors/source-command-poll`. It runs a
> configured command on the tick loop, captures the result, and reports change using snapshot-diff
> strategies. Verified: `plugins/source-command-poll/src/index.ts` (source) and
> `plugins/source-command-poll/src/index.test.ts` (the §11.7 validation list); registered via
> `registerCoreSources` (`apps/cli/src/sources.ts`) with an `init --type command-poll` template
> (`apps/cli/src/commands/init.ts`), covered by `apps/cli/src/commands/cli.integration.test.ts`.

`command-poll` exists so that any CLI-backed system (`git`, `gh`, `kubectl`, build tools, task
managers) can be monitored purely through `MONITOR.md` config, with **zero domain-specific source
code in this repo** (non-goal reaffirmed from #81). The driving example is a local productivity CLI
(`ofocus today --json`), but nothing below is specific to it.

### 11.1 Scope

```yaml
watch:
  type: command-poll
  command: ['ofocus', 'today', '--json'] # argv array — REQUIRED
  interval: 5m
  cwd: /optional/working/dir
  env: # optional literal additions/overrides
    NO_COLOR: '1'
  timeout: 30s
  key: ofocus-today # optional objectKey override
  change-detection:
    strategy: json-diff
```

| Field                           | Type             | Required | Default                  | Description                                                                      |
| ------------------------------- | ---------------- | -------- | ------------------------ | -------------------------------------------------------------------------------- |
| `command`                       | `string[]`       | Yes      | —                        | Argv array; `command[0]` is the executable (resolved via `PATH`). `minItems: 1`. |
| `interval`                      | duration string  | No       | runtime default          | Poll cadence hint; owned by the scheduling engine, same as `api-poll`.           |
| `cwd`                           | `string`         | No       | daemon working directory | Working directory for the child process.                                         |
| `env`                           | `object<string>` | No       | `{}`                     | Literal env vars merged over the inherited daemon environment.                   |
| `timeout`                       | duration string  | No       | `30s`                    | Wall-clock limit; expiry is an **execution failure** (§11.5).                    |
| `key`                           | `string`         | No       | joined argv              | Overrides the observation `objectKey` (§11.4).                                   |
| `change-detection.strategy`     | enum             | No       | `text-diff`              | `text-diff` \| `json-diff` \| `exit-code` (§11.3).                               |
| `change-detection.ignore-paths` | `string[]`       | No       | `[]`                     | Plain `json-diff` paths removed before comparison (§11.3).                       |

**`command` MUST be an argv array; a shell string form MUST NOT be accepted.** The child is spawned
directly (`execFile` semantics, `shell: false`): there is no word-splitting, globbing, quoting, or
injection surface, and what executes is exactly what the author wrote, token for token. This is the
decision for #81's first open question; a `sh -c` convenience form is rejected — an author who needs
shell features writes them into a script and polls the script.

**`env` is merged over the inherited daemon environment** (decision for #81's second open
question). Restricting the inherited environment adds hygiene, not security — the command runs as
the same user the daemon does, and an author who can write `MONITOR.md` can already run anything
that user can — so v1 does not pay the usability cost of an allow-list. Secrets reach the command
the same way `api-poll`'s `auth.token-env` does: via the daemon's environment, never inline in
`MONITOR.md`. `env` **values MUST NOT be persisted** in any observation `payload`, `snapshot`, or
runtime state row.

### 11.2 Execution model

One execution per due tick (`observe()` only — no `watch()` in v1, per #81): spawn `command` with
`cwd`/`env`, capture `stdout`, `stderr`, and the exit code, enforcing `timeout` (SIGTERM at expiry,
SIGKILL after a 5s grace). `stdout` capture is capped at **1 MiB**; output beyond the cap is
discarded and the result is marked `truncated: true` (a truncated result still diffs — but see the
validation note in §11.7).

The **result** of an execution is `(exitCode, stdout)`. A **nonzero exit code with output is a
valid result, not a failure** — many CLIs exit nonzero meaningfully (`grep`, linters, a task CLI
whose backing app is closed). The failure category is reserved for executions that produce no
result at all (§11.5).

### 11.3 Change-detection strategies

Mirrors `api-poll` (§4.2), substituting the local-process equivalents:

| Strategy    | Compares                                                                                 | Default |
| ----------- | ---------------------------------------------------------------------------------------- | ------- |
| `text-diff` | Raw `stdout` strings                                                                     | Yes     |
| `json-diff` | `stdout` parsed as JSON, key-order/whitespace-insensitive (same algorithm as `api-poll`) |         |
| `exit-code` | Exit codes only; `stdout` changes are ignored                                            |         |

`json-diff` falls back to raw text comparison when either side fails to parse, identical to
`api-poll`. `exit-code` is first-class in v1 (decision for #81's fourth open question); the broader
"predicate over the result" generalization is explicitly deferred — if it lands later, `exit-code`
becomes sugar for one such predicate, which is a compatible evolution.

Plain `json-diff` MAY set top-level `change-detection.ignore-paths` to remove noisy fields before
comparison, e.g. `ignore-paths: ['duration']` or `ignore-paths: ['$.duration']`. Paths use the same
minimal dotted grammar as §12 keyed-collection ignore paths: an explicit root (`$.field`) or bare
root-relative form (`field`), with no wildcards, array indices, filters, or recursive descent.
Top-level `ignore-paths` is valid only with `strategy: json-diff`; unknown `change-detection` keys
are validation errors so misplaced or misspelled options do not silently no-op.

`stderr` is never diffed; it is captured solely for failure diagnostics (§11.5).

### 11.4 Observation identity and stateful behavior

Mirrors `api-poll` (§4.4–4.5):

- `title` / `summary`: `"Command output changed: <objectKey>"`
- `objectKey`: the `key` field if set, otherwise the argv joined with single spaces
  (`ofocus today --json`)
- `payload`: `{ command, exitCode, strategy, stdout, truncated }` — **never `env`**
- `snapshotText`: captured `stdout`
- `queryScope`: `{ command: <objectKey> }`
- `snapshot`: `{ command, exitCode, stdoutLength, strategy }`
- `changeKind`: `modified` (the observed object is the command's result; it is never created or
  destroyed in v1 — per-item lifecycle arrives with keyed collections, §12)

`command-poll` declares `stateful: true` (PP6). The first successful execution stores
`{ stdout, exitCode }` as `nextState` and emits nothing; subsequent executions diff against
`context.previousState` under the configured strategy.

### 11.5 Failure semantics (fail-open as a health signal)

An **execution failure** is: spawn failure (`ENOENT`, `EACCES`, …) or `timeout` expiry. Per #81's
framing, a failure is information, not something to silently swallow — but it must not spam.

- On failure, prior state is **kept** (no re-baseline, no state loss) — identical in spirit to how
  `api-poll` treats an unreachable endpoint and `incoming-changes` treats a broken repo (§6.5).
- The source tracks `health: 'ok' | 'failing'` in its state and emits an observation only on the
  **transition edge**, not on every failing tick:
  - `ok → failing` (or first-ever run fails): one observation, `title:
"Command failing: <objectKey>"`, `payload: { command, error, stderrTail }`.
  - `failing → ok`: one observation, `title: "Command recovered: <objectKey>"`. If the recovery
    result also differs from the pre-failure baseline under the configured strategy, the ordinary
    output-changed observation is emitted **as well** (two observations on that tick).
- A failing first run establishes **no baseline**; the first successful run after it baselines
  silently as usual.

**What this rule buys:** a tool that is closed for three hours produces exactly two signals
(failing, recovered) rather than 36 failure events at a 5-minute interval — and cannot mask the
output change that happened while it was down.

### 11.6 Trust model for local execution

Running an arbitrary local command is a higher-trust action than an HTTP GET (#81's third open
question). The decision is in two parts:

**v1 (normative):** `command-poll` executes without an interactive acknowledgment step. A
`MONITOR.md` is workspace-resident configuration in the same trust class as `package.json` scripts,
git hooks, or `.claude` hooks: anyone who can write it into the workspace can already achieve
arbitrary execution through those channels, and the daemon already scopes evaluation to the
workspace it was started for. Adding a prompt here would be security theater that taxes the
legitimate path.

**Target (designed, deferred):** a **command-acknowledgment ledger** for hosts that want explicit
gating. Sketch: the runtime computes `commandFingerprint = hash(argv ‖ cwd ‖ env-keys)`; a monitor
whose fingerprint is not in the persisted ledger does not execute — it surfaces as `blocked:
awaiting-acknowledgment` in `scan`/`status` output, and an explicit CLI act
(`agentmonitors monitor approve <id>`) records the fingerprint. Any edit that changes the
fingerprint re-blocks. This composes with v1 (an empty-ledger-means-allow default preserves v1
behavior) and is the right shape **if** multi-tenant or untrusted-workspace hosting ever matters.
It is not scheduled; it exists here so the v1 decision is visibly a decision, not an omission.

### 11.7 Validation implications

Source-level tests verify, beyond the §10 generic items (verified:
`plugins/source-command-poll/src/index.test.ts` unless noted; the acceptance-criterion labels are
issue #86's AC1–AC7):

- A shell-metacharacter argv element (`['echo', '$(whoami); rm -rf /tmp/x']`) is passed through as a
  **literal argument** — the output contains the metacharacters verbatim, proving no shell is
  involved (AC1: _"passes shell metacharacters through as a literal argument"_).
- Baseline run emits nothing; an output change under each strategy emits exactly one observation;
  `exit-code` ignores stdout-only changes; `json-diff` ignores key reordering (AC2: the
  _"baseline and change-detection strategies"_ describe block).
- Top-level `change-detection.ignore-paths` removes noisy fields before plain `json-diff`
  comparison, and unrelated stable-field changes still fire (AC2: _"json-diff: top-level
  ignore-paths removes noisy fields before comparison"_).
- A nonzero-exit result with changed output **is** diffed and reported (nonzero ≠ failure) (AC3:
  _"reports a changed nonzero-exit output as an observation"_).
- Spawn failure and timeout each: keep prior state, emit exactly one `ok → failing` observation, stay
  silent on subsequent failing ticks, and emit `failing → ok` on recovery (AC4: the
  _"transition-edge failure semantics"_ describe block).
- `env` values appear in the child's environment and in **no** persisted artifact (payload, snapshot,
  state row) (AC5: _"passes env to the child but excludes the env config from all persisted
  artifacts"_).
- Output exceeding the 1 MiB cap sets `truncated: true` and still produces stable diffs (two
  truncated captures of identical leading content do not report change) (AC6: _"marks truncated and
  produces stable diffs across identical leading content"_).
- `timeout` kills a hung child within the grace period and leaves no orphan process (AC6: _"a
  timed-out child leaves no orphan (killed within the grace window)"_, mirroring the daemon-test
  no-orphan discipline).
- Registration + the `init --type command-poll` template + `validate` accepting/rejecting a
  `command-poll` monitor are covered at the CLI layer (AC7: verified:
  `apps/cli/src/commands/cli.integration.test.ts` — _"scaffolds a command-poll monitor that passes
  validate"_, _"rejects a command-poll monitor missing `command`"_, _"accepts a well-formed
  command-poll monitor"_, _"rejects unknown command-poll change-detection keys"_).

### 11.8 Non-goals (v1)

- No domain-specific source code (OmniFocus, git, gh, …) in this repo — those are `MONITOR.md`
  consumers of `command-poll`.
- No `watch()` (long-lived `--watch`-style child); `observe()` per tick only.
- No mtime/file-based "did anything change?" pre-gate, and no monitor chaining as a polling
  optimization — both rejected in #81 with reasoning this spec adopts: the gate signal is over-broad
  (backing files are touched by sync/housekeeping, not just relevant edits), the content diff still
  does the real suppression work, and dependency edges between monitors contradict the
  independent-monitors model (PP3). The principled cost optimization, if poll cost ever bites, is
  the cursor protocol (§13).

## 12. Keyed-Collection Change Detection

> **Status: current — shipped** (PP7). The generic companion to §11 applies equally to `api-poll`
> and `command-poll`. The per-object diff is implemented **once** as a shared, exported core helper
> (verified: `libs/core/src/observation/keyed-collection.ts`, exported from
> `libs/core/src/index.ts`) and consumed by **both** sources (verified:
> `plugins/source-api-poll/src/index.ts`, `plugins/source-command-poll/src/index.ts`) — the
> create/modified/descoped semantics are identical across the two, so sharing avoids divergence.
> Proven by `libs/core/src/observation/keyed-collection.test.ts` (the §12 semantics), per-source
> integration tests in each plugin's `index.test.ts`, and the `validate` BP3-rejection tests in
> `apps/cli/src/commands/cli.integration.test.ts`.

A third `change-detection` mode treating output as a **collection of keyed objects** rather than
one blob:

```yaml
change-detection:
  strategy: json-diff
  collection:
    path: '$.tasks' # where the array lives in the parsed output
    key: 'id' # field whose value is the per-object identity
    ignore-paths: ['$.fetchedAt'] # optional: paths excluded before comparison
```

Semantics:

- The output is parsed (JSON in v1; the `collection` block is invalid under `text-diff`/`exit-code`
  and MUST be rejected by scope validation).
- Each element of the array at `path` becomes a tracked object with
  `objectKey = <monitor-objectKey>#<key-value>`.
- Per-object observations are emitted with the existing `ChangeKind` vocabulary (§2.3): `created`
  (key appears), `modified` (key present in both, content differs after `ignore-paths` removal),
  `descoped` (key disappears from the output — the upstream object may well still exist; the
  collection no longer contains it, which is precisely `descoped`, not `deleted`).
- The baseline rule is unchanged: the first run records the keyed snapshot and emits nothing.
- Reordering of elements and whitespace are inherently ignored (comparison is per-key, not
  positional).

**What this buys (the #81 motivating case):** "three tasks became overdue" lands as three precise
`modified` observations with stable per-task `objectKey`s — instead of one opaque "output changed"
blob — and a re-sorted list produces zero observations.

**`path` syntax (resolved).** `path` is a **minimal `$.`-prefixed dotted path**: a root `$`
followed by `.field` segments (`$.tasks`, `$.data.items`). There are no wildcards, array indices,
filters, or recursive descent — deliberately the smallest grammar that keeps the §12 examples valid.
`path` MUST select exactly **one array**; a path that resolves to a non-array (or to nothing) is an
error (surfaced at observe time with a precise message naming the path). `ignore-paths` entries use
the same dotted syntax and address fields **within each element** (relative to the element root,
e.g. `$.fetchedAt`). The keyed-collection `collection` block is only valid under `strategy:
json-diff`; under `text-diff`/`exit-code` (or a defaulted/absent strategy) it is rejected by
`agentmonitors validate` with `change-detection.collection requires strategy: json-diff` (BP3 —
authoring-time error).

Validation note: each element's `key` value must be a scalar (string/number/boolean) and unique
within the collection; a missing or non-scalar key, or a duplicate key value, is an error.

## 13. Target: Caller-Held Cursor Protocol

> **Status: target — sketch only.** Adopted from #81 as the principled optimization **if** poll
> cost ever measurably bites; explicitly not v1, and not a prerequisite for §11 or §12.

Rather than caching output or gating on file mtimes, a poll source threads a **caller-held cursor**
through the command: a `{{state}}` placeholder is templated into the argv, and a `next-state` value
is extracted from the output:

```yaml
watch:
  type: command-poll
  command: ['ofocus', 'changes', '--since', '{{state}}', '--json']
  cursor:
    initial: '0'
    next-state: '$.cursor' # extracted from the parsed output after each run
```

This generalizes the stateful baseline the sources already keep (PP6): the cursor lives in the same
per-monitor `nextState` slot, the polled tool stays stateless (it merely answers "what changed since
`<cursor>`?" — `git <cursor>..HEAD`, `kubectl --resource-version`, a task CLI's change generation),
and change detection stays where the data lives **without** hidden cross-invocation state inside the
tool. Sequencing (from #81): ship §11 first, measure, and design this fully only against observed
poll cost.
