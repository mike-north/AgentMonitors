# 003 — Source Plugins

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md), [002-runtime-delivery.md](./002-runtime-delivery.md)
> **Covers:** source contract, bundled sources, current limitations, plugin-discovery notes, and target change-detection capabilities

## 1. Overview

This document specifies the contract implemented by observation source plugins and the current behavior of the bundled sources: `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes`. The runtime depends on sources to detect change, but the runtime owns scheduling, notify dispatch, and delivery timing (PP3).

Section §13 (the cursor protocol) remains a normative **target** rule that is not yet implemented; it moves to current status, with `verified:` references, when it ships. §2.5 (snapshots-not-diffs) and §2.6 (composite observation) have shipped and are now **current** behavior (verified below in each section). §11 (`command-poll`) and §12 (keyed-collection change detection) have shipped and are now **current** behavior (verified: `plugins/source-command-poll/src/index.ts`, `plugins/source-command-poll/src/index.test.ts`; the shared helper `libs/core/src/observation/keyed-collection.ts` with `libs/core/src/observation/keyed-collection.test.ts`, consumed by both `plugins/source-api-poll/src/index.ts` and `plugins/source-command-poll/src/index.ts`).

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
- `context.workspacePath?: string` — runtime workspace/config root for project monitor evaluation.
  File-system-oriented sources use this to resolve project-relative scope without depending on the
  daemon process cwd. For user-level monitors using absolute or home-relative globs,
  `workspacePath` is `null`; the source MUST NOT use the daemon process `cwd` as a fallback for
  glob resolution. The full sigil-based glob scope rules are in [§3.5](#35-glob-scope-resolution-sigil-based-syntax-for-user-level-monitors-target).
- `context.signal?: AbortSignal` — supplied to `watch()` only; the runtime aborts it to tear the watcher down (daemon shutdown, monitor removal). A `watch()` implementation **SHOULD** stop yielding and release resources when it fires. Unused by `observe()`.

### 2.3 Observation result

`observe()` returns an `ObservationResult`:

- `observations: Observation[]` — zero or more source observations.
- `nextState?: unknown` — optional source-owned persisted state to use in the next cycle.
- `outcome?: "rebaselined" | "no-files-matched"` — optional diagnostic for a zero-observation run
  that is meaningfully different from ordinary `no-change`. The runtime records it in
  `observation_history` only when the source returned zero observations and emitted nothing.

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
| `salience`     | `Urgency?`                            | Source-classified per-observation salience (`low` \| `normal` \| `high`).  |
| `snapshot`     | `unknown?`                            | Point-in-time snapshot metadata captured at fire time.                     |

`ChangeKind` is a **source-agnostic** vocabulary so consumers reason about change uniformly across
sources: `created` (object entered scope), `modified` (changed while in scope), `deleted` (destroyed
upstream — **information lost**), `descoped` (still exists upstream but **left the monitor's scope** —
no information lost). `deleted` and `descoped` are deliberately distinct (e.g., a pull request
_deleted_ vs _closed_ while watching open PRs). When an observation sets `changeKind`, the runtime
copies it into the materialized event's `queryScope.changeKind` so it is filterable without each
source populating `queryScope` itself (see [002 §5.1](./002-runtime-delivery.md)). Verified:
`libs/core/src/observation/types.ts`, `libs/core/src/runtime/service.ts`.

Observation `salience` is the source's per-observation **domain judgment** of how interrupt-worthy
_this_ observation is — a domain observation (PP3), not runtime reasoning. It is deliberately named
`salience`, **not** `urgency`: `urgency` stays the monitor-level policy knob authored in `MONITOR.md`.

The runtime does **not** let a source set urgency directly. Instead it resolves the _effective_
urgency by clamping `salience` into the monitor's authored `urgency` **band** `lo..hi` (see
[001 §3.2](./001-monitor-definition.md)):
`effective = clamp(salience ?? band.lo, band.lo, band.hi)`. So a source can escalate a single
observation only **within** the band the author granted, and a `salience` outside the band is clamped
to the nearest bound. A monitor authored with a bare scalar `urgency` (the degenerate band `x..x`) can
never be escalated, so adding `salience` is always safe and backward compatible. The notify-timing and
event-materialization consequences are specified in
[002 §4.1](./002-runtime-delivery.md) and [002 §5.1](./002-runtime-delivery.md). Verified:
`libs/core/src/observation/types.ts`, `libs/core/src/runtime/service.ts`.

### 2.4 Stateful sources

If `stateful` is `true`, the first successful `observe()` call **MAY** return an empty `observations` array while storing an initial baseline in `nextState`. That is not an error case — it is how baseline-then-detect sources work (PP6). On subsequent calls, the stored state is available via `context.previousState`.

`file-fingerprint`, `api-poll`, `command-poll`, and `incoming-changes` all declare `stateful: true`. `schedule` does not declare `stateful` (defaults to `false`).

### 2.5 Sources return snapshots, not diffs; the runtime is the sole diff producer

> **Status: current.** This makes explicit, in the source contract, the division of labor already
> required by PP3 and AP3 ([000](./000-principles.md)) and implemented by the runtime's object-level
> diff ([002 §5.2](./002-runtime-delivery.md)). The rule is restated here so a plugin author reads it
> where they author a source. Formalizes a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S4; ledger rows C2, C6, C43). Verified: the contract is documented on the `Observation` /
> `ObservationResult` types (`libs/core/src/observation/types.ts`); a bundled source returns
> current-state snapshots while the runtime computes the delivery diff against its own stored
> baseline — proven end-to-end by `plugins/source-file-fingerprint/src/index.test.ts` (the
> "snapshots-not-diffs (003 §2.5)" block: the source's observation is the full current file content
> with no diff field, and the runtime — not the source — materializes the `diffText`) and
> `libs/core/src/runtime/service.test.ts` ("computes a diff against the prior snapshot").

A source **observes current state**; it does **not** compute deltas for delivery. Concretely:

- A source's job is to acquire the **current** state of the watched thing and return it as
  observations — including a `snapshotText` (and/or `snapshot` metadata) capturing _what the thing
  is now_ — together with **its own change-detection state** via `nextState` (e.g. file fingerprints,
  the last API body, a last-seen commit SHA). The `nextState` a source carries is the source's
  _internal_ mechanism for noticing _that_ something changed since it last looked; it is **not** the
  per-recipient baseline used to compute _what is new for a given consumer_.
- The **runtime is the sole producer of the diff that drives delivery.** It owns diffing,
  parameterized by **the consumer's baseline** — today the latest stored object snapshot for
  `(workspacePath, monitorId, objectKey)` ([002 §5.2](./002-runtime-delivery.md), SP5); under the
  target pipeline model, the **per-recipient** baseline/cursor right of the shared/per-recipient seam
  ([002 §1.1.2](./002-runtime-delivery.md#112-the-shared--per-recipient-seam)). A source MUST NOT
  attempt to compute "what is new for recipient X" — it cannot, because it does not hold any
  recipient's baseline.

This split is what lets one shared observation fan out to many recipients with divergent baselines
(capability C15): the source observes once; the runtime diffs that one shared snapshot against each
consumer's baseline.

> **Why a source still carries `nextState`.** Holding change-detection state in the source (the
> `stateful` baseline of §2.4) is **not** the same as the source producing the delivery diff. The
> source uses `nextState` only to decide _whether to emit an observation at all_ and to advance its
> own cursor; the meaning of "new" relative to a **consumer** is always the runtime's to compute. A
> source that emits a fully formed delta packet (and lets the runtime pass it through untouched) is
> outside this contract.

**Validation implication.** A source whose `observe()` returns pre-diffed "what changed for the
consumer" packets instead of current-state snapshots violates this rule; the bundled sources
(`file-fingerprint`, `api-poll`, `command-poll`, `incoming-changes`) all return current-state
snapshots plus `nextState`, and the runtime computes the delivered diff (see each source's
`index.test.ts` and [002 §5.2](./002-runtime-delivery.md)).

### 2.6 Composite observation (one observation from many source calls)

> **Status: current.** Formalizes a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S1, §S2 area A; ledger row C40). The bundled `api-poll` source assembles a composite observation
> via its `change-detection.composite` mode (verified: `plugins/source-api-poll/src/composite.ts` and
> the `parseCompositeConfig`/`renderCompositeSnapshot`/`buildCompositeObservation` helpers wired into
> `plugins/source-api-poll/src/index.ts`; proven by `plugins/source-api-poll/src/index.test.ts` — the
> "composite observation (003 §2.6)" block reduces N calls into one observation under one
> `objectKey`, renders a deterministic snapshot regardless of part-fetch ordering, and fails the
> whole observation on a failed underlying call; the "composite × runtime integration" block drives
> it through the real runtime, materializing one event per change under the one `objectKey` with the
> runtime computing the diff).

A single `Observation` **MAY** be assembled from **multiple** source queries or calls — many requests
reduced into **one composite whole-state snapshot** — before it leaves the source. This is the
**[Compose]** stage of the pipeline model ([002 §1.1.1](./002-runtime-delivery.md#111-the-locked-stage-order)),
which sits on the **shared** (left) side of the seam: the composition runs **once** per observation,
not per recipient.

Modeling rules:

- The composite is assembled **inside** `observe()` (or `watch()`): the source issues however many
  underlying queries it needs and returns the assembled whole as **one** `Observation`. The runtime
  sees a single observation and is unaware of the fan-in; no contract change is needed on the runtime
  side.
- The composite snapshot MUST present a **stable, deterministic** `snapshotText`/`snapshot` — the
  same underlying state assembled in the same way MUST render identically run-to-run, so the
  runtime's diff against the consumer's baseline ([§2.5](#25-sources-return-snapshots-not-diffs-the-runtime-is-the-sole-diff-producer))
  is meaningful rather than churned by call ordering or transient fields.
- The composite carries **one** `objectKey` identifying the assembled whole (the composite _is_ the
  observed object), not one per underlying call. A source that genuinely tracks many independent
  objects should instead emit many observations (or use keyed-collection change detection, §12) —
  composition is for assembling **one** logical snapshot from many calls, not for batching unrelated
  objects.
- Partial-failure policy is the source's concern: a source MAY treat a failed underlying call as a
  failed observation (no `nextState` advance, so the prior baseline is preserved per
  [002 §3](./002-runtime-delivery.md)) or as a degraded-but-valid composite, but it MUST NOT silently
  emit a composite that omits part of its declared whole without that omission being visible in the
  snapshot — otherwise the runtime would diff against an incomparable baseline.

> **Example (the C40 motivating case).** A source that must call an external API once per entity to
> reconstruct a whole document issues N calls within a single `observe()` and reduces them into one
> ordered, rendered `snapshotText` — the composite whole-body snapshot — under one `objectKey`. The
> runtime then diffs that one snapshot against the consumer's baseline exactly as it would a
> single-call snapshot.

The bundled `api-poll` source realizes this via a `change-detection.composite` block: one
`object-key` for the assembled whole plus a list of `parts` (each an `id` and a `url`). On each
`observe()` it fetches every part and renders them — **sorted by `id`** so completion order never
churns the snapshot — into one composite `snapshotText` under the one `object-key`:

```yaml
watch:
  type: api-poll
  interval: '5m'
  change-detection:
    composite:
      object-key: 'order-42' # the composite IS the object — one key for the whole
      title: 'Order 42'
      parts: # N underlying calls reduced into one snapshot
        - id: 'header'
          url: 'https://api.example.com/orders/42'
        - id: 'line-1'
          url: 'https://api.example.com/orders/42/lines/1'
        - id: 'line-2'
          url: 'https://api.example.com/orders/42/lines/2'
```

`change-detection.composite` and `change-detection.collection` (§12) are mutually exclusive:
composite assembles **one** whole from many calls, whereas keyed-collection tracks **many**
independent objects. A failed underlying call fails the whole observation (the source does not
advance its state, so the prior baseline is preserved per [002 §3](./002-runtime-delivery.md)),
rather than silently emitting a composite missing a part.

### 2.7 Sources surface raw facts; the runtime computes derived facts

> **Status: current (G15).** This section is **current** behavior. It draws the
> line between the **raw facts** a source surfaces and the **derived/relative facts** the runtime's
> Shape stage computes from them ([002 §1.1.4](./002-runtime-delivery.md#114-shape-deterministic-derived-facts)).
> It reaffirms, and does not contradict, the source/runtime split of §2.5 and PP3/AP3
> ([000](./000-principles.md)). Formalizes a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S2 area C, E8; ledger row **C41**).
>
> Verified: the runtime Shape stage (`libs/core/src/runtime/shape.ts`,
> `libs/core/src/runtime/shape-stage.ts`) computes the relative facts from a source's raw snapshot
> plus the injected `now`; `libs/core/src/runtime/shape-stage.test.ts` drives a source that surfaces a
> raw `deferUntil` timestamp (never a pre-computed "revealed" flag) and asserts the runtime derives
> `revealed` against `now`.

A source's job in this division of labor is to surface the **raw facts** — the observable primitives
of the watched thing — in its `snapshot`/`snapshotText`/`payload`. A source **MUST NOT** compute the
recipient-facing derived/relative facts ("past due", "stalled", "revealed", "urgent"); those are the
runtime Shape stage's job, computed once on the shared snapshot against the runtime-injected `now`.

Concretely:

- **Raw facts (source).** The source surfaces the underlying values a derived fact is computed from —
  a `due` timestamp, a `defer-until` timestamp, a `priority` field, the set of a project's child task
  states. It surfaces them **as observed**, without interpreting their relationship to the current
  time or to each other. A source MUST NOT bake the current wall-clock into the snapshot (e.g. emit a
  pre-computed "past due" flag), because that would (a) make the snapshot non-reproducible and churn
  the diff (§2.6), and (b) place a time-relative judgment — which depends on _when the runtime
  evaluates_, not on _what the source observed_ — on the wrong side of the contract.
- **Derived facts (runtime).** The runtime Shape stage computes the relative/aggregate facts from
  those raw facts plus the injected `now`
  ([002 §1.1.4](./002-runtime-delivery.md#114-shape-deterministic-derived-facts)). This is what keeps
  the derived fact deterministic, reproducible (a fixed `now` yields a fixed fact), and **shared**
  (one computation for all recipients).

The boundary is the same one §2.5 draws for diffs, applied to facts: the source observes _what is
true of the watched thing_; the runtime derives _what that means relative to now_ and _what is new for
a consumer_. A source that surfaces a stable `due` timestamp lets the runtime decide "past due" at
evaluation time; a source that emits a pre-computed "past due" flag has put runtime-time, runtime-`now`
reasoning inside the source — outside this contract.

> **Why this matters for the diff.** A pre-computed time-relative flag in the snapshot would flip from
> run to run purely because `now` advanced (a task silently crossing "due soon" with no underlying
> change), producing a phantom diff against the consumer's baseline. Surfacing the raw timestamp and
> deriving the fact in Shape — diffed only once it is rendered into the artifact
> ([002 §1.1.5](./002-runtime-delivery.md#115-shape-render-to-a-stable-artifact-then-diff-the-artifact))
> — makes the delta correspond to a real, meaningful change (the marker appearing in the rendered
> line).

**Validation implication.** A source whose snapshot embeds a time-relative or aggregate _derived_ fact
(rather than the raw inputs) violates this rule; the derived-fact computation belongs to the runtime
Shape stage. The motivating case is the E8 OmniFocus composite (§2.6): the source surfaces each task's
raw `due`/`defer-until`/`priority` and child states; the runtime derives `past due`/`due soon`/
`revealed`/`urgent`.

## 3. Bundled Source: `file-fingerprint`

Source name: `"file-fingerprint"` (verified: `plugins/source-file-fingerprint/src/index.ts` line 278).

### 3.1 Scope

```yaml
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
  ignore:
    - '**/generated-*.ts'
  cwd: /optional/base/path
  interval: 30s
  backend: auto # optional; auto | fs-events | watchman | inotify | kqueue | windows
```

Required field: `globs`. Optional fields: `ignore` (exclude glob string or array of exclude glob
strings), `cwd` (string), `interval` (duration string), `backend` (string; see §3.9 below).

> **TARGET** — The `backend` field and the watch-mode behavior described in §3.8–§3.10 are **target**
> behavior, not current. The current implementation of `file-fingerprint` uses `observe()` only
> (the polling path described in §3.2). Everything in §3.8–§3.10 is the intended post-implementation
> contract; it MUST be marked _current_ (with `verified:` references) when the feature ships.

`globs` accepts **either** a single pattern as a bare string **or** an array of patterns
(OR-ed together). The single-file/single-glob case is therefore the one-line form:

```yaml
watch:
  type: file-fingerprint
  globs: notes.md # equivalent to globs: ['notes.md']
```

Validated by `parseScopeConfig`, which normalizes the string form to a one-element array and
throws if `globs` is missing, is neither a string nor an array of strings, is an empty array, or
contains an empty pattern. Verified: `plugins/source-file-fingerprint/src/index.ts`
(`parseScopeConfig`) and `plugins/source-file-fingerprint/src/index.test.ts` ("globs string
shorthand").

For project monitors, the effective `cwd` defaults to the runtime workspace/config root
(`ObservationContext.workspacePath`), i.e. the project directory containing `.claude`. Relative
`globs` therefore match project files by default. A relative `cwd` resolves against that same root;
an absolute `cwd` and absolute glob patterns are honored as-is. When no workspace/config root is
supplied, the source falls back to Node/glob's process-cwd behavior.

`ignore` accepts **either** a single exclude pattern as a bare string **or** an array of exclude
patterns, mirroring `globs`. The single-exclude case is therefore:

```yaml
watch:
  type: file-fingerprint
  globs: '**/*.txt'
  ignore: '**/notified-*.txt' # equivalent to ignore: ['**/notified-*.txt']
```

`ignore` excludes files from the matched set after `globs` are expanded. A path that matches `globs`
but also matches any `ignore` pattern is omitted from the baseline and from later change detection.
Ignore patterns are resolved against the same base as `globs` (including relative `cwd`/workspace
resolution), and do not support gitignore negation semantics. Use `ignore` when a monitor's fired
action writes files that would otherwise match the watched glob; for example,
`globs: ['**/*.txt']` with `ignore: ['**/notified-*.txt']` lets the action write
`notified-<timestamp>.txt` without retriggering itself. Verified:
`plugins/source-file-fingerprint/src/index.ts` (`parseScopeConfig`, `observe`),
`plugins/source-file-fingerprint/src/index.test.ts` ("ignore exclude globs"), and
`plugins/source-file-fingerprint/src/schema-parity.test.ts` ("valid bare-string ignore exclude glob
(shorthand)").

`interval` is the per-monitor observe interval: the runtime calls `file-fingerprint` only when this
monitor is due. If omitted, the effective default is approximately `30s`. Authors tune it with
`watch.interval`; this is distinct from the daemon `--poll-ms` loop-wake interval, which controls
how often the daemon checks whether any monitor is due.

### 3.2 Behavior

The source expands each glob pattern using `globSync` with `absolute: true` and **`nodir: true`**,
then removes any paths matched by `ignore` (expanded with the same `nodir: true`). For each
remaining matched path, it confirms the path is not a directory before computing a SHA-256 hash
using Node.js `crypto.createHash('sha256')` — see below for why a second, stat-based check is
needed in addition to `nodir: true`.

**Directory entries are excluded from the matched set, via two layers.** A globstar pattern such as
`docs/**` matches the directory entry `docs/` itself, in addition to every path under it — this is
`glob`'s documented globstar behavior, not a bug in the pattern. Without any filtering, the source
would attempt to `fs.readFile` that directory entry and crash with `EISDIR`. The first layer,
`nodir: true`, filters plain directory entries out at glob-expansion time, so `docs/**` behaves as
"every file under `docs/`, recursively" — the natural reading of the pattern — for the common case.
This applies identically to `ignore` patterns. However, `nodir` is `lstat`-based: a symlink whose
target is a directory (e.g. `docs/generated -> ../build/docs`) reports as a symlink, not a
directory, so it survives `nodir` and would still reach `fs.readFile` and crash with the same
`EISDIR`. The second layer, a `stat`-based (i.e. symlink-following) directory check, runs
immediately before hashing each surviving path and skips it if the real target is a directory. Only
with both layers does the source never crash with `EISDIR` on a directory-shaped glob match.
Verified: `plugins/source-file-fingerprint/src/index.ts` (`expandGlob` for the `nodir` layer;
`isDirectory` for the follow-symlink layer) and `plugins/source-file-fingerprint/src/index.test.ts`,
describe block "directory entries in glob matches (issue #377)" — tests "fingerprints only files
under docs/\*\*, never the directory itself", "ignores directory entries matched by an ignore glob
the same way", and "skips a symlink whose target is a directory, without crashing".

If a run matches zero files — including a glob that matches **only** directory entries, e.g.
`empty-dir/**` on a directory with no files in it — the source returns no observations and sets
`ObservationResult.outcome: "no-files-matched"`. This is a healthy, non-error outcome: the runtime
records it as a distinct `observation_history` outcome instead of ordinary `no-change`, so CLI
diagnostics can distinguish a broken glob/cwd from a matched file set with no content changes. Where
the CLI surfaces this outcome (`agentmonitors monitor test`), the message names the configured
`watch.globs` value so an author can tell "the glob matched nothing" from "the glob is fine but
nothing changed" without opening `MONITOR.md`. Verified: `apps/cli/src/commands/monitor-test.ts`
(`reportNoFilesMatched`, `formatGlobsForMessage`) and
`apps/cli/src/commands/cli.integration.test.ts` ("reports zero-match file-fingerprint scopes").

Current fingerprints are stored in `nextState.fingerprints` (a `Record<string, string>` keyed by absolute file path). On each call, the source compares each file's current hash against `context.previousState.fingerprints[filePath]`.

When a previously seen file's hash changes, the source emits one `Observation` per changed file (verified: `plugins/source-file-fingerprint/src/index.ts` lines 317–335):

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

### 3.4 Salience policy

`file-fingerprint` classifies a `deleted` observation as **`salience: 'high'`** because information
is permanently lost and an agent should react promptly. All other change kinds (`created`,
`modified`, `descoped`) carry **no `salience`** field (which the runtime treats as the band floor —
`salience ?? band.lo`). This means:

- A monitor authored with `urgency: normal..high` over a watched directory will receive a `high`-urgency
  delivery when a file is deleted and a `normal`-urgency delivery for any other change.
- A monitor authored with a bare scalar `urgency: normal` (the degenerate band `normal..normal`)
  is **never escalated** — the clamp formula preserves backward compatibility regardless of `salience`.

Verified: `plugins/source-file-fingerprint/src/index.ts` (`buildAbsentObservation`) and the
salience + end-to-end escalation tests in
`plugins/source-file-fingerprint/src/index.test.ts`.

### 3.5 Glob scope resolution: sigil-based syntax for user-level monitors (_target_)

> **Status: target** (Refs #194). The **project-level** behavior described in §3.1 — resolving
> bare-relative `globs` against `context.workspacePath` — is **current** and unchanged. The rules
> below add two new scope classes (absolute and home-relative) that are valid forms for
> **user-level** monitors. User-level bare-relative glob rejection is **target** pending a guard in
> `agentmonitors validate`. See [001 §6.1](./001-monitor-definition.md) for the authoring
> perspective. Project-relative fan-out for user-level monitors (one definition → N
> workspace-scoped instances) is **out of scope** for this release and is tracked in issue #258.

#### 3.5.1 Scope class determination

The scope class of every pattern in a monitor's `globs` (and `ignore`) array is determined by the
**leading character** of each pattern string. No separate `scope:` field is used.

| Leading character  | Scope class      | Resolution                                                                                                                                                    |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                | Absolute         | Passed to `globSync` unchanged. `cwd` is irrelevant.                                                                                                          |
| `~`                | Home-relative    | Expanded via `os.homedir()` (see §3.5.2) before being passed to `globSync`. `cwd` is irrelevant.                                                              |
| _(any other char)_ | Project-relative | Resolved against `context.workspacePath` exactly as today (§3.1). `cwd` is resolved against that same root if provided; `globSync` is called with that `cwd`. |

This determination runs **per pattern**, not per monitor. However, the no-mixing rule (§3.5.3)
means that in practice all patterns in a given monitor will have the same scope class.

#### 3.5.2 `~` expansion rule

A pattern whose first character is `~` **MUST** be expanded using `os.homedir()` before glob
expansion:

- `~` alone → `os.homedir()`
- `~/…` → `os.homedir() + '/…'`

The expanded result is an **absolute path**, and `globSync` is called with it as if it were a
`/`-prefixed pattern (no `cwd` involvement).

`~user` forms (patterns beginning with `~` followed immediately by a character other than `/`)
are **not** supported and **MUST** be rejected at `agentmonitors validate` with a clear error:

> _"`~user` home expansion is not supported. Use an absolute path or `~/…` instead."_

**Rationale:** `~user` expansion requires looking up another user's home directory via
platform-specific APIs that are unreliable in daemon contexts. The common author intent
("files in my home directory") is fully covered by `~/…`. The restriction is narrow and
self-correcting via the validate error.

#### 3.5.3 No-mixing rule

All patterns within a single monitor's `globs` array (and `ignore` array) **MUST** belong to the
same scope class. A monitor that mixes scope classes — for example, one `/var/log/x.log` (absolute)
and one `src/**/*.ts` (project-relative) in the same `globs` array — **MUST** be rejected at
`agentmonitors validate` with a clear error:

> _"Mixed glob scope classes in one monitor: found absolute and project-relative patterns. Split
> into two monitors — one per scope class."_

**Why this constraint exists:** a single monitor corresponds to a single `sourceState` and a
single baseline. Mixing scope classes would produce a baseline spanning both user-level files and
project-relative files, making the baseline ambiguous when a daemon serves multiple workspaces
(does the project-relative half belong to workspace A, workspace B, or all of them?). Two
monitors with separate identities, separate baselines, and separate event streams avoid the
ambiguity cleanly.

**Scope classes involved in the no-mixing rule:**

- absolute + home-relative = **allowed** (both are workspace-agnostic; technically two classes
  but both resolve without a workspace; `agentmonitors validate` **SHOULD** warn that mixing
  these two in one monitor is unusual but **MUST NOT** reject it as an error)
- absolute + project-relative = **rejected**
- home-relative + project-relative = **rejected**

> _Note:_ in practice, mixing absolute and home-relative is extremely unlikely (authors either
> watch files under `~` or at an absolute path, not both in one monitor). The SHOULD-warn rather
> than MUST-reject treatment keeps the rule simple without creating a false positive footgun.

#### 3.5.4 User-level monitor glob constraint (target)

A `MONITOR.md` living in a **user-level monitors root** (the global config root rather than a
project `.claude/monitors/` directory) **MUST NOT** use bare-relative `globs`. The daemon cannot
determine which workspace root to resolve bare-relative patterns against for a user-level monitor
without the project-relative fan-out machinery (issue #258), and silently resolving against the
daemon process `cwd` would produce wrong paths.

`agentmonitors validate` **MUST** detect this condition and reject it with a clear error:

> _"Bare-relative globs in a user-level monitor are not supported (Refs #258). Use `/…` for
> absolute paths or `~/…` for home-relative paths instead."_

Until the user-level context flag is propagated into the validation path, this check **MUST** be
implemented conservatively: if the validator is invoked with a `--user-level` flag (or an
equivalent context indicating the monitors directory is not a project `.claude/monitors/`
directory), bare-relative patterns are rejected. Without that flag, bare-relative patterns are
accepted as project-relative (preserving the current behavior for project-level monitors). The
mechanism for communicating user-vs-project context to `validate` is an implementation detail;
the observable contract is: **bare-relative + user-level = validate error**.

#### 3.5.5 Events from workspace-agnostic monitors

A `file-fingerprint` user-level monitor whose `globs` are all absolute or all home-relative
produces **workspace-agnostic** events: events whose `workspacePath` is `null`. These are
projected into **all lead sessions** via the existing `sessionsForWorkspace(null)` path.

This reuses existing infrastructure: workspace-agnostic events already exist in the runtime for
other sources. No new projection machinery is required for the absolute/home-relative forms.

Project-relative user-level monitors (which would produce per-workspace events from a single
definition) require the fan-out machinery tracked in issue #258 and are **not** covered here.

#### 3.5.6 Concrete examples

**Valid — home-relative user-level monitor (target):**

```yaml
# In a user-level monitors root (global config root)
watch:
  type: file-fingerprint
  globs:
    - '~/notes/**/*.md'
    - '~/inbox.txt'
```

`~/notes/**/*.md` and `~/inbox.txt` are both home-relative. `~` is expanded to `os.homedir()`.
The resulting events have `workspacePath: null` and project into all lead sessions.

**Valid — absolute user-level monitor (target):**

```yaml
watch:
  type: file-fingerprint
  globs:
    - '/var/log/app.log'
    - '/etc/hosts'
```

Both patterns are absolute. The resulting events have `workspacePath: null`.

**Valid — project-level monitor using bare-relative (current; unchanged):**

```yaml
# In a project .claude/monitors/ directory
watch:
  type: file-fingerprint
  globs:
    - 'src/**/*.ts'
    - 'package.json'
```

Bare-relative in a project-level monitor. Resolved against `context.workspacePath` as today. No
change to existing behavior.

**Invalid — bare-relative in a user-level monitor (target; rejected at validate):**

```yaml
# In a user-level monitors root — INVALID
watch:
  type: file-fingerprint
  globs:
    - 'src/**/*.ts' # ERROR: no workspace to resolve against at user level
```

`agentmonitors validate` rejects this with a clear error directing the author to use `~/…` or
an absolute path.

**Invalid — `~user` form (target; rejected at validate):**

```yaml
watch:
  type: file-fingerprint
  globs:
    - '~alice/notes.md' # ERROR: ~user expansion is not supported
```

`agentmonitors validate` rejects this with a clear error directing the author to use an absolute
path or `~/…`.

**Invalid — mixed scope classes (target; rejected at validate):**

```yaml
watch:
  type: file-fingerprint
  globs:
    - '/var/log/app.log' # absolute
    - 'src/**/*.ts' # project-relative — MIXES scope classes
```

`agentmonitors validate` rejects this with a clear error directing the author to split into two
monitors.

#### 3.5.7 Validation implications

The following test scenarios cover the sigil-based glob scope feature:

- **Happy path — home-relative user-level monitor:** a user-level monitor with
  `globs: ['~/notes/x.md']` is accepted by `agentmonitors validate`; the `~` in the pattern
  expands to `os.homedir()` at observe time; the resulting event has `workspacePath: null`; the
  event projects into a lead session for a different workspace (workspace-agnostic projection).
- **Happy path — absolute user-level monitor:** a user-level monitor with
  `globs: ['/var/log/x.log']` is accepted; the event has `workspacePath: null`.
- **Happy path — fixed single file:** a user-level monitor with a single fixed file path
  (e.g., `globs: ['/etc/hosts']`) is accepted; this is the simplest workspace-agnostic form.
- **Happy path — project-relative project monitor (current, unchanged):** a project-level monitor
  with `globs: ['src/**/*.ts']` continues to resolve against `context.workspacePath` exactly as
  today; no behavior change.
- **Negative — bare-relative in user-level monitor:** `agentmonitors validate --user-level`
  with `globs: ['src/**/*.ts']` exits non-zero with a message referencing #258 and directing the
  author to use `~/…` or an absolute path.
- **Negative — `~user` form:** `agentmonitors validate` with `globs: ['~alice/notes.md']` exits
  non-zero with a message saying `~user` expansion is not supported.
- **Negative — mixed scope classes:** `agentmonitors validate` with
  `globs: ['/var/log/x', 'src/foo.ts']` exits non-zero with a message directing the author to
  split into two monitors.
- **Cross-session projection:** a workspace-agnostic event (from an absolute or home-relative
  user-level monitor) projects into a session whose `workspacePath` is a project directory
  different from where the monitor is defined — proving `sessionsForWorkspace(null)` is used.

### 3.8 Watch mode: event-driven change detection (TARGET)

> **Status: target.** This section and §3.9–§3.10 describe the intended implementation of
> `watch()` for `file-fingerprint`. None of this is current behavior; the current source uses
> `observe()` only (§3.2). These rules MUST be moved to _current_ status with `verified:`
> references when the feature ships (process: [004 §5–6](./004-validation-testing.md)).

`file-fingerprint` **MUST** implement `watch()` and opt into the existing continuous-watch contract
(§2, G5/NP4). Watch mode is the **default change-detection mechanism for long-lived
`file-fingerprint` monitors**; the `interval` field becomes a fallback-only knob used when the
watcher cannot be initialized (see §3.9).

The watcher MUST be implemented via **`@parcel/watcher`** (auto mode by default). `@parcel/watcher`
is an in-process N-API native addon that transparently uses the most capable backend available
(FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows, or Watchman when the user
has it installed), ships prebuilt binaries so there is no compile-on-install step, and requires no
external daemon process. It therefore preserves the local-first "ordinary dev-tool process" posture
(PP9, NP1).

#### Why `observe()` is retained (non-negotiable)

`watch()` does not replace `observe()`; both MUST be implemented:

1. **`daemon once`** executes a single in-process tick with no event loop to host a watcher; it
   MUST call `observe()` directly (see [002 §10.1](./002-runtime-delivery.md)).
2. **Unreliable filesystems** — network mounts, some FUSE/overlay/container filesystems — cannot
   deliver reliable OS-level events; polling is the only correct mechanism on those.

When the runtime's tick loop calls `observe()` while an active watcher is running for the same
monitor, it MUST skip that monitor's `observe()` call (G5/NP4, [002 §2.3](./002-runtime-delivery.md)).
`daemon once` always uses `observe()` regardless of whether `watch()` is implemented.

#### How watch works

`watch()` opens an `@parcel/watcher` subscription for the resolved glob tree (`cwd` + `globs` +
`ignore` patterns). When the OS or Watchman delivers a file-system event for a matched path:

1. The source re-computes the SHA-256 fingerprint of the affected file(s).
2. It compares against the in-memory fingerprint state (the same `FingerprintState` shape as
   `nextState` in §3.2).
3. For each changed, created, or deleted path, it **yields** one `Observation` through the
   `AsyncIterable<Observation>` exactly as `observe()` would, using the same observation shape
   (§3.2), change-kind classification (§3.3), and salience policy (§3.4).
4. It updates the in-memory fingerprint state.

A small internal coalesce window (~50–100 ms) MAY be applied before emitting, to absorb
editor atomic-save sequences (write-tmp → rename) as a single change event. This is an
implementation detail of the watcher driver and MUST NOT affect the observation shape.

The `context.signal` abort is the watcher's stop signal: `watch()` MUST close the underlying
`@parcel/watcher` subscription and stop yielding when `context.signal` fires. The runtime aborts
the signal on daemon shutdown, monitor removal, or watcher error (see [002 §2.3](./002-runtime-delivery.md)).

#### Startup reconciliation (reconcile-on-start)

When a watcher boots — either at daemon startup or after a restart — it MUST perform a one-shot
`observe()` call against the **persisted fingerprint baseline** before opening the watcher
subscription. This reconcile-on-start pass detects any file changes that occurred while the daemon
was offline, so no downtime loss occurs. The reconcile observation flows through the same
notify-dispatch → materialization → projection pipeline as any other observation (PP1, PP6).

The sequence is:

1. Load the persisted `sourceState` (fingerprints baseline).
2. Run one full `observe()` pass against the current file tree; emit any resulting observations
   through the runtime's `ingest()` path.
3. Record the updated fingerprint state as the in-memory watcher baseline.
4. Open the `@parcel/watcher` subscription (§3.8 above).

> **Example (reconcile-on-start net diff).** The daemon is stopped for two minutes; during that
> time `foo.ts` is modified and `bar.ts` is deleted. When the daemon restarts, the reconcile pass
> diffs the current file tree against the persisted baseline, emitting a `modified` observation for
> `foo.ts` and a `deleted` observation for `bar.ts`. The watcher then opens and from that point
> forward delivers events in real time. No changes made during the downtime window are lost.
>
> **Test implication.** A test that stops the daemon, mutates a watched file, restarts, and
> immediately calls the watcher boot sequence MUST see the mutation surfaced as a reconcile
> observation before any OS-level watcher events arrive.

### 3.9 Backend selection and failure policy (TARGET)

> **Status: target.** Part of the §3.8 event-driven feature. All rules here are target.

The optional `backend` scope field controls which underlying watching mechanism `@parcel/watcher`
uses. When omitted it defaults to `auto`.

| Value       | Meaning                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `auto`      | Use the best available native backend. Watchman is used if installed; otherwise FSEvents / inotify / ReadDirectoryChangesW / kqueue. |
| `fs-events` | macOS FSEvents API (macOS only).                                                                                                     |
| `watchman`  | Meta Watchman daemon (must be installed separately by the user).                                                                     |
| `inotify`   | Linux inotify API (Linux only).                                                                                                      |
| `kqueue`    | BSD/macOS kqueue API.                                                                                                                |
| `windows`   | Windows ReadDirectoryChangesW API (Windows only).                                                                                    |

Two distinct failure policies apply depending on whether `backend` is `auto` or pinned:

**`auto` (default): fall back to polling with a loud warning.**

If watcher initialization fails under `auto` (e.g., the filesystem is a network mount that does
not deliver events, or `@parcel/watcher` cannot load its native addon), the source MUST:

1. Fall back to the `observe()`-based poll path (using the `interval` field as the poll cadence, or
   the default 30s if omitted).
2. Surface a **loud warning** on the monitor — visible in `agentmonitors monitor explain` output —
   describing that watch mode is unavailable and the monitor is polling instead.

Degradation to polling MUST NOT be silent. Silent degradation would mask infrastructure problems
(e.g. a developer unaware that a network mount cannot deliver events) and defeat the purpose of
the `backend: auto` selection.

**Pinned backend (`fs-events`, `watchman`, `inotify`, `kqueue`, `windows`): fail the monitor.**

If the pinned backend is unavailable, the source MUST fail the monitor with a clear, actionable
error. It MUST NOT silently fall back to a different native backend or to polling.

Rationale: an author who pins a backend (e.g., `backend: watchman`) has expressed a hard
requirement — typically because `auto` would pick a less capable mechanism for a very large tree.
Silently using a different mechanism would defeat that requirement without any signal to the author.

**Important: `@parcel/watcher`'s own behavior does not enforce this policy.** `@parcel/watcher`'s
native behavior is to fall back to its default backend if the pinned one is unavailable. The
`file-fingerprint` implementation MUST therefore check backend availability itself — before
delegating to `@parcel/watcher` — and reject the monitor with an explicit error when a pinned
backend is not available on the current platform or system. Delegating the check to the library is
insufficient.

> **Example (pinned fail-loud).** A monitor declares `backend: watchman` on a machine where
> Watchman is not installed. The source detects that Watchman is unavailable (e.g., by testing the
> `watchman` binary or probing the socket), fails the monitor with
> `"file-fingerprint: pinned backend 'watchman' is not available on this system"`, and does not
> fall back to FSEvents or polling. The error is surfaced in `daemon once` / `daemon run` error
> output and in `agentmonitors monitor explain`.
>
> **Test implication.** A test that supplies `backend: watchman` while Watchman is not available
> MUST see a monitor-level failure (not a silent polling fallback). A test that supplies `backend:
auto` with watcher init forced to fail MUST see the monitor switch to polling AND a warning
> visible in its explain output.

### 3.10 Periodic source-state checkpointing during watch (TARGET)

> **Status: target.** Part of the §3.8 event-driven feature. This section describes a new core
> contract addition (also specified in [002 §2.4](./002-runtime-delivery.md)) required for
> mid-watch crash safety. All rules here are target.

While `watch()` is running, the in-memory fingerprint state advances with every OS event —
but without periodic persistence, a mid-watch daemon crash would lose that state. On restart the
daemon would re-observe from the last persisted baseline and re-emit observations for changes that
had already been delivered and acknowledged, creating duplicate deliveries.

To prevent this, `file-fingerprint`'s `watch()` implementation MUST periodically checkpoint its
updated fingerprint state back to the runtime using the watch-checkpoint mechanism specified in
[002 §2.4](./002-runtime-delivery.md). The checkpoint carries the current `FingerprintState` as
`nextState` so the runtime can persist it durably — respecting the G14 durable-write-before-Interpret
ordering ([002 §1.1.8](./002-runtime-delivery.md)) — before any downstream pipeline work.

> **Why this is a core-contract addition.** Today ([002 §2.3](./002-runtime-delivery.md)), the
> runtime leaves `sourceState` untouched while a watcher is running (source state is only advanced
> by `observe()` returning `nextState`). Watch-mode checkpointing requires the runtime to accept an
> out-of-band state write from an active watcher. The new `context`-level callback or periodic
> `{ observation, nextState }` checkpoint shape is the mechanism for this write-back; its exact
> TypeScript shape is specified in [002 §2.4](./002-runtime-delivery.md).

A checkpoint interval of approximately the `interval` field (or the default 30s if omitted) is
a reasonable default. The checkpoint MUST be durable before the runtime interprets the accompanying
observation (G14 ordering). If the checkpoint write fails, `watch()` SHOULD treat this as a
transient error, log a warning, and continue watching — a failed checkpoint is not cause to abort
the watcher.

> **Test implication.** A test that (a) starts a watcher, (b) triggers file changes that are
> observed and yielded, (c) simulates a daemon crash before the next checkpoint, and (d) restarts the
> daemon MUST see the reconcile-on-start pass (§3.8) report only the changes that occurred
> _after_ the last checkpoint — not re-report changes that were delivered before the crash.

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
  timeout: 30s
  auth:
    type: bearer
    token-env: API_TOKEN
  # change-detection is OPTIONAL. When omitted, the strategy is inferred from the
  # response Content-Type (§4.2). Set it only to override the inferred default.
```

The common "watch a web page" case needs **no** `change-detection` block at all:

```yaml
watch:
  type: api-poll
  url: 'https://example.com/page'
  interval: 5m
```

Required field: `url` (string). Important optional fields: `method`, `headers`, `interval`, `auth`, `timeout`
(request/body deadline, default `30s` — see §4.9), `change-detection`.

`interval` is declared in the scope schema with pattern `^\d+[smhd]$` but is used by the scheduling engine, not by the plugin directly (verified: scope schema comment at `plugins/source-api-poll/src/index.ts` line 131).

`method` defaults to `GET` in the schema and in the `fetch` call if absent from config.

### 4.2 Change-detection strategies

Supported strategies (verified: `plugins/source-api-poll/src/index.ts`, `ChangeStrategy` type and `hasChanged` function):

| Strategy      | Semantics                                                                                                                                  | Use for                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `text-diff`   | Compare raw response body strings.                                                                                                         | HTML pages, plain-text status pages — the correct choice for web pages |
| `json-diff`   | Parse both bodies as JSON, recursively sort object keys, then compare serialized strings. Ignores key ordering and whitespace differences. | JSON APIs                                                              |
| `status-code` | Compare only HTTP status codes; body changes are ignored.                                                                                  | Watching whether an endpoint goes up/down (e.g. 200 → 503)             |

**`json-diff` renders a structural `diffText`, not a text line diff (issue #437).** This `strategy`
value is read by the runtime's diff renderer (the source-agnostic `change-detection.strategy` this
row and §11.3 describe) to choose how `diffText` is rendered, not only whether a change occurred:
`strategy: json-diff` produces
added/removed/changed elements or key paths (`buildJsonDiff`) instead of `buildTextDiff`'s line-level
diff, which degrades to a whole-line remove-all/add-all on compact single-line JSON. See
[002 §5.2](./002-runtime-delivery.md#52-snapshots-and-diffs) for the renderer's full behavior
(identity heuristics, bounded output, and the parse-failure fallback to `buildTextDiff`).

Setting `snapshot.strategy` is a **bundled-source convention** (`source-api-poll`, `source-command-poll`
both set it), not a requirement of the [§2 source contract](#2-source-contract) — a third-party source
MAY opt into it the same way to get the structural renderer, but the contract does not mandate every
`Observation`'s `snapshot` carry a `strategy` field. A source that omits it (or emits `snapshot` at all)
simply always renders via `buildTextDiff` (`changeDetectionStrategyOf` returns `undefined` for anything
that isn't a metadata object with a string `strategy` field).

**`change-detection.strategy` is optional (issue #230).** When the author **omits** it, the strategy is
**inferred from the response `Content-Type`**: a JSON media type (`application/json` or any
structured-syntax `+json` suffix such as `application/ld+json`, per RFC 6838) infers `json-diff`;
everything else — `text/html`, `text/plain`, and a missing/unknown `Content-Type` — infers `text-diff`.
This makes the common "watch a web page" case zero-config: omit `change-detection` and the source picks
`text-diff` for an HTML page and `json-diff` for a JSON API automatically.

Rendered HTML can still be a noisy input even when `text-diff` is the correct strategy. Many real
status pages embed per-request timestamps, CSRF tokens, nonces, or build metadata, so the raw HTML
body differs on every poll despite no user-visible status change. For status-page monitoring,
authors SHOULD prefer a machine-readable status endpoint when available (for example, a
Statuspage-style `/api/v2/status.json` URL) because JSON summary endpoints are generally stable
until the status itself changes. If only rendered HTML is available, authors SHOULD expect noise and
pair the monitor with a `notify.strategy: debounce` window when appropriate.

**An explicit `change-detection.strategy` always wins.** When the author specifies a strategy it is used
**verbatim**, with no inference and no Content-Type override — user specification is absolute. So an
explicit `json-diff` against an HTML page stays `json-diff` (and triggers the warning below), and an
explicit `text-diff` against a JSON body stays `text-diff`. (Verified: `plugins/source-api-poll/src/index.ts`,
`resolveStrategy` / `isJsonContentType`; `plugins/source-api-poll/src/index.test.ts`.)

If `json-diff` parsing fails for either body, the implementation falls back to raw text comparison
(verified: `plugins/source-api-poll/src/index.ts`, `hasChanged`). Because that fallback is silent and
is almost always the wrong strategy for the body in question, the source attaches a **non-fatal
warning** to the `ObservationResult` (`ObservationResult.warnings`) when an **explicit** `strategy: json-diff`
is configured but the fetched body does not parse as JSON. (An **inferred** strategy never warns: inference
picks `json-diff` only for JSON `Content-Type`s, so it never mismatches the body — issue #230.)
`agentmonitors monitor test` prints the warning (`Warning: api-poll: change-detection.strategy is json-diff
but the response … does not parse as JSON; … Use strategy: text-diff …`) so the author sees the
misconfiguration during a dry-run rather than getting quietly wrong diffing in production. The warning does
not change the observation outcome — the baseline/diff still proceeds via the text fallback. (Verified:
`plugins/source-api-poll/src/index.ts`; `plugins/source-api-poll/src/index.test.ts`. Issues #219, #230.)

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

`api-poll` declares `stateful: true`. The first **successful (2xx)** call fetches the URL, stores
`{ body, status }` as `nextState`, and returns an empty `observations` array. Subsequent calls compare
against `context.previousState` and emit an observation only when `hasChanged` returns `true`.

A **non-2xx** response is not a valid baseline for body-diffing strategies — see §4.8.

### 4.8 Non-2xx responses → errored observation

A non-2xx HTTP response (e.g. a `401` from a missing/invalid bearer token, a `403`, a `404`, a `500`
error page) is **not** silently used to establish or advance a change-detection baseline for the
`text-diff` and `json-diff` strategies. Baselining on an error body makes a misconfigured monitor
appear to "work" — it would baseline on, and then diff, error pages — with no signal that auth or the
URL is broken (the failure mode in issue #220, where a bad token produced `HTTP 401` yet the monitor
validated and observed "successfully").

Instead, for `text-diff`/`json-diff` the source **throws** on a non-2xx status with a status-bearing
message:

> `api-poll received HTTP <status> from <url> — check auth/url; not establishing a baseline on an error response`

Because the source throws, the runtime records an **`errored`** observation outcome (no `nextState`
advance, so any prior baseline is preserved per [002 §3](./002-runtime-delivery.md)); `daemon once` /
`daemon run` include it in their error reporting; `monitor history` shows the tick as `errored`; and
`monitor test` reports `Observation failed: api-poll received HTTP <status> …`.

**Exception — `status-code`:** the `status-code` strategy exists precisely to detect status
transitions (an endpoint going `200 → 503`). For it, a non-2xx status is a legitimate **observed
signal**, not an error — the status itself is the watched object — so `status-code` does **not** throw
on non-2xx. Only the body-diffing strategies treat a non-2xx as an error, because diffing an error
body is meaningless.

Successful (2xx) responses baseline and diff exactly as before (no regression). This is distinct from
§4.6 **network**-level failures (ECONNREFUSED, DNS, timeout), which throw before any response status is
known; §4.8 covers transport-level success with a non-2xx status. (Verified:
`plugins/source-api-poll/src/index.ts`; `plugins/source-api-poll/src/index.test.ts`. Issue #220.)

### 4.6 Network error propagation

When Node `fetch` throws (ECONNREFUSED, ENOTFOUND, timeout, …), it wraps the real OS-level error as `err.cause`. The source catches the `TypeError("fetch failed")`, builds a composite message `"fetch failed: <cause.message>"`, and re-throws a new `Error` with that message and `cause` set to the original fetch error. This means `monitor explain` and observation-history audit rows show the real reason (e.g. `"fetch failed: connect ECONNREFUSED 127.0.0.1:9999"`) instead of the generic `"fetch failed"`. (Verified: `plugins/source-api-poll/src/index.ts`.)

### 4.7 `monitor test` baseline output

`agentmonitors monitor test` for an `api-poll` monitor prints the HTTP status code and response body
size (UTF-8 bytes, via `Buffer.byteLength`) after establishing a successful baseline, before running
the second observation. For body-diffing strategies (`text-diff` / `json-diff`), only **2xx**
responses establish that baseline; non-2xx responses are rejected as errored observations per §4.8.
This output therefore surfaces successful-but-suspicious responses, such as a misconfigured endpoint
returning an empty 200. A monitor that intentionally watches non-2xx status transitions should use
`change-detection.strategy: status-code`, where the status itself is the observed signal.

Note: network-level failures (ECONNREFUSED, DNS, timeout) throw _before_ any baseline is
established and are handled separately by §4.6 error propagation; they do not produce a status/size
line. Example output for a successful (transport-level) request:

```
Testing monitor "api-health" (source: api-poll)...

Baseline established. The "api-poll" source requires a prior baseline before it can detect changes.
  HTTP 200 (1234 bytes)
Running a second observation to demonstrate change detection...
```

### 4.9 Request duration, response size, and composite concurrency bounds (issue #304)

A stalled or huge endpoint must not wedge a whole tick, delay unrelated monitors, exhaust daemon
memory, or amplify the local SQLite database (P1 daemon availability). `api-poll` enforces four
bounds, all covered by a documented default with — for the deadline — a validated per-monitor
override:

| Bound                                                       | Default                                            | Override                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request/body deadline                                       | `30s`                                              | `timeout` (scope field, duration string `^[1-9]\d*[smhd]$`, e.g. `"1m"`); at most `2147483647`ms (~24.8 days) — the largest delay Node's `setTimeout` can schedule |
| Response body size cap (per part)                           | 10 MiB (10 × 1024 × 1024 bytes)                    | not configurable; not enforced at all for `change-detection.strategy: status-code`                                                                                 |
| Composite cumulative artifact-byte budget                   | 10 MiB, summed across ALL parts' rendered sections | not configurable                                                                                                                                                   |
| Composite concurrency                                       | 5 parts in flight at once                          | not configurable                                                                                                                                                   |
| Composite part count (issue #304 review, third round)       | 50 `parts` entries max                             | not configurable                                                                                                                                                   |
| Composite part `id` length (issue #304 review, third round) | 256 characters max                                 | not configurable                                                                                                                                                   |

**Request/body deadline.** A single `AbortController`-backed timer, started when the request is
issued, bounds the ENTIRE exchange — connecting, receiving headers, and streaming the body to
completion — not just the initial `fetch()` call. A server that never sends headers and a
server that sends headers promptly but then stalls or trickles a chunked body are both aborted at
the same deadline. On abort, the source throws:

> `api-poll request to <url> timed out after <timeoutMs>ms`

exactly like a network-level failure (§4.6): the runtime records an **`errored`** observation, no
`nextState` advance, and any prior baseline is preserved. Under an HTTP/2 or socket-teardown race,
undici can reject a mid-body read with a raw `TypeError: terminated` instead of the `AbortError`
this source's own timer produces; that race is still classified as the same "timed out" error
(checked via `controller.signal.aborted`, not just the caught error's type), so a caller never sees
the raw undici error leak through.

`timeout` defaults to `30s` when omitted — meaning `config['timeout']` is `undefined` — (matching
`command-poll`'s default, 003 §11.1) and is resolved by core's shared `parseOperationTimeoutMs`
helper (exported next to `parseDuration`, and used by both `api-poll` and `command-poll` so the
grammar and default cannot drift between the two plugins). A _present_ value that is not a string
(a number, `null`, …) is a misconfiguration, not "omitted", and is rejected rather than silently
defaulted:

> `Invalid timeout: expected a string matching ^[1-9]\d*[smhd]$ (e.g. "30s"), got <type>.`

A present string is parsed with `parseDuration`, so a malformed value throws the same descriptive
`Invalid duration: "<value>". Expected format: <number><s|m|h|d>` error as every other duration
field. Three values `parseDuration` alone would accept are rejected up front, so the parser and the
JSON Schema `pattern` for `timeout` (`^[1-9]\d*[smhd]$`) always agree:

- A **zero-length** value (`"0s"`, `"0m"`, `"0h"`, `"0d"`) — which would abort every request before
  it could ever complete — is rejected with `Invalid timeout: "<value>". A zero-length timeout is
not allowed; specify at least 1 unit (e.g. "1s").`.
- A **leading-zero** value (`"01s"`, `"007m"`, …) — the schema pattern's `[1-9]\d*` already rejects
  these, but `parseDuration`'s own `\d+` digit group would otherwise accept them, a schema/parser
  mismatch — is rejected with `Invalid timeout: "<value>". A leading zero is not allowed; use "1s"
instead of "01s" …`.
- A value exceeding **`2147483647`ms** (~24.8 days, e.g. `"25d"`) — the largest delay Node's
  `setTimeout` can schedule; a longer value silently overflows to a near-instant timer instead of
  the author's intended deadline — is rejected with `Invalid timeout: "<value>" (<ms>ms) exceeds
the maximum supported deadline of 2147483647ms (~24.8 days) …`. The JSON Schema `pattern` cannot
  express this numeric upper bound (it is a pure string grammar), so this one check is
  parser-only — a documented, narrow gap, not a parity bug.

In composite mode (§2.6), the **same** deadline applies independently to **each** part — a failing
part errors the whole composite immediately (see **Composite concurrency** below) without starving
or serializing the others.

**Response body size cap.** The cap is enforced twice, because `Content-Length` is not
authoritative:

1. **Early rejection.** If the response declares a `Content-Length` header above the cap, the
   source aborts the request and releases the (unread) response body back to the connection pool,
   then throws before reading any body bytes:

   > `api-poll response from <url> declares Content-Length <n> bytes, exceeding the 10485760-byte cap`

2. **Streamed counting (the authority).** Regardless of what — or whether — `Content-Length` was
   declared (it is absent under chunked transfer encoding, and can simply be wrong), every chunk
   read from the response body stream is counted; once the running total exceeds the cap, the
   source aborts the in-flight request and throws:

   > `api-poll response from <url> streamed <n> bytes, exceeding the 10485760-byte cap`

Either path is a thrown error (not a truncated result): the runtime records an `errored`
observation, exactly as for the deadline. `api-poll` never baselines or persists a partial or
oversized body — unlike `command-poll`'s stdout cap (003 §11.2), which truncates and still treats
the capped output as a valid, diffable result. The difference matches the failure mode: a huge
command output is still meaningful once capped, but treating a stalled/incomplete HTTP body as a
successful baseline would silently corrupt future diffs.

**`status-code` is exempt from the byte cap.** `change-detection.strategy: status-code` never
inspects the response body — the status transition IS the watched object (§4.2, §4.8) — so
`api-poll` skips reading the body entirely for it: the response is released back to the connection
pool via `cancel()` without buffering or counting a single byte. This is strictly cheaper than the
body-diffing strategies AND means a `status-code` monitor watching a large endpoint (e.g. a big
static artifact whose availability is being tracked) is never subject to the 10 MiB cap — it can
still observe a `200 → 503` transition even though the response body, if read, would exceed the
cap. This exemption applies only when `change-detection.strategy` is written explicitly as
`status-code`; an omitted strategy is inferred from the response `Content-Type` (§4.2) and can only
resolve to a body-diffing strategy, so the body is always read in the inferred case.

**Composite concurrency.** Composite mode (§2.6) issues one call per `parts` entry within a single
`observe()`. Without a bound, a composite with many parts starts every request at once, multiplying
both the stalled-connection risk and memory pressure this issue exists to bound. `api-poll` runs at
most 5 part-fetches concurrently; when there are more than 5 parts, each completed fetch's slot is
immediately taken by the next queued part (a bounded worker pool, not fixed batches of 5). Every
part still gets the same request/body deadline and byte cap as a single-URL monitor. A failing part
(non-2xx per §4.8, timeout, or oversize) fails the whole composite observation **immediately** —
the pool races a dedicated failure promise against the worker pool, so the batch rejects the moment
the first part fails rather than waiting for other in-flight parts to reach their own deadline —
and aborts every other in-flight part via a shared `AbortSignal` instead of letting them run to
completion. Either way `nextState` never advances and the prior baseline is preserved; the
concurrency bound changes only how many requests are in flight at once and how fast a doomed batch
surfaces its failure, not the composite's all-or-nothing semantics.

**Composite cumulative artifact-byte budget.** The per-part 10 MiB cap (above) bounds any ONE
part's response body; the 5-worker concurrency bound (above) bounds how many parts are in flight
AT ONCE — but neither bounds the aggregate size of the assembled composite. A composite with many
small parts, each individually far under the per-part cap (e.g. 12 parts × 1 MiB), could still
assemble and baseline a `snapshotText`/`nextState` many times larger than any single-URL monitor's
response, persisted every tick. `api-poll` therefore also tracks the running SUM of every part's
**rendered** section — the `## <id>\n<body>` text `renderCompositeSnapshot` emits for it, not just
its raw response body — across the whole composite; once that running total exceeds the same
10 MiB figure (reused, not a second configurable knob), the source throws:

> `api-poll composite "<objectKey>" exceeded the 10485760-byte cumulative rendered-artifact budget
after part "<partId>" (<n> bytes across the composite's framed parts fetched so far) — reduce the
number/size of parts or split into multiple monitors`

This fails the whole composite exactly like a non-2xx or oversized part: `mapWithConcurrency`
aborts every other in-flight part via the shared `AbortSignal`, `nextState` never advances, and the
prior baseline is preserved.

**Composite part count and part-`id` length (issue #304 review, third round).** The byte budget
above bounds aggregate _size_, but bounds neither the number of parts nor a single part's `id`
length — and a reviewer showed both matter independently of body size: 100,000 empty-body parts (0
cumulative body bytes) completed 100,000 requests and produced a 1,699,998-byte baseline without
tripping the (then body-only) budget, and a single empty-body part with an 11 MiB `id` produced an
11,534,340-byte baseline the same way, since `renderCompositeSnapshot` frames every part with
`## <id>\n` regardless of how large the body is. `api-poll` therefore also caps:

- `change-detection.composite.parts` at **50 entries** — rejected in both the JSON Schema
  (`maxItems`, so `agentmonitors validate`/`monitor test`/`watch declare` catch it at authoring
  time) and the parser (`change-detection.composite.parts must not exceed 50 entries (got <n>)`,
  defense in depth for a hand-edited `MONITOR.md` that skipped validation — 002 §2.2).
- each part's `id` at **256 characters** — rejected the same way in both the schema (`maxLength`)
  and the parser (`change-detection.composite.parts[<i>].id must not exceed 256 characters (got
<n>)`).

Both are structural rejections at config-parse time, before `observe()` issues a single request —
neither reviewer repro shape above ever reaches the network under this bound. The part-count cap
also bounds **worst-case tick duration**: with `MAX_COMPOSITE_CONCURRENCY` (5) workers, a composite
takes at most `ceil(parts / 5) * timeout` to resolve or fail, so at the 50-part cap and the default
30s timeout, one composite's worst case is `ceil(50 / 5) * 30s = 300s` (5 minutes) — a known,
documented ceiling rather than an unbounded function of how many parts an author (or a
misconfigured/compromised MONITOR.md) declares.

(Verified: `plugins/source-api-poll/src/index.ts`, `MAX_RESPONSE_BYTES`, `MAX_COMPOSITE_BYTES`,
`MAX_COMPOSITE_CONCURRENCY`, `readBoundedBody`, `fetchBody`, `observeComposite`;
`plugins/source-api-poll/src/composite.ts`, `MAX_COMPOSITE_PARTS`, `MAX_PART_ID_LENGTH`,
`framedPartByteLength`, `parseCompositeConfig`;
`libs/core/src/notify/notifier.ts`, `parseOperationTimeoutMs`, `DEFAULT_OPERATION_TIMEOUT_MS`,
`OPERATION_TIMEOUT_PATTERN`, `MAX_OPERATION_TIMEOUT_MS`;
`plugins/source-api-poll/src/map-with-concurrency.ts`;
`plugins/source-api-poll/src/index.test.ts`, "request/body bounds (issue #304)",
"composite cumulative byte budget (issue #304 review, second + third round)",
"composite part-count and part-id bounds (issue #304 review, third round)";
`plugins/source-api-poll/src/map-with-concurrency.test.ts`;
`libs/core/src/notify/notifier.test.ts`.)

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

**Authoring-time IANA validation (issue #297).** A present `timezone` MUST be a name
`Intl.DateTimeFormat` accepts (e.g. `America/New_York`, `UTC`) — checked by core's
`invalidTimezoneError()`, wired into `validateWatchScope()` (verified:
`libs/core/src/schema/validate-scope.ts`), the same source-agnostic supplemental check
`change-detection.collection` uses (§12). `agentmonitors validate`, `monitor test`, and `watch
declare` (007 §4.2) all call `validateWatchScope()` and therefore reject an invalid `scope.timezone`
with an actionable error before a monitor is ever ticked. `tick()` itself does **not** call
`validateWatchScope()` (it scans and evaluates monitors directly), so a hand-edited `MONITOR.md`
with a bad timezone that skipped `validate` still reaches the runtime — see 002 §2.2's defensive
isolation, which is the last line of defense for that case.

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

`incoming-changes` is a local commit-graph source, not a remote-ahead detector. It observes the ref
as resolved in the workspace; it does not contact remotes and therefore does not notice upstream
commits before local refs advance. To watch remote branch tips without fetching, use `command-poll`
with `git ls-remote origin refs/heads/<branch>` (§11.8).

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

### 7.3 Validation behavior

The current CLI validation command extracts the source config from `watch:` minus `type` and enforces
the selected source's full `scopeSchema` with the core `validateScope` helper. The `scopeSchema` name
is a plugin API term; monitor authors write those fields flat inside `watch:`. Validation coverage is
documented in [004-validation-testing.md](./004-validation-testing.md).

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
When this example is authored as a project monitor, a relative `cwd` is resolved from the
workspace/config root.

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

| Field                           | Type             | Required | Default                  | Description                                                                                                                                                            |
| ------------------------------- | ---------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                       | `string[]`       | Yes      | —                        | Argv array; `command[0]` is the executable (resolved via `PATH`). `minItems: 1`.                                                                                       |
| `interval`                      | duration string  | No       | runtime default          | Poll cadence hint; owned by the scheduling engine, same as `api-poll`.                                                                                                 |
| `cwd`                           | `string`         | No       | daemon working directory | Working directory for the child process.                                                                                                                               |
| `env`                           | `object<string>` | No       | `{}`                     | Literal env vars merged over the inherited daemon environment.                                                                                                         |
| `timeout`                       | duration string  | No       | `30s`                    | Wall-clock limit; expiry is an **execution failure** (§11.5). Parsed via core's shared `parseOperationTimeoutMs` (§4.9) — a zero-length value (`"0s"`, …) is rejected. |
| `key`                           | `string`         | No       | joined argv              | Overrides the observation `objectKey` (§11.4).                                                                                                                         |
| `change-detection.strategy`     | enum             | No       | `text-diff`              | `text-diff` \| `json-diff` \| `exit-code` (§11.3).                                                                                                                     |
| `change-detection.ignore-paths` | `string[]`       | No       | `[]`                     | Plain `json-diff` paths removed before comparison (§11.3).                                                                                                             |

**`command` MUST be an argv array; a shell string form MUST NOT be accepted.** The child is spawned
directly (`execFile` semantics, `shell: false`): there is no word-splitting, globbing, quoting, or
injection surface, and what executes is exactly what the author wrote, token for token. This is the
decision for #81's first open question; a bare-string `command` (which would imply implicit shell
word-splitting) is rejected — an author who needs shell features writes them into a script and polls
the script.

**Shell features are opt-in, not implicit.** An author who genuinely needs a pipeline or shell
operator spawns a shell _explicitly_ in argv form — `command: ['sh', '-c', 'git status -sb | grep ahead']`
— which the source runs verbatim like any other argv (the shell is `argv[0]`, chosen by the author,
not silently interposed by the source). This is the supported inline equivalent of "write a script
and poll it." When `command` is given as a bare string, `parseScopeConfig` rejects it with a message
that names this `['sh', '-c', …]` form, so the common pipeline mistake is self-correcting. Verified:
`plugins/source-command-poll/src/index.ts` (`parseScopeConfig` error) and
`plugins/source-command-poll/src/index.test.ts` ("guides a bare-string command toward the sh -c argv
form", "accepts an explicit sh -c argv form").

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

**The timeout escalation targets the command's entire process tree, not just the direct child**
(issue #303). A supported command may itself invoke a shell that backgrounds a worker
(`['sh', '-c', 'sleep 30 & wait']`) or spawn its own subprocesses; killing only the direct child
would leave such descendants running after the observation is reported as timed out — a resource
leak (accumulated long-lived processes across repeated polls) and a spec violation (§11.7 requires
no orphan). Platform-specific mechanism:

- **POSIX:** each spawn runs as the leader of its own process group/session (`detached: true`); the
  timeout escalation signals the **negative PID** (`process.kill(-pid, 'SIGTERM')`, then
  `'SIGKILL'` after the grace), which targets the whole group at once.
- **Windows:** there is no process-group-signal equivalent, and no reliable graceful signal for a
  non-console-attached spawned process (`taskkill` without `/F` frequently fails silently for this
  kind of child). The documented choice is `taskkill /PID <pid> /T /F` — forceful and tree-wide —
  issued at both the timeout expiry and the grace follow-up; there is no softer phase to escalate
  from on this platform.

Resolution on timeout is driven by the direct child's own `exit` event, never by waiting for its
stdio streams to `close`. A descendant that inherited stdout/stderr (the `sleep` in the example
above) can hold those pipes open indefinitely even after the whole process group has been signaled;
gating resolution on stream close would hang the observation forever in that case — the failure
mode #303 fixes. A short bounded fallback (2s) applies the same principle to ordinary, non-timeout
completions, so a well-formed command can never hang this call either; a normal command's streams
close within milliseconds of exit, so this never adds latency in the common case.

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

As with `api-poll`, `strategy: json-diff` also selects the structural `diffText` renderer (issue
#437) — see the §4.2 note and [002 §5.2](./002-runtime-delivery.md#52-snapshots-and-diffs). This is
the fix for the observed `command-poll` case: a `gh pr list --json` monitor emitting compact
single-line JSON no longer degrades to a whole-line remove-all/add-all when one array element
changes.

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
- `timeout` kills the command's **entire process tree**, not just the direct child, and does so
  without hanging on a descendant that inherited stdout/stderr (issue #303: _"timed-out sh -c
  descendant is fully terminated"_ — `sh -c 'sleep 30 & wait'`, the supported shell-pipeline idiom
  from §11.1, leaves no live descendant, verified by PID rather than process-tree membership since
  an orphan is reparented away from the test process the instant its true parent dies). The same
  guarantee is verified end to end through a live `daemon run` subprocess and a real `daemon stop`
  (verified: `apps/cli/src/commands/cli.integration.test.ts` — _"a live daemon kills a backgrounded
  sh -c descendant on tick timeout, and shutdown leaves it dead"_), so the no-orphan property holds
  not just per-call but across the daemon's own shutdown.
- Registration + the `init --type command-poll` template + `validate` accepting/rejecting a
  `command-poll` monitor are covered at the CLI layer (AC7: verified:
  `apps/cli/src/commands/cli.integration.test.ts` — _"scaffolds a command-poll monitor that passes
  validate"_, _"rejects a command-poll monitor missing `command`"_, _"accepts a well-formed
  command-poll monitor"_, _"rejects unknown command-poll change-detection keys"_).

### 11.8 Upstream branch recipe

`command-poll` is the source-agnostic way to watch remote branch tips because it can poll the remote
without teaching the core runtime any git-specific API:

```yaml
watch:
  type: command-poll
  command:
    - git
    - ls-remote
    - origin
    - refs/heads/main
  interval: 5m
  change-detection:
    strategy: text-diff
```

The command's stdout is the watched value, so `text-diff` fires when the remote reports a different
SHA for the ref. `git ls-remote` contacts the remote directly and does not fetch or mutate local
refs. Local status/ref commands such as `git status`, `git status -sb`, or
`git rev-parse origin/main` are not equivalent remote-ahead checks: they inspect local working tree
state or local remote-tracking refs, which can stay stale until `git fetch` or `git pull`.

The `incoming-changes` source remains the right fit for local post-pull/post-merge provenance checks
touching paths (§6): it reacts after the workspace commit graph advances, not when the remote first
advertises a new commit.

The `init --type command-poll` scaffold uses this recipe so a newly generated monitor does not
silently become a local-only status check when the author's intent is upstream branch monitoring.

### 11.9 Non-goals (v1)

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

**`path` syntax (resolved).** `path` is a **minimal dotted path**. Authors may use either explicit
root form (`$.tasks`, `$.data.items`) or bare root-relative form (`tasks`, `data.items`). There are
no wildcards, array indices, filters, or recursive descent — deliberately the smallest grammar that
keeps the §12 examples valid while allowing the common monitor-author shorthand. `path` MUST select
exactly **one array**; a path that resolves to a non-array (or to nothing) is an error (surfaced at
observe time with a precise message naming the path). `ignore-paths` entries use the same dotted
syntax and address fields **within each element** (relative to the element root, e.g. `$.fetchedAt`
or `fetchedAt`). The keyed-collection `collection` block is only valid under `strategy: json-diff`;
under `text-diff`/`exit-code` (or a defaulted/absent strategy) it is rejected by
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
