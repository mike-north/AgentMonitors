# 001 — Monitor Definition & Authoring

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md)
> **Covers:** `MONITOR.md` structure, frontmatter schema, identity, scoping notes, notify semantics, authoring examples

## 1. Overview

This document specifies the authored monitor definition: where it lives, how it is parsed, what frontmatter fields mean, and which authoring constraints are part of the implementation contract.

### Why a dedicated monitor-definition spec?

The rest of the system depends on monitor definitions being stable. Runtime scheduling, source execution, hook delivery, schema generation, and validation all derive from authored monitor data. A monitor file is therefore not just a configuration convenience; it is the root object for the delivery pipeline (PP2, SP1, AP6).

### Principles Satisfied

| Section                  | Principles    |
| ------------------------ | ------------- |
| File layout and identity | PP2, SP1, SP2 |
| Frontmatter schema       | PP2, PP5, AP4 |
| Notify semantics         | PP5, PP7      |
| Scope notes              | AP5           |

## 2. Monitor File Layout

A monitor **MUST** live at one of the following two forms:

```text
<monitors-root>/<monitor-id>/MONITOR.md   (folder monitor — id = parent directory name)
<monitors-root>/<monitor-id>.md           (flat monitor — id = filename without extension)
```

Where:

- `<monitors-root>` is the directory being scanned or validated
- `<monitor-id>` is derived from the file path as described below

The parser **MUST** derive the monitor's stable machine ID using form-aware logic (SP1):

- **Folder monitor** (`<id>/MONITOR.md`): the id is the basename of the parent directory.
- **Flat monitor** (`<id>.md` directly in the monitors root): the id is the filename without its
  extension.

> Verified: `libs/core/src/parser/parse-monitor.ts` — `const base = path.basename(filePath)`, then
> `base === 'MONITOR.md' ? path.basename(path.dirname(filePath)) : path.parse(filePath).name`. A
> derived id that is empty or begins with `.` is rejected as a parse error.

The file **MUST** contain:

- YAML frontmatter
- a Markdown body, which may be empty

The parser **MUST**:

- validate frontmatter against the monitor schema
- trim outer leading/trailing whitespace from the Markdown body before storing it as monitor instructions (stored in the `instructions` field on `MonitorDefinition`)
- preserve the absolute source file path

> Verified: `libs/core/src/parser/parse-monitor.ts` — trimming at line 49 (`parsed.content.trim()`); `filePath` stored at line 51; schema validation via `monitorFrontmatterSchema.safeParse` at line 36.

The scanner discovers monitors using two glob passes relative to the supplied base directory:

1. **Folder monitors**: `**/MONITOR.md`, then excluding any match at depth-0 — a folder monitor is
   `<id>/MONITOR.md` (at least one directory deep, the folder name being the id). A bare
   `<monitors-root>/MONITOR.md` is **not** a valid monitor and is ignored.
2. **Flat monitors**: `*.md` at depth-1 only, excluding any file named `MONITOR.md` — resolves to
   flat-form monitors. Markdown assets nested inside a folder monitor's directory are intentionally
   **not** treated as monitors.

All discovered paths are resolved to absolute paths before parsing.

> Verified: `libs/core/src/parser/scan-monitors.ts` — `globSync('**/MONITOR.md', ...)` filtered to
> exclude matches whose directory is the monitors root (depth-0), and
> `globSync('*.md', ...).filter(f => basename(f) !== 'MONITOR.md')` for flat monitors.

## 3. Monitor Frontmatter Schema

Each monitor frontmatter object **MUST** contain:

| Field               | Type     | Required | Meaning                                                                                                                           |
| ------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | string   | no       | Human-readable display name; defaults to the monitor id (filename or directory name) when omitted                                 |
| `watch`             | object   | yes      | Intent-first observation config: `type` names the source; remaining keys are per-source config                                    |
| `urgency`           | string   | no       | A level (`low`/`normal`/`high`) **or** an authored band `lo..hi` (see [§3.2](#32-urgency)); **defaults to `normal`** when omitted |
| `notify`            | object   | no       | Explicit debounce/throttle policy                                                                                                 |
| `shape`             | object   | no       | Deterministic Shape declaration: derived facts + render (see [§5.1](#51-shape-declaration-current))                               |
| `payload`           | object   | no       | Author-declared payload form + transform (see [§5.2](#52-payload-form-current))                                                   |
| `baseline-strategy` | string   | no       | How the per-recipient Diff spans a catch-up span — `net` (default) or `incremental` (see [§3.7](#37-baseline-strategy-current))   |
| `tags`              | string[] | no       | Tags for later filtering                                                                                                          |

> Verified: `libs/core/src/schema/monitor-schema.ts` — the `monitorFrontmatterSchema` Zod object requires only `watch`; `urgency`, `name`, `notify`, `tags`, `shape`, and `payload` are optional. An omitted `urgency` flattens to the degenerate band `normal..normal` (i.e. `urgency: 'normal'`, `urgencyMax: 'normal'`) in the frontmatter transform, so the minimal valid monitor is a `watch:` block plus a body (`libs/core/src/schema/monitor-schema.test.ts` — "defaults a missing urgency to normal"). The `shape` and `payload` fields are **current** (G15): `shapeSchema`/`payloadSchema` accept the §5.1/§5.2 authoring surface and reject malformed CEL/jq transforms (`libs/core/src/schema/monitor-schema.test.ts`). `baseline-strategy` is also **current** (G13) — an optional `z.enum(['incremental', 'net'])` defaulting to `net` (see [§3.7](#37-baseline-strategy-current)).

### 3.1 `watch`

The `watch` block is the authoring surface for _what to observe_. It **MUST** be an object with a `type` key; all remaining keys are per-source configuration carried flat alongside `type`.

```yaml
watch:
  type: file-fingerprint # source plugin name, kebab-case
  globs:
    - 'src/**/*.ts' # per-source config flat inside watch:
  interval: 5m # scheduling hint (also inside watch:)
```

**`watch.type`** identifies the observation source plugin. It **MUST** match the pattern `/^[a-z][a-z0-9-]*$/`: it must start with a lowercase letter, and subsequent characters may be lowercase letters, digits, or hyphens. The type value is the key used to resolve the plugin in the source registry and determine runtime scheduling defaults.

> Verified: `libs/core/src/schema/monitor-schema.ts` — `watch.type` is validated via `z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'watch.type must be kebab-case')`.

**Per-source config** is everything in the `watch` block except `type`. These keys are passed directly to the source plugin's `observe()` / `watch()` methods. The core schema imposes no constraints on these keys beyond their container being an object; full validation is delegated to each source's `scopeSchema`.

**`interval`** (used by the scheduling engine to determine poll frequency) lives inside the `watch:` block as a sibling of `type`, not at the top level.

> Authoring principle: `watch.type` names the _intent_ (`file-fingerprint`, `api-poll`, `schedule`, `incoming-changes`, …), never a mechanism. This removes the "which event do I subscribe to?" question from the authoring surface.

### 3.2 `urgency`

The three urgency **levels** are `low`, `normal`, `high`, ordered `low < normal < high`. Even though earlier public docs emphasized only `normal` and `high`, the implemented schema, runtime, and CLI all support `low` (PP5).

The `urgency` field is **optional**. When omitted it defaults to the degenerate band
`normal..normal` (i.e. `urgency: 'normal'`), so the minimal monitor needs only a `watch:` block and
a body. When present, it is authored as an **urgency band** — the range the runtime is permitted to
deliver within — and **MUST** be one of:

- **A bare level**, e.g. `urgency: normal`. This is the **degenerate band** `normal..normal`: the monitor always delivers at exactly that level and a source can never escalate it. This is the historical form, so every existing monitor keeps its exact behavior (backward compatible).
- **A range** `lo..hi`, e.g. `urgency: normal..high`. `lo` is the **base / default** effective urgency (used when a source attaches no `salience`); `hi` is the **ceiling** a source's per-observation `salience` is allowed to escalate to. Surrounding and internal whitespace around the bounds is tolerated (`normal .. high`).

The schema **MUST** reject:

- A bound that is not one of `low`/`normal`/`high` (e.g. `low..critical`).
- An **inverted** range where `lo > hi` over the `low < normal < high` ordering (e.g. `high..normal`, `normal..low`).
- A malformed range (more or fewer than two bounds, or an empty bound — e.g. `low..normal..high`, `..high`).

The parsed band exposes its low bound as `frontmatter.urgency` (kept under that key for backward compatibility with every consumer that reads a single urgency level) and its high bound as `frontmatter.urgencyMax` (equal to `urgency` for a bare level).

How a source's per-observation `salience` interacts with the band — `effective = clamp(salience ?? band.lo, band.lo, band.hi)` — is specified in [002 §4.1](./002-runtime-delivery.md) and [003 §2.3](./003-source-plugins.md). Because escalation is only ever permitted **within a band the author wrote**, urgency stays user-controlled (PP5).

> Verified: `libs/core/src/schema/monitor-schema.ts` — `urgencyBandSchema` parses a bare level or a `lo..hi` range, rejects unknown/empty bounds, malformed ranges, and inverted ranges, and the frontmatter transform flattens the band into `urgency` (low bound) + `urgencyMax` (high bound). `libs/core/src/schema/types.ts` — `export type Urgency = 'low' | 'normal' | 'high'`.

### 3.4 `notify`

If present, `notify` **MUST** be one of these shapes:

```yaml
notify:
  strategy: debounce
  settle-for: 5m
```

```yaml
notify:
  strategy: throttle
  suppress-for: 30m
```

A third shape, the scheduled-rollup Pace mode (`strategy: rollup` with a required `window` cron),
is specified in [§3.6](#36-notify-rollup--scheduledwindowed-rollup-current).

Duration strings **MUST** match `^\d+[smhd]$` (one or more digits followed by exactly one of `s`, `m`, `h`, `d`). Examples: `30s`, `5m`, `1h`, `2d`.

If `notify` is omitted, default delivery behavior is defined in [002-runtime-delivery.md](./002-runtime-delivery.md).

> Verified: `libs/core/src/schema/monitor-schema.ts` — `debounceNotifySchema` at lines 5–13 (requires `strategy: 'debounce'` and `settle-for` matching `durationPattern`); `throttleNotifySchema` at lines 15–23 (requires `strategy: 'throttle'` and `suppress-for` matching `durationPattern`); `durationPattern` at line 3 is `/^\d+[smhd]$/`; `notifySchema` is a discriminated union on `strategy` at lines 25–28.

### 3.5 `tags`

If present, `tags` **MUST** be an array of strings. Tags have no runtime semantics in the current implementation and are intended for future filtering.

> Verified: `libs/core/src/schema/monitor-schema.ts` line 40 — `tags: z.array(z.string()).optional()`.

### 3.6 `notify: rollup` — scheduled/windowed rollup (_current_)

> **Status: current** (G12, capability C44; resolved
> [`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5.2). The schema accepts `rollup` alongside `debounce` and `throttle`, requiring a `window`
> cron; the runtime accumulates observations durably and flushes on the window.
>
> Verified: `libs/core/src/schema/monitor-schema.ts` — `rollupNotifySchema` (requires
> `strategy: 'rollup'` + a five-field cron `window`; optional `timezone`) is the third arm of
> `notifySchema`. `libs/core/src/runtime/service.ts` — `dispatchRollup()` (accumulate →
> `cronMatchesDate(window)` window eval → flush+clear on a non-empty window). Proven by
> `libs/core/src/schema/monitor-schema.test.ts` ("rollup notify" — accept with `window`, reject
> missing `window`/malformed cron), `apps/cli/src/commands/cli.integration.test.ts` (`validate`
> accepts a rollup monitor, rejects one missing `window`), and
> `libs/core/src/runtime/service.test.ts` ("rollup Pace mode" — durable accumulation across ticks,
> window flush+clear, empty-window no-delivery, and restart-safety of the accumulated batch).

The third Pace mode is **scheduled / windowed rollup**: the runtime accumulates all observations
produced between delivery windows and delivers them together at the next scheduled window opening
(e.g. once at 09:00 every weekday). Unlike `debounce` (settle on quiet) and `throttle` (suppress
within a fixed window), rollup makes _delivery time_ the primary constraint — the agent receives a
digest on a human-readable schedule, never per-change.

```yaml
notify:
  strategy: rollup
  window: '0 9 * * 1-5' # cron — when the window opens (required)
  timezone: America/Los_Angeles # optional; defaults to UTC
```

**Field semantics (target):**

| Field      | Type   | Required | Meaning                                                                                            |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------------------- |
| `strategy` | string | yes      | Must be `rollup`                                                                                   |
| `window`   | string | yes      | Five-field cron expression defining the recurring delivery time; same grammar as `schedule` source |
| `timezone` | string | no       | IANA timezone for `window` evaluation; defaults to `UTC`                                           |

**Interaction with observation cadence (target):** a `rollup` monitor does **not** need to observe
at low latency — if delivery is once daily there is no benefit to polling every 30 seconds. Authors
**SHOULD** pair a `rollup` notify with a relaxed `watch.interval` (e.g. `1h`), which reduces both
observation cost and token cost without changing the delivery outcome. The runtime **MUST NOT**
enforce this coupling — relaxing cadence remains the author's choice — but tooling **SHOULD** surface
a hint when a rollup monitor's `interval` is set tighter than its delivery window.

**Accumulation semantics (target):** all observations produced since the last window opening are
held in durable accumulation state in `monitorState.notifyState`. On the next window opening the
runtime flushes the entire accumulated batch as a single composite delivery, then clears the batch.
If no observations accumulated, the window opening produces no delivery (no empty pings).

**Cross-references:** [002 §4.4](./002-runtime-delivery.md) for runtime semantics; [002 §4.5](./002-runtime-delivery.md)
for the complete Pace mode reference; capability study C44 / §S5.2.

### 3.7 `baseline-strategy` (_current_)

> **Status: current.** The `baseline-strategy` frontmatter field is accepted by
> `agentmonitors validate` and enforced by the runtime per-recipient **Diff** stage whose runtime
> semantics are specified in
> [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)
> (shipped under roadmap G13). Formalizes a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5.1; ledger rows **C6**, **C7**). Default changed from `incremental` → `net` on 2026-06-19
> (strategy-call decision, Refs #110); `incremental` is now the explicit opt-out.
>
> Verified: `libs/core/src/schema/monitor-schema.ts` — `baselineStrategySchema` is a
> `z.enum(['incremental', 'net']).default('net')`; the frontmatter transform renames the
> YAML key `baseline-strategy` to `baselineStrategy` and defaults it to `net` when omitted.
> At claim, `RuntimeStore.collapseNetForClaim` (`libs/core/src/runtime/store.ts`) groups unclaimed
> events per `(monitorId, objectKey, workspacePath)` and, under `net`, delivers only the newest
> event per object — recomputing its per-recipient diff against the recipient's own cursor →
> endpoint — recording older intermediates claimed-but-suppressed (never delivered, always
> explainable via `monitor explain`). Tested by
> `libs/core/src/schema/monitor-schema.test.ts` ("baseline-strategy" — accepts `incremental`/`net`,
> defaults to `net`, rejects unknown), `libs/core/src/runtime/service.test.ts` ("baseline
> strategy (G13, 002 §1.1.7)" — omitting behaves as `net`, explicit `net` collapses N-observation
> span to one net delta, explicit `incremental` delivers N ordered deltas),
> `libs/core/src/runtime/object-consolidation.test.ts` (canonical 15-saves case +
> per-object-not-per-monitor + incremental opt-out, all end-to-end through the real runtime tick),
> and `apps/cli/src/commands/cli.integration.test.ts` (`validate` accepts `incremental`/`net`,
> rejects unknown).

A monitor **MAY** declare a `baseline-strategy` field that controls how the per-recipient **Diff**
stage ([002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current))
spans a _catch-up span_ — the set of shaped observations that accumulated since the recipient's
last-seen baseline. It is **optional**; omitting it is equivalent to `net` (the standard
per-object consolidation contract).

The two values are:

```yaml
baseline-strategy: net # default — one before/after delta per changed object per window
```

```yaml
baseline-strategy: incremental # opt-out — play-by-play of each step since baseline
```

| Value               | Diff a recipient receives across a catch-up span                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`net`** (default) | A **single before/after delta** representing _where things stand now_ versus the recipient's baseline — intermediate churn between delivery windows is collapsed into the endpoint difference. A recipient that missed three changes receives **one** net delta. Multiple objects changing in the same window each produce their own before/after event in the same claim envelope (per object, not per monitor). |
| **`incremental`**   | Every intermediate observation since the recipient's baseline, delivered **in order** (play-by-play). A recipient that missed three changes receives three deltas, in sequence. Preserves the full history of how things changed.                                                                                                                                                                                 |

**Default is `net`.** A monitor that omits `baseline-strategy` behaves as if it had declared
`baseline-strategy: net`. This is the standard delivery contract: one before/after delta per changed
object per notification window, with zero reasoning in the daemon (2026-06-19 strategy-call
decision, Refs #110).

**Choosing between the two strategies:**

- **`net`** (default) is appropriate for the vast majority of monitors: the recipient wants to know
  _where things stand now_ relative to their last baseline, not a replay of every intermediate save.
  Spec documents (E2) are the archetypal fit: an agent that missed several editing bursts wants
  "what does the spec look like now vs. what I was building against."
- **`incremental`** is the explicit opt-out — appropriate when the _sequence_ of changes carries
  meaning and the recipient needs to process each step in turn. Comment threads (E1) are a natural
  fit: each reply is a discrete step. Declare `baseline-strategy: incremental` explicitly when the
  full ordered history matters.

> **Cross-references:** [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)
> for runtime Diff semantics; capability study C6 (per-agent what's-new), C7 (size-to-span);
> §S5.1 (original decision: default incremental); 2026-06-19 decision memo in #110 (default
> flipped to net). See also §1.1.2 for the shared/per-recipient seam that makes the baseline
> per-recipient in the first place.

## 4. Monitor Identity and Uniqueness

Monitor IDs **MUST** be unique within a scanned monitor tree (SP2). The runtime stores monitor state by `monitorId`, so two monitors deriving the same ID would alias each other's persisted source and notify state — a durable-state correctness hazard, not a cosmetic one.

This is enforced (current behavior): `scanMonitors` reports folder-name collisions in `ScanResult.duplicateIds` (a `DuplicateMonitorId[]` of `{ id, filePaths }`). The runtime tick **MUST** refuse to run when any duplicate is present, and `agentmonitors validate` **MUST** fail (non-zero exit) while `scan` reports the collisions.

> Verified: `libs/core/src/parser/scan-monitors.ts` — the scan groups parsed monitors by `id` and populates `duplicateIds`; `libs/core/src/runtime/service.ts` `tick()` throws when `duplicateIds` is non-empty; `apps/cli/src/commands/validate.ts` adds duplicates to its error set and exits non-zero.

Integrators **MUST NOT** create two monitor directories with the same basename under the same monitored tree; doing so is now a hard error rather than a silent hazard.

## 5. Monitor Body Semantics

The Markdown body after the frontmatter is the monitor's handling instructions. The body is author-written guidance intended for the receiving agent. When a source observation omits its own `body`, the runtime uses these instructions as the default event body. This makes the monitor body part of the delivery contract, not mere documentation.

The stored value is the trimmed body — leading and trailing whitespace are removed. An empty body is permitted (results in an empty string after trimming).

> Verified: `libs/core/src/parser/parse-monitor.ts` line 49 — `instructions: parsed.content.trim()`; `libs/core/src/schema/types.ts` line 9 — `instructions: string` (no minimum length constraint, so empty string is valid).

### 5.1 Shape declaration (target)

> **Status: current (G15).** This section is **current** behavior. The `shape` frontmatter field
> declares Shape behavior; the schema below is the authoring surface for the deterministic **Shape**
> stage whose runtime semantics are specified in
> [002 §1.1.4–§1.1.5](./002-runtime-delivery.md#114-shape-deterministic-derived-facts). Formalizes a
> resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S2 area C, §S3 Tier 1, E8; ledger rows **C41**, **C42**, **C43**).
>
> Verified: `libs/core/src/schema/monitor-schema.ts` (`shapeSchema`: `derive` rules with CEL `when`
> predicates, `render: rendered`, malformed-CEL rejection); `libs/core/src/runtime/shape.ts`
> (`computeDerivedFacts` pure over `(snapshot, now)`, `renderArtifact` byte-stable);
> `libs/core/src/runtime/diff.ts` (`renderShapeArtifact`); wired in
> `libs/core/src/runtime/service.ts` (`processObservation` → `shapeObservation`, diffing the rendered
> artifact). Proven by `libs/core/src/runtime/shape.test.ts`,
> `libs/core/src/runtime/shape-stage.test.ts`, and `libs/core/src/schema/monitor-schema.test.ts`.

A monitor **MAY** declare a `shape` block describing the deterministic post-processing applied to the
shared snapshot before Pace and Diff. It is **optional**; a monitor with no `shape` block gets no
derived facts and no explicit render (today's behavior — the raw `snapshotText` is the diff input).

```yaml
shape:
  derive: # author-declared deterministic facts (capability C41)
    - name: past-due
      when: 'due < now' # a deterministic predicate over the shaped snapshot + injected `now`
    - name: due-soon
      when: 'now <= due && due <= now + 48h'
    - name: urgent
      when: "priority == 'high' && due <= now + 24h"
  render: rendered # produce the stable, diffable text artifact (capability C42/C43)
```

Authoring rules:

- **`shape.derive`** is an ordered list of named derived facts. Each entry has a `name` (the marker
  surfaced in the rendered artifact) and a deterministic `when` **CEL boolean predicate** evaluated
  over `(snapshot, now)` — the shaped snapshot plus the runtime-injected `now` (never an ambient
  clock — see [002 §1.1.4](./002-runtime-delivery.md#114-shape-deterministic-derived-facts)). CEL is
  used here specifically because `when` is a _condition_ (boolean selection), not a reshaping
  expression; jq is reserved for extraction/reshaping (§5.2 `payload.transform`). The predicate is a
  constrained declarative expression, **not** arbitrary code.
- **`shape.render`** opts into rendering the shaped state to the stable, token-efficient text artifact
  that the runtime then diffs ([002 §1.1.5](./002-runtime-delivery.md#115-shape-render-to-a-stable-artifact-then-diff-the-artifact)).
  The rendered form is markdown-ish text, never JSON — chosen so the diff is semantic and cheap.
- **Determinism is a validation obligation.** Because instability produces phantom diffs, a `shape`
  declaration MUST be a pure function of `(snapshot, now)`. CEL is structurally pure (no I/O, no
  clock) and a malformed predicate is **rejected at validate** (current). Statically rejecting a
  predicate that _references an identifier outside the snapshot and `now`_ remains **target** — see
  [004 §2.2](./004-validation-testing.md); today such a reference evaluates to "fact does not hold"
  (a deterministic, snapshot-only outcome) rather than a parse-time rejection.

> **What this example proves:** an author can move timestamp/aggregate reasoning below the model
> (C41), name the resulting markers, and opt into the diffable render (C42/C43) — without writing any
> code, only declarative predicates. The recipient reads _"urgent, due soon"_ rather than a raw
> timestamp it must subtract `now` from.

### 5.2 Payload form (target)

> **Status: current (G15).** This section is **current** behavior. The `payload` frontmatter field
> declares a payload form; its runtime meaning is specified in
> [002 §1.1.6](./002-runtime-delivery.md#116-author-declared-payload-form). Formalizes
> a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5 item 5, §S2 areas C/G, E5/E6/E8; ledger row **C46**).
>
> Verified: `libs/core/src/schema/monitor-schema.ts` (`payloadSchema`: the four-form enum, the
> `structured`-only transform rule, malformed-transform rejection, encoding enum);
> `libs/core/src/runtime/transform.ts` (`applyPayloadTransform` — `jq` reshapes, `cel` gates with
> `false` ⇒ suppress); wired in `libs/core/src/runtime/service.ts`. The `PayloadForm` type
> (`prose | structured | artifact | rendered`) is exported as a stable named contract. Proven by
> `libs/core/src/runtime/transform.test.ts`, `libs/core/src/runtime/shape-stage.test.ts`, and
> `libs/core/src/schema/monitor-schema.test.ts`.

A monitor **MAY** declare a `payload` block stating the **form** of what is delivered to the recipient
and, for the `structured` form, the deterministic transform that produces it. It is **optional**;
omitting it preserves today's textual (`rendered`/`prose`) delivery.

```yaml
payload:
  form: structured # one of: prose | structured | artifact | rendered
  transform: # only for form: structured — a turnkey declarative transform
    language: jq # jq (extraction/reshaping) or cel (predicate/boolean selection)
    expression: '.sets | map({weight: .weight, reps: .reps, rpe: .rpe})'
  encoding: json # output serialization: json (default) | yaml | toon | toml
```

> The bundled `jq` evaluator is `jq-in-the-browser` (chosen for CSP/Workers safety — no `Function`
> constructor or `eval`). It implements a practical subset of `jq`: object construction requires
> explicit keys (`{weight: .weight}`, not the `{weight}` shorthand), and array collection is via
> `map(...)` rather than `[ … ]` around a pipe. `cel` predicates are evaluated by `cel-js` (also
> `Function`/`eval`-free).

Authoring rules:

- **`payload.form`** MUST be one of `prose`, `structured`, `artifact`, `rendered` (the four forms of
  [002 §1.1.6](./002-runtime-delivery.md#116-author-declared-payload-form)). The form
  is **declared, not inferred** — the runtime does not guess it from the source. `prose` is the only
  form that invokes the optional Interpret stage; the other three are deterministic-floor forms (and
  `structured` is the explicit way to avoid a lossy digest for a computing recipient — E6).
- **`payload.transform`** is valid **only** when `form: structured`. Its `language` is **`jq`** or
  **`cel`**, and its `expression` is evaluated over the **canonical JSON** form of the shaped snapshot
  (predicate semantics are defined on JSON regardless of the chosen `encoding`). The transform is a
  constrained declarative expression — a turnkey affordance, **not** arbitrary user code.
- **`payload.encoding`** selects the output serialization (`json` default; `yaml` / `toon` / `toml`
  also permitted) and is a downstream concern that does not change the transform's predicate
  semantics.
- **Validation.** A `payload.transform` under any `form` other than `structured` is rejected; a
  malformed `jq`/`cel` expression is rejected; an unknown `form`, `language`, or `encoding` is
  rejected (current — see [004 §2.2](./004-validation-testing.md)).

> **What this example proves:** the same pipeline serves opposite recipients — a computing domain
> agent gets `structured` numbers via a `jq` projection (E6), while a watch-it-for-change recipient
> gets the `rendered` diffable artifact (E8) — and the choice is one declarative field, not bespoke
> code (C46).

## 6. Scope and Activation Notes

The public docs describe monitor roots at enterprise, user, and project scope. Those concepts remain useful, but the current implementation does **not** define a merge algorithm across multiple roots (AP5). What the implementation currently defines is simpler:

- commands and runtime ticks operate on one supplied monitors directory at a time
- the directory may represent project-level, user-level, or other deployment conventions chosen by the integrator

This means scope precedence, override order, and multi-root composition are outside the current contract.

### 6.1 Glob scope in `file-fingerprint` monitors (_target_)

> **Status: target.** The sigil syntax and the home-relative `~` expansion described here are
> the intended authoring contract for user-level monitors using the `file-fingerprint` source.
> The **project-level** bare-relative behavior (§3.1 below) is **current** today. The
> user-level absolute/home forms are **target** pending implementation. The bare-relative
> rejection for user-level monitors is also **target** (it requires a guard in
> `agentmonitors validate`). Fan-out of bare-relative user-level globs across all workspaces
> is tracked separately in issue #258.

The `globs` and `ignore` fields of a `file-fingerprint` monitor carry path patterns whose
resolution scope is determined by **sigil-based pattern syntax** — the leading character of each
pattern — not by a separate `scope:` discriminator field:

| Leading character | Scope class      | Resolved as                                                                                                         |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/`               | Absolute         | Interpreted as an absolute filesystem path. No expansion. Used as-is by `globSync`.                                 |
| `~`               | Home-relative    | `~` or `~/…` is expanded to `os.homedir()` before glob expansion. `~user` (other users) is **not** supported.       |
| _(bare relative)_ | Project-relative | Resolved against the workspace/config root (`context.workspacePath`). This is the current project-monitor behavior. |

**No mixing within a single monitor:** all patterns within one monitor's `globs` array MUST
belong to the same scope class (all absolute, all home-relative, or all project-relative). A
monitor that mixes scope classes (e.g., one `/var/log/…` and one `src/**/*.ts`) MUST be split
into two monitors — one per scope class. This constraint is enforced at `agentmonitors validate`
time once the target sigil-parsing logic is implemented.

**`~` expansion rule:** a pattern beginning with `~` **MUST** match one of these forms:

- `~` alone (expands to the exact home directory path)
- `~/…` (expands `~` to `os.homedir()`, then appends the rest of the path)

Any pattern beginning with `~` followed immediately by a non-`/` character (e.g. `~user/…`,
`~root`) is **not** supported. `agentmonitors validate` **MUST** reject such patterns with a
clear error: _"~user home expansion is not supported; use an absolute path or ~/… instead."_

**Scope class of a user-level monitor:** a `MONITOR.md` that lives in a user-level monitors root
(i.e., the global config root rather than a project `.claude/monitors/` directory) uses either
absolute or home-relative `globs`. Such a monitor **MUST NOT** use bare-relative `globs` —
there is no single well-defined workspace to resolve them against without project-relative
fan-out (see [003 §3.5](#) and issue #258). If bare-relative `globs` appear in a user-level
monitor, `agentmonitors validate` **MUST** reject them with a clear error:
_"Bare-relative globs in a user-level monitor are not supported until project-relative fan-out
lands (Refs #258). Use an absolute path (/) or a home-relative path (~/) instead."_

**Events produced by user-level monitors using absolute or home-relative globs** are
workspace-agnostic (`workspacePath: null`) — they project into all lead sessions, reusing the
existing `sessionsForWorkspace(null)` projection path. Project-level monitors are unchanged.

> **Examples:**
>
> ```yaml
> # User-level monitor — home-relative (target; valid user-level form)
> watch:
>   type: file-fingerprint
>   globs:
>     - '~/notes/**/*.md'
> ```
>
> ```yaml
> # User-level monitor — absolute (target; valid user-level form)
> watch:
>   type: file-fingerprint
>   globs:
>     - '/var/log/app.log'
> ```
>
> ```yaml
> # User-level monitor — bare relative (target; INVALID for user-level; rejected at validate)
> watch:
>   type: file-fingerprint
>   globs:
>     - 'src/**/*.ts' # ERROR: no workspace to resolve against in a user-level monitor
> ```
>
> ```yaml
> # Project-level monitor — bare relative (CURRENT; valid for project-level)
> watch:
>   type: file-fingerprint
>   globs:
>     - 'src/**/*.ts' # resolved against context.workspacePath; unchanged behavior
> ```

**Cross-reference:** full resolution and validation rules are specified in
[003 §3.5](./003-source-plugins.md). The project-relative fan-out case (one user-level
definition → N workspace-scoped instances) is tracked in issue #258 and is out of scope for
this release.

## 7. Authoring Examples

### 7.1 File mutation monitor

```md
---
name: Build Config Drift
watch:
  type: file-fingerprint
  globs:
    - 'package.json'
    - 'tsconfig.json'
urgency: high
notify:
  strategy: debounce
  settle-for: 30s
tags: [build, config]
---

When these files change, determine whether build behavior, dependency state, or developer setup instructions need to be updated.
```

**What this example proves:**

- monitor ID is folder-derived rather than declared in frontmatter
- `watch.type` names the source; per-source config (`globs`) lives flat alongside it
- `high` urgency is valid and can still be combined with explicit notify timing
- `settle-for: 30s` is a valid duration string matching `^\d+[smhd]$`
- the Markdown body is intended to become the fallback event body

### 7.2 Low-urgency schedule monitor

```md
---
name: Weekly Maintenance Reminder
watch:
  type: schedule
  cron: '0 9 * * 1'
  timezone: America/Los_Angeles
  label: Weekly maintenance review
urgency: low
tags: [maintenance]
---

Review stale monitors, old failed items, and event volume trends.
```

**What this example proves:**

- `low` urgency is a valid authoring value
- the schedule source uses per-source config (`cron`, `timezone`, `label`) flat inside `watch:`
- human-readable labels belong in source-specific config where appropriate

### 7.3 Daily digest rollup monitor (_current_)

> **Status: current** (G12). `strategy: rollup` is implemented; this example documents the
> authoring surface (§3.6, [002 §4.4](./002-runtime-delivery.md)).

```md
---
name: Chief-of-Staff Daily Digest
watch:
  type: api-poll
  url: 'https://api.example.com/updates'
  interval: 1h
urgency: low
notify:
  strategy: rollup
  window: '0 9 * * 1-5'
  timezone: America/Los_Angeles
tags: [digest, daily]
---

Summarize all updates since the last digest and surface any action items.
```

**What this example illustrates (target):**

- `strategy: rollup` is the third Pace mode, alongside `debounce` and `throttle`
- `window` is a cron expression defining when the accumulated batch is delivered
- `interval: 1h` relaxes observation cadence to match the delivery frequency — no benefit to polling every 30 s when delivery is once daily
- `urgency: low` is a natural pairing: rollup delivery is a background digest, not an interrupt

### 7.4 Net-delta spec-doc monitor (_current_)

> **Status: current.** `baseline-strategy: net` is the default (2026-06-19 decision, Refs #110);
> this example shows the authoring surface (§3.7,
> [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)).
> The explicit `baseline-strategy: net` line below is redundant with the default but shown for
> clarity; authors may omit it.

```md
---
name: Shared Spec Docs
watch:
  type: file-fingerprint
  globs:
    - 'docs/specs/**/*.md'
  interval: 30s
urgency: normal
notify:
  strategy: debounce
  settle-for: 3m
# baseline-strategy: net  # this is now the default — omit or include, same behavior
tags: [specs, fleet]
---

The shared spec docs have changed since you last checked. Review the net diff and determine
whether any aspect of your current task needs to be adjusted.
```

**What this example illustrates (_current_):**

- `baseline-strategy: net` is the default — a fleet of agents at divergent baselines each receives
  "how does the spec look now vs. what I was building against," not a replay of every intermediate
  edit burst (E2)
- omitting `baseline-strategy` entirely yields `net` (the default); only declare
  `baseline-strategy: incremental` when the full ordered history matters (e.g. comment threads)
- the field works alongside any `notify` strategy; the baseline strategy governs how the
  per-recipient Diff spans a catch-up span, which is independent of Pace

### 7.5 Home-relative user-level monitor (_target_)

> **Status: target** (§6.1, [003 §3.5](./003-source-plugins.md)). Illustrates a user-level
> `file-fingerprint` monitor using a home-relative `~/…` glob — valid at user-level scope. The
> events this monitor emits are workspace-agnostic (`workspacePath: null`) and project into all
> lead sessions.

```md
---
name: Personal Notes Changes
watch:
  type: file-fingerprint
  globs:
    - '~/notes/**/*.md'
  interval: 30s
urgency: normal
notify:
  strategy: debounce
  settle-for: 30s
---

Your personal notes have changed since you last checked.
```

**What this example proves:**

- `~/notes/**/*.md` is a home-relative glob (leading `~`); `~` expands to `os.homedir()` before
  glob expansion (target behavior)
- this is the correct form for a user-level monitor watching files in the user's home directory
- the monitor's events are workspace-agnostic and project into all lead sessions
- bare-relative `globs: ['notes/**/*.md']` would be rejected for a user-level monitor (no
  workspace to resolve against); `~` is the correct prefix

## 8. Validation Implications

At minimum, monitor authoring validation should be able to prove:

- the frontmatter parses successfully
- required top-level fields are present
- `urgency` and `notify.strategy` values are in-range
- duration strings are syntactically valid
- the selected source exists in the source registry
- required source-specific scope fields are present

The `agentmonitors validate` command enforces all of the above, including full per-source JSON Schema validation of the `watch` config (the `watch` block minus `type`) against each source's `scopeSchema` (via the exported core helper `validateScope`). See [004-validation-testing.md](./004-validation-testing.md) §2.2.

**Additional validation obligations for glob scope (§6.1 — target):**

Once the sigil-based glob scope logic is implemented, `agentmonitors validate` MUST also enforce:

- a `file-fingerprint` user-level monitor with bare-relative `globs` is rejected with a clear
  error referencing issue #258
- a pattern beginning with `~` followed by a non-`/` character (e.g., `~user/…`) is rejected with
  a clear error directing the author toward `~/…` or an absolute path
- a `globs` array that mixes scope classes (absolute + project-relative, or home-relative +
  absolute) within a single monitor is rejected with a clear error directing the author to split
  into two monitors

See [003 §3.5](./003-source-plugins.md) for the full source-level validation rules and the
required test matrix.
