# 002 — Runtime, Delivery & Persistence

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md)
> **Covers:** polling, source state, notify dispatch, event materialization, session projection, hook state, delivery lifecycle, daemon IPC, agent adapter contract, legacy inbox relationship, persistence schema

## 1. Overview

This document specifies how authored monitors become delivered work signals. It defines the runtime tick loop, monitor scheduling, event persistence, session-aware projection, hook state materialization, delivery claims, the daemon and IPC layer, the agent adapter contract, and the relationship between the runtime event model and the older inbox item model.

### Why a dedicated runtime spec?

The repository's most important behavior lives here: not merely detecting change, but deciding when a detected signal becomes durable, whom it is projected to, and how it is surfaced to an active agent (PP1, PP4, AP1, AP3).

### Principles Satisfied

| Section                           | Principles              |
| --------------------------------- | ----------------------- |
| Tick loop and due scheduling      | PP1, PP4, PP6, AP3, BP1 |
| Notify dispatch                   | PP5, PP7, SP4           |
| Event persistence and snapshots   | SP3, SP5                |
| Session projection and hook state | PP4, AP1, BP2           |
| Daemon and IPC                    | PP4, AP3                |
| Agent integration (adapters)      | AP1, AP3                |
| Legacy inbox split                | AP2                     |

## 1.1 Post-Processing Pipeline Model

> **Status: target.** Every rule in this section is **target**, not current behavior. It names the
> conceptual stages an observation passes through on its way to delivery and fixes their order and
> the one structural seam between them. The current runtime (§2–§9) implements a subset of this
> model — `Observe → Notify (≈ Pace) → Materialize/Diff → Project → Deliver` — under different
> names and with the diff computed once per object rather than per recipient (§5.2). This section is
> the vocabulary the follow-on pipeline work builds on; individual stages are specified in detail by
> later target work and are introduced here only to lock the names, responsibilities, and order.
> This formalizes already-resolved decisions from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S1, §S4, §S5; ledger rows C6, C15, C43). It does **not** contradict any _current_ rule: the
> current object-level diff (§5.2) is the degenerate case of the per-recipient diff below, and
> "runtime owns diffing" (PP3, AP3, [003 §2.5](./003-source-plugins.md)) is reaffirmed, not changed.

### 1.1.1 The locked stage order

An observation flows through these stages, in this order (square brackets mark **optional** stages
that not every monitor uses):

```
Observe → [Compose] → Shape → Pace → ⟦per-recipient seam⟧ → Diff → Interpret → Deliver → [React]
```

| Stage         | Side of seam            | Responsibility                                                                                                                                                                                                                                                                             |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Observe**   | Shared                  | Acquire the current state of the watched thing on a cadence (poll/watch/ingest), or compose a trigger. Owned by the source ([003 §2](./003-source-plugins.md)); the runtime owns _when_ it runs (PP3, AP3).                                                                                |
| **[Compose]** | Shared, optional        | Assemble **one** observation from multiple source queries/calls into a single composite snapshot before anything downstream (capability C40; specified for the source side in [003 §2.6](./003-source-plugins.md)). Omitted when one call already yields the whole observation.            |
| **Shape**     | Shared                  | Deterministically filter / identify / group / compute / **render** the raw snapshot into a stable, token-efficient artifact (capabilities C3–C5, C21, C41, C42). Runs **before** Pace and **before** Diff so both operate on the shaped signal, never the raw source (C43).                |
| **Pace**      | Shared                  | Decide _when_ a shaped signal becomes a candidate for delivery — settle / deadline / immediate / scheduled-rollup (the runtime's notify timing, §4). One settle decision is made once for all recipients. A clock independent of observation cadence and of per-recipient delivery timing. |
| **Diff**      | **Per-recipient**       | Compute _what is new_ for **this recipient** relative to **that recipient's** baseline/cursor (capabilities C6, C43). The only useful diff is against a specific recipient's last-seen point, so this is the first per-recipient stage.                                                    |
| **Interpret** | Per-recipient           | Optionally produce a cheap, natural-language reading of the **per-recipient delta** (summarize / suppress / triage; capabilities C10/C11/C38). Optional by default; never on the critical path. Judges the _change_ against author criteria, never the recipient's private state.          |
| **Deliver**   | Per-recipient           | Hand the right, well-timed, durable packet to **this recipient** at an appropriate delivery lifecycle (§9). Different recipients may receive different packets (or none) from one monitor.                                                                                                 |
| **[React]**   | Per-recipient, optional | An executor agent (which **may be** the recipient itself) acts on the delivered packet. Out of the runtime's delivery contract today (NP2); named here only to fix its position in the order. Specified by later target work.                                                              |

### 1.1.2 The shared / per-recipient seam

> **Status: current (G10 complete).** The structural seam below — a single shared `monitor_events`
> artifact materialized once, then diffed **per recipient against each recipient's own baseline
> cursor** — is built (PR-A) and the right-of-seam stages now exploit it (PR-B): the `net` collapse
> ([§1.1.7](#117-baseline-strategy-per-recipient-diff-semantics-current)) is a **per-recipient
> claim-time** decision, and Interpret ([§1.1.8](#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool))
> runs **once per distinct per-recipient delta**. Two lead sessions at divergent stored baselines each
> receive an independently-spanned Diff (and net/Interpret result) from one shared observation, while
> co-registered recipients still share the single computation.
>
> Verified: the per-recipient baseline cursor `session_object_cursor`
> (`libs/core/src/inbox/schema.ts`, denormalized `baseline_content` for prune-immunity) and the
> per-recipient delta `session_event_state.diff_text`. `RuntimeStore.insertEvent`
> (`libs/core/src/runtime/store.ts`) materializes ONE shared event, then for each projected lead
> session diffs the shaped artifact against that session's own cursor (seeding a first-time recipient
> to the pre-event state so a late joiner hears only changes after it registered); `markClaimed`
> advances a recipient's cursor to the artifact it was just shown. Durable writes stay before any
> Interpret await (the `ingest()` ordering invariant). Proven by
> `libs/core/src/runtime/per-recipient-diff.test.ts` (divergent-baseline fan-out, cursor
> restart-safety, session isolation, single-session backward-compat + legacy-NULL fallback,
> new-session seed).

The single most important structural fact in this model is the **seam** between Pace and Diff:

- **Everything LEFT of the seam (Observe … Pace) is computed ONCE and SHARED** across all recipient
  sessions, no matter how many recipients a monitor fans out to: one acquisition, one compose, one
  Shape/render, one Pace/settle decision. Nothing left of the seam may depend on recipient identity.
  A stage that branched on _which_ recipient is asking would have to run N times and would defeat
  the efficiency this seam exists to provide.
- **Everything RIGHT of the seam (Diff … Deliver) is PER-RECIPIENT**, because the only useful diff
  is against **that recipient's own baseline/cursor**. Two recipients that happen to hold the
  _identical_ baseline (and therefore would compute the identical span) MAY be deduplicated — the
  per-recipient work is multiplied only where baselines genuinely differ (capability C15).

This seam is what makes fan-out cheap: the expensive shared work (acquire, reduce, render, settle)
runs once; only the genuinely per-baseline work multiplies. It is the structural reason a single
monitor can serve a whole fleet without recomputing its observation per session
([capability study §S1](../product/monitoring-capability-exercises.md), ledger row C15).

> **Relationship to current behavior.** The runtime still computes a shared object-level diff once
> per object against the latest stored snapshot for `(workspacePath, monitorId, objectKey)` (§5.2,
> SP5) — that shared diff is retained on `monitor_events.diff_text` for `events list`/history display.
> On top of it (G10 PR-A), the materialized event is projected into each matching session (§6) and a
> **per-recipient** delta is computed against each session's own cursor, recorded on
> `session_event_state.diff_text`. A single session at the shared baseline (or sessions co-registered
> at the same point) reproduces the shared diff byte-for-byte — the degenerate case — while a session
> away for an hour and a session away for a day each hear the right span. This is an
> efficiency-and-correctness refinement over the prior single-shared-baseline diff, not a
> contradiction of it.

### 1.1.3 Three independent clocks

Pace timing, observation cadence, and per-recipient delivery timing are **three independent clocks**.
They compose and do not conflict: a source may observe every 30s, Pace may hold a high-urgency batch
for a 15s settle (§4.1), and an individual recipient may not be delivered to until its next
turn-boundary (§9). None of the three is derivable from the others.

### 1.1.4 Shape: deterministic derived facts

> **Status: current (G15).** This section is **current** behavior. It details the
> **Shape** stage of [§1.1.1](#111-the-locked-stage-order): the deterministic computation the runtime
> performs on a shared, post-Compose snapshot **before** Pace and **before** Diff. It is on the
> **shared** (left) side of the seam ([§1.1.2](#112-the-shared--per-recipient-seam)), so it runs
> **once** per observation regardless of recipient count. Formalizes a resolved decision from the
> monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S1, §S2 area C, §S3 Tier 1, E8; ledger row **C41**). The raw facts this stage consumes originate at
> the source/observation surface ([003 §2.7](./003-source-plugins.md)).
>
> Verified: `libs/core/src/runtime/shape.ts` (`computeDerivedFacts` — pure over `(snapshot, now)`,
> `now` injected, never an ambient clock) wired inside `materializeObservation`
> (`libs/core/src/runtime/service.ts` via `libs/core/src/runtime/shape-stage.ts`) before Diff. Proven
> by `libs/core/src/runtime/shape.test.ts` (fixed-`now` purity: a crossed threshold yields exactly
> `revealed`, one minute earlier none) and `libs/core/src/runtime/shape-stage.test.ts`.

The Shape stage **MAY** compute **derived / relative facts** from the raw observation
deterministically — facts the recipient would otherwise have to reason about, burning model tokens on
arithmetic and aggregation that has one correct answer. Computing them below the model is the point:
it is reproducible, cheap, and cannot hallucinate. (E8 records the status quo without this stage as
_"nearly 100% waste"_ — an agent doing timestamp and aggregate reasoning on every poll.)

A **derived fact** is a value computed by an author-declared deterministic rule over the shaped
snapshot (and the runtime-supplied `now`), surfaced in the rendered artifact (§1.1.5) so the
recipient reads a conclusion rather than recomputing it. The four motivating rule shapes from E8
(capability C41) are:

| Derived fact                | Deterministic rule (illustrative)                                                      | Raw inputs                     |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| **past due** / **due soon** | compare an item's `due` timestamp to `now` (and to an author-set "soon" horizon)       | a timestamp field + `now`      |
| **stalled**                 | a project all of whose tasks are blocked (no actionable next step)                     | the set of child task states   |
| **revealed**                | a deferred item whose defer-until threshold has now been crossed (`defer-until ≤ now`) | a defer timestamp + `now`      |
| **urgent**                  | a priority signal combined with deadline proximity crossing an author-set bound        | priority + a timestamp + `now` |

Rules for the derived-facts step:

- **Deterministic and reproducible.** A derived fact MUST be a pure function of the shaped snapshot
  plus the runtime-supplied `now` — the same inputs MUST yield the same fact every run. No model call,
  no network, no wall-clock read other than the injected `now`. This is what keeps the fact on the
  **shared** side of the seam (one computation serves every recipient) and out of the
  hallucination-prone Interpret stage.
- **`now` is the only time input, and it is injected.** Relative facts ("past due", "due soon",
  "revealed") are computed against the runtime-supplied `now` (the same `now` threaded to
  `observe()`, [002 §2](#2-runtime-tick-model)) — never an ambient `Date.now()` read inside the rule —
  so a tick is reproducible and testable with a fixed clock.
- **Author-declared.** Which facts to compute, and their thresholds (the "soon" horizon, the urgency
  proximity bound), are author configuration, not built-in policy — the rule set is part of the
  monitor definition's Shape declaration ([001 §5.1](./001-monitor-definition.md#51-shape-declaration-target)).
  A monitor that declares no derived facts gets none; this stage is **optional**.
- **Runs before Diff (and before Pace).** Derived facts are computed on the **shared** snapshot and
  baked into the rendered artifact (§1.1.5) **before** the per-recipient Diff, so that a fact
  _appearing_ or _changing_ (a task gaining an "urgent" marker, a "revealed" line showing up) is
  itself a diffable delta. Computing derived facts after the Diff would put recipient-independent work
  on the per-recipient side and defeat the seam.

> **Example (E8).** A `command-poll`-style monitor composes an OmniFocus whole-body snapshot
> ([003 §2.6–§2.7](./003-source-plugins.md)). Shape computes, for each task: `past due` when
> `due < now`, `due soon` when `now ≤ due ≤ now + 48h`, `revealed` when a previously-deferred task has
> `defer-until ≤ now`, and `urgent` when `priority = high ∧ due ≤ now + 24h` — all from the injected
> `now`, no model. The recipient is handed _"Ship the deck — urgent, due soon"_, never a raw
> timestamp it must subtract `now` from.
>
> **Test implication.** With a fixed `now`, a snapshot whose single task crosses its defer threshold
> produces exactly the `revealed` fact (and no other), and a snapshot one minute earlier produces
> none — proving the rule is a pure function of `(snapshot, now)` and reproducible run-to-run.

### 1.1.5 Shape: render to a stable artifact, then diff the artifact

> **Status: current (G15).** This section is **current** behavior when a monitor declares `shape`. It
> details the **render** half of Shape and pins its relationship to the **Diff** stage. Formalizes
> resolved decisions from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S1, §S2 area C/E, §S3 Tier 1, E8; ledger rows **C42** and **C43**). It refines, and does not
> contradict, the current object-level diff (§5.2): the current diff runs over `snapshotText` already;
> this names the artifact that `snapshotText` becomes once Shape renders it.
>
> Verified: `libs/core/src/runtime/shape.ts` (`renderArtifact` — byte-stable, sorted keys, facts in
> authored order) and `libs/core/src/runtime/diff.ts` (`renderShapeArtifact`); when `shape` is
> declared, `materializeObservation` (`libs/core/src/runtime/service.ts`) diffs the rendered artifact, not
> the raw source. Proven by `libs/core/src/runtime/shape.test.ts` (same shaped state → byte-identical
> artifact → no phantom diff; one crossed threshold → exactly one added `revealed` line) and
> `libs/core/src/runtime/shape-stage.test.ts` (the same, end-to-end through a runtime tick: identical
> raw source across ticks yields exactly the `revealed` line in the rendered-artifact diff).

After computing derived facts (§1.1.4), the Shape stage **MAY** **render** the shaped state into a
**stable, token-efficient, human-readable artifact** (markdown-ish text, **not** JSON), and the
runtime **MUST** then compute the **Diff** over that **rendered artifact**, never over the raw source
snapshot.

This pins the pipeline order concretely (capability C43):

```
Observe → [Compose] → Shape(compute facts → render artifact) → Pace → ⟦seam⟧ → Diff(of the rendered artifact) → …
```

Rules for the render-then-diff step:

- **Render is deterministic and stable.** The same shaped state MUST render to byte-identical text
  run-to-run: stable element ordering, stable field ordering, no transient fields (no embedded
  wall-clock unless it is a derived fact), no incidental whitespace churn. Instability here manifests
  downstream as phantom diffs (a delta with no real change), so determinism is a hard requirement, not
  a nicety. (This is the same stability the composite snapshot already requires,
  [003 §2.6](./003-source-plugins.md).)
- **The rendered artifact is the diff input.** The Diff stage (§5.2, and the per-recipient target Diff
  of §1.1.2) compares **this artifact** against the consumer's baseline. Because the artifact is shaped
  to diff cleanly, semantic deltas fall out as line-level changes for free: a newly-`revealed` task is
  a **new line**, a task becoming `urgent` is a **changed line**, a `past due` marker **appears** — all
  with zero recipient reasoning. The diff is cheap (line-level text) and semantic (the lines _mean_
  the derived facts).
- **Render is shared; the diff baseline is per-recipient.** Rendering is one shared computation (left
  of the seam, §1.1.2). The **baseline** the rendered artifact is diffed against is per-recipient
  (right of the seam): two recipients at different last-seen points see different spans of the **same**
  rendered artifact. Render once; diff that one artifact against each baseline (capability C15).
- **Why render before diff, not diff the raw source.** Diffing the raw source (a JSON body, raw CLI
  output) yields opaque, noisy deltas (a reordered key, a changed internal id) that do not correspond
  to anything the recipient cares about. Diffing the **rendered** artifact yields deltas that are
  exactly the meaningful changes, because the render already discarded the irrelevant and computed the
  derived facts. **Deterministic render is therefore a prerequisite for a useful diff** — it is why
  Shape MUST precede Diff.

> **Example (E8).** The OmniFocus snapshot renders to a markdown-ish overview — one line per task with
> its derived markers — explicitly **not** JSON. Between two ticks a deferred task crosses its reveal
> threshold: the rendered artifact gains one line, and the recipient is handed only that **delta** (a
> single new line), not the whole overview and not raw JSON to re-derive. A script could produce the
> rendered artifact today; the _monitor_ is what observes it on a tight loop and delivers **only the
> change**, cheaply and at low latency.
>
> **Test implication.** Rendering the same shaped state twice yields byte-identical text (no phantom
> diff); rendering a state with one task's defer threshold newly crossed yields an artifact whose diff
> against the prior artifact is exactly one added `revealed` line.

### 1.1.6 Author-declared payload form

> **Status: current (G15).** This section is **current** behavior. It names the
> **payload form** an author declares for a monitor — the form the shaped/diffed output takes when it
> is delivered — and the deterministic transform surface that produces a `structured` payload.
> Formalizes a resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5 item 5, §S2 areas C/G, E5/E8; ledger row **C46**). The authoring field is specified in
> [001 §5.2](./001-monitor-definition.md#52-payload-form-target); this section specifies its runtime
> meaning. It does not contradict any _current_ rule: today every monitor effectively delivers a
> `rendered`/`prose` payload (the textual diff + monitor body); the declared form generalizes that.
>
> Verified: `libs/core/src/runtime/transform.ts` (`applyPayloadTransform` — `jq` reshapes the
> delivered payload, a `cel` gate of `false` suppresses delivery entirely) wired into
> `materializeObservation` (`libs/core/src/runtime/service.ts`), and the stable exported `PayloadForm`
> type (`prose | structured | artifact | rendered`). Both evaluators are CSP/Workers-safe (no
> `Function`/`eval`): `jq-in-the-browser` and `cel-js`. Proven by
> `libs/core/src/runtime/transform.test.ts` (a `jq` projection yields the projected fields; a `cel`
> gate suppresses; a malformed transform fails validation) and
> `libs/core/src/runtime/shape-stage.test.ts` (the `structured`/`jq` reshape and `cel`-gate
> suppression end-to-end through a tick). The optional **Interpret** stage that `prose` invokes
> remains **target** ([§1.1.8](#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool), G14).

A monitor's author **MAY** declare the **payload form** — the shape of what the Shape/Deliver pipeline
hands the recipient. The four forms are:

| Form             | What the recipient receives                                                                                  | When to choose it                                                                                                                                                    | Capability evidence |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **`prose`**      | A natural-language reading of the change (an Interpret summary, [§1.1.1](#111-the-locked-stage-order)).      | A human, or a high-level orchestrator agent, who wants to be _told_ the substance.                                                                                   | E1, E2              |
| **`structured`** | Machine-structured data the recipient computes over (the result of a declarative transform, below).          | A **computing domain agent** that must operate on values precisely; a prose digest would be **lossy** (E6 — a trainer needs sets/weights/RPE, not "good chest day"). | E5, E6              |
| **`artifact`**   | A handle to a derived external artifact (e.g. a produced-document URL), mechanics hidden from the recipient. | A reaction produced something out-of-band and only the result handle should be delivered.                                                                            | E3, E4              |
| **`rendered`**   | The stable, diffable text artifact of §1.1.5 (or its per-recipient delta).                                   | A recipient that **watches/reads** a status and wants only the change (E8).                                                                                          | E8                  |

Rules for the payload-form step:

- **Form is author-declared, not inferred.** The form is part of the monitor definition
  ([001 §5.2](./001-monitor-definition.md#52-payload-form-target)); the runtime does not guess it from
  the source. Omitting it preserves today's behavior (a `rendered`/`prose` textual delivery).
- **`prose` ⇒ Interpret may run; the other forms may skip it.** `structured`, `artifact`, and
  `rendered` are deterministic-floor forms that do **not** require the Interpret stage. `prose` is the
  one form that invokes Interpret (cheap agentic summary, [capability study §S4 C45](../product/monitoring-capability-exercises.md))
  — and even then Interpret stays optional and off the critical path ([§1.1.1](#111-the-locked-stage-order)).
  Choosing `structured` for a computing recipient is the explicit way to **skip a lossy digest** (E6).
- **`structured` is produced by a declarative transform over JSON.** When the form is `structured`,
  the author declares a **turnkey declarative transform/filter** — **`jq`** (extraction/reshaping) or
  **`cel`** (significance gate) — that the runtime evaluates deterministically. The transform operates
  over the **canonical JSON** form of the shaped snapshot: even when the author _thinks_ in YAML /
  toon / TOML, the predicate/transform surface is defined on JSON (the canonical interchange form),
  and the chosen output encoding (`json` / `yaml` / `toon` / `toml`) is a downstream serialization
  concern, not part of the predicate semantics. The two languages have distinct, non-overlapping
  roles: **`jq` reshapes** — its output is the reshaped JSON delivered as the structured payload;
  **`cel` gates** — it evaluates to a boolean, where `true` delivers the canonical (un-reshaped)
  shaped snapshot as the structured payload and `false` **suppresses delivery entirely**. A suppressed
  delivery is not silently dropped: the runtime records it as suppressed so it remains explainable
  ([§1.1.1](#111-the-locked-stage-order)). To both gate and reshape, use `jq` with an explicit
  condition in the filter expression.
- **The transform is on the shared side of the seam.** A `jq`/`CEL` transform is a deterministic
  reduction of the **shared** shaped snapshot, so it runs **once** (left of the seam,
  [§1.1.2](#112-the-shared--per-recipient-seam)), not per recipient. It is **not** arbitrary user code
  — it is a constrained, declarative expression language (this is what makes it a turnkey affordance
  rather than a sandboxed-execution surface, [capability study §S5a](../product/monitoring-capability-exercises.md)).

> **Example (E6 vs E8 — the two poles).** A workout monitor declares `payload: structured` with a `jq`
> transform that projects each set's `{ weight, reps, rpe }` and the session `heartRate` — the trainer
> agent receives the **numbers** it must compute weight adjustments from, never a prose digest that
> would destroy them. The OmniFocus overview monitor (E8) declares `payload: rendered` — its recipient
> watches the diffable artifact and wants only the changed lines. Same pipeline, opposite declared
> forms, chosen by "compute precisely on it" vs. "monitor it for change."
>
> **Test implication.** A monitor declaring `payload: structured` with a `jq` projection, evaluated
> against a fixed shaped snapshot, yields exactly the projected fields (and a malformed transform
> fails validation, [001 §5.2](./001-monitor-definition.md#52-payload-form-target)); the same snapshot
> under `payload: rendered` yields the §1.1.5 text artifact instead.

### 1.1.7 Baseline strategy: per-recipient Diff semantics (_current_)

> **Status: current.** The `baseline-strategy` field and its two modes (`incremental` / `net`) are
> implemented (roadmap G13). It specifies how the **Diff** stage
> ([§1.1.1](#111-the-locked-stage-order), [§1.1.2](#112-the-shared--per-recipient-seam)) spans a
> **catch-up span** when a recipient has missed several changes between deliveries. The two modes are
> parameterized by the `baseline-strategy` authoring field
> ([001 §3.7](./001-monitor-definition.md#37-baseline-strategy-current)). Formalizes a resolved
> decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5.1; ledger rows **C6**, **C7**). The source/runtime diff split (PP3, AP3,
> [003 §2.5](./003-source-plugins.md)) is unchanged — the baseline strategy parameterizes the
> per-recipient Diff already named in §1.1.2, not a new diff surface. Default changed from
> `incremental` → `net` on 2026-06-19 (strategy-call decision, Refs #110).
>
> Verified (G10 PR-B, Refs #182; default-net, Refs #110): the `net` collapse is **per recipient at
> claim time**, not on the shared span. The shared `monitor_events` chain records **every**
> observation in order — the incremental substrate (Decision Q3, precise over cheap) — so an away
> recipient can be served a correct net delta against **its own** cursor. At claim,
> `RuntimeStore.collapseNetForClaim` (`libs/core/src/runtime/store.ts`, driven by
> `AgentMonitorRuntime.claimDelivery` in `libs/core/src/runtime/service.ts`) groups a recipient's
> unclaimed events per `(monitorId, objectKey, workspacePath)`; for a `net` monitor it delivers only
> the **newest** event per object — with its per-recipient `diff_text` recomputed as
> `buildDiff(cursor.baselineContent, newestArtifact, strategy)` (cursor → endpoint; strategy-aware
> as of issue #437 — structural for `strategy: json-diff`, `buildTextDiff`'s line-level diff
> otherwise, per [§5.2](#52-snapshots-and-diffs)) when the group actually collapsed — and records
> the older intermediates **claimed-but-suppressed** (`session_event_state.net_suppressed_at`):
> retained and explainable via `monitor explain` ([§10.7](#107-monitor-pipeline-diagnosis)), never
> delivered. `incremental` (explicit opt-out) delivers all in order. The per-recipient cursor still
> advances to the newest claimed artifact (`markClaimed`) even when intermediates are suppressed.
> The monitor's `baseline-strategy` is persisted on each `monitor_events` row (`baseline_strategy`)
> so the claim-time decision needs no monitor re-scan.
> Tested by `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-N → one net delta + 2
> suppressed; `incremental` contrast; missed-nothing degenerate; shared-chain keeps all N),
> `libs/core/src/runtime/json-diff-wiring.test.ts` (net-collapse recomputation renders
> structurally and survives a persistence round-trip, issue #437),
> `libs/core/src/runtime/service.test.ts` ("baseline strategy (G13, 002 §1.1.7)" — omitting ≡
> `net`, explicit `net` → 1 delta, explicit `incremental` → N ordered deltas; rollup
> not-due/due-path parity tests), and
> `libs/core/src/runtime/object-consolidation.test.ts` (canonical 15-saves → 1 delta end-to-end;
> two objects → two deltas in one envelope; incremental opt-out → N deltas). The full
> per-recipient-baseline seam — two recipients at **divergent** stored baselines each receiving an
> independently-spanned net Diff — is **current** (G10 complete).

A **catch-up span** is the set of shaped observations that accumulated for a monitor between a
recipient's last-seen baseline and the current delivery point. When a recipient has been away for
multiple observation cycles, its catch-up span may contain several intermediate observations.

The `baseline-strategy` field declares how the runtime's per-recipient **Diff** stage processes
this span:

| Strategy            | What the recipient receives for a catch-up span                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`net`** (default) | A **single before/after delta** representing _where things stand now_ versus the recipient's baseline — intermediate observations between delivery windows are collapsed into the endpoint difference. A recipient that missed _N_ shaped observations receives **one** delta. Multiple objects changing in the same window each produce their own before/after event in the same claim envelope (per object, not per monitor). |
| **`incremental`**   | Each intermediate observation since the recipient's baseline, **in order** — a play-by-play of every change step. A recipient that missed _N_ shaped observations receives _N_ deltas, sequentially.                                                                                                                                                                                                                            |

**Semantics of each strategy:**

- **`net` (default).** The runtime collapses the catch-up span per object: it compares the shaped
  state at the _delivery point_ against the recipient's baseline and delivers a single net delta.
  Intermediate observations — edits, reverts, re-edits — are absorbed; only the endpoint difference
  surfaces. This is the standard delivery contract: one before/after delta per changed object per
  notification window, with zero reasoning in the daemon (2026-06-19 strategy-call decision,
  Refs #110). The envelope may carry multiple events when multiple objects changed. Shared spec
  documents (E2; capability C7 "size/shape the change to the span") are the archetypal fit: an
  agent that missed several editing bursts wants "what does the spec look like now vs. what I was
  building against."

- **`incremental` (explicit opt-out).** The runtime delivers each observation in the catch-up span
  individually and in the order they were materialized. The recipient sees the full play-by-play.
  This is appropriate when the _sequence_ of changes carries meaning — when a recipient needs to
  know not just the final state but how things evolved. Comment threads (E1; capability C6) are a
  natural fit: each reply is a discrete step. Declare `baseline-strategy: incremental` explicitly
  when the full ordered history matters.

**Default is `net`.** A monitor that omits `baseline-strategy` **MUST** behave as `net`. This is
the default because:

1. It is the standard per-object consolidation contract: one before/after delta per changed object
   per notification window, the most useful signal for the vast majority of monitors.
2. Authors who want the full ordered history must declare it explicitly — `incremental` is an
   intentional opt-in to the more verbose delivery mode.

**Interaction with the shared / per-recipient seam.** The baseline strategy is a per-recipient
concern: it governs how the Diff stage (right of the seam, §1.1.2) processes a specific
recipient's catch-up span. It does **not** affect the shared side of the seam (Observe, Shape,
Pace run once, unchanged) — the shared `monitor_events` chain records **every** observation in order
regardless of strategy (the incremental substrate, Decision Q3). The `net` collapse is applied **per
recipient at claim time**: when a recipient claims its unclaimed catch-up span, its events are
grouped per `(monitorId, objectKey, workspacePath)` and, under `net`, only the newest event per
object is delivered (its delta recomputed against **that recipient's** cursor → endpoint), with the
older intermediates recorded **claimed-but-suppressed** (retained and explainable via `monitor
explain`, §10.7 — never delivered, never a silent drop). Two recipients of the same monitor at
different baselines each receive their own collapsed span. A within-tick burst that emits several
observations for one object collapses the same way (the newest of the burst is the surviving net
delta for an away recipient).

**Event order and equal-time endpoints.** Event delivery, `net` endpoint selection,
claimed cursor advancement and event listings order by persisted observation `created_at`
first, then private SQLite `monitor_events.sequence`. Timestamps remain second-precision;
this does not recover discarded millisecond observation ordering. The sequence resolves
only equal persisted timestamps by committed materialization order across writers. A
later insertion with an earlier observation timestamp does not displace a newer-observed
endpoint. Public event IDs and `MonitorEventRecord` shapes are unchanged.

The pure collapse decision consumes candidates already in canonical equal-time order.
Store pending/unread queries establish this order; preview filtering and transport caps
preserve it. The mutating `collapseNetForClaim` boundary reloads authoritative records
by candidate ID and orders them from SQLite before choosing endpoints, including mixed
urgency concatenations and externally supplied arrays. Unknown or duplicate IDs fail
before mutation; caller-modified artifacts do not override persisted content. Raw shared
candidate records retain that representation, including `listEvents(session)` records
that carry optional delivery state with a shared diff. Only a delta different from the
shared event requests a recipient delta view: the return value uses the **requested
session's current persisted projection**, not supplied delta text.
This preserves incremental/single-net views and refreshes stale re-anchored deltas without
falling back to shared history. Optional delivery state is refreshed independently when
requested; its presence never changes the delta representation. If the event has no
projection for that session, existing raw-event behavior remains; this ordering boundary
does not add a new authorization model. Preview, actual
claim and cursor advancement use the same ordering contract.

Event sequence allocation occurs within existing event/projection/cursor/snapshot
atomicity. Its transactional migration preserves all row fields, public IDs, logical
references and explicit indexes/triggers. As for snapshots (§5.2), current hidden rowid
is the legacy bootstrap policy, not reconstructed lost chronology. Rollback leaves no
committed position, deletion does not reuse committed positions, and VACUUM/reopen
preserve them. No observation-history or source-frontier contract changes are implied.

**Interaction with Pace modes.** The baseline strategy is independent of the Pace mode. A `net`
strategy on a `debounce` monitor still settles first (Pace), then collapses the catch-up span for
delivery (Diff). A recipient that was live for every settled observation and never missed a window
receives a zero-span catch-up regardless of strategy — `incremental` and `net` are identical in
this degenerate case (no intermediate steps to collapse).

> **Cross-references:** [001 §3.7](./001-monitor-definition.md#37-baseline-strategy-current)
> for the authoring field; capability study C6 (per-agent what's-new), C7 (size-to-span), E1 and
> E2 (the two motivating contrasts); §S5.1 (original decision: default incremental); 2026-06-19
> decision memo in #110 (default flipped to net).
>
> **Test implication.** A monitor that omits `baseline-strategy` (or declares `net`) and a
> recipient that missed three observations receives **one** net delta equivalent to diffing the
> baseline snapshot against the final observation's snapshot. A monitor with
> `baseline-strategy: incremental` and a recipient that missed three observations receives three
> deltas in order. In both cases a recipient that missed nothing receives the standard single-step
> delta — `incremental` and `net` are behaviorally equivalent when the catch-up span contains
> exactly one observation.

### 1.1.8 Interpret: a cheap agentic digest via the user's own AI tool

> **Status: current** (G14, Refs #178). The rules in this section are implemented behavior. It
> details the **Interpret** stage of [§1.1.1](#111-the-locked-stage-order): the optional, cheap,
> agentic reading of the **per-recipient delta** that runs **after** the per-recipient Diff and before
> Deliver, on the **per-recipient** (right) side of the seam
> ([§1.1.2](#112-the-shared--per-recipient-seam)). It is invoked **only** when the author declares
> `payload.form: prose` ([001 §5.2](./001-monitor-definition.md#52-payload-form-target),
> [§1.1.6](#116-author-declared-payload-form)); the other three forms skip it. The stage is disabled
> unless an `InterpretAdapter` is injected into `AgentMonitorRuntime`, so the default (no adapter)
> behavior is the degenerate, fully-backward-compatible case. Formalizes a resolved
> decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S4, resolved §S5 item 3; ledger rows **C45/C10/C11/C38/C12**, with E5 as the flagship — the first
> scenario where this stage _is_ the product, not a layer above the deterministic floor). It does
> **not** contradict any _current_ rule: today every monitor delivers its textual diff with no agentic
> reading, so Interpret being absent is the degenerate (and default) case, and the runtime's existing
> deterministic `structured`-`cel` gate ([§1.1.6](#116-author-declared-payload-form)) is the
> _deterministic_ sibling of the _agentic_ gate below — they are distinct stages, not competitors.

The runtime **MAY**, for a `prose`-form monitor, run an **optional Interpret stage** that produces a
**cheap, natural-language digest** of the per-recipient delta — and, optionally, applies an **agentic
significance gate** that suppresses delivery when the change is not substantive (capabilities
C10/C11/C38). Interpret is the one stage that invokes an AI model; everything left of it is
deterministic.

**Rules for the Interpret stage:**

- **Optional, and never on the critical path.** A monitor that does not declare `payload.form: prose`
  gets no Interpret stage; the deterministic-floor forms (`structured` / `artifact` / `rendered`,
  [§1.1.6](#116-author-declared-payload-form)) deliver without it. Even for a `prose` monitor,
  Interpret is best-effort: an Interpret failure (the tool is missing, errors, or times out) **MUST
  NOT** drop the underlying delta — the runtime falls back to delivering the deterministic
  `rendered` artifact of §1.1.5 (degrading to today's behavior) and records the Interpret failure as
  explainable (below). Delivery correctness never depends on a model call succeeding (PP4, AP3).

- **Runs after Diff, on the per-recipient delta.** Interpret consumes the output of the per-recipient
  Diff ([§1.1.2](#112-the-shared--per-recipient-seam)) — _what is new for this recipient_ — never the
  raw source snapshot and never the whole shared artifact. Because it is right of the seam, an
  Interpret call **MAY** be deduplicated across recipients that computed the **identical** span
  (capability C15), but otherwise multiplies per genuinely-distinct baseline. It is sized to the span:
  a one-line change yields a one-line digest (C10).

- **Judges the change against author criteria, never the recipient's private state.** Interpret may
  classify the delta against **author-supplied criteria and reference data** ("is this a question I
  must answer?", "is the sender on the VIP roster?" — C38, the multi-class triage of E5; C11 is its
  binary passing-vs-notify case). It **MUST NOT** depend on the receiving agent's private runtime
  context — the same stable boundary the capability study fixed across E2 and E5
  ([§S2 area F](../product/monitoring-capability-exercises.md)). This keeps Interpret a pure function
  of `(delta, author criteria/data)` and therefore portable across recipients and explainable in
  isolation.

- **Runs via the user's own installed AI tool — Agent Monitors ships no model and holds no
  credentials.** The digest/gate is produced by **shelling out to whatever AI CLI the user already
  has installed** (e.g. `claude -p …`, resolved §S5 item 3 / C45). This is a first-class
  **trust/compliance principle**, not merely an implementation detail: summarization runs through the
  user's _existing_ tooling, so the deployment **inherits the user's existing data-governance and
  egress posture by construction**. Agent Monitors never becomes a model vendor or a
  data-exfiltration surface — it senses and routes; the user's own tool reads. (Distinct from the
  heavy executor of the [React] stage, which is likewise the user's own agent, [§S4](../product/monitoring-capability-exercises.md).)

- **The tool invocation is host-agnostic, behind an adapter interface — never in the runtime core.**
  Which AI tool to invoke, the command string, and how to pass the delta in / read the digest out are
  **host-specific** and **MUST** live behind an adapter boundary, exactly as Claude-specific hook
  names and transcript behavior live in the Claude adapter (`libs/core/src/adapter/claude.ts`) and
  never in the runtime core (the host-agnostic-core invariant, §11.1, AP3). The runtime core owns
  _when_ Interpret runs (after Diff, before Deliver), _whether_ it runs (the `prose` gate), and the
  recording of its decision; an adapter owns _how_ the user's tool is invoked. A new host that wires a
  different AI CLI is a new adapter, not a change to the core. Where the digest is a delivery-transport
  concern, see [006](./006-agent-integration.md).

- **The agentic significance gate is distinct from the deterministic `cel` gate.** Two suppression
  mechanisms exist and **MUST NOT** be conflated:

  | Gate                          | Stage / side of seam                              | Decides by                                                | Suppresses when                                |
  | ----------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
  | **`cel` significance gate**   | Shape / `structured` payload, **shared** (§1.1.6) | a deterministic boolean predicate over canonical JSON     | predicate is `false`                           |
  | **Agentic significance gate** | Interpret, **per-recipient** (this section)       | cheap model judgment of the delta against author criteria | the change is judged not substantive (C11/C38) |

  The deterministic `cel` gate runs **once** on the shared shaped snapshot and is reproducible and
  hallucination-free; reach for it whenever the "is this substantive?" decision can be expressed as a
  predicate (it is cheaper and auditable). The agentic gate exists for the **irreducibly agentic**
  judgments a predicate cannot express — "is this Slack mention a question I must answer vs. idle
  chatter?" (E5) — and runs per-recipient inside Interpret. An author **MAY** use both: a deterministic
  `cel` pre-filter on the shared side, then an agentic gate on what survives, per recipient (the
  "deterministic-first, agentic-second" pattern of [§S2 / E5](../product/monitoring-capability-exercises.md)).

- **Every suppress/deliver decision is recorded and explainable.** When Interpret suppresses (the
  agentic gate fires) or delivers, the decision and its reason **MUST** be recorded so that **"why
  nothing fired" is inspectable** (capability C12 — the silent-failure-honesty invariant). Because the
  Interpret decision is **per-recipient** (right of the seam), it is recorded on the per-recipient
  delivery/projection surface (`session_event_state` projection, surfaced by the
  projection-and-delivery stage of `monitor explain`, §10.7) — **not** the shared, tick-level
  `observation_history` (§15), which records the _deterministic_, pre-seam outcomes (`triggered` /
  `suppressed` / `no-change` / `no-files-matched` / `errored` / `rebaselined`) and where the deterministic `cel`-gate
  suppression already lands. A recipient (or its operator) **MUST** be able to ask the pipeline why a
  delta did or did not surface for that recipient and receive the recorded Interpret verdict
  (deliver / suppressed-as-not-substantive / interpret-failed-fell-back), never silence. An agentic
  suppression is a deliberate, recorded outcome — never a silent drop.

> **Example (E5 — Interpret is the product).** A chief-of-staff monitor watches a Slack mention stream
> with `payload.form: prose`. Shape deterministically pre-filters to mentions of the principal and does a
> reference-data VIP-roster lookup (a `cel`/`jq` step, shared, no model). On what survives, Interpret
> runs the user's own `claude -p` per recipient to classify the delta against the author's criteria:
> _passing chatter_ → the agentic gate suppresses (recorded as suppressed-not-substantive, C11/C12);
> _a question, VIP involvement, or an action item_ → a one-line digest is delivered (C10/C38). Agent
> Monitors supplied no model and saw no credentials; the principal's own Claude install read the
> message, inheriting their org's data-governance posture.
>
> **Test implication.** With the user's AI tool stubbed by a deterministic fake adapter (host-agnostic
> boundary, §11.1): a delta the fake classifies "passing" produces **no** delivery and a recorded
> per-recipient suppression reason retrievable via `monitor explain` (§10.7); a delta classified
> "question" produces a `prose` delivery whose digest is the fake's output. A monitor **without**
> `payload.form: prose` never invokes the adapter at all. When the fake adapter throws, the recipient
> still receives the §1.1.5 `rendered` artifact (best-effort fallback) and the Interpret failure is
> recorded as explainable — proving delivery never depends on the model call succeeding.

**Interpret runs at materialize on the per-recipient single-event delta — the common case
(Decision Q4).** Interpret is invoked on each per-recipient delta as it materializes (after the
per-recipient Diff, before Deliver), deduplicated across recipients that computed the **identical**
delta and multiplied per genuinely-distinct baseline. A later claim-time `net` collapse
([§1.1.7](#117-baseline-strategy-per-recipient-diff-semantics-current)) re-diffs the surviving
delta against the recipient's cursor → endpoint, but it **does not re-invoke the adapter** unless the
collapsed delta string differs from what was already interpreted (the recorded digest stays valid for
an unchanged delta). This keeps Interpret off the claim critical path: the common case (a recipient
whose per-recipient delta is a single materialized event) carries its already-computed digest into
delivery, and only a genuinely-changed collapsed delta would warrant a fresh reading.

Verified (G10 PR-B): per-recipient distinct-delta dedup is implemented in `runInterpret`
(`libs/core/src/runtime/service.ts`) — it groups projected sessions by their distinct
`session_event_state.diff_text` and invokes the adapter once per distinct delta, recording the
verdict on every session in that group. Proven by
`libs/core/src/runtime/net-per-recipient.test.ts` (two recipients at **divergent** baselines → adapter
invoked **twice**, distinct digests recorded per session; **identical** baselines → invoked **once**,
verdict fanned).

Verified: `libs/core/src/adapter/interpret.ts` — `InterpretAdapter` interface and
`createClaudeInterpretAdapter` (the host-specific `claude -p` argv-only invocation, behind the
adapter boundary); `libs/core/src/runtime/service.ts` — `interpretMaterializedObservation` invokes the stage only
for `payload.form: prose` and only when an adapter is injected, `runInterpret` records each
per-recipient verdict and falls back on failure; `libs/core/src/runtime/store.ts` —
`recordInterpretDecision` plus the `notInterpretSuppressed` delivery exclusion;
`libs/core/src/inbox/schema.ts` / `db.ts` — the `session_event_state.interpret_decision /
interpret_reason / interpret_digest` columns (additive migration). Proven by
`libs/core/src/runtime/interpret-stage.test.ts` (proof criteria a–e: prose-only invocation,
substantive→deliver-with-digest, not-substantive→no-delivery-with-explainable-reason,
tool-throws→rendered-fallback-recorded, no-adapter→no-AI-call) and
`libs/core/src/adapter/interpret.test.ts` (the concrete adapter's argv/stdout contract).

## 2. Runtime Tick Model

For each runtime tick, the implementation **MUST**:

1. scan the supplied monitors directory for `**/MONITOR.md`
2. parse valid monitor definitions and collect parse errors separately
3. resolve each parsed monitor's `source` name against the source registry
4. fail the tick if a parsed monitor references an unknown source
5. validate the source-specific `watch` config (minus `type`) with `validateWatchScope`; skip invalid config before scheduling, observation, notify processing, or admission, so a rejected config records no drop and queues no retry
6. determine whether the monitor is due to run
7. call the source's `observe()` method with: the monitor's `scope`, the monitor's previously persisted source state if any, the runtime-supplied `now` timestamp
8. route returned observations through notify dispatch
9. materialize emitted observations as durable events, queue failed envelopes, and persist updated source/notify state in one immediate transaction
10. report emitted ids and errors from the committed result
11. refresh hook state for sessions in the affected workspace

A materialization failure rolls back that envelope's event/projection/cursor/snapshot transaction.
Earlier successful siblings remain events; the failed envelope and every later sibling enter the
bounded outbox before source/notify state advances, when the outbox can retain that whole ordered
suffix (below). If the outbox write or the state write fails, the outer transaction rolls back the
batch and retains the prior source baseline. Interpret and the audit rows other than an
unretained failure's `errored` outcome run best-effort only after that durable boundary.

#### Admission outcomes when the outbox cannot retain a suffix

_Current._ Every observation a span dispatches **MUST** reach exactly one durable outcome,
committed in the same transaction as the span's source/notify state:

1. a materialized event (with every recipient projection, cursor seed and snapshot);
2. a queued retry in the bounded outbox; or
3. an `errored` `observation_history` row whose error says why the observation was not retained.

The outbox can retain a failed observation only together with its whole ordered suffix: the
failed envelope and every later sibling. The suffix is retainable when every envelope in it is
inside the outbox's plain-data domain and all of it fits the monitor's remaining capacity
(256 rows / 8 MiB per workspace/monitor, terminal rows included; see
[`materialization_retry_outbox`](#materialization_retry_outbox)). The runtime decides this inside
the admission transaction, before it writes to the outbox:

- **Retainable.** The suffix is queued in order, as above.
- **Not retainable.** Replaying the span would fail the same way, so holding the baseline would
  stop the monitor permanently. Instead, the failed observation gets an `errored` row in the
  admission transaction. Its error is the materialization error followed by
  `Not retained for retry:` and the reason: either the outbox capacity is exhausted (records and
  bytes needed vs remaining), or the envelope, or a later sibling in its suffix, is not
  serializable for the outbox. The row also names which observation was lost (see
  [`observation_history`](#observation_history)). Admission then continues with the next sibling. Nothing older is queued ahead of
  it, so materializing it cannot reorder the span. A later failure in the same span is decided
  the same way, for its own suffix.
- **Never part of a suffix.** The runtime never queues part of a suffix: a later sibling would
  then materialize ahead of an older queued observation.

The source baseline advances once every observation has an outcome. Writing an `errored` row is
a storage write like any other: if it fails, the span rolls back and the baseline is held. A
transaction-wide failure (below) still rolls back the whole span. So does a storage failure of the
outbox or state write. Neither is a refusal decided in advance, so both keep the prior baseline
for replay. No ingest path drops an observation silently. The tick result's
`erroredObservations` and the watcher's `onError` report the failure. `monitor history` lists the
committed `errored` row.

A dropped observation **MUST NOT** be less visible than a retained one. A drop stays
_outstanding_ until it is _superseded_, and only these outcomes supersede it:

- **A drop with an object key** (the observation's `objectKey` was a string) is superseded by a
  later event of the same monitor id, in the same workspace, for exactly that object key. An event
  of another monitor or another workspace for the same key does not supersede it. "Later" means
  the event's observation was **admitted** after the drop, not merely committed after it.
  Admission order is the `monitor_events` materialization order: an event materialized in its
  admitting span takes its `sequence` there, and a retained observation reserves the next position
  of the same AUTOINCREMENT counter when its retry is queued (`admission_sequence`), which its
  event keeps when the retry completes. The drop row records that counter's high-water mark inside
  the admission transaction, and only an event whose admission position (`admission_sequence`,
  else `sequence`) is above it counts. So a later sibling in the dropping span, a later span and a
  rollup or debounce flush count, and so does a retry admitted after the drop (a later sibling of
  the dropping span that was retained, or a later span's) once it completes. A retry admitted
  before the drop carries older state for the key and never supersedes it, even when it completes
  after the drop. An event's `created_at` is observation time, which a flush or retry carries over
  from the original observation, so it cannot order events against the drop.
- **A drop without an object key** is superseded by a later span of the same monitor in the same
  workspace that materializes at least one event and drops nothing: a later `triggered` batch row
  whose `notRetainedCount` is absent or zero, ordered after the drop row by `(created_at, id)`. The
  dropping span's own batch row carries its count, so it never supersedes its own drops.

Nothing else clears a drop: not a `no-change` (or `no-files-matched`) tick, not a debounce or
rollup hold (`suppressed`), not an observe failure, not a later span whose only failure was
retained, not a later span that materializes events only for other keys, and not a daemon restart.
Every drop is counted separately, so one superseded drop does not clear another. While a drop is
outstanding:

- `explainMonitor`'s materialization stage is `failure` (§10.7), so its verdict fails;
- `doctorReport` attaches `unretainedObservationLoss` to that monitor's rollup: the outstanding
  count and the newest outstanding drop's time, error, position, span size, `objectKey` and
  `title`. `doctor` fails that monitor's check with the reason ([005](./005-cli-reference.md)
  per-monitor rollup).
- When the monitor has no one unambiguous parsed definition (its definition was removed, fails to
  parse, or its id is duplicated), the loss goes to that id's entry in `orphanedMonitorWork`
  instead (`monitorKind: "persistent"`), beside any retained work, with the same per-id rule as
  retained work: a duplicated id's rollups omit it and its one orphan group carries it. A parsed
  definition that fails validation keeps the loss on its rollup. That includes a definition whose
  source config the preflight (§2.0) now rejects: the preflight runs before admission, so the
  rejected config records no new drop and queues no retry, and the drop it already has stays
  outstanding until an observation made after the config is corrected supersedes it. `monitor
explain` reports that drop as a `failure` materialization stage after the definition failure,
  which stays the verdict.
- An ephemeral monitor ([007 §4](./007-agent-facing-interaction.md)) has no definition file, so it
  has no rollup. While it is `active` its loss and retained work are attributed to it in
  `ephemeralMonitorWork` (with its declaring `sessionId`), not reported as orphaned. If its
  persisted scope is now rejected by the source's preflight (the check every tick applies), the
  group also carries `validationError`: the tick skips the watch, and an ephemeral scope cannot be
  edited, so nothing it owes can clear. Cancelling the watch and declaring it again with a valid
  scope restores observation, but the new declaration gets a new id: this id's outstanding loss
  and retained work stay reported under its retired id, as below. The field is absent while the
  scope is accepted. Once it is cancelled or reaped it is _retired_: its outstanding loss and
  retained work stay visible in `orphanedMonitorWork` with `monitorKind: "ephemeral"`, as a
  removed definition's do. A retired
  ephemeral monitor never observes again, so nothing supersedes its drop; it stays outstanding.
- `doctor` fails a `dropped-observation:<id>` check for each of these cases, so the loss never
  disappears with its definition or its declaration.

Both read the durable rows through `RuntimeStore.outstandingUnretainedObservationLoss()`
(internal), so the answer is the same with or without a daemon and across restarts. The lookup
runs on every doctor and explain call, so it is indexed: a partial index on drop rows, an
`observation_history (monitor_id, workspace_path, result, created_at, id)` index for the later
span, and a `monitor_events (monitor_id, workspace_path, object_key, sequence, admission_sequence)`
index for the later event, all created by the additive schema migration.

For example, 600 observations with a native `RAISE(ABORT)` on the 300th leave a 301-record suffix,
which no empty outbox can hold. The span commits 599 events, one `errored` row naming capacity, and
the advanced baseline. The next tick observes newer input. A BigInt payload fails event persistence
and is outside the outbox domain: that one observation is `errored` and its siblings materialize.

The same rule applies to the poll path (`ingest()`), the watch path (one yielded batch is one
span, §2.4), and the not-due rollup window flush (`flushRollupWindow()`, §4.4). For the rollup
flush, the notify state that clears `pendingRollup` commits in the same transaction as the
flushed span. A flush that rolls back leaves the whole window held, records a best-effort
`errored` row, and reports the error on the tick result. The next window check retries it.

Verified by `libs/core/src/runtime/unretainable-suffix-admission.test.ts`: a capacity overflow on
the poll path, with its drop row, batch-row count, explain verdict and doctor rollup, kept
through a later span of other keys and cleared by a later event for its key; a keyed drop kept
through a `no-change` tick, an observe failure, a retained-only span and a span of other keys; a
same-key event of another monitor or workspace that does not clear it; a later sibling of the
same key that does; an unkeyed drop kept through quiet ticks and a span that drops again and
cleared by a span that materializes and drops nothing; a rollup drop kept through the next hold
and cleared by the flush that materializes its key; a drop kept across reopening the store; a
drop of a removed, unparseable, duplicated or invalid definition reported in doctor; a drop kept
outstanding across a later observe failure and accumulated with a later drop; a span whose only
observation is dropped, kept through later quiet ticks; bounded, control-free identity text with
no payload; explain and doctor failing for both a retained and a dropped failure; an exact-fit and one-over boundary in an outbox filled by earlier ticks; a full
outbox; a BigInt payload; a non-serializable later sibling; rollup window flushes that overflow,
fit, or roll back; and watch batches over capacity or with a BigInt payload. Each asserts the
three-outcome invariant and that the next tick or batch makes progress.

Suffix retry admission applies only while the owning SQLite transaction is still active after
an envelope failure. A savepoint-local `RAISE(ABORT)` may retain an earlier successful prefix
and queue the suffix. A transaction-wide `RAISE(ROLLBACK)` instead aborts the entire span:
the runtime **MUST** rethrow the original materialization error before any fallback retry or
checkpoint write. It must not start a replacement transaction to retain only the suffix after
the prefix has disappeared. Prior committed events/projections and the recipient cache survive;
the prior source checkpoint and held notify envelopes remain available for complete replay.
The native liveness predicate belongs to the same private SQLite connection as the registered
package-private transaction runner; it is not a source/plugin hook or a public transaction mode.
Verified by the real SQLite rollback/ABORT, nonempty committed-cache and forced-due reopen cases
in `poll-admission.test.ts`, and for a held not-due rollup flush (including an envelope captured
before a parsed source edit) in `rollup-admission.test.ts`.

The complete finite span **MUST** be committed before the first Interpret invocation: all successful
events, every recipient projection/cursor seed, sequential object snapshots (including empty text),
ordered retry suffix, and source/notify checkpoint are visible from an independent connection while
that first invocation is suspended. Held notify observations also belong to admission, even when
no event is emitted. An outer failure preserves prior source and notify state, all prior committed
rows, and the store's last-committed recipient cache; restart can retry from that prior state.

Admission **MUST** read current source/notify state and decide notify dispatch under the same immediate
transaction as its writes. A normalized serialized source-baseline token is captured before invoking
external observation code, so mutating the context object cannot change the expected baseline.
If the persisted source token changed before admission, the batch is refused without overwriting
the winner's checkpoint or held work, including an empty batch that omits `nextState`. Notify-only
updates committed before admission participate in the fresh dispatch decision. This guards changed
baselines; it does not provide cross-process leader election or distinguish an ABA return to the
same serialized source state. Not-due rollup checks also read and decide under their admission
write lock (§4.4), but acquire no source observations and preserve the fresh source checkpoint/time.

Transaction composition is package-private and accepts only implementation-owned synchronous work.
The exported RuntimeStore API does not expose an executable transaction callback. This does not
claim that SQLite cancels asynchronous JavaScript effects. Watch batches use the same admission boundary under §2.4.

Verified: `libs/core/src/runtime/service.ts` — `AgentMonitorRuntime.tick()`, `ingest()`, and
`admitSpan()`, `flushRollupWindow()` and `finishMaterializationSpan()`.

### 2.0 Source-config preflight (current)

A tick **MUST NOT** observe a monitor whose config fails its registered source's
schema. It **MUST** use the existing `validateWatchScope` helper, including its
friendly collection-strategy and timezone diagnostics, and report the joined
errors in `skippedMonitors` as `{ monitorId, validationError }` with no `nextDueAt`.
This check applies to directory-backed and persisted ephemeral monitors, before
due scheduling (even when not due), and before any held notify work can flush.
The monitor is absent from `evaluatedMonitors`; a rejected config is not an
attempted observation and creates no observation-history row.

**Existing invalid configs that previously ran now stop observing. This is
intentional.** Fix the reported config to resume. A skipped monitor's persisted
baseline, last-observation time, and pending notify state **MUST** remain intact,
including across restart; fixing only the source config resumes normal scheduling
and releases held work according to its existing notify policy. For example,
`value: 42` against a source requiring a string causes no source effect and leaves
an overdue debounce batch untouched; changing it to `value: fixed` allows the next
due tick to observe using the retained baseline and flush the captured batch.
Healthy sibling monitors **MUST** continue progressing.

Validation **MUST NOT** mutate the plugin's JSON Schema. The shared helper uses a
private copy because validator setup may annotate schema nodes. Frozen valid schemas remain valid and
must not prevent observation or watcher startup. A schema setup/evaluation exception
(such as a malformed regular expression) **MUST** fail closed for that monitor with
`Source schema validation failed: <cause>` through the existing joined validation
diagnostics: tick `skippedMonitors`, watcher startup `onError`/stderr, and definition
validation in explain/doctor/validate. It must not execute the affected source,
consume its baseline/cursor/held notify work, or abort healthy siblings, final
suppression cleanup, or hook-state refresh. Correcting the schema permits normal
preflight and recovery; ordinary scope rejections retain their existing messages.

Verify-artifact ownership reconciliation (§2.6) runs before observation preflight and does not
depend on the monitor's source config or cadence: an owner reaped while its monitor's config is
rejected supplies the same durable cleanup authority as any other inactive owner, and no lifetime is
derived from the rejected config. Ordinary source preflight still rejects that config before
observation, leaving baseline and legitimate notify work intact.

Continuous `watchMonitors()` startup **MUST** apply the same preflight before
calling `watch()` or reserving a watcher slot. Invalid monitors are excluded from
the returned handle and reported through `onError` (or stderr when no callback is
provided), with the same joined diagnostic. Watchers already running keep their
startup config; live watcher reload is outside this contract. When the rejected scope
has held work, its admission closes until valid recovery (§4.6).

`monitor explain` **MUST** report a definition failure and `doctor` **MUST** report
an invalid monitor with the same diagnostic as `validate`. A rejected monitor's outstanding
dropped observation stays reported beside it, in explain's materialization stage and on doctor's
rollup (§2, "Admission outcomes when the outbox cannot retain a suffix"). Doctor **MUST NOT**
schedule a rejected scope: for example, `file-fingerprint` with valid `globs` and
`interval: bad` returns the authoritative validation error, `due: false`, and no
`nextDueAt`, while healthy siblings remain in the report. Diagnostic reads **MUST**
preserve source state, pending notify work, events, and observation history.
`daemon once` text and
JSON output and the continuous daemon log **MUST** expose validation skips even
when no events emit, naming the monitor and diagnostic; waiting for a next-due time
cannot fix invalid config. Runtime and built-CLI regressions in
`source-validation.test.ts` and `runtime-source-validation.test.ts` enforce these
boundaries with source side effects, sibling progress, and restart recovery.

### 2.1 Due scheduling

Default due intervals are:

| Source class  | Default                                  |
| ------------- | ---------------------------------------- |
| `schedule`    | evaluated once per minute                |
| `api-poll`    | 5 minutes if `scope.interval` is absent  |
| other sources | 30 seconds if `scope.interval` is absent |

Verified: `libs/core/src/runtime/service.ts` — constants `DEFAULT_FILE_FINGERPRINT_POLL_MS = 30_000`, `DEFAULT_API_POLL_MS = 300_000` (lines 30–31); `scheduleForMonitor()` (lines 449–488).

If a non-schedule monitor provides a string `scope.interval`, the runtime **MUST** parse it as a duration using `parseDuration` and use the result as the due interval. Verified: `libs/core/src/runtime/service.ts` lines 478–483 (generic interval path).

### 2.2 Schedule matching

For schedule monitors: `scope.cron` is interpreted as a five-field cron expression; `scope.timezone` defaults to `UTC` if omitted; malformed cron fields are treated as non-matching (the entire `cronMatchesDate` call returns `false`); a schedule monitor cannot fire more than once in the same minute because the elapsed guard `elapsed >= 60_000` is required in addition to cron-field matching; missed cron windows are not backfilled (BP1). The schedule source itself does not decide whether it is due. The runtime does.

Verified: `libs/core/src/runtime/service.ts` — `cronMatchesDate()`, `scheduleForMonitor()` schedule branch.

**An invalid `scope.timezone` MUST NOT abort the tick (issue #297).** `scope.timezone` is
authoring-time validated (003 §5.2), but the tick loop itself does not call that validator (§2, step
1–4 above only reject an unknown `source` name, not an invalid scope value) — so a hand-edited
`MONITOR.md` that skipped `validate` can still reach `scheduleForMonitor()` with a timezone
`Intl.DateTimeFormat` rejects. `scheduleForMonitor()` **MUST** catch that failure internally and
return a `PollingDecision` with `due: false` and an `error` message rather than throw — this is a
defensive backstop, not the primary defense (authoring-time validation is). Every caller **MUST**
treat a present `PollingDecision.error` as "this monitor cannot be scheduled right now" and isolate
the failure to that monitor:

- The tick loop (`evaluateMonitorOnTick()`) records it exactly like an `observe()` failure (§2.5, AP
  per-monitor isolation): pushed onto the tick result's `erroredObservations` and written as an
  `errored` `observation_history` row, then that monitor is skipped for the tick — every other
  monitor still runs. Same isolation applies to a `rollup` monitor's `notify.timezone` on the
  not-due window-flush path (§4.4), which evaluates `notify.window`/`notify.timezone` independently
  of `scope.timezone`.
- `monitor.explain` (§10.7) — which **MUST NOT** mutate runtime state — renders the failure as an
  `observation`-stage `failure` (the same shape a real `observe()` error produces), computed purely
  in-memory, WITHOUT writing an `observation_history` row.
- `doctor` (005 §14) folds it into the monitor's `valid`/`validationError` reporting, alongside any
  scope-schema error.

Verified: `libs/core/src/runtime/service.ts` — `PollingDecision.error` (`runtime/types.ts`),
`scheduleForMonitor()`'s try/catch around `cronMatchesDate()`, the `schedule.error` branch in
`evaluateMonitorOnTick()`, the `dispatchRollup()` try/catch in the not-due rollup-flush path,
`explainMonitor()`'s `schedule.error` branch, `doctorReport()`'s `schedule.error` fold into
`validationErrors`. Proven by the two-monitor regression tests in `service.test.ts` ("isolates an
invalid schedule timezone so a sibling monitor still emits", "explains an invalid schedule timezone
as an observation-stage failure, not a crash") and `doctor-report.test.ts`.

### 2.3 Watch-mode execution

In addition to the one-shot `observe()` tick loop, the runtime drives continuous `watch()` for sources that implement it (NP4). `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` scans the tree and, for each monitor whose source exposes `watch()`, consumes its `AsyncIterable<ObservationResult>`, funnelling each finite batch through the **same** notify dispatch → event materialization → session projection pipeline as `observe()` (the shared `ingest()` path). It returns a `WatchHandle` whose `stop()` aborts (via `context.signal`) and awaits every watcher. `daemon run` starts watchers at startup and stops them on shutdown.

While a monitor has an active watcher, the tick loop **MUST** skip its `observe()`, so it is never driven twice. A watcher **MUST** be released from the active-watcher set whenever it exits for **any** reason — the `watch()` iterable completing normally, an error (other than the runtime's own abort; that case is also reported via the `onError` callback), or `stop()`/abort — after its admitted batch settles, after which the tick loop resumes driving that monitor via `observe()` and a later `watchMonitors()` can re-establish it. A watcher that ends normally must therefore not remain pinned in the active-watcher set (which would permanently starve `observe()`). Each active-watcher slot carries a per-watcher identity token so a superseded watcher only ever releases its **own** slot, never a newer watcher's. A `watch()` source yields its associated restart baseline in each batch's `nextState`; the runtime commits it with the batch ([§2.4](#24-watch-mode-source-state-checkpointing)). A restarted watcher receives that persisted baseline in `context.previousState`.

> **Example:** a source that opens an OS file-system watcher yields a batch containing a `modified` observation and its next fingerprint state when a file changes, rather than waiting for the next poll interval; `stop()` closes the OS watcher via the aborted signal.
>
> **Test implication:** a `watch()`-based source whose iterator yields a one-observation batch then idles until aborted produces exactly one materialized, session-projected event, and `stop()` resolves with the source's abort handler having fired (`libs/core/src/runtime/service.test.ts`).

Verified: `libs/core/src/runtime/service.ts` — `watchMonitors()`, `consumeWatch()`, the `activeWatchers` skip in `tick()`, and the shared `ingest()` helper; `apps/cli/src/commands/daemon.ts` — watcher start/stop in `runLoop()`.

### 2.4 Watch-mode source-state checkpointing

> **Status: current.** Explicit finite watch batches replace the independent checkpoint callback.
> **Accepted decision, 2026-11-01:** the user selected “Explicit batches: change the watch contract
> so the runtime commits observations and checkpoint together (recommended).” An opaque checkpoint
> could previously advance before an observation was yielded; serialization alone did not prevent
> lost work after admission failure or a crash. Deferring it until the next yield is also insufficient
> when it covers several future yields. Association must therefore be explicit in the yielded value.

#### One finite batch and one commit

`ObservationSource.watch` returns `AsyncIterable<ObservationResult>`, reusing the poll result:

```typescript
yield {
  observations: [firstObservation, secondObservation],
  nextState: nextSourceBaseline,
};
```

Every yielded batch is one admission unit. The runtime **MUST** persist its source checkpoint,
notify state, successful event prefix (including all recipient projections/cursor seeds/snapshots),
and complete ordered retry suffix in one synchronous transaction. The whole unit **MUST** commit
before the first Interpret invocation or next iterator pull. No source/plugin callback, Interpret,
or other external asynchronous effect runs inside that transaction. A materialization failure with
successful durable retry admission is an admitted batch. So is one whose failed observation the
outbox could not retain and which was recorded `errored` in the same commit (§2). An
outbox/state/transaction storage failure is not.

`nextState` is source-owned change-detection/restart state, not a recipient baseline, delivery
receipt or agent acknowledgement. Omitted or `undefined` preserves the prior source baseline;
`null` resets it to the existing empty-state representation `{}`. The source **MUST** associate
only work covered by the finite batch, retaining replayability of unadmitted input. The runtime
can enforce the atomic association supplied by the source; it cannot infer omitted upstream events
or validate source-specific cursor meaning.

An empty `observations` array is valid for a state-only source batch. It introduces no source event;
normal notify evaluation may still flush already-held work. Source checkpoint and any resulting
notify changes share the same transaction, including when nothing emits. Like polling, the batch
updates `lastObservationAt` and records its normal no-change/rebaseline audit outcome; it is not
the former callback's state-only write that left observation timing untouched. An empty-batch state-write
failure is an admission failure, not a warning-only checkpoint operation.

#### Failed admission and lifecycle

Whole-admission failure **MUST** preserve the prior source/notify state and all prior committed rows,
record/report the error best-effort, close the iterator, and stop before requesting newer input.
A restart or one-shot fallback receives the prior baseline and can replay the unadmitted batch.
Durable retry obligations remain distinct from completed materialization; retry draining before
newer input and the final owned-process crash proof remain separate runtime recovery work.

Aborted or superseded watchers **MUST NOT** admit late batches. After an abort during Interpret,
already committed work survives and no newer iterator pull occurs. Iterator completion, setup
failure, admission failure and abort release only that watcher's own ownership token. `stop()`
awaits watcher completion; source implementations must release resources on iterator close or abort.
All state writes use the watcher's exact `(monitorId, workspacePath)` scope.

Ownership tokens fence watchers inside one runtime instance. Each watch also retains the serialized
source baseline captured before producer invocation, advances that expected token only after its own
successful batch admission, and refuses a later batch if the persisted baseline changed. Notify
state is read and dispatched under the admission lock. These checks prevent stale overwrite but do
not establish cross-process source leadership, distinguish source-state ABA, or promise exactly-once
acquisition by competing producers.

#### Breaking plugin migration

`ObservationContext.checkpoint` is removed. There is no independent checkpoint callback and no
bare-observation compatibility fallback. Migrate `yield observation` plus a separate checkpoint to
`yield { observations: [observation], nextState }`; collect all observations covered by one checkpoint
in the same finite array. A baseline-only update uses `{ observations: [], nextState }`. Runtime
validation rejects a legacy bare observation before changing state and stops that iterator with a
migration error. Poll `observe()` signatures remain unchanged; no bundled source currently uses
`watch()`.

A crash before admission leaves the old replay baseline. After admission, every accepted observation
is an event, durable retry, held notify work or intentional policy suppression. Sources that omit or
lag checkpoints may replay duplicates; this is not exactly-once source acquisition or agent delivery.
Verified by `watch-batch-admission.test.ts` (whole batch/suffix before suspended Interpret, independent
read visibility, rollback/reopen, state-only failure, missing/undefined/null state semantics, legacy
refusal, workspace isolation, abort, replacement ownership and lifecycle cleanup), with existing
end-to-end watch/poll exclusivity scenarios retained in `service.test.ts`.

#### Notify admission gate and teardown

While the notify admission gate ([§4.6](#46-effective-notify-policy-edits-current)) is closed — a
failed edit drain, an unresolved source, or a rejected scope with held work — a yielded batch waits
on the consumer's stack and the iterator is not pulled again. The waiting batch is not admitted, so
it records no drop and queues no retry; its observations and `nextState` stay unpersisted until the
gate opens. Admission rereads the gate, cancellation and the watcher's ownership token in the same
synchronous turn as the batch's transaction. The watcher's source factory is likewise created only
once the gate is open, from the latest admitted definition and the baseline persisted at that turn.

`stop()`/abort releases a waiting batch unadmitted. A superseded watcher's batch is never admitted,
and that watcher releases only its own cache lease, never its successor's slot. Because one batch is
admitted at a time, completion or an iterator error happens only after the last admitted batch has
settled; only then does the watcher retire its slot and lease, so polling or a replacement watcher
reads the resulting durable baseline rather than overtaking it.

**Example.** A batch carrying cursor 111 waits while an edited-policy drain is blocked. A recovery
tick commits the old hold, then the batch is admitted with cursor 111; only after that may polling or
a later batch advance the baseline to 999. Reopening SQLite shows 999, never a stale 111.

`runtime/notify-checkpoint-teardown.test.ts` and `runtime/notify-boundaries.test.ts` verify waiting
batches at a closed gate, completion and error after admission, abort, token supersession, polling
and replacement exclusion, workspace/monitor isolation and independent SQLite reopen.

### 2.5 Tick result

`tick()` returns a `RuntimeTickResult` summarizing the tick:

- `evaluatedMonitors` — the ids of every monitor whose `observe()` was attempted this tick (including monitors whose outcome was `errored`).
- `emittedEventIds` — the ids of the durable events materialized this tick.
- `erroredObservations` — one `{ monitorId, message }` entry per monitor whose observation failed this tick (its `observe()` threw/rejected, or its `ingest()` failed), and one per observation a debounce/rollup hold refused because it cannot be serialized (§4.7). Each entry is pushed from the **same** code path that writes the `errored` row to `observation_history` (§15 `observation_history`), so the result is the single source of truth for tick-time failures — it is never recomputed by re-scanning history. A monitor that genuinely observed no change does **not** appear here.
- `skippedMonitors` — either `{ monitorId, validationError }` for invalid source config (§2.0), or `{ monitorId, nextDueAt }` for a valid monitor skipped because it was not yet due (interval not elapsed or cron window not open). The due time comes from the same scheduling decision that gates evaluation. An active continuous watcher does not appear as a cadence skip; validation of a newly scanned invalid definition still reports its config problem. Consumers must check which field is present before reading a due time.

The runtime **MUST** surface `erroredObservations` so a caller (e.g. the CLI tick output, §10.1/§10.2) can report a failed observation rather than print a clean `emitted 0` that an author cannot distinguish from a genuine no-change.

The runtime **MUST** surface `skippedMonitors` so a caller can distinguish "monitors exist but are not yet due" from "no monitors found" — two situations that previously produced identical CLI output (issue #152).

Verified: `libs/core/src/runtime/types.ts` — `RuntimeTickResult`, `ErroredObservation`, `SkippedMonitor`; `libs/core/src/runtime/service.ts` — `tick()` populates `erroredObservations` in both the `observe()` and `ingest()` error branches alongside the `recordObservationHistory({ result: 'errored' })` write; populates `skippedMonitors` in the `!schedule.due` branch from the same scheduling decision.

### 2.6 Verify-artifact ownership (_current_)

`agentmonitors verify --use-workspace-daemon` (005 §16) proves a file-fingerprint monitor against
the user's persistent workspace daemon by creating a synthetic scratch file,
`agentmonitors-verify-<token><ext>`, whose 12-hex-digit `<token>` is the run's random identity. The
runtime keeps every observation of that exact file out of every later lead session once the run is
finished with it, through **durable exact ownership** rather than a time-limited suppression.

**Registration (before the artifact exists).** Before creating the file, the run registers one
ownership record: `runId` (the token), the owner session (the run's own throwaway lead session),
`workspacePath`, `monitorId` (the monitor being verified) and the exact `objectKey` (the scratch
path). Registration **MUST** be refused when:

- the key is not a verify scratch path, or its token differs from `runId` (a real watched path can
  never acquire by-key authority; a verify that edits a real file keeps the exact-event-id cleanup of
  005 §16 step 9);
- the owner session does not exist, is not `active`, or belongs to another workspace;
- the same workspace, monitor and key are already owned by another run;
- the `runId` is already registered for a different owner, workspace, monitor or key.

Repeating an identical registration (a retry, including after a crash or daemon restart) is a no-op
that returns the existing record, so one run never holds more than one record. Only verify
registration creates these records.

**Proof phase.** While the owner session is `active` and has not requested cleanup, the artifact's
observations are ordinary work: they materialize and project normally, so the run can observe its
own proof delivery.

**Cleanup authority.** Authority takes effect, and is never withdrawn, when either:

- **`owner-request`** — the run asks for cleanup after its proof (`verifyArtifacts.requestCleanup`,
  §10); or
- **`owner-inactive`** — the owner session is closed, reaped as stale (§6.2), or missing.

The first cause is recorded with its time (`cleanupRequestedAt`, `cleanupCause`); a later request or
reconciliation keeps the first record. `owner-inactive` is recorded when the runtime closes or reaps
the owner and again by reconciliation at the start of every tick, so a crash between ending the
session and recording the cause is repaired on the next tick. Until it is recorded, an inactive owner
already supplies authority at both filter boundaries below. When authority is recorded, the runtime
retracts every existing event for the exact key in that workspace and refreshes hook state, in
one store write.

**Filtering.** With authority in effect, the runtime drops observations whose object key equals the
registered key, for the registered monitor and workspace only, at two boundaries:

1. **Incoming observations** — after the CEL pre-filter and before notify dispatch (§4), inside the
   same transaction. A dropped observation never enters a debounce or rollup hold and never consumes
   a throttle window that a later legitimate change needs. Poll results and watcher batches pass
   through the same boundary.
2. **Held emission** — when held work materializes: debounce settle, rollup window and escalation
   flushes, and the notify-policy edit drain (§4.6). Legitimate items in the same held batch
   materialize unchanged.

Authority has **no wall-clock expiry**, and no successful poll, empty observation or other source
outcome retires it. Source plugins are unaware of ownership: their opaque state, baselines and
fingerprints are never cleared or rewritten, and the source contract (003) is unchanged. A source
that still remembers the deleted scratch file and reports its deletion after an arbitrary delay,
restart or config repair produces an observation that the incoming boundary drops.

**Exactness.** A matching basename alone confers nothing: an unregistered scratch-looking path, even
one projected into a reaped session whose host id looks like a verify session, is ordinary work. A
foreign workspace with the same monitor id and key keeps delivering, and sibling monitors whose
globs happen to match the scratch file are not filtered.

**Retention.** Records are retained without a TTL, one row per verify run, which also keeps a
retained key from ever being registered again. Nothing retires a record automatically; there is no
retirement command today, and accumulation across verify runs is accepted. The cost is dominated by
the workspace path and scratch key, each stored in the row and in the object index. Measured after
`VACUUM` with SQLite `dbstat` (4 KiB pages, 151-character workspace path, 188-character key,
samples of 100, 1,000 and 10,000 runs): about 850 bytes per run once cleanup is recorded, about
1,000 bytes while a record awaits cleanup (the partial index releases its entry on cleanup), or
roughly five runs per page.

**Guarantee and its limits.** For a run that registered its artifact, no observation of the exact
scratch key reaches a lead session other than the owner once cleanup authority is in effect, across
arbitrary delay, daemon restart, held-work flushes and config repair. Before authority takes effect,
a run that was killed is still in its proof phase: its events stay visible until the daemon reaps
the owner as stale (§6.2) and retracts them. A client that predates ownership, or a current client
against a daemon that predates it, falls back to the legacy `events.suppressObject` tombstone with a
finite lifetime (005 §16 step 9), which does not carry this guarantee.

Verified: `libs/core/src/runtime/verify-artifact-ownership.test.ts` (real file-fingerprint
observations, SQLite close/reopen, an actual later-lead claim) and
`libs/core/src/runtime/verify-artifact-rejected-config.test.ts`; schema in
`libs/core/src/inbox/schema.ts` (`verify_artifacts`).

## 3. Persisted Monitor State

Each monitor has persisted runtime state containing: `lastObservationAt`, `sourceState`, `notifyState`. `sourceState` is owned by the source plugin and returned via `nextState`. `notifyState` is owned by the runtime and records delivery timing state such as active suppression windows for throttle, pending observation batches for debounce, and the accumulated rollup batch (`pendingRollup`, [§4.4](#44-scheduled-rollup-pace-mode-current)) held between delivery windows.

This split is important: source plugins own change-detection state, while the runtime owns notification timing behavior.

**Workspace scoping (issue #345 / #307):** this state is keyed by
`(monitorId, workspacePath)`, never `monitorId` alone. The global database can
hold the same monitor id in unrelated workspaces, so every runtime read/write of
monitor state names its workspace scope (the tick loop, `ingest()`,
`scheduleForMonitor()`, the watch path, and `explain`/`doctor` all thread it
through). See the [`monitor_state` schema](#monitor_state) for the key, the
NULL-safe uniqueness, and the one-time re-baseline migration.

**Restart-safety / upgrade backfill (issue #109):** When a persisted `notifyState.pendingDebounce` or `notifyState.pendingRollup` batch is hydrated on daemon restart, envelopes written before the range-urgency upgrade may lack an `effectiveUrgency` field. The runtime **MUST** backfill it on hydration using `effectiveObservationUrgency(monitor, observation)` so that the materialized `monitor_events.urgency` row is never written with an undefined value. `effectiveObservationUrgency` degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax` (old monitor): the `URGENCY_BY_RANK[NaN] ?? lo` fallback returns the monitor's base urgency. The `pendingRollup` batch survives daemon restarts and flushes on the next window opening (BP1; [§4.4](#44-scheduled-rollup-pace-mode-current)).

Verified: `libs/core/src/runtime/types.ts` — `MonitorRuntimeState` (lines 131–135); `libs/core/src/inbox/schema.ts` — `monitorState` table (lines 98–105).

### 3.1 Local data permission model — the local trust boundary (_current_)

Agent Monitors persists private snapshot, event, diff, and source-state data and serves an
**unauthenticated** IPC socket entirely on the local machine (NP1; the daemon holds no network
identity). The trust boundary is therefore the **current OS user**: no _other_ local user may read
persisted data, read hook state, or reach the daemon socket to inspect/claim/ack events or stop the
daemon. On multi-user hosts with permissive home/XDG directory modes this is not automatic, so the
runtime and CLI **MUST** establish owner-only modes at creation time **and MUST tighten pre-existing
artifacts on startup** (BP4, [000 §5](./000-principles.md)).

- **Directories — `0700` (`rwx------`):** the per-workspace data directory, session directories
  (which hold hook state), the socket directory the daemon creates, and the startup-lock directory.
- **Files — `0600` (`rw-------`):** the SQLite database, its `-wal`/`-shm`/`-journal` sidecars,
  hook-state files, the startup-lock pid file, the `.claude/agentmonitors.local.md` coordination
  file, and `daemon run --detach`'s `--log` file. (The `.claude` directory itself belongs to the
  host tool and is **not** re-moded — only the coordination file we own is.)
- **The `--detach` log's parent directory is Agent-Monitors-owned only conditionally.** A _missing_
  parent (default or a missing ancestor under a custom `--log`) is always created `0700` — the
  runtime is the one creating it, so there is no pre-existing mode to preserve. A pre-existing
  parent is only tightened when it is the **default** location (the workspace data directory); a
  pre-existing **custom** `--log` parent (e.g. a repo checkout or a shared logs directory the user
  chose) is left exactly as it is, mirroring the existing `--socket`-directory treatment above — the
  runtime does not own it and silently removing group/other access would be a functional regression,
  not a hardening.
- **The `--detach` log FILE is always owner-only and fail-closed against a symlinked path**,
  regardless of whether its parent is the default or a custom location: it is created `0600` if
  missing and tightened via `restrictExistingPathMode` if it already exists as a regular file, but
  when the path is a symlink, tightening intentionally no-ops (never touches the mode of the
  symlink or its target) — and the runtime does **not** then fall back to opening through the link.
  The final open uses `O_NOFOLLOW` (`ELOOP` if the last path component is a symlink) and `fchmod`s
  the resulting descriptor rather than the path, so a planted symlink at the log path is refused
  (surfaced as a clean spawn failure) instead of silently appending the daemon's output into
  whatever it points at.
- **The `--detach` log's `fchmod` is fail-closed, not warn-and-continue.** If that final `fchmod`
  on the opened descriptor itself fails — e.g. `EPERM`/`EACCES` because a pre-existing `--log` file
  is owned by another user and open-for-append succeeded but tightening did not — the runtime
  closes the descriptor and refuses to start the detached daemon, reporting an actionable error
  naming the path and the underlying cause. This is a deliberate exception to "degrade gracefully"
  below: that rule covers artifacts the runtime silently _tightens_ without changing whether the
  triggering operation proceeds (a socket, a directory, a hook-state file, the database — all of
  which need only to be written, not to gate anything). The log file is different: whether it can
  be made owner-only gates whether the daemon starts logging at all, and the log carries workspace
  paths and monitor-failure details for the lifetime of the process. Starting to write those details
  into a file the daemon cannot secure is worse than refusing to start; the caller can point `--log`
  at a file it owns, or remove the existing one, and retry.
- **Sockets:** the Unix domain socket is **bound under a restricted (`0o077`) umask so it is born
  `0600`** (Node binds a Unix socket synchronously inside `listen()`, so the umask window closes
  before the socket is observable), then re-chmod'd `0600` after bind as defense-in-depth, and —
  decisively — lives inside an owner-only directory, so other users cannot even traverse to it on
  platforms that ignore socket permission bits for `connect(2)`. Because `chmod` follows symlinks
  (there is no `fchmod` for a path that cannot be `open(2)`'d), the owner-only parent directory — not
  the post-bind chmod — is the load-bearing guard against a swapped-symlink race.
- **Creation invariant.** On-disk databases are opened under a restricted (`0o077`) process umask so
  the WAL/SHM files SQLite creates itself are private from birth; directories are created with an
  explicit `0700` mode (a permissive umask cannot re-add group/other bits to `0700`); files are
  written `0600`.
- **Migration — tighten on startup.** An artifact created by an earlier, pre-hardening version keeps
  its world-readable mode until re-moded. Each startup re-applies the owner-only mode to existing
  databases, sidecars, hook-state files, and Agent-Monitors-owned data/session/socket directories.
  This includes the Agent-Monitors-owned **default** socket directory even when the database is
  `:memory:` (which has no on-disk file to tighten at `createDb`) — a pre-existing world-readable
  default socket directory must not slip through. Re-application is idempotent and performed **once
  per process** (a process is one startup), so the steady-state write path — hook state per lead
  session per tick — does not re-`lstat`/`open`/`fchmod` an already-verified path. Tightening is
  **symlink-safe**: it `lstat`s first, refuses to act on a symlink, and re-opens with `O_NOFOLLOW`
  before `fchmod`, so a planted symlink cannot redirect a `chmod` onto a file the user does not own.
  A socket directory the user _explicitly chose_ (`--socket` / `AGENTMONITORS_SOCKET`) or a shared
  system directory is **not** tightened — only Agent-Monitors-owned directories are.
- **SQLite lock ownership.** Existing SQLite artifacts MUST be tightened before this
  process opens its first connection to that database. Newly created artifacts remain
  protected by the restricted umask. Permission migration MUST NOT open and close
  independent descriptors on artifacts owned by a live SQLite connection: on POSIX,
  closing those descriptors releases SQLite's locks. Equivalent relative, absolute,
  and symlinked paths resolve to one actual database path for both SQLite and
  permission migration, including the target directory and sidecars. The canonical
  path shares the once-per-process permission cache; generic filesystem tightening
  still refuses symlinks. A dangling database file symlink is rejected before
  SQLite opens or creates its target because it has no stable canonical identity.
  Hard-link database aliases are unsupported. Outside an explicit
  transaction, a long-lived reader MUST observe each later committed process write;
  a competing process MUST read only committed data and receive `SQLITE_BUSY` when
  trying to write while an immediate transaction owns the writer lock. Regression:
  `db-visibility.test.ts` exercises independent processes without warming or reopening
  the original reader.
- **Degrade gracefully where the artifact is not ours.** Tightening never _fails_ an operation that
  only needs write access. When the target exists but is owned by another user (a caller pointed,
  say, `--hook-state-path` into a shared group-writable directory), the `chmod` returns
  `EPERM`/`EACCES`; the helpers emit **one structured stderr warning per path per process** and
  continue, leaving the mode unchanged — they do **not** throw. The daemon must never die because an
  artifact it was asked to write is not one it can chmod; correspondingly, a single malformed or
  unexpected IPC request is answered with an error response, never allowed to crash the daemon
  process ([§10.4](#104-ipc-wire-protocol)). This rule governs artifacts the daemon tightens
  incidentally to an already-necessary write; it does **not** cover the `--detach` log file's own
  `fchmod`, which is fail-closed per the bullet above — there the mode check gates whether the
  daemon starts at all, not merely whether a write that would happen regardless succeeds.
- **Windows.** POSIX modes are not meaningful; the helpers create the paths without mode enforcement.

Verified: `libs/core/src/security/local-permissions.ts` — `ensurePrivateDir`,
`restrictExistingPathMode`, `withRestrictedUmask`, `writePrivateFileAtomic`, `restrictSocketMode`;
`libs/core/src/inbox/db.ts` — `createDb`; `libs/core/src/hook-bridge/bridge.ts` +
`libs/core/src/runtime/service.ts` — hook-state writes; `apps/cli/src/daemon-ipc.ts` — socket,
startup lock, and the long-socket-path fallback ([§10.3](#103-socket-path-resolution));
`apps/cli/src/local-state.ts` — coordination file; `apps/cli/src/detached-spawn.ts` — `openLogFd`
(the `--detach` log: a missing parent always created `0700`, an existing parent tightened only at
the default location, and the log file itself created `0600`/tightened via
`restrictExistingPathMode` before every append, then opened `O_NOFOLLOW` with the descriptor
`fchmod`'d — never the path — so neither the ambient umask, a pre-existing permissive file/dir from
an earlier run, nor a symlink planted at the log path leaves it world-readable or writes through to
an unintended target; a descriptor `fchmod` failure closes the descriptor and fails the spawn rather
than warning and continuing); tests:
`local-permissions.test.ts`, `inbox/db-permissions.test.ts`, `hook-bridge/bridge.test.ts`,
`daemon-ipc.test.ts`, `detached-spawn.test.ts`, `open-log-fd-fail-closed.test.ts`, and the
real-binary UAT in `apps/cli/src/commands/cli.integration.test.ts`.

## 4. Notify Dispatch

Notify dispatch converts observations returned by a source into emitted observations that should become durable events.

### 4.1 Default notify behavior

If a monitor omits `notify`: `high` urgency **MUST** default to `debounce` with `settle-for: 15s`; `normal` urgency **MUST** emit immediately (no notify config applied); `low` urgency **MUST** emit immediately.

This default is part of the runtime contract and explains why high-urgency signals are not delivered the instant a single source observation appears.

#### Effective urgency (source salience within the authored band)

A monitor's `urgency` frontmatter is an authored **band** `lo..hi` (see
[001 §3.2](./001-monitor-definition.md)); a bare scalar is the degenerate band `x..x`. A source
observation **MAY** carry an optional `salience` (see [003 §2.3](./003-source-plugins.md)) — the
source's domain judgment of how interrupt-worthy _this_ observation is (PP3 — a domain observation,
not runtime reasoning). It is named `salience`, not `urgency`, because `urgency` stays the
monitor-level policy knob.

For each observation, the runtime **MUST** resolve the **effective urgency** as:

```
effective_urgency = clamp(salience ?? band.lo, band.lo, band.hi)
```

- No `salience` → the band's low bound (the authored base / default urgency).
- `salience` inside the band → it escalates (or de-escalates) within it.
- `salience` outside the band → it is clamped to the nearest bound (above → `band.hi`, below →
  `band.lo`).

Notify dispatch **MUST** evaluate the default notify behavior against the **effective** urgency, and
event materialization ([§5.1](#51-derived-defaults)) **MUST** persist the effective urgency.

Because a degenerate band (`lo === hi`) clamps every salience back to the single authored level, a
monitor authored with a bare scalar `urgency` can **never** be escalated by a source — preserving PP5
(urgency stays user-controlled) and full backward compatibility. Escalation is therefore always an
explicit, visible authorial grant: the runtime only ever escalates within a band the author wrote.

##### Debounce interaction: escalation flushes the whole held batch early

When an **escalated** observation (its effective urgency exceeds the band's low bound) arrives while a
debounce batch is **held**, the runtime **MUST** flush the _entire_ held batch — the already-held
observations plus the escalated one — immediately, rather than waiting for the batch's `dueAt`. The
runtime **MUST NOT** split the batch (emit only the escalated observation and keep the rest held):
splitting risks ordering confusion across the durable event stream. Held-first ordering is preserved.

Verified: `libs/core/src/runtime/types.ts` — `defaultNotifyConfigForUrgency()`: returns `{ strategy: 'debounce', 'settle-for': '15s' }` for `high` urgency, `undefined` (immediate) for all other urgencies. `libs/core/src/runtime/service.ts` — `effectiveObservationUrgency()` resolves the clamp; `dispatchNotify()` evaluates notify against the effective urgency and performs the whole-batch early flush on an escalated observation.

### 4.2 Throttle semantics

For `throttle`: the first observation after any suppression window emits immediately; further observations inside the suppression window are dropped; `suppressedUntil` is updated from the emitted observation time.

Verified: `libs/core/src/runtime/service.ts` — `dispatchNotify()` throttle branch (lines 523–536).

### 4.3 Debounce semantics

For `debounce`: incoming observations are accumulated in a pending batch; each new observation resets the batch's `dueAt` time to `observedAt + settle-for`; a later runtime tick at or after that due time flushes the full pending batch. An observation that cannot be serialized is not accepted into the batch and does not reset `dueAt` (§4.7). This means debounce delivery is bounded by both the configured settle interval and the daemon's tick cadence.

Verified: `libs/core/src/runtime/service.ts` — `dispatchNotify()` debounce flush path (lines 499–508) and accumulation paths (lines 540–561).

The pending debounce state uses the `PendingDebounceState` shape: `{ observations: StoredObservationEnvelope[]; dueAt: string }`.

Verified: `libs/core/src/runtime/types.ts` — `PendingDebounceState` (lines 137–140).

### 4.4 Scheduled-rollup Pace mode (_current_)

> **Status: current** (G12; capability C44, resolved in the monitoring capability study
> [`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S5.2). The authoring surface lives in [001 §3.6](./001-monitor-definition.md).
>
> Verified: `libs/core/src/runtime/service.ts` — `dispatchRollup()` implements steps 1–6 below
> (accumulate into `notifyState.pendingRollup`; evaluate the `window` cron via `cronMatchesDate`
> in the configured `timezone`; flush the whole batch and clear state on a non-empty window; no
> delivery on an empty window; one materialized event per accumulated observation). The
> accumulation batch is persisted in `monitor_state.notify_state` (`PendingRollupState`,
> `libs/core/src/runtime/types.ts`) and hydrated with the §3 `effectiveUrgency` backfill on
> restart. Proven by `libs/core/src/runtime/service.test.ts` ("rollup Pace mode": durable
> accumulation across ticks without between-window delivery; window flush+clear; empty-window
> no-delivery; restart-safety of the batch) and the `validate` tests named in
> [001 §3.6](./001-monitor-definition.md).

**Overview.** The `rollup` strategy accumulates all shaped observations produced between delivery
windows and flushes them as a single composite delivery when the next window opens — for example, a
9am weekday digest. It is the third Pace mode alongside `debounce` (settle on quiet) and `throttle`
(suppress within a fixed window). Where debounce and throttle are reactive (a change triggers the
clock), rollup is _proactive_: the delivery schedule is fixed by the author, not by change frequency.

**The three-clocks principle (§1.1.3) applied to rollup.** Rollup makes the independence of the
three clocks especially visible:

- **Observation clock** — how often the source polls (e.g. every hour). Can be as slow as the
  delivery window or slower; there is no requirement to poll at low latency when delivery is a daily
  digest. This is the key cost advantage of rollup: the author **SHOULD** relax `watch.interval`
  to match the delivery frequency (see [001 §3.6](./001-monitor-definition.md)), reducing both
  observation cost and token cost without changing the delivery outcome.
- **Pace clock** — the rollup window schedule (e.g. `0 9 * * 1-5`). Determines _when_ the
  accumulated batch is flushed. Independent of how often the source observes.
- **Delivery clock** — when the agent next reaches a delivery lifecycle (§9). The flushed batch
  lands in session projection and is picked up at the next appropriate lifecycle, independent of
  when the window opened.

**Runtime semantics (target):**

1. **Accumulation.** Each observation produced since the last window flush is appended to a durable
   accumulation batch in `monitorState.notifyState` (analogous to `pendingDebounce` but without a
   `dueAt` reset on each new observation — the flush time is schedule-driven, not settle-driven).
   Observations are accumulated across daemon restarts; the batch **MUST** survive a restart.
   An observation that cannot be serialized is not accepted into the batch (§4.7).

2. **Window evaluation.** On each runtime tick the runtime evaluates the monitor's `window` cron
   expression against the current time using the configured `timezone` (defaulting to `UTC`). The
   window fires at most once per minute (same guard as the schedule source, §2.2). If the window
   matches and the accumulated batch is non-empty, the batch is flushed as a single composite
   emission and the accumulation state is cleared. The window marker, pending-batch removal,
   materialized events, and retry-outbox admission commit in one immediate transaction. A state or
   outbox failure leaves the prior pending batch and marker available for restart recovery.
   The authoritative read of the batch, minute marker, source checkpoint and observation time
   **MUST** occur after acquiring that immediate writer lock. A preliminary scheduling read cannot
   supply the persisted decision. A competing poll/watch/rollup admission that committed first
   participates in this fresh decision; an already-fired minute cannot flush newly held work again.
   Not-due evaluation preserves the locked current source checkpoint and `lastObservationAt` because
   it acquires no new observations. The successful event prefix and complete retry suffix share the
   batch clear/marker commit; retained work is successful admission, not completed materialization.
   Any state/outbox failure also rolls back projections, cursor seeds, snapshots, and the store's
   projected-recipient cache. Audit and Interpret run only after outer commit.

3. **Empty window.** If the window opens but no observations have accumulated since the last flush,
   the runtime produces no delivery (no empty pings — preserving C14), but still commits the minute
   marker. Closed-window checks retain their pending batch. Neither case creates routine no-change
   history. Even a non-emitting state write belongs to the transaction: failure preserves exact
   prior state, reports one monitor error/best-effort error history, and allows healthy siblings to run.
   Verified by `rollup-admission.test.ts`: independently owned competing runtimes before BEGIN,
   a reader opened before admission, retained-suffix barriers, rollback/reopen, and empty/closed-window
   error isolation. This does not add source leader election or retry draining; §2 limits still apply.

4. **Batch representation.** The flushed batch becomes one or more `monitor_events` rows (one per
   accumulated observation) rather than a single merged row, so the full event history is
   queryable. The runtime **MAY** synthesize a composite summary for the delivery payload. The exact
   materialization shape is left to the implementation within these constraints.

5. **Relationship to urgency.** Urgency applies to the _accumulated_ observations individually.
   The effective urgency of the flush follows the most-escalated observation in the batch if the
   batch is flushed as a unit. If materialized as individual events, each event carries its own
   effective urgency.

6. **No per-change interrupts.** Except for the effective-policy-edit boundary in §4.6,
   a monitor with `strategy: rollup` **MUST NOT** deliver anything outside a window opening. Observations accumulate silently between windows. This is the defining
   property: the author trades per-change interrupts for a predictable delivery schedule.

**Relationship to the Pace stage (§1.1.1).** Rollup is entirely on the **shared** side of the
seam: accumulation, window evaluation, and the flush decision are computed once for all recipients
before the per-recipient Diff stage runs. The flushed batch enters the normal materialization →
projection → delivery pipeline (§5 → §6 → §9).

**Cadence-relaxation note.** The most important operational consequence of rollup is that it
_permits_ relaxing the observation cadence without any delivery-quality loss. A monitor delivering a
9am daily digest wastes resources polling every 30 seconds — the capability study (C44, §S5.2)
explicitly names lower token and observation cost as a first-class motivation for the rollup mode.

### 4.5 Complete Pace mode reference (_current_)

> **Status: current** (all four rows reflect current behavior; the rollup row landed with G12).
> This section collects all four Pace modes in one place so authors and implementers can compare
> them. The modes are not hierarchical — each solves a different delivery-timing problem.

| Mode                  | `notify` strategy | Trigger for delivery                           | Cost profile                                   | Primary use case                                                 |
| --------------------- | ----------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| **Immediate**         | _(omit notify)_   | Each observation emits immediately             | Highest (one delivery per observation)         | Low-latency streams; `high` urgency events after debounce window |
| **Settle (debounce)** | `debounce`        | First tick after the watched signal goes quiet | Moderate (burst absorbed into one delivery)    | Spec docs that are edited incrementally; noisy file changes      |
| **Throttle**          | `throttle`        | First observation after the suppression window | Low (at most one delivery per suppress window) | High-volume sources where only the latest state matters          |
| **Scheduled rollup**  | `rollup`          | Window opening (cron schedule)                 | Lowest (observation cadence can be relaxed)    | Chief-of-staff digests; end-of-day summaries                     |

> Scheduled rollup landed with G12 — see §4.4 and [001 §3.6](./001-monitor-definition.md).

**The Pace set is now complete.** The four modes cover the full range of "when should a shaped
signal become a candidate for delivery" (§1.1.1): immediately on change, after the signal settles,
at most once per window, or on an author-defined schedule. No further Pace modes are anticipated at
this stage.

### 4.6 Effective notify-policy edits (_current_)

> **Status: current.** Refs #537; decision [#556](https://github.com/mike-north/AgentMonitors/issues/556#issuecomment-6665228377).
> An author-caused policy edit is a narrow early-flush exception to debounce settling (§4.3)
> and rollup's window-only rule (§4.4). It does not claim or acknowledge a delivery.

The runtime **MUST** reconcile effective pacing edits before source-due and active-watcher
skips, without requiring new source input. Each held envelope's captured definition determines
its original policy. Effective policy includes the strategy, normalized duration, rollup cron
and timezone (default UTC), granted whole-batch escalation (§4.1), and
urgency/salience-dependent defaults when notify is omitted.
Equivalent duration spellings and explicit/default UTC are unchanged policies. A body/title edit
alone does not change pacing. The effective policy is compared over absent salience and all three
salience levels, so an urgency band edit only changes pacing when the resolved notify behavior
changes. A scalar urgency edit with unchanged explicit debounce retains its clock; a band edit
that changes the grant to flush a held batch early is an effective pacing change. This includes
observations resolving to immediate or throttle: escalation is tested before either branch.

On a changed policy, the runtime **MUST** flush **all** existing debounce/rollup holds before
observing new work under the edited policy. This covers debounce → immediate/throttle/rollup,
rollup → immediate/throttle/debounce, and effective parameter/default changes within a strategy.
Unchanged effective policy preserves normal clocks. Omitted notify at high urgency still means
15s debounce (§4.1), not immediate.

The flush uses each envelope's original content, effective urgency, title/source policy, payload,
observation timestamp and handling/Shape/Interpret definition. Observation body still takes
precedence over captured monitor instructions. Missing legacy effective urgency is backfilled
from the captured definition per §3; missing/invalid captured semantics **MUST** block recovery,
never borrow values from the new definition. Already-materialized rows remain immutable (#451).
Old holds retain their order; mixed legacy hold arrays use stable observation-time order, with
array order and then debounce-before-rollup as ties. Retired throttle suppression and rollup
minute guards **MUST** be cleared when adopting a changed policy; they cannot suppress accepted
old work or the new policy's first observation. Private persisted policy identity permits guard
reset across restarts; it is not an authoring field. Changes to that private encoding alone must
not flush unchanged captured work or reset its clocks; complete captured definitions still detect
real effective edits when older metadata omitted an escalation bit.

**Legacy identity learning (current).** If successful unchanged reconciliation finds no private
policy key on an existing scoped row, it **MUST** record the current effective identity under the
same owned writer boundary. This is metadata learning, not an edit: preserve all guards, holds,
observation clocks, opaque source state and materialized artifacts. It must not make observation
due or create a synthetic previous-state baseline for a fresh scope. A later known effective edit,
including after restart, can then retire its suppression/minute guards before new work. With no
historical key or held definition, edits before that first successful scan are unknowable and are
not retroactively inferred. Failed validation or identity persistence does not record a successful
key; existing compatible key encodings retain unchanged clocks.

**Source-baseline preservation (current).** Every notify-only reconciliation commit, including
retiring guards without held work and atomically draining holds, **MUST** update only notify-owned
metadata and its legitimate materialization artifacts. It must preserve the persisted
`source_state`, `last_fingerprint` and `last_observation_at` columns exactly, without decoding and
reserializing the source baseline. Source ingestion (poll results and watch batches, §2.4) retains
its existing ownership.
For example, a legacy raw JSON `null` baseline with a fingerprint remains `null` after a not-due
throttle `1h` → `1s` edit and SQLite reopen; the next actual source call receives `previousState:
null`, not `{}`. The edit neither makes observation due nor creates a fresh baseline. Failed
notify persistence rolls back held materialization and metadata together, preserving those same
source columns. This extends the source ownership rule in §3 and 003 §2 to effective edits;
`runtime/notify-only-baseline.test.ts` verifies tick/startup, guard resets, drains, rollback and the
next real source input across restart.

**Discovery freshness (current).** A directory scan supplies candidate file paths, not authority
for a later policy mutation. Tick and watcher startup **MUST** synchronously reread each authored
definition immediately before its reconciliation transaction, without an intervening await. That
read is the admission linearization point: a file edit after it belongs to a subsequent discovery.
An older scan delayed on another monitor cannot restore obsolete pacing, drain newer held work,
or reopen a gate blocked by a newer edit. Missing/invalid scan diagnostics likewise recheck the
captured file before closing its gate. File location is not identity (001 §2): if a live owner's latest
admitted definition for the **same monitor ID and workspace** has a different path, both locations
are reread. A valid current replacement protects admission from an obsolete path's disappearance;
cached contents alone never authorize it. A missing/invalid current replacement or unresolved source
still blocks. Two valid same-ID locations remain a fatal duplicate, not a cached-path preference.
Missing-definition diagnostics use this same scoped resolution, including current source/scope
validation for held work. Returning to a previously used policy or moving back to a previous location
remains legitimate. Fallback requires genuine absence evidence: a metadata query must report
ENOENT or ENOTDIR for the admitted location. A false boolean existence probe also represents access
or query failure and **MUST NOT** authorize replacement. Permission, other I/O or unclassified
metadata failures keep admission blocked with the original read diagnostic and retained holds.
Closing permission **MUST NOT** forget the current location to revalidate: repeated unchanged
tick/startup and captured-route discoveries remain blocked until that location is valid or genuine
absence permits moveback. A newly selected location that fails source resolution or reconciliation
also becomes the current location while blocked; subsequent file edits there are reread, not replaced
with cached contents. One current pathname belongs to the existing counted live ownership, separately
from open/closed permission. It contains no instruction snapshot or historical locations and retires
with the last watcher/poll/deferred-result lease. No retired location governs a future owner.
Established source/handling snapshots are not restarted or reconfigured; independent scopes continue.

**Atomic edit drain.** The runtime **MUST** own one synchronous immediate SQLite transaction,
reread current held state under that writer boundary, and commit the entire old batch's events,
projections, cursor seeds, snapshots and removal of corresponding holds together. No stale read
before the writer lock can authorize removal or replay. Event materialization units may nest as
savepoints; the edit drain must not join an externally owned transaction. This prevents two
runtimes from duplicating or overwriting one drain. A drain of held rollup work is a held rollup
flush outside any window: it uses the same store-owned runtime transaction as the not-due window
flush (§4.4), so a rollback also restores the store's last-projected recipient cache. Unlike the
window flush it commits no prefix and retains no suffix; any failure rolls the whole drain back. Optional Interpret runs after commit using
each event's own projected recipients. This does not guarantee exactly-once downstream effects
(000 NP2).

Unknown-source handling **MUST** inspect current workspace-scoped operational holds at source
resolution, not membership captured before an earlier monitor awaited. A live watcher may create
its first hold during that await. Existing admission closes on unresolved source even without holds;
with current held work the failure is scoped, the holds remain, and healthy siblings continue. The
existing fatal unknown-source behavior without held work is preserved. A watch batch cannot
advance under that invalid definition and is admitted only after valid reconciliation, or released
unadmitted on cancellation.

Any deterministic write failure **MUST** roll back every event and all original held/source/timing
state. The runtime reports the blocked edit through existing tick errors and best-effort history,
retains holds even if diagnostic persistence fails, and defers only that monitor's new observation
and source-baseline advancement. Healthy siblings and other workspace scopes continue. Restart or
another edit retries from durable captured state. Watcher acceptance is backpressured while
blocked: the consumer retains its current unaccepted batch and does not request another (§2.4).
Admission **MUST** re-read the current gate in the same synchronous turn as the durable mutation;
a definition captured before an `await` cannot authorize a later write. A waiting batch whose gate
closes before its mutation waits for recovery or cancellation. The admitted span's deterministic
writes finish before optional async Interpret can interleave another edit.

An edit drain and ordinary admission fail differently. Ordinary ingest and window flushes keep
their span contract (§2): a dispatched observation that cannot materialize is retained with its
ordered suffix for retry, or recorded as a drop when the outbox cannot retain it. An edit drain is
all-or-nothing: if any held envelope cannot materialize, the whole drain rolls back, the holds stay
held and the gate stays closed, and it records no drop and queues no retry. Work blocked at a closed
gate (a waiting batch or a retained poll result) has not been admitted, so it records neither. A
drop is a history outcome, never held work, so it neither keeps the gate closed nor is drained by an
edit. An outstanding drop stays outstanding across an edit unless the drain materializes an event
that supersedes it under the §2 rule.
Reconciliation can resume it without reloading the live source. Its reconciled pacing and
urgency band govern future yields; its established execution/handling snapshot remains until an
explicit restart.
Watcher startup **MUST** reconcile existing scoped watcher/evaluating-poll/deferred-result ownership
even when the current registered source has no watch factory. Factory capability controls creation,
not admission for live work. A failed drain, or an invalid scope while held work exists, blocks
watch batch admission and baseline writes; valid recovery commits old work before they resume.
No new watcher, source reload or polling is introduced. An observe-only scope without its own live ownership remains untouched
by watcher startup, even if other scopes have owners.
Successful startup drains **MUST** refresh the affected workspace's session
hook state after commit, even if the source never yields and no tick follows; failed transactions
must not publish an unread prefix. This rule does not introduce unrelated live-definition reload behavior.

Polling shares this boundary: concurrent rescans may reconcile a monitor while its `observe()` is
in flight. The runtime **MUST** recheck current admission before the returned result's deterministic
writes, applying current pacing with the established execution/handling snapshot. Only one source
observation may be in flight or awaiting admission per monitor/workspace. Once an operation
relinquishes that admission, its later completion/error reporting **MUST NOT** remove a successor's
slot or wake waiters as if that successor had finished. If reconciliation is
blocked, retain that returned result locally and finish the tick with an explainable error, so the
daemon can run a later recovery scan. A successful rescan drains the old captured holds and admits
the retained result before another observation or watcher factory can overtake its source baseline.
This local retention is not a durable recovery queue: before admission, the persisted source cursor
remains unchanged, so restart reobserves from that cursor under the existing source contract.

Watcher factory creation **MUST** reread the gate and cancellation in its synchronous creation
turn. Its full initial definition is the latest admitted definition at actual creation; subsequent
pacing changes preserve that established execution/handling snapshot. Outstanding polls precede
factory creation, including a startup overlapping polling without a failed edit.

Cached notify definitions **MUST** belong only to live watcher/poll admissions or locally retained
results. Removing a deferred result for handoff **MUST** release exactly its retained lease on
every invocation exit, including definition assembly or source-result argument getters failing
before ingestion starts. Other live watcher/poll owners keep their leases. Such handoff failures
remain visible as ordinary observation failures **after** the edit transaction committed; they
cannot claim the drained holds were retained or restore them. Poll completion and watcher teardown
release their ownership; cancellation/session close/dormancy also retire unadmitted ephemeral results. Reaping cannot resurrect their timing/baselines
or keep private instruction snapshots as historical cache entries. Cleanup of this process-local
metadata does not delete durable holds, event history or diagnostics. Missing/invalid definitions
with operational work retain that work until valid reconciliation or its existing lifetime rules.

An invalid/unreadable/missing current definition **MUST** retain its operational holds and report
the blocking reason. Current source-scope validation at this boundary protects existing holds;
it does not introduce general observe-time preflight for monitors without held work. When a tick
or watcher startup rejects a scope (§2.0) that has durable holds or a retained poll result,
admission closes and a running watcher's next batch waits for valid reconciliation. Without
such held work, the rejection never closes admission by itself: a watcher whose admission is open
keeps its startup config, while one already blocked (an unresolved source, a failed drain) stays
blocked until a valid definition is reconciled, and nothing it yielded is lost.
There is no implicit cancellation on removal, rename or invalid metadata. Draining retained retries
(§2) and flushing unchanged policies after source errors are separate contracts, not added by this rule.

**Example.** At 08:00, debounce holds A at normal urgency with instructions X. At 08:00:02 the author
selects daily rollup and instructions Y. Reconciliation commits A immediately with normal/X and
its original 08:00 timestamp, before any new source observation. New B uses Y and waits for rollup's
09:00 window. If A's write fails, A remains held and B is not newly observed until the drain succeeds.

**Verification:** `runtime/notify-boundaries.test.ts` covers immediate/throttle escalation identity,
real watcher batch microtask races, synchronous acceptance before Interpret, and actual
hook-file refresh after idle/completed startup drains. `runtime/notify-policy-edit.test.ts` covers the transition/default/parameter
matrix, captured fields, unchanged clocks, missing/invalid definitions, SQLite trigger failures
(including a later batch event and hold removal), sibling/workspace isolation, watcher backpressure,
post-commit Interpret, actual owned-child SIGKILL before/after commit and independent-process stale
read reconciliation. Child probes load the same TypeScript source without invoking a package build.

### 4.7 Held-work serializability (_current_)

> **Status: current.** Refs #570.

Debounce (§4.3) and rollup (§4.4) holds persist their observation envelopes as JSON in
`monitor_state.notify_state`. An envelope that JSON cannot encode, such as a payload holding a
BigInt or a cyclic reference, would make every later state write for that monitor fail. The source
baseline would then never advance, the same batch would be observed again on every tick, and the
monitor would stop.

The runtime **MUST** check serializability once per observation, at **hold acceptance**: the
point where an observation would join `pendingDebounce` or `pendingRollup`. The check uses the
same serializer as the state write, so an envelope that passes stays serializable in every later
write of that hold. The check serializes the envelope separately from the write, so it covers
values that serialize identically each time. A non-deterministic accessor (a getter that returns a
BigInt only on a later read) can still pass the check and fail the write; the runtime does not
defend against that. The same rule covers both strategies and every path into a hold: poll and watch
span admission (§2), a deferred poll result admitted after a notify edit (§4.6), and a debounce hold
that starts on an escalated observation's urgency. Every one of them reaches the hold through notify
dispatch, which is where the check runs. An effective edit's drain and startup reconciliation
(§4.6) only empty holds, and a rollup window check on a tick that is not due carries over envelopes
that were already accepted; none of them adds a new envelope to a hold.

An observation that fails the check is **not held**:

1. It never joins the hold. The batch's other observations are unaffected: serializable siblings
   before and after it are held in their original order, and the hold's `dueAt` is not reset on
   its account.
2. The span's admission transaction (§2) proceeds. Its state write advances the source baseline
   past the batch, so the observation is not observed again, including after a restart, and later
   observations are accepted on following ticks.
3. It gets one `errored` `observation_history` row, written inside that same admission
   transaction, before the span's batch row. If the transaction rolls back, the row, the state and
   every sibling's outcome roll back together, and the batch is decided again from the prior
   baseline. The row's `observationData.error` is
   `Observation "<title>" was not held for <debounce|rollup>: it cannot be serialized (<reason>).`
   The title and reason are each reduced to one terminal-safe line. The title is capped at 200 code
   points and the reason at 512. The stored row and JSON history keep the whole message; history and
   explain text, and explain's stage reasons, cap it at 512 code points, so the start of the reason
   always stays visible there, but a long reason (for example a deep circular-structure path) can be
   cut. If the serializer's reason cannot be read (it threw a value that cannot be
   converted to text), the reason is the fixed text `unknown serialization error`; building the
   message never throws.
4. The same message is reported where the path reports failures: the tick result's
   `erroredObservations` (`{ monitorId, message }`), or the watcher's `onError` callback. The
   report happens only after the admission transaction commits and the span has materialized
   (including any Interpret), so a callback that throws cannot lose work already committed, such as
   a debounce batch that flushed in the same dispatch. A throwing callback is ignored. A span that
   rolls back reports no refusal; it reports its own failure instead.

The span's batch row (§`observation_history`) counts a not-held observation in `observed`, adds
`notHeld: <n>`, and classifies only the remaining observations: a mixed span that holds a sibling
is `suppressed`. A span whose only observations were not held writes no batch row, because nothing
was held or emitted. Its `errored` rows are the outcome. The batch-row rules of §2 still apply to
the rest of the span: a span that also emitted carries both counts, for example
`triggered { observed: 3, emitted: 1, notRetainedCount: 1, notHeld: 1 }`, and a span whose
dispatched observations all failed writes no batch row.

A refusal is **not** a drop (§2 "Admission outcomes when the outbox cannot retain a suffix"). It
is decided before materialization, never reaches the retry outbox, and its row carries no drop
identity. Doctor and explain do not count it as outstanding unretained loss.

Hold acceptance applies only where an observation would be held. An observation that goes straight
to materialization is never checked here: immediate, throttle, an escalation that flushes a
debounce batch (§4.1), and an observation arriving on the tick a rollup window fires. If it cannot
be persisted as an event, it fails at materialization (§5), where §2 retains it for retry or drops
it. That is a separate outcome, decided by the materialization contract, not by this rule.

This rule does not make such payloads round-trip. A value JSON encodes lossily, such as an
`undefined` member (omitted) or a `Date` inside the payload (an ISO string), is held as it is today.
The check does not adopt the retry outbox's stricter plain-data domain
([`materialization_retry_outbox`](#materialization_retry_outbox)).

Since a refused observation never enters a hold, it never contributes held work to an effective
notify edit's drain (§4.6) or to the admission gate that held work closes. The gate sees only
serializable holds, and a refusal cannot leave it closed.

**Example.** A debounce monitor's source returns `[Bad, A]`, where `Bad.payload` is `{ count: 10n }`.
The tick reports `Observation "Bad" was not held for debounce: it cannot be serialized (Do not know
how to serialize a BigInt).`, records that `errored` row, and holds `A`. The source baseline
advances. The next tick observes `B` and holds `[A, B]`; after the settle window both materialize.

**Verification:** `runtime/notify-hold-serializability.test.ts` covers debounce and rollup, each with
a BigInt and a cyclic payload, with and without a restart between ticks. Each case covers the
sibling held, the baseline advancing, the single `errored` row, and later observations
materializing. It also covers: a span whose only observation is refused; sibling order around a
refusal; an effective notify edit draining the accepted hold; the watch path's `onError`; the batch
row's `notHeld` count; title sanitization and the 200-code-point title cap; a refusal leaving the
hold's `dueAt` unchanged; a `toJSON` that throws an unconvertible value; a watcher `onError` that
throws while a due batch flushes; a deferred poll result admitted after a notify edit
(`runtime/notify-deferred-handoff.test.ts`); a span that mixes a refusal, an admitted observation
and a drop, counted once each in the batch row, with the drop alone outstanding; a span whose
admission rolls back reporting and recording no refusal, then refusing once on the retry; a refusal
row that cannot be written rolling its span back; a refusal leaving the admission gate open for a
running watcher when a later definition is rejected
(`runtime/edit-drain-admission-outcomes.test.ts`); the built
CLI's `monitor history` showing the reason of a long-titled refusal; and JSON-encodable payloads
(`undefined` members, Dates) still being held.

## 5. Event Materialization

Each emitted observation becomes one row in the `monitor_events` table. The runtime **MUST** persist at least: `id`, `workspacePath`, `monitorId`, `sourceName`, `urgency`, `title`, `body`, `summary`, `payload`, `snapshotMetadata`, `snapshotText`, `diffText`, `objectKey`, `queryScope`, `tags`, `createdAt`.

The event row, every matching lead-session projection, any first-recipient cursor seed, and the
event's snapshot form one synchronous durable materialization unit. They **MUST** commit in one
immediate SQLite transaction or all roll back. Optional Interpret work begins only after that
transaction commits and remains best-effort; an Interpret failure cannot undo the deterministic
artifact.

Verified: `libs/core/src/runtime/service.ts` — `materializeObservation()`;
`libs/core/src/runtime/store.ts` — `insertEvent()`; and
`libs/core/src/runtime/transactional-materialization.test.ts`.

### 5.1 Derived defaults

If an emitted observation omits fields, the runtime **MUST** derive them as follows:

- `body`: observation body, otherwise monitor instructions
- `urgency`: the **effective urgency** = `clamp(observation.salience ?? band.lo, band.lo, band.hi)`
  (see [§4.1](#41-default-notify-behavior)). With no `salience`, this is the band's low bound (the
  monitor's authored base urgency). The persisted `monitor_events.urgency` is the same effective value
  notify timing used, so a held batch and its event rows agree.
- `summary`: observation summary, otherwise observation body, otherwise title
- `objectKey`: observation `objectKey`, otherwise the monitor ID
- `queryScope`: observation `queryScope`, otherwise `{}` — and if the observation sets `changeKind`
  (see [003 §2.3](./003-source-plugins.md)), the runtime adds `changeKind` to the stored
  `queryScope` so the source-agnostic lifecycle is filterable without each source duplicating it.
- `snapshotMetadata`: observation `snapshot`, otherwise `{}`

Verified: `libs/core/src/runtime/service.ts` — `materializeObservation()`.

### 5.2 Snapshots and diffs

An explicitly empty `snapshotText: ""` is a present snapshot, not a missing value. The runtime
**MUST** persist it and compute the prior-to-empty deletion delta for both shared history and a
newly projected recipient. A later nonempty observation diffs from that empty baseline. Only
`null`/`undefined` mean no snapshot. Verified: `runtime/empty-snapshot.test.ts` exercises
nonempty → empty → nonempty through the runtime and a late-joining lead session.

If an emitted observation includes `snapshotText`, the runtime **MUST**:

1. look up the latest stored snapshot for the same `(workspacePath, monitorId, objectKey)` triple
2. compute a textual diff if a previous snapshot exists
3. store the new snapshot in the same transaction as the event, projections, and cursor seeds

**Snapshot ordering (total materialization order).** The runtime **MUST** resolve
"the latest stored snapshot" to the most recently materialized retained row for its
workspace/monitor/object, independently of observation timestamps, ambient clock changes,
or process-local ULID factories. `monitor_snapshots.sequence` is a private SQLite
`INTEGER PRIMARY KEY AUTOINCREMENT`, allocated in the snapshot insert and its enclosing
materialization transaction. `latestSnapshot()` orders by `sequence DESC` only. Public
snapshot `id` values remain unique ULIDs; they identify rows but do not order them.

SQLite's single writer serializes allocations across connections/processes. A rollback
leaves no committed predecessor and may reuse its uncommitted allocation. Deleting any
committed rows, including the newest or all rows, does not reuse their sequence numbers;
a new snapshot follows the remaining history. Explicit integer keys survive reopen and
`VACUUM`. The sequence is private ordering metadata, not an external cursor or contiguous
counter. Existing event/projection/snapshot atomicity is unchanged.

A legacy snapshot table is rebuilt atomically under the schema migration's immediate
transaction. All public IDs, contents, timestamps, scope and event references survive;
explicit indexes and triggers are recreated without replaying insertion side effects.
The event and snapshot rebuilds share one trigger-preservation scope inside that
transaction. When either retained legacy table needs rebuilding, all persisted
main-schema triggers are temporarily suspended, including triggers owned by other
tables that reference either rebuilt table. Their exact stored SQL is restored only
after both final table names exist. A copy, index or trigger-restoration failure rolls
back the complete original schema and data. Already-current/new schemas do not churn
triggers; connection pragmas, public identities and ordering policies remain unchanged.

**Columns the current schema does not define are carried, never dropped** (_current_,
issue #569). The rebuild derives its target from the live table (`PRAGMA table_xinfo`),
not from a fixed column list. Columns the current schema defines take their current
definitions (§15); one the old table lacks takes its default. Every other column — one a
released version later stopped creating (0.0.1–0.3.0's `monitor_events.event_kind`), one a
later change adds in place, or one an operator added — is carried with its values, its
declared type and its default; an expression default such as `(datetime('now'))` is carried
as an expression, including one that ends in a line comment. A carried column keeps `NOT NULL` only when it has a default, because the
current writer never names it.

What the rebuild preserves, loses and refuses:

- **Preserved:** every column and its values; each carried column's type and default; the
  current definitions of current columns (including `id` uniqueness, which also covers a
  released `id TEXT PRIMARY KEY`); every explicit `CREATE INDEX` / `CREATE UNIQUE INDEX` and
  every trigger, recreated from its exact stored SQL.
- **Lost:** a carried column's collation (a `COLLATE NOCASE` column behind an explicit unique
  index then compares case-sensitively), and its `NOT NULL` when it has no default: the
  rebuilt column admits `NULL` where the old one did not, because the current writer never
  names the column and would otherwise fail every insert.
- **Refused:** any `UNIQUE` or `PRIMARY KEY` constraint other than the lone `id` key (inline on
  a carried column, or table-level; SQLite backs each with an automatic index that is not an
  explicit index and cannot be recreated, and a rowid-alias `INTEGER PRIMARY KEY` on another
  column has none to detect, so it is found through the column's primary-key position); any
  `CHECK` constraint, inline or table-level, found by scanning the stored table text with
  string literals, quoted identifiers and SQL comments blanked; any `REFERENCES` clause
  (found through `PRAGMA foreign_key_list`), since the connection enforces foreign keys and
  the rebuilt table would admit orphan rows the old one rejected; and a `STRICT` table (found
  through `PRAGMA table_list`), since the rebuilt table is not strict and would admit values
  the old one rejected. Dropping these would
  silently admit rows the table rejected, so the open stops with a `SchemaMigrationError`
  instead. The message names the table, and the column when one is identifiable (a `CHECK`
  that mentions no column is reported as "the table has a table-level CHECK constraint", and
  a `STRICT` table likewise names no column), and ends with the remedy: SQLite
  cannot drop a column or table constraint in place, so rebuild the table by hand without it (or
  restore the database), and the open will then proceed.

Since every column survives, every explicit index and trigger still resolves; the rebuild
drops none of them. Opening any database a released version wrote therefore succeeds without
losing an event or snapshot value.

A rebuild that cannot carry a row or column stops before copying and reports a
`SchemaMigrationError` naming the table, and the column when one is identifiable, for example
`Cannot migrate monitor_events to the current schema: column "id" has no value in a
retained row, and the current schema requires one. The database was left unchanged.`
This covers a generated column (its expression is not recoverable from table metadata),
a `UNIQUE`/`PRIMARY KEY`/`CHECK`/`REFERENCES` constraint it cannot recreate or a `STRICT` table (above), and a retained row
holding `NULL` in a column the current schema requires, with or without a default (a
released `id TEXT PRIMARY KEY` admits `NULL`). The error names the live table (and column, when one is identifiable),
never the scratch table. The schema transaction rolls back, so the database
keeps its original schema and data; the open fails the same way until that row or column
is repaired.

Retained rows receive sequence numbers in their **current hidden rowid order**. This is
an explicit bootstrap policy: it cannot recover chronology already lost before migration
(for example through historical `VACUUM`) or repair previously generated diffs. Reopening
an already migrated database is idempotent; simultaneous openers serialize the migration.
Older binaries can still insert their named columns, but their timestamp/ULID readers do
not gain the corrected ordering behavior. Event ordering is defined separately in §1.1.7; observation-history ordering and source
frontiers are unchanged by these sequences.

The renderer is chosen by the object's `change-detection.strategy` (003 §4.2/§11.3), via `buildDiff(previous, current, strategy)`:

- **Default** (`strategy` omitted, `text-diff`, `exit-code`, or anything else `buildDiff` does not recognize): a line-level unified-style representation capped at 20 changed lines, produced by `buildTextDiff`. If previous and current text are identical, `buildTextDiff` returns the empty string.
- **`strategy: json-diff`**: a **structural** diff — added/removed/changed elements or key paths, e.g. `- removed[number=430]: {"number":430,"title":"..."}` — produced by `buildJsonDiff`, capped at 20 diff entries with an explicit `… N more changes elided` marker (the `json-diff` analog of `buildTextDiff`'s line cap), and each rendered value truncated at 300 characters. This avoids `buildTextDiff` degrading a compact single-line JSON snapshot into a whole-line remove-all/add-all when one array element changes (issue #437) — the json-diff strategy already detects the change structurally; the rendered `diffText` no longer throws that structure away. Arrays of objects are diffed by element identity where feasible: a stable-key heuristic (trying `id`, `key`, `uuid`, `_id`, `slug`, `sha`, `number`, `name`, in that order, for a field that is a unique scalar on every element of both sides) first, then whole-element deep-equality matching (order-insensitive; added/removed only — no reliable identity to report a `changed` element against) when no such field exists; arrays of non-object elements diff positionally by index. Both identity-based matchers are themselves order-insensitive, but `hasChanged` is array-order-**sensitive** (it sorts object keys, never array elements) — so a pure element reorder renders an explicit `reordered` entry rather than an empty diff, preserving "change detected ⟺ non-empty `diffText`". `buildJsonDiff` falls back to `undefined` — and `buildDiff` then falls back to `buildTextDiff` — whenever either side fails to parse as JSON, identical to each `json-diff` source's own `hasChanged` fallback (003 §11.3/§4.2): this specific parse-fallback decision never disagrees between the two.

> **Known gap (not yet fixed): `command-poll`'s `ignore-paths` is not carried through to the renderer.**
> `command-poll`'s `json-diff` strategy MAY set top-level `change-detection.ignore-paths` (003
> §11.3) to strip noisy fields (e.g. a `duration`) BEFORE its own `hasChanged` comparison decides
> whether a change occurred. `buildDiff`/`buildJsonDiff` are not given `ignore-paths` and always
> diff the raw `snapshotText`, so an ignored field's churn still renders in `diffText` — and, in the
> worst case, can push the real change past `MAX_JSON_DIFF_ENTRIES` and out of the rendered output
> entirely, even though `hasChanged` correctly ignored that field when deciding a change occurred.
> Fixing this (carrying `ignore-paths` through the persisted snapshot metadata and stripping the
> same fields before rendering) is a follow-up, not implemented as part of issue #437.

Verified: `libs/core/src/runtime/service.ts` — `materializeObservation()`; `libs/core/src/runtime/store.ts` — `insertEvent()`, `collapseNetForClaim()`, `saveSnapshot()`/`latestSnapshot()` (private SQLite snapshot sequence); `libs/core/src/runtime/diff.ts` — `buildDiff()`, `buildTextDiff()` (cap at 20 lines), `buildJsonDiff()` (cap at 20 entries); `libs/core/src/runtime/transactional-materialization.test.ts` (rollback after cursor and snapshot failures).

This makes snapshot history an object-level concern rather than a monitor-level or session-level concern (SP5).

> **Pipeline model.** In the stage vocabulary of [§1.1](#11-post-processing-pipeline-model), the diff
> described here is the **shared object-level** diff against the latest stored object snapshot,
> retained on `monitor_events.diff_text` for `events list`/history. As of G10 PR-A the **delivered**
> Diff is computed **per recipient against that recipient's own baseline cursor**, right of the
> shared/per-recipient seam ([§1.1.2](#112-the-shared--per-recipient-seam)), and recorded on
> `session_event_state.diff_text`; the shared object-level diff here is its degenerate
> single-baseline case (a recipient at the shared baseline gets a byte-identical span).

### 5.3 Pending events keep the semantics they were observed under

> **Status: current.** Resolves issue [#451](https://github.com/mike-north/AgentMonitors/issues/451).

Editing a monitor's `MONITOR.md` (raising `urgency`, rewriting the body, narrowing a
`command-poll` filter) is routine, and an edit can land while events from the old definition are
still pending or while an observation is held in a notify batch.

**Contract.** A monitor event is delivered with the `urgency`, `title` and `body` it was
materialized under. An edit changes what _future_ observations produce; it never changes an event
already stored, and it never changes whether that event interrupts a turn. An observation held in a
debounce/rollup batch across the edit materializes under the definition it was observed under,
because the batch stores the whole definition snapshot with each observation.

This holds because of how the runtime is built, not because of a special case:

- `processObservation` writes `urgency`, `title` and `body` onto the `monitor_events` row from the
  observation's stored definition snapshot, and no code path updates those columns afterwards.
- Every delivery surface (the `turn-interruptible`/`turn-idle`/`post-compact` claims, the hook and
  channel renderers, hook state, `events` output) renders the stored row, its stored digests and its
  per-recipient diff. None re-reads the live definition. The live definition is read only to decide
  _when_ to observe and for `explain`/`scan` display.
- Observation, event and source timestamps stay as provenance.

**Diagnostic.** Each row also stores `definition_fingerprint`, a short hash of the parts of the
definition that decide what an event is, computed once at materialization (nullable, additive; `NULL`
on rows from before the column existed). Objects are hashed in canonical key order, so key order and
whitespace in the file do not matter (array order does).

| Included                                  | Why it can change a stored or delivered event                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `urgency`, `urgencyMax`                   | the event's delivery urgency                                                                                                     |
| the body                                  | the delivered body when the source supplies none                                                                                 |
| `name`                                    | the delivered title ([§5.4](#54-event-title))                                                                                    |
| `watch`, except the scheduling keys below | source and configuration (command, query, globs, …) decide the payload and `objectKey`                                           |
| `shape`, `payload`                        | derive facts, render the snapshot and transform the payload before diffing, so they change the stored snapshot, diff and payload |
| `baseline-strategy`                       | stored on the event; decides how each recipient's catch-up span is collapsed                                                     |

| Excluded         | Why                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| `notify`         | decides when events materialize, not what they contain                 |
| `tags`           | a label used only to filter `events list`                              |
| `watch.interval` | read by the scheduling engine, not by any source; changes cadence only |

The schedule source's `cron` and `timezone` stay included: the scheduler reads them, but that source
also writes them into its payload and `objectKey`.

`monitor explain`'s delivery stage compares the stored fingerprint with the current definition and
reports the **total** number of pending events that predate it (not bounded by `--limit`), with their
ids in `details.staleDefinitionEventIds`. `NULL` means unknown and is never reported. The diagnostic
is read-only and never gates, delays or alters delivery.

**Verified in:** `libs/core/src/runtime/definition-change.test.ts`.

### 5.4 Event title

> **Status: current.** Resolves issue [#449](https://github.com/mike-north/AgentMonitors/issues/449).
>
> Verified: `libs/core/src/runtime/service.ts` — `materializeObservation()`;
> `libs/core/src/runtime/event-title.test.ts` (the core rule) and
> `apps/cli/src/commands/event-title-transports.test.ts` (the same title on both transports).

The runtime — not the source — decides a materialized event's `title`:

1. the monitor's **authored `name`** (frontmatter, [001 §3](./001-monitor-definition.md)) when present;
2. otherwise the source-provided observation `title`, unchanged.

A source's title is written from the source's point of view and routinely embeds a configuration
detail (`command-poll` interpolates its `objectKey`, which defaults to the joined argv). The author's
`name` is the one human-written string that says what the monitor is _for_, so it is the headline the
recipient sees. Source identity always remains on `objectKey` / `payload`.

**What happens to the source's `title` depends on whether the observation carries its own `summary`
(the compatibility contract):**

| Observation                                                  | Named monitor delivers                                                                                                                                   | Nameless monitor delivers                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `title` only, or `title` == `summary` (every bundled source) | title = `name`; detail line = source title (via the derived `summary`, §5.1)                                                                             | title = source title; no detail line          |
| `title` + a **distinct** `summary`                           | title = `name`; detail line = `summary` — the source's `title` string does **not** appear in delivered text                                              | title = source title; detail line = `summary` |
| `title` + `body`, no `summary`                               | title = `name`; detail line suppressed (the derived summary equals the body, which the block already renders — [006 §4.2.1](./006-agent-integration.md)) | title = source title; body below              |

So for a **named** monitor whose source sets a title and a _different_ summary, the source's title is
genuinely dropped from delivered text. This is intended, not an accident: `summary` is defined as the
short per-object text for lightweight delivery surfaces ([003 §2.1](./003-source-plugins.md)), so a
source that supplies one has already said which string it wants surfaced. A source that wants its
title preserved should make `summary` carry that text — which is what every bundled source does.

Both injecting transports render the detail line beneath the title
([006 §4.2.1](./006-agent-integration.md)) — so a per-object source still names the object that
moved, and the delivered text stays self-sufficient.

Because the title is chosen once at materialization, it is **transport-independent** — the hook and
channel renderers ([006 §4/§5](./006-agent-integration.md)) cannot diverge on it — and it is what
`events list` and history display too.

Sources bound a **configuration-identity** `objectKey` they interpolate into their own title/summary
([003 §2.8](./003-source-plugins.md#28-an-objectkey-is-an-identity-not-a-headline)), so a nameless
monitor's fallback title is bounded for those sources; path-like keys are deliberately excluded there
and remain unbounded.

## 6. Session Projection

Persisted events are not directly tied to one session. They are projected into matching sessions via `session_event_state`. When an event is inserted, the runtime **MUST** project it into matching **lead** sessions only.

Current projection rules: an event in workspace `W` projects into lead sessions whose `workspacePath` matches `W` **and** into lead sessions whose `workspacePath` is `null`, representing global visibility. Subagent sessions are tracked but do not receive automatic event projection.

As of G10 PR-A, the projection step also computes each recipient's **per-recipient delta** — the shared event's shaped artifact diffed against that session's own baseline cursor (`session_object_cursor`, [§1.1.2](#112-the-shared--per-recipient-seam)) — and records it on `session_event_state.diff_text`. A session's first projection of an object seeds its cursor to the pre-event state (so a late joiner hears only changes after it registered); `markClaimed` advances the cursor to the artifact the recipient was shown. Legacy rows (materialized before G10) carry a `NULL` `session_event_state.diff_text` and fall back to the shared `monitor_events.diff_text`.

Verified: `libs/core/src/runtime/store.ts` — `insertEvent()` filters `sessionsForWorkspace(event.workspacePath)` with `.filter(candidate => candidate.role === 'lead')` and computes/records the per-recipient `diff_text` in the same projection loop (durable before any Interpret await). `sessionsForWorkspace()` returns sessions matching the workspace path **or** sessions with a `null` workspace path. Proven by `libs/core/src/runtime/per-recipient-diff.test.ts`.

### 6.1 Session identity

Opening a session with the same `(adapter, hostSessionId)` pair resumes the existing AgentMon session record instead of creating a duplicate. Closing a session marks it dormant (`status = 'dormant'`, `dormantAt` set) but preserves all history.

Verified: `libs/core/src/runtime/store.ts` — `openSession()` (lines 102–152): checks for an existing row by `(adapter, hostSessionId)`; if found, sets `status = 'active'` and clears `dormantAt`. `closeSession()` (lines 175–188) sets `status = 'dormant'`.

### 6.2 Per-session dormancy (_current_)

> **Status: current** (Refs #312). Added so [007 §4.4](./007-agent-facing-interaction.md)'s
> ephemeral monitors reap on a session going dormant, not only on an explicit close.

§6.1 makes a session dormant on an **explicit** close (the `session close` verb, driven by the host's
session-end hook). A session can also go away **without** an explicit close — the host crashes, the
tab is killed, or the end hook never fires. For those cases the runtime defines a **per-session
dormancy trigger by inactivity**:

- A session's `lastActiveAt` advances whenever it is opened/resumed ([§6.1](#61-session-identity)) or
  touched by a delivery claim (`touchSession`, [§9](#9-delivery-lifecycles)).
- On each tick, **before** evaluating monitors, the runtime transitions every `active` session in the
  ticked workspace whose `lastActiveAt` is at or before `now − DEFAULT_SESSION_DORMANCY_MS`
  (default **30 minutes**) to `status = 'dormant'` (setting `dormantAt`), via the same path as an
  explicit close. This releases the session's session-scoped resources — notably its **ephemeral
  monitors**, which are reaped ([007 §4.4](./007-agent-facing-interaction.md)) — so a vanished
  session cannot keep firing watches indefinitely.
- This is a **per-session** transition and **MUST NOT** be conflated with the daemon-wide idle
  self-termination of [§10.2](#102-daemon-run--continuous-loop--unix-socket-server), which stops the
  whole daemon only after **all** of a workspace's sessions are inactive for `--reap-after-ms`. One
  session going dormant by inactivity does not stop the daemon; it only releases that session's
  session-scoped state. A resuming session (`openSession` with the same `(adapter, hostSessionId)`)
  becomes `active` again with a fresh `lastActiveAt`, but ephemeral monitors reaped during dormancy
  are **not** resurrected ([007 §4.4](./007-agent-facing-interaction.md)).

The threshold is generous by default (a live-but-thinking session is not reaped) and is a backstop:
the primary reap path stays the explicit close. It is overridable in-process (the
`AgentMonitorRuntime` constructor's `sessionDormancyMs` option) for deterministic tests.

Verified: `libs/core/src/runtime/service.ts` — `reapDormantSessions()` (called at the top of
`tick()`), the `DEFAULT_SESSION_DORMANCY_MS` constant and the `sessionDormancyMs` constructor option;
`libs/core/src/runtime/store.ts` — `staleActiveSessions()`. Proven by the
`reaps on per-session dormancy by inactivity` and `does NOT reap a session that is still within the
dormancy window` cases in `libs/core/src/runtime/ephemeral-monitors.test.ts`.

## 7. Unread, Claimed, and Acknowledged

For each projected event, the runtime tracks session-specific delivery state via `session_event_state`. These concepts are distinct (SP4):

- **Unread:** `acknowledgedAt IS NULL` in `session_event_state`. The session has not acknowledged the event.
- **Claimed (pending → notified):** `firstNotifiedAt IS NOT NULL`. The event has been surfaced at least once at a delivery lifecycle. Implemented as `pendingEventsForSession()` (events where `firstNotifiedAt IS NULL` and `acknowledgedAt IS NULL`).
- **Acknowledged:** `acknowledgedAt IS NOT NULL`. The session explicitly marked the event read.

This distinction matters because a claimed event may still need user or agent attention later.

Verified: `libs/core/src/runtime/store.ts` — `unreadEventsForSession()` (lines 435–452) and `pendingEventsForSession()` (lines 454–476); `libs/core/src/inbox/schema.ts` — `sessionEventState` columns (lines 86–96).

## 8. Hook State

Each session has a hook-state JSON file on disk. The file is written atomically (write to `.tmp`, then `rename`) to prevent partial reads.

Verified: `libs/core/src/runtime/service.ts` — `writeJsonAtomic()` (lines 45–50).

The hook state **MUST** include: `sessionId`, `updatedAt` (ISO 8601 string), unread counts for `low`, `normal`, `high`, and `total`, `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, `latestHighTitles`.

`hasPendingHigh` becomes `true` only when at least one unread high-urgency event is still unclaimed (`firstNotifiedAt IS NULL`) **and** its age is at or above the 15-second high-urgency settle window (`DEFAULT_HIGH_URGENCY_SETTLE_MS = 15_000`). This threshold deliberately mirrors the delivery condition used by `claimDelivery` at `turn-interruptible`.

`latestHighTitles` contains the titles of up to the 5 most recent unclaimed high-urgency events.

Verified: `libs/core/src/runtime/service.ts` — `refreshHookState()` (lines 426–447): settle window check at line 430–432; `highUnread.slice(-5)` at line 441. `libs/core/src/runtime/types.ts` — `SessionHookState` (lines 121–129).

## 9. Delivery Lifecycles

The runtime supports three delivery lifecycles as the `DeliveryLifecycle` union type: `turn-interruptible`, `turn-idle`, `post-compact`.

Verified: `libs/core/src/runtime/types.ts` — `DeliveryLifecycle` (lines 18–22).

`AgentLifecycleEvent` is a broader union that also includes `session-opened`, `session-dormant`, `turn-ended`, and `pre-compact`. These additional events are used by the adapter hook map but do not correspond to delivery claim points.

Verified: `libs/core/src/runtime/types.ts` — `AgentLifecycleEvent` (lines 9–16).

### 9.1 High urgency

At `turn-interruptible`, the runtime **MUST** deliver all pending high-urgency events that have aged past the 15-second settle window (`DEFAULT_HIGH_URGENCY_SETTLE_MS`). The delivery payload **MUST** summarize the concrete events (titles and summaries), not just emit a generic reminder. The `DeliveryClaim` will have `mode: 'delivery'` and include a populated `events` array.

Each element of the `events` array is a `DeliveryEventSummary` which carries: `eventId`, `monitorId`, `title`, `summary`, `objectDetail` (optional), `urgency`, `createdAt` (ISO-8601 string), `body`, and `diffText`. The `body` field is the raw monitor body-instructions (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`). It carries what the agent should **do** when the monitor fires, so a delivery transport (e.g. hook, MCP channel) can surface the instructions, not just the title/summary. `summary` is the **recipient-visible** field (§1.1.8): the per-recipient Interpret digest when one was produced, otherwise the deterministic `MonitorEventRecord.summary` → `body` → `title` fallback chain — a digest is a prose reading of the change and is not guaranteed to name which object it is about. `objectDetail` is the **deterministic**, never-digest-replaced per-object detail (`MonitorEventRecord.summary`); a transport rendering per-object identity (e.g. `buildEventBlock`'s detail line, §5.4) MUST prefer it over `summary`, since `summary` can carry no object identity at all for a multi-object `prose` monitor. `objectDetail` is optional only so a hand-constructed `DeliveryEventSummary` (e.g. a test) may omit it; the runtime always populates it for a real delivery. The optional `diffText` field is the change summary — what actually changed at the observed source — and is **recipient-specific**: it is `session_event_state.diff_text`, the diff THIS recipient's own baseline cursor produces against the shared observation, not necessarily the shared latest-snapshot delta. The shared `MonitorEventRecord.diffText` is used only as a legacy fallback when a pre-G10 row's per-recipient column is `null`. `diffText` is absent when the event carried no diff at all (neither the per-recipient nor the shared value is present); a transport that surfaces it MUST bound it, since a raw diff can be arbitrarily large (issue #436).

Verified: `libs/core/src/runtime/service.ts` — `claimDelivery()` turn-interruptible high branch: `settledHigh` filters by age, payload includes `summarizeEvents(...)` and a full `events` array with `body: event.body` and the recipient-specific `diffText` (`perRecipientDiffsForSession`, falling back to `MonitorEventRecord.diffText`).

#### 9.1.1 Cross-monitor coalescing window (issue #441)

> **Status: current** (issue #441, hardened by PR #456 review). Two monitors watching overlapping
> state — e.g. a high-urgency label monitor and a normal-urgency review-queue monitor both firing
> off the same underlying change — previously interrupted a session TWICE for one action: a
> settled-high delivery in one `turn-interruptible` call, then, once the high events were claimed, a
> SEPARATE normal-reminder delivery in a later call. A first fix attempt still preserved the
> two-interrupt failure whenever the normal reminder was due BEFORE the sibling high event settled —
> it fired standalone immediately, and the high batch (and its own coalescing) only arrived on a
> LATER call once it settled. This section describes the corrected behavior: the normal reminder is
> **withheld** whenever ANY high-urgency work is genuinely pending (settled or not), and only ever
> fires standalone once no high-urgency work is pending at all.

When a settled high-urgency batch (§9.1) is due **and** a normal-urgency reminder (§9.2) is
simultaneously due in the SAME `claimDelivery`/`reserveDelivery` decision, the runtime **MUST**
fold both into ONE `DeliveryClaim` rather than returning the high batch and deferring the normal
reminder to a later call:

- The claim's `events` array is unchanged from a pure high-urgency delivery — it still carries only
  the settled high-urgency `DeliveryEventSummary` entries (§9.1). A normal reminder never gains
  per-event detail from being coalesced; it stays a generic prompt, exactly as it would render on
  its own (§9.2).
- The claim's `message` is the high-urgency summary (`summarizeEvents(...)`) followed by the normal
  reminder text on its own line (`COALESCED_NORMAL_SUFFIX`, the transport-neutral `reminderMessage()`
  body of §9.2 — no product prefix, no CLI/tool verb).
- The claim carries a separate, optional `coalescedReminder: string` field, set to the SAME
  `reminderMessage()` body, whenever (and only whenever) a due normal reminder was folded in.
  **This field exists because neither `events` nor `message` is, on its own, enough for a
  length-bounded (events-rendering) transport to notice the coalesced reminder**: the hook-deliver
  and channel transports render `events` as concrete per-event blocks and never consult `message`
  once `events` is non-empty (§5.1, §5.5, §6). Before `coalescedReminder` existed, `claimDelivery`
  claimed the coalesced normal rows alongside the surfaced high events, but neither bounded
  transport rendered them anywhere — a claimed-but-unrendered violation of the claimed-set-equals-
  rendered-set invariant (§5.5). Both bounded transports **MUST** render `coalescedReminder`,
  sanitized, as a footer appended AFTER the packed event block(s), **and MUST append their own
  transport-owned acknowledge action step to that footer** — exactly as the standalone reminder of
  §9.2 does (the hook transport's `agentmonitors events ack`, the channel transport's `agentmon_ack`
  tool; [006 §5.1.1](006-agent-integration.md#511-attribution-is-transport-owned-delivered-text-is-self-sufficient-issues-438-434)).
  The runtime's `coalescedReminder` carries only the transport-neutral body, so without this the
  coalesced reminder would be self-insufficient (a "changes are pending" line with no way to act),
  the exact trap §9.2's self-sufficiency contract exists to prevent. See §5.1 and §6 for the exact
  rendering and cap-sizing contract. A transport that renders `message` directly instead of `events`
  (e.g. `hook claim --format text`) needs no separate handling — the reminder is already part of
  `message` there.
- The claim's top-level `urgency` **MUST** remain `'high'` — the most urgent band present in the
  batch. Coalescing **MUST NOT** downgrade the reported urgency because a lower-urgency reminder
  rode along, and **MUST NOT** escalate the normal reminder's own semantics (its events are not
  surfaced as high-urgency `DeliveryEventSummary` entries, and its own `urgency` field, where it
  appears at all, is never rewritten). This composes with issue #451's snapshot-at-materialization
  contract: coalescing decides only WHEN two already-materialized bands are delivered together,
  never re-derives an event's own urgency or body.
- Both the surfaced high-urgency events and the coalesced normal-urgency events are marked claimed
  in the SAME `applyDelivery` call, so a subsequent `claimDelivery` call does not re-deliver the
  normal reminder as a second interrupt for the same action.
- **A normal reminder that is otherwise fully due MUST NOT fire standalone while ANY high-urgency
  event is pending (unclaimed) but not yet settled.** Firing it standalone here would preempt this
  turn, and the high batch (with its own coalescing) would only surface on a LATER
  `turn-interruptible` call once it settles — reproducing the exact two-interrupt failure this
  section exists to fix, just shifted from (high-then-normal) to (normal-then-high). The reminder is
  instead withheld until there is no pending high-urgency work at all; once the pending high event
  settles, it is folded into that SAME delivery per the bullets above.
- The fresh-pending-batch reminder policy (§9.2) applies
  and still gates whether a normal reminder is due at all; this section only changes WHERE (and, per
  the bullet above, WHEN) a due normal reminder is delivered.
- A length-bounded transport sizing how many whole high-urgency event blocks fit under its cap
  **MUST** also account for a pending coalesced reminder — its own doc comment/API
  (`previewCoalescedReminder`/`previewCoalescedReminderClient`) exists precisely so sizing can
  reserve room for it BEFORE packing event blocks, not just after (see §5.1/§5.5).
- **Scope note:** this coalescing is specific to `turn-interruptible` (high + normal). Low-urgency
  reminders fire at the separate `turn-idle` lifecycle (§9.3) and are not folded in — a lifecycle
  boundary, not a settle-window artifact, separates them, so there is no equivalent "same call"
  moment to coalesce across. Two monitors that both materialize `high`-urgency events for the
  session are already coalesced by §9.1 (`settledHigh` pools ALL pending high events for the
  session regardless of which monitor produced them) — this section closes the remaining gap: high
  coalescing WITH a concurrently-due normal reminder.
- `hook deliver --debug`'s diagnosis (§10.7-adjacent `diagnoseHookDelivery`, issue #334) mirrors this
  precedence: it reports a `settle-window`-reasoned hold on the `normal` band when a fully-due
  reminder is being withheld by a concurrent unsettled high-urgency event, and independently still
  reports `no-new-work` only when no fresh work remains, and `reserved-in-flight`
  while a same-band reservation is active. Older claims do not withhold a fresh reminder.

Verified: `libs/core/src/runtime/service.ts` — `decideDelivery()`'s `turn-interruptible` branch computes `normalReminderDue` before the settled-high branch; when both are due it folds `normalPending` into the high branch's `candidates`, appends `COALESCED_NORMAL_SUFFIX` to the claim's `message`, and sets `coalescedReminder`; when a fully-due reminder exists but `highUnread.length > 0` with nothing settled, it returns no delivery (withheld) rather than firing the reminder standalone. `previewCoalescedReminder` (core) / `previewCoalescedReminderClient` (CLI) mirror the same due-check read-only for transport sizing. `diagnoseHookDelivery`'s `classifyCoalescingWithheldHold` (`hook-delivery-diagnosis.ts`) reports the withheld-by-settle-window case; `classifyReminderHold` is now evaluated unconditionally (not gated on `settledHighCount === 0`). `renderHookDelivery` (`apps/cli/src/hook-deliver-render.ts`) and `renderChannelEvent` (`apps/cli/src/channel-render.ts`) render `claim.coalescedReminder` as a cap-reserved footer after the packed event block(s). Proven by the "coalesces a due normal-urgency reminder..." / "holds a due normal-urgency reminder while a sibling high-urgency event is still inside its settle window, then coalesces both once it settles (issue #441 review finding 1)" / urgency-mixing-guard cases in `libs/core/src/runtime/service.test.ts`; the `previewCoalescedReminder` cases in `libs/core/src/runtime/hook-cap-redelivery.test.ts`; the withheld/fresh-batch-alongside-settled-high cases in `libs/core/src/runtime/diagnose-hook-delivery.test.ts` and `hook-delivery-diagnosis.test.ts`; and the reminder-footer rendering/sizing cases in `apps/cli/src/hook-deliver-render.test.ts` and `apps/cli/src/channel-render.test.ts`.

### 9.2 Normal urgency

At `turn-interruptible`, fresh pending normal-urgency events are delivered as one coalesced reminder per batch. Previously claimed-but-unacknowledged events MUST NOT block new pending work. A live same-band reservation temporarily withholds the reminder until commit, release or lease expiry; high-urgency settling still coalesces the reminder as specified in §9.1.1. The `events` array is empty in this case.

**Reminder wording contract (issues #438, #434; revised by PR #445 review, finding 2).** The runtime emits a **semantic, transport- and verb-neutral** reminder body, built by `reminderMessage()`:

```
Monitored changes are pending.
```

Two properties are **normative**:

1. **No product-name attribution.** The runtime **MUST NOT** embed a product name (e.g. `AgentMon`) in the reminder body. Attribution is a property of the delivery **surface**, and is owned by each transport ([006 §5](006-agent-integration.md)): the hook transport prepends its own label because its `additionalContext` arrives in the agent's context window unlabeled; the channel transport prepends **nothing**, because its `<channel source="agentmonitors">` tag already names the source. A product name in the body double-attributed the channel. This also keeps the core host-agnostic — per-surface phrasing lives in the adapter/transport, never in the runtime.
2. **No reference to the legacy `inbox` model.** `inbox_items` is explicitly non-authoritative ([§12](#12-legacy-inbox-model)); the authoritative path is events/session projection. The former wording (`'AgentMon messages are available. Read the inbox.'`) steered recipients toward a deprecated concept with no runnable referent, and **MUST NOT** reappear in any authoritative delivery string. (The legacy `inbox` CLI surface itself is unchanged.)

**Self-sufficiency and the acknowledge step are transport-owned (revised by PR #445 review, finding 2).** An earlier revision of this function also embedded the concrete `agentmonitors events list`/`events ack` CLI commands directly in the shared message — but the channel transport pushes this string verbatim into its `<channel>` tag body, and a channel-connected agent acknowledges through the `agentmon_ack` MCP tool ([006 §4.3](006-agent-integration.md)), not the CLI. Baking one transport's verb into the transport-neutral message put conflicting instructions on the channel surface. Each transport now appends its **own** concrete, runnable next step — including the acknowledge step, with the recipient's real session id interpolated (the transport has it on the `DeliveryClaim`/its own render options) — on top of this shared sentence: the hook transport names `agentmonitors events list`/`events ack` directly, with an explicit `--socket <path>` ([006 §5.1.1](006-agent-integration.md#511-attribution-is-transport-owned-delivered-text-is-self-sufficient-issues-438-434)); the channel transport points at its `agentmon_ack` tool instead. Including the ack step somewhere in the delivered payload lets the recipient explicitly complete handling of the observations (issue #434) — this is a property of the **overall rendered payload**, not this shared message alone.

The same body is used for the low-urgency reminder (§9.3); urgency is carried in the claim's `urgency` field and in the transports' metadata, not in the prose.

**Fresh work is independent of acknowledgment of older work (current).** Delivering a reminder
claims only its pending batch (`firstNotifiedAt` is set), never acknowledges it. With no newly
pending work, repeated claims return `null`; old work remains unread and queryable until explicitly
acknowledged. If event A was claimed and event B arrives, B MUST produce a new reminder at the next
eligible lifecycle without requiring acknowledgment of A. This applies across monitors and after a
mixed-band recap. It deliberately replaces the former `pending === unread` band-wide suppression.

A live same-band reservation still holds the next reminder, preventing simultaneous generic reminders
from competing transports. That hold ends on commit, release or expiry; the committed older batch
then remains unread but cannot block the next pending batch. The runtime MUST NOT auto-acknowledge,
reset prior claims, or re-claim old rows to obtain forward progress.

**Diagnostics.** `no-new-work` means no fresh pending work remains. `reserved-in-flight` means
a same-band lease is the temporary blocker, even when older claimed rows coexist; it MUST NOT
recommend acknowledgment as a remedy. Fresh pending work with no lease produces neither finding.
`coalesced-until-ack` remains a legacy wire value for compatibility with older daemon responses,
but current decisions never emit it. Concurrent high settling still reports `settle-window`.

**Acknowledgment remains explicit and handled-item scoped.** A reminder tells the recipient to inspect
unread events and acknowledge handled work; it does not identify every item that was handled. The
existing transport-owned action steps remain in force. Older unread claims are included in unread
queries and counts; a new reminder does not erase them or certify their completion.

Verified: `libs/core/src/runtime/reminder-progress.test.ts` covers new batches through direct hook
claims and channel reserve/commit, per-session isolation, lease commit/release/expiry, and high settle
coalescing. `reminder-diagnosis.test.ts`, `hook-delivery-diagnosis.test.ts` and
`diagnose-hook-delivery.test.ts` cover truthful holds. `apps/cli/src/delivery-text.integration.test.ts`
checks rendering of fresh normal/low batches through both transport renderers.

### 9.3 Low urgency

At `turn-idle`, fresh pending low-urgency events are delivered as one coalesced reminder per batch.
The normal-band pending/claimed/lease rules of §9.2 apply identically. Old claimed-but-unacknowledged
low events MUST NOT block a fresh low batch. The `events` array is empty; the reminder body is the
same transport-neutral `reminderMessage()`. No low event is promoted to the normal lifecycle.

Verified: `libs/core/src/runtime/reminder-progress.test.ts` runs the same forward-progress, isolation
and reservation scenarios for `low` at `turn-idle` and `normal` at `turn-interruptible`.

### 9.4 Recap

At `post-compact`, if unread events remain, the runtime **MUST** emit a recap payload that:

- includes a summary of up to the 10 most recent unread events (`MAX_RECAP_EVENTS = 10`, using `.slice(-10)` so the 10 newest are included)
- appends two commands: one for full session history and one for unread details
- updates `lastRecapAt` on the session record

The `DeliveryClaim` in this case has `mode: 'recap'`. The `events` array contains up to 10 `DeliveryEventSummary` entries, each including `body` (the raw monitor instructions — see §9.1 for the `DeliveryEventSummary` shape). Claiming any delivery **MUST** mark the underlying session-event rows as claimed (`firstNotifiedAt` set). Claiming **MUST NOT** acknowledge them (`acknowledgedAt` remains null) (BP2).

Verified: `libs/core/src/runtime/service.ts` — `claimDelivery()` post-compact branch; `MAX_RECAP_EVENTS = 10`; `store.markClaimed()` does not set `acknowledgedAt` (see `libs/core/src/runtime/store.ts`: only sets `firstNotifiedAt`, `lastClaimAt`, `lastClaimLifecycle`). Each mapped event includes `body: event.body`.

## 10. Daemon and IPC

The CLI exposes two operational modes for the runtime:

### 10.1 `daemon once` — single tick

`agentmonitors daemon once [monitorsDir]` creates a local `AgentMonitorRuntime` in-process and calls `runtime.tick()` once without starting a socket server. It does not go through the daemon IPC socket.

In `text` format the command prints `Evaluated N monitor(s), emitted M event(s).`. When the tick has one or more errored observations (§2.5), the trailing period is replaced by `, K errored:` followed by one indented `  <monitorId>: <message>` line per errored monitor — so a broken source is visible without any verbose flag. When `K` is zero the output is unchanged (the genuine no-change case stays clean — the command must not "cry wolf"). In `json` format the full `RuntimeTickResult`, including `erroredObservations`, is printed verbatim.

Verified: `apps/cli/src/runtime-client.ts` — `daemonTickClient()`: constructs a `createRuntime()` directly and calls `runtime.tick()`; `apps/cli/src/commands/daemon.ts` — `once` subcommand and the `appendErroredLines()` helper; `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once error visibility (issue #117)')`.

### 10.2 `daemon run` — continuous loop + Unix socket server

`agentmonitors daemon run [monitorsDir]` runs the full daemon mode:

1. Creates a local `AgentMonitorRuntime`
2. Starts a Unix domain socket server via `createDaemonServer()` — the socket, its directory, and the startup-lock directory are owner-only ([§3.1](#31-local-data-permission-model--the-local-trust-boundary-current))
3. Enters a `while (!stopping)` tick loop, calling `runtime.tick()` on each iteration
4. Sleeps for `--poll-ms` milliseconds (default `30000`) between ticks using a cancellable timer
5. Handles `SIGINT` and `SIGTERM` to stop cleanly
6. Refuses to start if the socket is already in use (another daemon is running)

**Tick logging:** after each tick the loop logs a line when the tick emitted events **or** had one or more errored observations (§2.5); a clean no-change tick logs nothing. The line is `Emitted M event(s) from N monitor(s).`, and when errored it becomes `Emitted M event(s) from N monitor(s), K errored:` followed by one indented `  <monitorId>: <message>` line per errored monitor — the same surfacing as `daemon once` so a broken source is never hidden behind a silent loop.

**Idle reaping:** the daemon monitors active sessions for the workspace. After each tick it counts sessions with `status === 'active'` and `workspacePath === workspacePath`. If this count stays zero continuously for `--reap-after-ms` milliseconds (default `300000`; `0` disables), the daemon stops itself cleanly. This is the primary self-termination mechanism for daemons booted by `session start`.

**A live channel-transport heartbeat counts as activity (issue #435 Option A).** A channel server (`agentmonitors channel serve`, [006 §12](./006-agent-integration.md)) is the push surface for an **idle** agent — it delivers monitor events into a session that is no longer prompting, and so fires no hooks. Without this exemption those two contracts compose to "push works only while the session is active enough not to need it": the idle session goes dormant, the active-session count reaches zero, the daemon reaps ~`reap-after-ms` later, monitors stop ticking, and the channel is permanently silent exactly when it is needed (issue #435). So the reaper additionally treats a workspace as active — resetting the idle clock, exactly as an open session does — whenever a **non-stale** `channel` heartbeat exists for it. Precisely:

- The exemption is keyed on the heartbeat's owner-declared **TTL lease** ([006 §12.2](./006-agent-integration.md), `isHeartbeatStale`), evaluated fresh against `now` on every reap check — **not** a static "a channel is registered" flag. When the channel process dies without cleanup, its lease expires within the TTL and it stops counting, so normal reaping resumes. This is the guard that prevents an orphaned channel server ([issue #426](https://github.com/mike-north/AgentMonitors/issues/426)) from pinning the daemon alive forever; the exemption is an **active expiring lease**, never a permanent pin.
- Only the **`channel`** transport qualifies. The `hook` transport is short-lived and self-healing (a fresh process per prompt) and carries a 24h "wired-up" TTL; letting it suppress reaping would keep the daemon alive for a day after a session ended. A `hook` heartbeat therefore never exempts.
- The heartbeat must match **both** the reaper's `workspacePath` **and its own daemon's `socketPath`**. Two daemon instances can independently resolve the same `workspacePath` (e.g. an orphaned daemon left over from a prior boot, bound to a stale socket) — without the socket comparison, a live channel keeping a _different_ daemon alive would wrongly suppress reaping on _this_ one, which the channel is not actually pinning.
- A channel-only exemption **never sets** the reaper's `hasSeenSession` flag — only an actually-open session does. `hasSeenSession` specifically gates the boot-grace window (`max(reapAfterMs, bootGraceMs)`); a channel can attach before any session has registered, and if it detaches cleanly before one ever does, the boot-grace window must still apply on the next reap check rather than falling through to the shorter post-session `reapAfterMs`.
- The reaper does the registry I/O (reading and staleness-checking heartbeats) and is skipped entirely when reaping is disabled (`--reap-after-ms 0`) — `shouldReap` short-circuits on that case regardless of `channelAttached`, so there is no reason to scan the machine-wide transport registry on every tick of a daemon that will never reap. The pure `shouldReap` decision ([`apps/cli/src/reap-decision.ts`](../../apps/cli/src/reap-decision.ts)) takes a single `channelAttached` boolean, so the policy stays deterministically testable. Verified end to end by `apps/cli/src/commands/daemon-reaper-lease.integration.test.ts` (a live channel keeps a dormant-session daemon alive and still ticking; a stale lease lets reaping resume; a live hook heartbeat does not exempt; a heartbeat naming a different daemon's socket does not exempt).

**Per-workspace isolation:** socket and db paths are derived from the workspace path via `workspacePaths()` in `apps/cli/src/workspace-paths.ts`, which hashes `resolve(workspacePath)` (SHA-256, first 16 hex chars) under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`. Two sessions in the same repo share one daemon; two distinct repos get isolated daemons. This applies **regardless of how the daemon was started**: both `session start`'s lazy boot and a _directly_-invoked `agentmonitors daemon run`/`daemon once` — with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — resolve to the same per-workspace paths for an enabled workspace (`resolveWorkspaceDbPath()` in `apps/cli/src/workspace-db-path.ts`, and the equivalent socket fallback in `resolveManualDaemonSocketPath()`). Prior to issue #335, only the lazy-boot path applied this convention; a directly-invoked `daemon run` (the Getting Started guide's own documented usage) silently bound to the bare global default instead, so `doctor` — which always assumed the per-workspace convention — read an empty, unrelated database and disagreed with `session list`/`daemon status` about whether a lead session existed, despite all three describing the exact same live daemon.

**Lazy boot:** `session start` spawns `daemon run` as a detached background process when no daemon is already listening at the per-workspace socket path, waits up to 8 seconds for the socket to appear, then opens the session. The spawner unref's the child, so the parent (the hook process) can exit while the daemon continues running. The coordination file `.claude/agentmonitors.local.md` holds `enabled`, `socket`, `db`, and `reap-after-ms` fields so sibling hooks can locate the per-workspace daemon without re-deriving paths.

**Quick-exit when not enabled:** if `.claude/agentmonitors.local.md` is absent or has `enabled` unset/`false`, `session start` returns without opening a session or spawning a daemon — except it is not silent when the project already has monitor definitions sitting unwatched: see the "Monitors-found-but-disabled advisory" bullet in [006 §5.6](./006-agent-integration.md) for the one-line `additionalContext` advisory that case emits (issue #269). A project with no monitor definitions at all stays fully silent, unchanged.

Verified: `apps/cli/src/commands/daemon.ts` — `runLoop()`; `run`/`once` subcommands (both now resolve db/socket via the shared per-workspace helpers, issue #335); `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()`; `apps/cli/src/workspace-paths.ts` — `workspacePaths()`; `apps/cli/src/workspace-db-path.ts` — `resolveWorkspaceDbPath()`; `apps/cli/src/manual-daemon.ts` — `resolveManualDaemonSocketPath()`; `apps/cli/src/local-state.ts` — `readLocalState()`/`writeLocalState()`.

### 10.3 Socket path resolution

The socket path is resolved by `resolveSocketPath()`. Priority order:

1. Caller-supplied `overridePath`
2. `AGENTMONITORS_SOCKET` environment variable
3. `<dbDir>/agentmonitors.sock` (where `<dbDir>` is the directory containing the SQLite file, or `~/.local/share/agentmonitors` for `:memory:` databases)

If the resolved path exceeds 100 characters (the Unix socket path length limit in use), the path is hashed (SHA-256, first 16 hex chars) and placed at `/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock` — inside an **owner-only (`0700`) per-uid directory**, not directly under the shared, world-writable `/tmp` (issue #292; the pre-#292 fallback wrote a predictable `/tmp/agentmonitors-<hash>.sock` any local user could connect to). The per-uid directory is created with an atomic owner-only `mkdir` and, if it already exists, is refused unless it is a real (non-symlink) directory owned by the current user, so the daemon fails closed rather than binding inside a directory another user could have planted. The base is `/tmp` (not the platform temp root) deliberately: on macOS the per-user temp root (`/var/folders/…/T`) would push the substituted socket back over the 100-char limit — privacy comes from the owner-only per-uid subdirectory, not the shared base ([§3.1](#31-local-data-permission-model--the-local-trust-boundary-current)).

**Legacy-fallback transition (no split-brain).** Because that fallback location _moved_ (from the pre-#292 `/tmp/agentmonitors-<hash>.sock` to the per-uid path), an upgrade could otherwise strand a running pre-upgrade daemon: it keeps listening at the old path while upgraded clients resolve to the new path and lazy-boot a **second** daemon on the same database — two daemons ticking one DB, which the startup lock cannot prevent because it is keyed per socket path. To avoid this, `resolveSocketPath`'s fallback branch first probes the legacy path: **if a live daemon still answers there, it returns the legacy path so clients keep talking to the existing daemon**; otherwise it returns the new per-uid path. A daemon only ever _binds_ the new path — a live legacy daemon makes `daemon run`'s "already running" check succeed, so no second bind happens — so **one restart of the legacy daemon completes the migration** (its clean shutdown removes the legacy socket; the next resolve returns the new path). The probe is a short-lived connect (the same liveness test the bind path uses), guarded by an existence check so the steady state — no legacy socket file — costs nothing.

**Explicit `--socket` substitution is announced (issue #337).** When `overridePath` came from a
literal `--socket` flag the caller typed (not `AGENTMONITORS_SOCKET`, not a
`.claude/agentmonitors.local.md`-derived value, and not the computed default) and that path exceeds
the limit, the CLI prints one line to stderr naming the requested path, the limit it exceeded, and
the substituted path before falling back to the hash — e.g. `daemon run --socket <144-char path>`
still binds and reports the hashed path on stdout (§10.2's startup line is unchanged), but stderr now
says so instead of substituting silently. Env-derived, local-state-derived, and default-derived
candidates continue to hash silently, as before — they were never a value the caller typed on this
invocation, so there is nothing to warn about a mismatch against.

**Stale-daemon risk on the hash fallback (documented, not yet enforced).** Consistent hashing means
repeated invocations with the _same_ over-limit candidate keep resolving to the same substituted
socket, so same-argument commands still find "their" daemon. But the substituted path depends only on
the candidate string, not on which workspace is asking: if a _different_ over-limit candidate happens
to resolve to the same derived path — either a genuine hash collision (SHA-256 truncated to 16 hex
chars; astronomically unlikely) or, far more plausibly, the _same_ shared/templated `--socket`
value reused across otherwise-unrelated workspaces (same input, same hash — not a collision). If a
stale daemon from an earlier, unrelated invocation of the same over-limit candidate is still listening on
`/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock`, a caller can silently talk to the wrong daemon. The daemon IPC does
not currently expose a single "this daemon's workspace" identity to check against — `session.list` is
scoped per-session (`AgentSessionRecord.workspacePath`), and a daemon using the global default DB is
explicitly allowed to serve sessions for multiple workspaces at once (§10.2), so "the reachable
daemon's workspace differs from mine" cannot be decided from one scalar without breaking that
multi-workspace case. Until a per-daemon workspace handshake exists, callers relying on an explicit
over-limit `--socket` should treat the substituted path as workspace-identified only by the exact
candidate string, not by the workspace it was invoked from.

Verified: `apps/cli/src/daemon-ipc.ts` — `resolveSocketPath()`, `ResolveSocketPathOptions`.

### 10.4 IPC wire protocol

Each request/response is a single newline-delimited JSON object. A connection
admits **one request** and then closes after `{ id, result? }` or `{ id, error, code? }`.
Additional frames cannot dispatch while the first request is in flight.

Before JSON parsing, the first frame MUST be at most **1,048,576 bytes**, excluding
its newline. The server counts raw bytes across chunks, including split UTF-8
characters, and rejects an oversized frame even when no newline arrives. Retained
frame storage is bounded independently of fragment count; trailing frames are not
retained. Exact byte limits are accepted.

Before envelope or method schema validation, every decoded array and record
(including unknown fields) MUST have at most **1,000** elements or own keys.
The complete request MUST contain at most **10,000 values**, counting the root,
containers, and scalar values once each, and have depth at most **32**, with the
root at depth zero. Iterative admission checks prevent schema traversal or runtime
mutation on rejection. These budgets support bulk control operations while
bounding validation work; they do not apply to response payloads or the MCP transport.

The decoded traversal MUST avoid copying container values into intermediate
collections after counting their widths. Admission responses correlate only an
own string `id` from the decoded envelope; inherited IDs are ignored. Raw-frame
limit diagnostics describe bytes because rejection precedes UTF-8 decoding.

Admission failures return one bounded error with `code: INPUT_LIMIT_EXCEEDED`.
Collection failures preserve a string request ID when available; byte failures use
`id: invalid` because no JSON is parsed. The daemon remains available and existing
sessions are unchanged. Ordinary malformed JSON and unsupported envelopes retain
the legacy error and unsupported-request code. Connection resets are local to the
peer and cannot terminate the daemon.

Verified: `apps/cli/src/input-limits.test.ts`,
`apps/cli/src/input-limits.integration.test.ts` (spawned daemon, two sessions,
raw sockets, exact boundaries), and `apps/cli/src/daemon-ipc.test.ts`.

### 10.5 Exposed socket commands

The daemon socket exposes the following commands (the `DaemonMethod` enum):

| Method                           | Description                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ping`                           | Health check; returns `{ ok: true }`                                                                               |
| `status`                         | Returns `RuntimeStatus` (session counts, event count)                                                              |
| `stop`                           | Requests graceful daemon shutdown                                                                                  |
| `session.open`                   | Opens or resumes a session; returns `AgentSessionRecord`                                                           |
| `session.close`                  | Marks a session dormant; returns `AgentSessionRecord`                                                              |
| `session.list`                   | Returns all `AgentSessionRecord[]`                                                                                 |
| `events.list`                    | Lists events, with optional filters; returns `MonitorEventRecord[]`                                                |
| `events.ack`                     | Acknowledges events for a session                                                                                  |
| `hook.claim`                     | Claims a delivery payload for a session at a lifecycle point; returns `DeliveryClaim \| null`                      |
| `history.list`                   | Lists recent observation-history rows, optionally filtered by monitor id                                           |
| `monitor.explain`                | Returns a read-only staged diagnosis for one monitor's current pipeline state                                      |
| `daemon.tick`                    | Runs one tick on the specified monitors directory                                                                  |
| `verifyArtifacts.register`       | Registers exact ownership of a verify scratch artifact before it is created (§2.6); returns `VerifyArtifactRecord` |
| `verifyArtifacts.requestCleanup` | The owner's cleanup request after its proof (§2.6); returns `VerifyArtifactCleanupResult`                          |

Verified: `apps/cli/src/daemon-ipc.ts` — `daemonMethodSchema` (lines 26–37); `handleRequest()` (lines 150–222).

### 10.6 CLI commands that round-trip through the socket

The `session`, `events`, and `hook` CLI subcommands call the daemon socket via the `runtime-client.ts` helpers rather than constructing a local runtime:

- `agentmonitors session open/close/list` → `session.open` / `session.close` / `session.list`
- `agentmonitors events list` / `events.ack` → `events.list` / `events.ack`
- `agentmonitors hook claim` → `hook.claim`
- `agentmonitors monitor history` → `history.list`
- `agentmonitors monitor explain` → `monitor.explain`

Verified: `apps/cli/src/runtime-client.ts` — `openSessionClient`, `closeSessionClient`, `listSessionsClient`, `listEventsClient`, `acknowledgeEventsClient`, `claimDeliveryClient` (lines 14–82); `apps/cli/src/commands/session.ts`, `hook.ts`.

### 10.7 Monitor pipeline diagnosis

`monitor.explain` is a read-only daemon IPC method used by
`agentmonitors monitor explain <monitorId>` ([005 §6](./005-cli-reference.md)). It walks one
monitor through the persisted pipeline state and returns stages for:

1. Definition: scanned `MONITOR.md`, source resolution, and source scope validation
2. Scheduling: persisted `monitor_state.last_observation_at`, due state, and next due time
3. Observation: recent `observation_history` rows and latest outcome
4. Notify state: active debounce or throttle state in `monitor_state.notify_state`
5. Materialization: an outstanding dropped observation (§2), then retained retries, then recent
   `monitor_events`
6. Projection and delivery: `session_event_state` joined to `agent_sessions`, reported as
   `unread`, `claimed`, or `acknowledged`. When a session's unread normal/low events are already
   claimed with no fresh work remaining, or a same-band lease exists, this stage additionally
   reports a `reminderSuppression` finding: `no-new-work` means no new pending work;
   `reserved-in-flight` means a temporary reservation is holding the next batch. A live lease is
   never remediated by acknowledgment. Older claims cannot suppress fresh pending observations.

Each stage carries a `status` of `ok`, `pending`, `healthy`, or `failure`:

- `ok` — the stage produced the signal the next stage needs.
- `pending` — the stage is intentionally holding (debounce/throttle) or has not run because an
  upstream stage has not produced its input.
- `healthy` — the stage ran successfully and the correct outcome was "no work to do": the watched
  target genuinely did not change. A `no-change` or `rebaselined` observation outcome is `healthy`,
  **not** a `failure` — an idle monitor is not a bug. When the latest observation is `healthy`, the
  downstream materialization and delivery stages report `healthy` rather than `failure` for the
  expected absence of events/projections. The verdict for a genuinely idle monitor is therefore an
  affirmative `healthy` at the observation stage (e.g. "Source ran, observed 0 changes — your watched
  target genuinely hasn't changed (not a bug).").
- `failure` — a real fault: invalid definition, errored observe, a zero-file match diagnostic, an outstanding dropped observation, terminal retained work, or a missing expected projection.
  (An unreachable daemon is **not** itself a stage failure: the CLI falls back to an in-process read
  of the persisted store — see the no-daemon fallback below.)

For an `errored` observation with a nonempty string `observationData.error`, the observation
stage is `failure` with reason `Source observation failed: <displayed error>` and the existing
observation data in `details`. Reasons strip VT escape sequences and C0/DEL/C1 controls, collapse
whitespace to a single line, and cap the error at 512 Unicode code points including a trailing
`...` when truncated. Missing/empty/non-string errors retain the generic errored-stage reason.
This is a read-only display transformation: `details`, history JSON and stored audit bytes remain
unchanged. The existing verdict severity ordering still applies; another failure may win the
verdict without removing this observation-stage diagnostic. Verified: `source-error-state.test.ts`
and the CLI socket/fallback tests in `incoming-changes-diagnostics.test.ts` (Refs #305).

While the monitor has an outstanding dropped observation (§2, "Admission outcomes when the outbox
cannot retain a suffix"), the materialization stage is `failure` with reason
`<count> observation(s) were dropped because the retry outbox could not retain them; the newest,
<which>, failed: <displayed error>`. `<which>` is `observation <position> of <spanSize>`, followed
by `(<objectKey>, "<title>")` with whichever of the two were recorded; the error uses the display
rule above. `details.unretainedObservationLoss` carries the same fields as doctor's
`unretainedObservationLoss`, with `recordedAt` as an ISO string. This branch precedes the
retained-retry branches: retained work can still be recovered and a drop cannot. The stage stays
`failure` until every drop is superseded (§2): a quiet tick, a notify hold, an observe failure or
events for other keys leave it failing. The observation stage still describes the newest history
row. Verified: `unretainable-suffix-admission.test.ts` and, through a real `daemon run` socket
after a quiet scheduled tick, `apps/cli/src/retry-diagnostics.test.ts` (Refs #497).

The method MUST NOT mutate runtime state. **It MUST scope to the requested workspace.** The inbox DB
is global (not per-workspace), so the same `monitorId` can exist in multiple workspaces; the
materialization stage filters `monitor_events` to `workspacePath` (plus workspace-agnostic events)
and the delivery stage filters projections to that workspace's sessions (plus global sessions), so
one workspace's report never counts another workspace's events or projections. If events exist but
there is no lead session matching the workspace (including global sessions), the delivery stage
reports that no lead session is registered. If the daemon socket is unavailable, the CLI does **not**
fabricate a scheduling failure: because `explainMonitor` is a pure read over the persisted store, the
CLI runs the **same** method in-process against the local SQLite DB (`explainMonitorInProcess`) and
returns the real per-stage diagnosis built from the last persisted tick (#150). A monitor that fired
before the daemon stopped is therefore diagnosed truthfully — never reported as a false scheduling
failure. Only when the daemon is unreachable **and** the store holds no persisted state for the
monitor (no `observation_history` and no `monitor_events` rows) does the CLI emit an actionable
remediation message instead of a report ([005 §6](./005-cli-reference.md)). The in-process fallback
fires **only** for a genuine connection failure (socket refused/absent or request timeout); a
daemon-side application error is surfaced verbatim rather than masked as "daemon not running".

## 11. Agent Integration (Adapters)

### 11.1 The `AgentRuntimeAdapter` contract

Every agent integration is defined as an `AgentRuntimeAdapter` object with four members:

- `name: string` — unique identifier for the adapter
- `hookEventMap: Record<AgentLifecycleEvent, string>` — maps each `AgentLifecycleEvent` to the string hook name used by the target agent runtime
- `defaultHookStatePath(input): string` — computes the default path for the hook-state file
- `createSessionInput(input): OpenSessionInput` — builds the `OpenSessionInput` to pass to `runtime.openSession()`
- `materializeHookState(state): Record<string, unknown>` — serializes `SessionHookState` to a JSON-serializable object for writing to disk

Verified: `libs/core/src/adapter/types.ts` — `AgentRuntimeAdapter` interface (lines 7–22).

### 11.2 The `claudeCodeAdapter`

The only built-in adapter is `claudeCodeAdapter` (name: `'claude-code'`). It is registered by default in `AgentMonitorRuntime` and is the adapter used by all CLI commands.

The `hookEventMap` maps delivery and session lifecycle events to Claude Code hook names:

| `AgentLifecycleEvent` | Claude Code hook name |
| --------------------- | --------------------- |
| `session-opened`      | `SessionStart`        |
| `session-dormant`     | `SessionEnd`          |
| `turn-interruptible`  | `PreToolUse`          |
| `turn-ended`          | `Stop`                |
| `turn-idle`           | `TeammateIdle`        |
| `pre-compact`         | `PreCompact`          |
| `post-compact`        | `PostCompact`         |

Verified: `libs/core/src/adapter/claude.ts` — `claudeCodeAdapter.hookEventMap` (lines 31–39).

The delivery lifecycles (`turn-interruptible` → `PreToolUse`, `turn-idle` → `TeammateIdle`, `post-compact` → `PostCompact`) are the events at which Claude Code will invoke the corresponding hooks, causing the CLI to call `hook.claim`.

### 11.3 Hook-state path derivation

The default hook-state path is derived by `defaultHookStatePath()`:

```text
<workspace-or-cwd>/.agentmonitors/sessions/<encoded-host-session-id>/hook-state.json
```

`<workspace-or-cwd>` is `input.workspacePath` if provided, otherwise `process.cwd()`.

`<encoded-host-session-id>` is the `hostSessionId` with each character that is not in `[A-Za-z0-9_-]` replaced by `~<hex-codepoint>` (zero-padded to 2 digits). The strings `.` and `..` are additionally escaped to prevent path traversal. An empty encoded result becomes `_empty`.

Verified: `libs/core/src/adapter/claude.ts` — `safeSessionPathSegment()` (lines 4–27); `defaultHookStatePath()` (lines 40–49).

> **Status: current** (Refs #336). `.agentmonitors/` is host-agnostic runtime state, not
> source-controlled project content: `defaultHookStatePath()` derives its location, and `refreshHookState()` creates it (via `writeJsonAtomic()`'s parent-`mkdir`) the moment a session
> opens (`openSession()` calls `refreshHookState()` immediately), before any project-level
> opt-in. Every file under it — currently just `hook-state.json` per session — is a materialized,
> regenerable projection of the runtime's SQLite store (`RuntimeStore`, never the source of
> truth), so the directory is always safe to delete; it is recreated on the next session open or
> tick. It is project-local (rooted at the workspace, not the user's data dir), so it is a
> `.gitignore` concern like `.claude/*.local.*`: `agentmonitors init` (bare or `--enable-only`)
> ensures `.gitignore` ignores both (`apps/cli/src/commands/init.ts` — `ensureGitignore()`).
> Prettier reads `.gitignore` by default, so that line also keeps these files out of a project's
> format check. Prettier reads only the `.gitignore` in the directory it runs from, so a format
> check run from above a nested workspace needs its own rule.

### 11.4 Hook-state materialization

`materializeHookState()` passes through all `SessionHookState` fields unchanged. The on-disk JSON object therefore contains: `sessionId`, `updatedAt`, `unread` (with `low`, `normal`, `high`, `total`), `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, `latestHighTitles`.

Verified: `libs/core/src/adapter/claude.ts` — `materializeHookState()` (lines 71–81).

## 12. Relationship to the Legacy Inbox Model

The repository still implements an inbox item state machine:

```text
queued → acked → in-progress → completed|failed → archived
```

That model remains useful and publicly exposed through `agentmonitors inbox ...` commands, but it is **not** the authoritative runtime delivery path (AP2). The important split is: runtime/session delivery uses `monitor_events` and `session_event_state`; inbox lifecycle commands operate on `inbox_items`. The system therefore has two durable work models in the repo today. This spec is explicit that the runtime/session pipeline is primary for monitor-triggered delivery.

Verified: `libs/core/src/inbox/inbox-service.ts` — `VALID_TRANSITIONS` (lines 37–44); `libs/core/src/inbox/schema.ts` — `inboxItems` table (lines 16–31).

Note: the `inbox_items` table does not share rows with `monitor_events`. They are independent storage paths. The `inbox_items` table has its own `state` column driving the lifecycle machine, whereas `monitor_events` rows are immutable once written; delivery state lives in `session_event_state`.

## 13. Example Flows

### 13.1 Debounced high-urgency burst

1. a high-urgency monitor emits two observations on a tick
2. notify dispatch stores them in pending debounce state (`notifyState.pendingDebounce`); no `monitor_events` rows are created yet
3. a later tick arrives at or after `dueAt` (15s later); the flush path emits the accumulated batch
4. two events are persisted and projected into matching lead sessions via `session_event_state`
5. after the settle window has elapsed, `turn-interruptible` claims them as a concrete high-urgency delivery with a populated `events` array

**What this example proves:** high urgency is not necessarily immediate; debounce acts before event persistence; delivery timing and unread state are separate concerns; the 15-second settle window appears at two places — the default `notify` config for high urgency, and the `claimDelivery` age filter.

### 13.2 Low-urgency background reminder

1. a low-urgency event is persisted and projected into a session
2. `turn-interruptible` returns `null` (low urgency is not delivered here)
3. `turn-idle` evaluates `shouldSendLow`: `pendingEventsForSession(sessionId, 'low').length > 0` and no low-urgency reservation is active → returns a `DeliveryClaim` with `message: reminderMessage()` (§9.2's wording contract); the delivering transport then appends its own session-scoped action step
4. the event remains unread until explicitly acknowledged

**What this example proves:** `low` urgency is real runtime behavior, not schema-only metadata; idle-time delivery differs intentionally from interruptible delivery.

### 13.3 Coalesced normal reminder, then its suppression (issue #333)

1. a `urgency: normal` monitor emits a change; the event is persisted and projected into a lead session (unread, unclaimed)
2. `turn-interruptible` evaluates the §9.2 guard — fresh pending normal work exists and no same-band reservation is active → returns a `DeliveryClaim` with `message: reminderMessage()` and an empty `events` array; the delivering transport appends its own action step naming the ack command, so the recipient can explicitly complete handled work, **and claims the event** (`markClaimed` sets `firstNotifiedAt`; not acknowledged)
3. a **second** `turn-interruptible` claim finds the event unread-but-claimed → the guard no longer holds → returns `null` (no new pending work exists; a fresh unclaimed normal event restores the reminder independently of the older claim, §9.2)
4. `monitor explain <id>` reports the `delivery` stage as `ok` with a `reminderSuppression` finding naming the reason (`no-new-work`), so the `null` is explainable rather than silent

**What this example proves:** the normal reminder fires on the first claim (it is _not_ silently swallowed); batch-level coalescing means a repeat claim without fresh work is intentionally quiet; claiming is not acknowledgment (the event stays unread and durable); and the "why nothing surfaced" answer is inspectable via `monitor explain`, never presented as bare silence. This is the resolution of the blind-study S3 F2 report: a first-run subject who claimed once, then claimed again, saw `null` the second time and mistook intended coalescing for a broken delivery path.

## 14. Validation Implications

Runtime and persistence tests should be able to prove:

- stateful source state survives runtime restarts (persisted via `monitor_state.source_state`)
- schedule matching respects configured timezone via `Intl.DateTimeFormat`
- high-urgency delivery waits for the 15-second settle window before `claimDelivery` returns a payload
- fresh normal/low batches surface despite older unacknowledged claims, while repeated claims without new work stay quiet
- low-urgency delivery happens only at `turn-idle` lifecycle points
- events project only into matching lead sessions (role filter in `insertEvent`)
- scope filters query `queryScope` rather than source payload internals (post-query filter in `listEvents`)
- snapshot diffs are keyed by `(workspacePath, monitorId, objectKey)`
- claimed events remain unread until acknowledged (`markClaimed` does not set `acknowledgedAt`)
- `daemon once` does not start a socket server; `daemon run` refuses to start if the socket is already in use

## 15. Persistence Schema (Appendix)

This section is normative. Column names use the SQLite snake_case form as defined in `libs/core/src/inbox/schema.ts`. All IDs are ULIDs. All timestamps are SQLite `INTEGER` columns stored as Unix epoch seconds (via Drizzle's `{ mode: 'timestamp' }`).

Verified: `libs/core/src/inbox/schema.ts` (entire file); `libs/core/src/inbox/db.ts` (DDL, lines 50–156).

### `monitor_events`

Corresponds to the `monitorEvents` Drizzle table. One row per materialized observation. Rows are immutable after insertion.

| Column                   | Type                     | Notes                                           |
| ------------------------ | ------------------------ | ----------------------------------------------- |
| `sequence`               | INTEGER PK AUTOINCREMENT | Private equal-time materialization tie-break    |
| `id`                     | TEXT NOT NULL UNIQUE     | Public ULID identity                            |
| `workspace_path`         | TEXT nullable            | Path to the workspace; `NULL` for global events |
| `monitor_id`             | TEXT NOT NULL            | Stable monitor identifier                       |
| `source_name`            | TEXT NOT NULL            | Source plugin name                              |
| `urgency`                | TEXT NOT NULL            | `low \| normal \| high`                         |
| `title`                  | TEXT NOT NULL            |                                                 |
| `body`                   | TEXT NOT NULL            | Defaults to `''`                                |
| `summary`                | TEXT NOT NULL            | Defaults to `''`                                |
| `payload`                | TEXT NOT NULL            | JSON; defaults to `{}`                          |
| `snapshot_metadata`      | TEXT NOT NULL            | JSON; defaults to `{}`                          |
| `snapshot_text`          | TEXT nullable            | Full snapshot content if provided               |
| `diff_text`              | TEXT nullable            | Line-level diff vs. previous snapshot           |
| `object_key`             | TEXT nullable            | Snapshot and diff keying                        |
| `query_scope`            | TEXT NOT NULL            | JSON; defaults to `{}`                          |
| `tags`                   | TEXT NOT NULL            | JSON array; defaults to `[]`                    |
| `created_at`             | INTEGER NOT NULL         | Observation timestamp                           |
| `admission_sequence`     | INTEGER nullable         | Retry admission position; see below (§2)        |
| `definition_fingerprint` | TEXT nullable            | Observing definition's fingerprint (§5.3)       |

`admission_sequence` is set only on an event completed from the retry outbox: the position its
retry reserved in the materialization order when it was queued (`0` for a retry queued before
positions were reserved). `NULL` means the event was admitted where it committed, at `sequence`.
Supersession of a dropped observation compares admission positions (§2).

`definition_fingerprint` is the fingerprint of the definition the observation was made under,
computed from the envelope's monitor snapshot at materialization (§5.3). An event completed from the
retry outbox carries its stored envelope's fingerprint, supplied by the completing caller with the
rest of that envelope's materialization, never the current definition's. `NULL` on rows from before
the column existed.

Both columns are additive. The materialization-order rebuild of a pre-`sequence` table carries each
of them when the old table already has it and copies `NULL` otherwise; the migration then adds any
still missing and creates the object-key index on the rebuilt table.

A database written before the `sequence` column existed (every released version through
0.13.0) is rebuilt on first open. Columns the current schema does not define, such as
0.0.1–0.3.0's `event_kind` or a column an operator added, are carried across nullable
unless they have a default; see §5.2 for the full column, index and failure policy.

### `monitor_snapshots`

Stores the full text content of each snapshot for diff computation. Keyed by `(workspace_path, monitor_id, object_key)`.

| Column           | Type                     | Notes                                       |
| ---------------- | ------------------------ | ------------------------------------------- |
| `sequence`       | INTEGER PK AUTOINCREMENT | Private durable materialization order       |
| `id`             | TEXT NOT NULL UNIQUE     | Public ULID identity; not an ordering key   |
| `workspace_path` | TEXT nullable            |                                             |
| `monitor_id`     | TEXT NOT NULL            |                                             |
| `object_key`     | TEXT NOT NULL            |                                             |
| `event_id`       | TEXT NOT NULL            | Logical reference to `monitor_events.id`    |
| `content`        | TEXT NOT NULL            | Full snapshot text                          |
| `created_at`     | INTEGER NOT NULL         | Epoch seconds for diagnostics, not ordering |

`RuntimeStore.saveSnapshot()` allocates the sequence through SQLite;
`latestSnapshot()` selects the greatest retained sequence for the scoped object. See
§5.2 for rollback, deletion, reopen and legacy migration semantics. The public result
remains `{ content }`. Verified: `runtime/store.ts`, `inbox/schema.ts`, `inbox/db.ts`, and
`runtime/snapshot-materialization-order.test.ts`.

### `materialization_retry_outbox`

Durable observations that could not complete deterministic materialization. Each row retains the
stored observation envelope and trusted local route so a later attempt can re-enter materialization
without invoking the source or moving a source cursor again.

| Column               | Type             | Notes                                             |
| -------------------- | ---------------- | ------------------------------------------------- |
| `id`                 | TEXT PK          | Monotonic ULID                                    |
| `workspace_path`     | TEXT nullable    | Part of the per-monitor capacity scope            |
| `monitor_id`         | TEXT NOT NULL    | Must match the stored envelope                    |
| `source_name`        | TEXT NOT NULL    | Must match the envelope's monitor source          |
| `envelope`           | TEXT NOT NULL    | JSON `StoredObservationEnvelope`                  |
| `envelope_bytes`     | INTEGER NOT NULL | Exact persisted UTF-8 byte count                  |
| `attempt_count`      | INTEGER NOT NULL | Automatic retry failures; starts at `0`           |
| `status`             | TEXT NOT NULL    | `pending \| terminal`                             |
| `next_attempt_at`    | INTEGER nullable | `NULL` after terminalization                      |
| `last_error`         | TEXT nullable    | Control-stripped, bounded safe diagnostic message |
| `created_at`         | INTEGER NOT NULL | Preserves oldest-first drain order                |
| `updated_at`         | INTEGER NOT NULL | Last attempt or operator re-arm                   |
| `admission_sequence` | INTEGER nullable | Reserved admission position; see below (§2)       |

`admission_sequence` is the position the row reserved in the `monitor_events` materialization
order (that table's AUTOINCREMENT counter) when it was queued; its completed event keeps it (§2).
It is `NULL` on rows queued before positions were reserved.

Capacity is 256 rows or 8 MiB of stored envelopes per `(workspace_path, monitor_id)`, including
terminal rows. Envelope size is the exact serialized UTF-8 byte count. Callers must supply ordinary
plain-data records and dense arrays of JSON primitives (excluding negative zero), apart from the
single typed `observedAt` Date. Class/built-in instances remain outside this supported domain even
if their prototypes have been replaced. Enqueue rejects detectable domain violations (including
BigInt, negative zero, nested Dates, proxies, accessors, cycles, and intrinsic object brands exposed
by Node) with a domain error before database mutation.
When an already-held debounce or rollup envelope fails materialization after a source-type
edit, retry admission **MUST** derive its source route from that captured envelope, just as
materialization does. The current definition must not replace the captured source, instructions,
effective urgency, observation content or timestamp. This routing rule does not reinterpret or
transform the source-owned opaque baseline. Verified by source-edit fault/success controls in
`poll-admission.test.ts`.

The full envelope is validated before route fields are read. Proxies, including revoked proxies,
are rejected before their traps can run; route accessors are rejected without invoking their getters.
Date detection uses an intrinsic brand check rather than traversing prototype chains, so an
ordinary object or array with a proxy prototype is rejected without executing inherited traps.
Known intrinsic brands are checked independently of prototype identity: Maps, Sets, boxed
primitives, buffers/views and other detectable built-ins cannot disguise their internal data as
plain records merely by replacing their prototypes.

The plain-data rule is a caller precondition, not authentication of arbitrary same-process object
provenance. JavaScript cannot generally distinguish an ordinary empty record from an object whose
prototype was replaced and whose private/native state has no exposed intrinsic brand (for example,
a private-field class, or some platform objects). Such values are unsupported even when early
validation cannot identify them. Sources must normalize their meaningful data into ordinary
records before constructing retry envelopes; successful validation is not proof that an arbitrary
object's hidden state was preserved. This boundary does not change the round-trip guarantee for
supported plain-data inputs.

`observedAt` must be a valid, unmodified Date instance: subclasses or own properties are rejected
without invoking their hooks. The validated instant is serialized explicitly as ISO text and
restored as a Date; a string timestamp is not an accepted substitute. A batch
enqueue uses one immediate transaction: if every failed sibling cannot fit, none is stored. Another
workspace or monitor has independent capacity. Runtime admission does not rely on that rejection:
it checks the domain and remaining capacity (`RuntimeStore.materializationRetryCapacity()`, the
same bound) first. It enqueues only a suffix that fits, and records an unretainable failure as
`errored` (§2, "Admission outcomes when the outbox cannot retain a suffix").

New records first become due after at least 1 second, measured from the instant the retry is
enqueued (_current_): backoff starts after source acquisition and prefix materialization, not at the
tick's start. An observation taken at `12:00:00.000` and admitted at `12:00:03.850` first becomes
due at `12:00:05.000`. Observation, event, envelope, source and notify timestamps remain
observation-time provenance and are never rewritten to repair the deadline. Because retry
timestamps are persisted at whole-second precision, deadlines round upward to the next
representable second, never downward: admission at `12:00:00.850` becomes due at `12:00:02.000`. A retry row's `createdAt`/`updatedAt` record enqueue time. This can add less than one second to a
backoff, but must not shorten it. `last_error` is a single-line diagnostic: C0/C1 controls, DEL and
Unicode line/paragraph separators are replaced with spaces, then the result is capped at 1,024
characters. The same rule applies at admission and every failed-attempt update.

Failed automatic attempts wait at least 5 seconds, 30 seconds, 2 minutes, and 5 minutes; the fifth
failed automatic attempt marks the row `terminal` and clears `next_attempt_at`. Due queries never
return a terminal row. Terminal rows remain durable and consume capacity until an operator
explicitly re-arms them. Re-arm preserves the identity and envelope, resets attempts and last error,
and schedules the initial delay again. Re-arming a pending row is an invalid transition.

Completion accepts a deterministically rendered event from the retained envelope, not a caller
callback. The store **MUST** reject terminal work before any event write, and **MUST** require the
event's workspace, monitor, source and object identity to match the retained work. An omitted
observation object key defaults to the monitor ID, matching the normal runtime materialization path;
explicit keys, including the empty string, retain their own identity. Rendering and
selection of due work remain runtime responsibilities. The store owns the synchronous event,
projection, cursor-seed and snapshot writes plus retry-row deletion in one immediate transaction.
Any write or deletion failure **MUST** preserve the retry row and roll back all materialization
writes; the last-projected-session cache must likewise describe committed state. For example, a
failure deleting the retry after writing its snapshot leaves neither a new event nor a snapshot,
and the original retry is still available. Interpret and external asynchronous effects happen only
after successful completion; the API makes no claim that arbitrary asynchronous work is cancellable.

Missing identities raise `MaterializationRetryNotFoundError` with code
`materialization_retry_not_found`. Invalid lifecycle/completion transitions raise
`MaterializationRetryTransitionError` with code `materialization_retry_invalid_transition`.
Both expose `retryId`; neither includes the stored envelope. Storage failures remain distinguishable
from these domain failures.

_Current:_ storage, retry transitions and atomic completion primitives. Runtime drain-before-observe
adoption remains target work for #295; these primitives alone do not make source checkpoints safe.
Verified by `retry-outbox.test.ts` and `retry-lifecycle.test.ts`: due boundaries, invalid transitions,
callback non-execution, actual snapshot/deletion fault rollback, failure-text sanitization and
failed/terminal/rearmed/completed states across on-disk reopen.

Core diagnostics expose each retained row's id, status, attempt count, sanitized error and attempt
timestamps through `explainMonitor` and `doctorReport`. Queries select metadata only: captured
envelopes, source configuration, instructions and observation payloads are never reconstructed.
Errors are control-stripped and length-bounded at the read projection as well as on writes, so
legacy rows cannot bypass the diagnostic boundary. Reads do not rewrite the stored error. This is
not arbitrary secret redaction.

`explainMonitor` **MUST** include the exact workspace/monitor retry summary even when the definition
is missing, parse-invalid, duplicated, source/scope-invalid or unschedulable. Its existing definition
or scheduling failure remains the primary diagnosis. Omitted workspace defaults to `monitorsDir`,
matching tick; it never means an unscoped or NULL-workspace query.

_Current contract:_ `explainMonitor` **MUST** finish asynchronous definition discovery before
reading retry metadata and the later persisted diagnosis. Work committed on the same runtime/store
connection while discovery waits must appear in the retry summary returned after discovery, even
when a definition-error return follows. For example, a committed event prefix with a retained retry
suffix must report that suffix's count and IDs and, for a valid definition, materialization as
pending rather than successful solely because the prefix exists. Definition and scheduling failures
retain their primary diagnosis. This ordering does not provide a cross-process transactional
snapshot or change the meaning of `generatedAt` or the caller's `now`.

`doctorReport` attaches retry summaries to unambiguous parsed monitor rollups, including those with
invalid scope or schedule. A live ephemeral monitor's retained work is attributed to it in
`ephemeralMonitorWork`. Its `orphanedMonitorWork` groups the remaining obligations by monitor id:
removed/parse-failed definitions, duplicated ids and retired ephemeral monitors. Each retained
outbox appears in exactly one diagnostic location. Orphan groups contain only `monitorId`,
`monitorKind`, and `materializationRetries` (present only while the outbox holds records) and/or
`unretainedObservationLoss` (§2); they **MUST NOT** fabricate a retry summary for an empty outbox,
or current source, urgency or cadence from the captured envelope. Existing parse and duplicate diagnostics remain intact. Groups are ordered by
monitor id; each summary orders records by `(createdAt, id)` and includes exact counts and bytes.
Outbox discovery is not capped by the per-monitor 256-row limit: one full outbox cannot hide another.
Every summary excludes other workspaces and NULL-scope records unless that exact scope is requested
at the store boundary. Diagnostic reads never re-arm, discard, observe or materialize retained work.

Only `pending` and `terminal` are supported lifecycle values. If an exact-route summary encounters
an unsupported persisted status (for example `records`, `bytes`, or `blocked`), it **MUST** fail
explicitly before constructing summary data, with a bounded diagnostic that does not echo the stored
value. It **MUST NOT** skip or relabel the row or return fabricated healthy totals. The row and its
private envelope remain unchanged; this adds no lifecycle value or automatic repair behavior.

Report additions remain optional for older-daemon compatibility. _Current:_ core retry metadata
reports, CLI text/JSON rendering, and socket Date revival for explain, attached doctor summaries,
and orphan groups. The CLI projects only the documented retry metadata fields and normalizes legacy
error controls and length at its wire boundary as well as at text display. Omitted older-daemon
fields remain supported; doctor JSON uses empty summaries/groups while explain preserves omission.
Real owned-socket tests verify dates rather than inferring correctness from core Date objects.

Poll ingestion atomically admits the complete emitted span and source/notify state before Interpret. Runtime retry draining and final crash acceptance remain separate work.

### `session_event_state`

Per-session delivery tracking for each projected event. Drives the unread/claimed/acknowledged state machine (§7).

| Column                 | Type             | Notes                                                                       |
| ---------------------- | ---------------- | --------------------------------------------------------------------------- |
| `id`                   | TEXT PK          | ULID                                                                        |
| `session_id`           | TEXT NOT NULL    | FK to `agent_sessions.id`                                                   |
| `event_id`             | TEXT NOT NULL    | FK to `monitor_events.id`                                                   |
| `first_notified_at`    | INTEGER nullable | Set when event is first claimed; `NULL` = pending                           |
| `acknowledged_at`      | INTEGER nullable | Set by explicit ack; `NULL` = unread                                        |
| `last_claim_at`        | INTEGER nullable | Time of most recent claim                                                   |
| `last_claim_lifecycle` | TEXT nullable    | Lifecycle at most recent claim                                              |
| `diff_text`            | TEXT nullable    | Per-recipient delta (G10); `NULL` ⇒ fall back to `monitor_events.diff_text` |
| `interpret_decision`   | TEXT nullable    | Per-recipient Interpret verdict (G14); `NULL` for non-`prose`               |
| `interpret_reason`     | TEXT nullable    | Interpret suppression/failure detail (G14)                                  |
| `interpret_digest`     | TEXT nullable    | Delivered cheap digest when verdict is `deliver` (G14)                      |
| `created_at`           | INTEGER NOT NULL |                                                                             |
| `updated_at`           | INTEGER NOT NULL |                                                                             |

### `session_object_cursor`

The per-recipient baseline cursor (G10, [§1.1.2](#112-the-shared--per-recipient-seam)). One row per `(session_id, monitor_id, object_key, workspace_path)`: the last shaped artifact this recipient was caught up to, the anchor its per-recipient Diff spans FROM. Unique on the four key columns (`COALESCE(workspace_path, '')` collapses the global/`NULL` case). `baseline_content` is denormalized (the full artifact text) so a recipient's baseline is prune-immune. Survives daemon restart (BP1); session-keyed so isolation is structural.

| Column                 | Type             | Notes                                                 |
| ---------------------- | ---------------- | ----------------------------------------------------- |
| `id`                   | TEXT PK          | ULID                                                  |
| `session_id`           | TEXT NOT NULL    | FK to `agent_sessions.id`                             |
| `monitor_id`           | TEXT NOT NULL    |                                                       |
| `object_key`           | TEXT NOT NULL    |                                                       |
| `workspace_path`       | TEXT nullable    | `NULL` = global                                       |
| `baseline_snapshot_id` | TEXT nullable    | The event/snapshot the baseline came from (diagnosis) |
| `baseline_content`     | TEXT NOT NULL    | Denormalized full artifact (defaults to `''`)         |
| `updated_at`           | INTEGER NOT NULL | Set on seed and on each claim-advance                 |

Verified: `libs/core/src/inbox/schema.ts` (`sessionObjectCursor`), `libs/core/src/inbox/db.ts` (DDL + unique index + additive `diff_text` migration), `libs/core/src/runtime/store.ts` (`getSessionObjectCursor` / `seedSessionObjectCursor` / `advanceSessionObjectCursor`).

### `agent_sessions`

One row per known agent session. Upserted on open (via `hostSessionId` + `adapter` uniqueness).

| Column            | Type             | Notes                                                |
| ----------------- | ---------------- | ---------------------------------------------------- |
| `id`              | TEXT PK          | ULID                                                 |
| `adapter`         | TEXT NOT NULL    | e.g. `claude-code`                                   |
| `host_session_id` | TEXT NOT NULL    | Session ID from the integrating runtime              |
| `agent_identity`  | TEXT NOT NULL    | Human-readable agent identifier                      |
| `role`            | TEXT NOT NULL    | `lead \| subagent`; default `lead`                   |
| `workspace_path`  | TEXT nullable    | `NULL` = global session                              |
| `hook_state_path` | TEXT NOT NULL    | Absolute path to the hook-state JSON file            |
| `status`          | TEXT NOT NULL    | `active \| dormant`                                  |
| `baseline_at`     | INTEGER NOT NULL | Session open time; used for event baseline filtering |
| `last_active_at`  | INTEGER NOT NULL | Updated on each `touchSession()`                     |
| `last_recap_at`   | INTEGER nullable | Set by `updateSessionRecap()`                        |
| `dormant_at`      | INTEGER nullable | Set when session is closed                           |
| `created_at`      | INTEGER NOT NULL |                                                      |
| `updated_at`      | INTEGER NOT NULL |                                                      |

### `monitor_state`

Stores the per-monitor polling and notification state. **One row per
`(monitor_id, workspace_path)` scope** — _not_ per monitor id alone. The database
is global and the same monitor id can exist in unrelated workspaces (the
getting-started default `my-first-monitor` is the common collision), so keying
this row by id alone let one workspace's source baseline (`source_state`) leak
into another: a second project reusing the id observed `descoped`/`deleted`
changes for files that only ever existed in the first (issue #345 / #307). A
surrogate `id` PK plus a UNIQUE index on `(monitor_id, COALESCE(workspace_path, ''))`
keeps each scope single-rowed, including the global (`NULL`-workspace) scope — the
same NULL-safe pattern as `session_object_cursor`.

| Column                | Type             | Notes                                          |
| --------------------- | ---------------- | ---------------------------------------------- |
| `id`                  | TEXT PK          | ULID surrogate key                             |
| `monitor_id`          | TEXT NOT NULL    | Unique with `workspace_path`                   |
| `workspace_path`      | TEXT nullable    | `NULL` = global scope                          |
| `last_observation_at` | INTEGER nullable | Used for due-interval computation              |
| `last_fingerprint`    | TEXT nullable    | Reserved; not currently written by the runtime |
| `source_state`        | TEXT NOT NULL    | JSON; owned by the source plugin               |
| `notify_state`        | TEXT NOT NULL    | JSON; `NotifyRuntimeState` shape               |
| `updated_at`          | INTEGER NOT NULL |                                                |

**Migration — one-time re-baseline (issue #345 / #307).** A `monitor_state` table
created before workspace namespacing keyed rows by `monitor_id` alone (it was the
PRIMARY KEY, with no `workspace_path` column). SQLite cannot add the surrogate
`id` PK the scoped schema needs in place, so on the first open after upgrade the
runtime **rebuilds** the table. The rebuild is _not_ a blanket drop:

- **`source_state` is reset.** The source plugin's change-detection baseline
  cannot be attributed to one workspace (several workspaces sharing one global DB
  clobbered each other on that id), so every monitor re-baselines cleanly on its
  first post-upgrade tick — a source seeing no prior state establishes a fresh
  baseline and emits no spurious created/deleted/descoped events.
- **`notify_state` is preserved, not reset.** `notify_state` is operational
  runtime state, not diagnostic: its `pendingDebounce` / `pendingRollup` batches
  hold **already-detected** observations the runtime MUST redeliver after a
  restart ([§4.4](#44-scheduled-rollup-pace-mode-current), issue #109). Dropping
  them would be silent, permanent event loss (the reset baseline never re-detects
  those changes). Each batched observation carries its monitor's `filePath`, so
  the migration derives each observation's workspace and re-inserts the batch into
  the correctly-scoped row(s), where the next tick of that workspace hydrates and
  flushes it.
- **`observation_history` is migrated additively** (see below), not reset by this
  drop: its `workspace_path` column is added in place and legacy rows keep `NULL`.

This is a documented one-time transition, not a per-tick behavior.

### `observation_history`

An audit trail of each due monitor's outcome per tick. For every evaluated monitor the runtime writes a row with `monitorId`, `sourceName`, `observationData`, and `result`. The `result` values are:

- `triggered` — ≥1 event was emitted (including a tick that flushes a previously-held debounce batch even when it returned no new observations). `observationData` is `{ observed, emitted }`, plus `notRetainedCount` (a positive integer) when the span dropped observations the outbox could not retain (§2), and `notHeld` (a positive integer) when a hold refused some of the span's observations (§4.7).
- `suppressed` — observations were returned but none emitted this tick (throttled or held in a debounce batch). `observationData` is `{ observed, emitted }`, plus `notHeld: <n>` when a hold refused some of the observations (§4.7). Refused observations count in `observed`, carry their own `errored` rows, and are not what makes the span `suppressed`; a span whose only observations were refused writes no batch row. A refusal is not a drop: it never sets `notRetainedCount`.
- `no-change` — the source returned no observations and signalled no special outcome. `observationData` is `{ observed: 0, emitted: 0 }`.
- `no-files-matched` — the source returned zero observations and signalled that its file-system scope matched zero files. This is distinct from `no-change` because no watched target was actually observed. `observationData` is `{ observed: 0, emitted: 0 }`.
- `errored` — a failure occurred and was **isolated** so the tick (or watcher) continued. Three sub-cases:
  - `observe()` threw or rejected in the tick loop: `ingest()` was never called, so the monitor's persisted `sourceState` is left exactly as it was and no subsequent delta is dropped.
  - A dispatched observation failed to materialize. The same rows are written whether the span
    came from `ingest()` (tick or watch path) or from the not-due notify-window flush
    (`flushRollupWindow()`). The outcome depends on the failure kind (ordered retry suffix and
    admission-unit rules: §2):
    - _Savepoint-local failure_ (e.g. `RAISE(ABORT)` on an event, projection/cursor or snapshot
      write): that envelope's own materialization rolls back, the earlier committed prefix stays,
      and the failed envelope plus every later sibling are queued, in order, as retries.
      `emittedEventIds` reflects only durably committed events. `finishMaterializationSpan()`
      writes one `errored` row for the failed envelope after the span commits; the deferred later
      siblings get none.
    - _Savepoint-local failure the outbox cannot retain_ (its whole ordered suffix exceeds the
      outbox's remaining capacity or is not serializable for it; §2 "Admission outcomes when the
      outbox cannot retain a suffix"): nothing is queued for that failure. `admitSpan()` writes
      its `errored` row **inside** the admission transaction, with an error ending in
      `Not retained for retry: <reason>`. That row is the observation's durable outcome, not a
      best-effort audit. Later siblings keep materializing and the source baseline advances. Its
      `observationData` is `{ error, notRetained: true, position, spanSize, objectKey?, title? }`:
      `position` is the observation's 1-based place among the `spanSize` observations the span
      dispatched, and `objectKey`/`title` are copied only when they are strings. The payload is
      never copied. Every text field gets the retry-error safe-text rule: C0, DEL, C1, U+2028 and
      U+2029 become spaces, and each field is capped at 1,024 characters. `error` shortens the
      materialization error, not the reason, to fit. If every observation of the span was
      dropped, no batch row is written (as for any span that emitted nothing and failed). Two
      internal columns, never part of `observationData`, mark the row as a drop and say what
      supersedes it (§2): `unretained_object_key` holds the raw `objectKey` (NULL when it was not
      a string), and `unretained_event_watermark` holds the high-water mark of the
      `monitor_events` materialization order (its AUTOINCREMENT counter, including positions
      reserved by queued retries) when the row was written. The row stays outstanding until
      superseded; it is never deleted or rewritten.
    - _Transaction-wide failure_ (`RAISE(ROLLBACK)`): the whole span rolls back, prefix included,
      and nothing is queued. The source baseline does not advance. The single `errored` row comes
      from `tick()`'s ingest-error catch; on the watch path it comes from `consumeWatch()`'s outer
      catch, which also ends that watcher. On the not-due flush it comes from the tick's
      monitor-local flush catch, which reports the original native error (not a follow-on
      `COMMIT` failure) and lets healthy siblings continue. The window stays held because its
      `pendingRollup` clear rolled back too.

  - A debounce or rollup hold refused an observation because it cannot be serialized (§4.7): one
    row per refused observation, `{ error: "<message>" }`, written **inside** the span's admission
    transaction, before the batch row. It commits with the state that advances the baseline past
    the observation, and a span that rolls back takes the row with it. It is not a drop: it has no
    `unretained_object_key`/`unretained_event_watermark` and is not outstanding loss. The span's
    other observations are held, emitted or dropped as usual.

  In every other case `observationData` is `{ error: "<message>" }`. Except for the unretained-suffix
  and hold-refusal rows, which commit with the span, the audit write is best-effort: a `recordObservationHistory`
  failure is swallowed so a failing audit row can never re-abort the tick.

  An unavailable `incoming-changes` repository/ref uses this existing source-error path (003 §6.5,
  decision #555, Refs #305). Source state, notify state and `lastObservationAt` remain unchanged,
  including across reopening the store. Once due, rejection is retried on each daemon tick;
  ordinary debounce/rollup dispatch in that monitor's due-ingest path waits for observation to
  succeed. These are current error-path consequences, not a guarantee that accepted held work
  can wait indefinitely: #558 tracks held-work flushing and #559 tracks retry cost separately.
  Other monitors continue, and already-materialized events remain deliverable.

- `rebaselined` — the source advanced its persisted baseline to the current point but could not compute a delta (e.g. a force-pushed or gc'd prior ref). The source returned zero observations and set `ObservationResult.outcome: 'rebaselined'`; the runtime maps this to `rebaselined` rather than `no-change`. The runtime enforces the zero-observation invariant: `rebaselined` is recorded **only** when the tick emitted nothing **and** returned zero observations — if a source sets the diagnostic while also returning observations (which are then held/suppressed), the tick is recorded as `suppressed`, not `rebaselined`. This outcome is distinct from `no-change` (genuinely nothing changed) and from `errored` (the source threw). `observationData` is `{ observed: 0, emitted: 0 }`.

_current_. Per-monitor isolation and the `errored` outcome are guaranteed by the runtime for both the tick loop and the watch path (issue #46). The `rebaselined` and `no-files-matched` outcomes are supported via the optional `ObservationResult.outcome` diagnostic field (issues #56 and #193). Verified: `RuntimeStore.recordObservationHistory` / `listObservationHistory`, written from `service.ts` `tick()` (observe-error and ingest-error catches), `admitSpan()` (in-transaction `errored` rows for unretained failures), `ingest()`'s admission transaction (hold-refusal rows, §4.7), `finishMaterializationSpan()` (per-failure `errored` rows and `sourceOutcome` classification), the not-due rollup flush catch, and `consumeWatch()`'s outer catch (which also ends the watcher). Read via `agentmonitors monitor history` ([005 §6](./005-cli-reference.md)).

An observation tick always runs for one concrete workspace, so each row records
its `workspace_path`. Workspace-scoped readers (`monitor explain`, `doctor`, and
`monitor history --workspace`) filter by exact workspace so a same-id monitor in
another workspace cannot leak its audit trail here (issue #345 / #307); an
unscoped `monitor history` still tails across all workspaces. Rows written before
the `workspace_path` column existed keep `NULL` and fall out of any
workspace-scoped query (a soft one-time reset consistent with the `monitor_state`
re-baseline above).

| Column             | Type             | Notes                                                                                |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| `id`               | TEXT PK          | ULID                                                                                 |
| `monitor_id`       | TEXT NOT NULL    |                                                                                      |
| `workspace_path`   | TEXT nullable    | Observing workspace; `NULL` on pre-namespacing legacy rows                           |
| `source_name`      | TEXT NOT NULL    |                                                                                      |
| `observation_data` | TEXT NOT NULL    | JSON                                                                                 |
| `result`           | TEXT NOT NULL    | `triggered \| suppressed \| no-change \| no-files-matched \| errored \| rebaselined` |
| `created_at`       | INTEGER NOT NULL |                                                                                      |

Verified: `libs/core/src/inbox/schema.ts` lines 104–113; `libs/core/src/inbox/db.ts` lines 98–107; `libs/core/src/runtime/service.ts` `tick()` catch blocks (including the not-due rollup flush catch), `admitSpan()` unretained-failure rows, `finishMaterializationSpan()` failure rows and result classification, and `consumeWatch()`'s outer catch block.

### `verify_artifacts`

Durable verify-artifact ownership (§2.6). One row per `verify --use-workspace-daemon` run that
registered its scratch artifact; retained without expiry. Created by an additive migration
(`CREATE TABLE IF NOT EXISTS`), so every released database shape opens unchanged.

| Column                 | Type             | Notes                                                       |
| ---------------------- | ---------------- | ----------------------------------------------------------- |
| `run_id`               | TEXT PK          | The run's 12-hex-digit token, also embedded in `object_key` |
| `owner_session_id`     | TEXT NOT NULL    | The run's throwaway lead session                            |
| `workspace_path`       | TEXT NOT NULL    |                                                             |
| `monitor_id`           | TEXT NOT NULL    | The verified monitor; the filter is scoped to it            |
| `object_key`           | TEXT NOT NULL    | Exact scratch path                                          |
| `registered_at`        | INTEGER NOT NULL |                                                             |
| `cleanup_requested_at` | INTEGER nullable | First time cleanup authority was recorded; never cleared    |
| `cleanup_cause`        | TEXT nullable    | `owner-request \| owner-inactive`                           |

Indexes: unique `idx_verify_artifacts_object (workspace_path, monitor_id, object_key)` (the filter
lookup, and refusal of a key owned by another run); partial
`idx_verify_artifacts_awaiting_cleanup (workspace_path, owner_session_id) WHERE cleanup_requested_at IS NULL`
(per-tick reconciliation reads only records still awaiting cleanup).

### `inbox_items`

Legacy inbox table. Driven by `InboxService`, not by the runtime tick loop (§12).

| Column         | Type             | Notes                                                               |
| -------------- | ---------------- | ------------------------------------------------------------------- |
| `id`           | TEXT PK          | ULID                                                                |
| `session_id`   | TEXT nullable    |                                                                     |
| `monitor_id`   | TEXT NOT NULL    |                                                                     |
| `state`        | TEXT NOT NULL    | `queued \| acked \| in-progress \| completed \| failed \| archived` |
| `urgency`      | TEXT NOT NULL    | `low \| normal \| high`                                             |
| `title`        | TEXT NOT NULL    |                                                                     |
| `body`         | TEXT NOT NULL    |                                                                     |
| `snapshot`     | TEXT NOT NULL    | JSON                                                                |
| `tags`         | TEXT NOT NULL    | JSON array                                                          |
| `created_at`   | INTEGER NOT NULL |                                                                     |
| `updated_at`   | INTEGER NOT NULL |                                                                     |
| `acked_at`     | INTEGER nullable |                                                                     |
| `completed_at` | INTEGER nullable |                                                                     |
