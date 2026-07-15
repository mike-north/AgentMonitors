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
> `now` injected, never an ambient clock) wired inside `processObservation`
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
> declared, `processObservation` (`libs/core/src/runtime/service.ts`) diffs the rendered artifact, not
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
> `processObservation` (`libs/core/src/runtime/service.ts`), and the stable exported `PayloadForm`
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
> `buildTextDiff(cursor.baselineContent, newestArtifact)` (cursor → endpoint) when the group
> actually collapsed — and records the older intermediates **claimed-but-suppressed**
> (`session_event_state.net_suppressed_at`): retained and explainable via `monitor explain`
> ([§10.7](#107-monitor-pipeline-diagnosis)), never delivered. `incremental` (explicit opt-out)
> delivers all in order. The per-recipient cursor still advances to the newest claimed artifact
> (`markClaimed`) even when intermediates are suppressed. The monitor's `baseline-strategy` is
> persisted on each `monitor_events` row (`baseline_strategy`) so the claim-time decision needs no
> monitor re-scan.
> Tested by `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-N → one net delta + 2
> suppressed; `incremental` contrast; missed-nothing degenerate; shared-chain keeps all N),
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
adapter boundary); `libs/core/src/runtime/service.ts` — `processObservation` invokes the stage only
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
5. determine whether the monitor is due to run
6. call the source's `observe()` method with: the monitor's `scope`, the monitor's previously persisted source state if any, the runtime-supplied `now` timestamp
7. route returned observations through notify dispatch
8. persist updated source state and notify state
9. materialize emitted observations as durable events
10. refresh hook state for sessions in the affected workspace

Verified: `libs/core/src/runtime/service.ts` — `AgentMonitorRuntime.tick()` (lines 358–420).

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

Verified: `libs/core/src/runtime/service.ts` — `cronMatchesDate()` (lines 118–132), `scheduleForMonitor()` schedule branch (lines 456–467).

### 2.3 Watch-mode execution

In addition to the one-shot `observe()` tick loop, the runtime drives continuous `watch()` for sources that implement it (NP4). `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` scans the tree and, for each monitor whose source exposes `watch()`, consumes its `AsyncIterable<Observation>`, funnelling each yielded observation through the **same** notify dispatch → event materialization → session projection pipeline as `observe()` (the shared `ingest()` path). It returns a `WatchHandle` whose `stop()` aborts (via `context.signal`) and awaits every watcher. `daemon run` starts watchers at startup and stops them on shutdown.

While a monitor has an active watcher, the tick loop **MUST** skip its `observe()`, so it is never driven twice. A watcher that throws (other than from the runtime's own abort) is reported via the `onError` callback and released, after which the tick loop resumes driving that monitor via `observe()`. A `watch()` source owns its change-detection state in memory; the runtime does not persist it, so watchers re-establish fresh on restart.

> **Example:** a source that opens an OS file-system watcher yields a `modified` observation the instant a file changes, rather than waiting for the next poll interval; `stop()` closes the OS watcher via the aborted signal.
>
> **Test implication:** a `watch()`-based source whose iterator yields one observation then idles until aborted produces exactly one materialized, session-projected event, and `stop()` resolves with the source's abort handler having fired (`libs/core/src/runtime/service.test.ts`).

Verified: `libs/core/src/runtime/service.ts` — `watchMonitors()`, `consumeWatch()`, the `activeWatchers` skip in `tick()`, and the shared `ingest()` helper; `apps/cli/src/commands/daemon.ts` — watcher start/stop in `runLoop()`.

### 2.4 Watch-mode source-state checkpointing (TARGET)

> **Status: target.** The current implementation leaves `sourceState` untouched while a watcher is
> running — source state is only advanced when `observe()` returns `nextState`. This section defines
> the new core contract addition that allows an active watcher to write back its updated source state
> durably, required for mid-watch crash safety. This rule MUST be moved to _current_ status with
> `verified:` references when it ships (process: [004 §5–6](./004-validation-testing.md)).

A source whose `watch()` implementation maintains in-memory change-detection state (e.g.,
`file-fingerprint`'s fingerprint map) faces a crash-safety gap: if the daemon is killed between
OS-event deliveries, the accumulated state is lost, and on restart the reconcile-on-start pass
([003 §3.5](./003-source-plugins.md)) will re-emit observations for changes that were already
delivered before the crash — duplicate deliveries.

To close this gap, the runtime **MUST** support a **watch-checkpoint mechanism** by which an active
watcher can periodically write back its updated `sourceState` durably, independent of yielding an
observation.

#### Contract shape

The `ObservationContext` **MUST** be extended with an optional `checkpoint` callback:

```typescript
context.checkpoint?: (nextState: unknown) => Promise<void>
```

A watcher implementation calls `context.checkpoint(updatedFingerprintState)` to request a durable
write of the updated source state. The runtime **MUST**:

1. Persist the provided `nextState` into the monitor's `monitorState.sourceState` row **before**
   processing any further observations from the same watcher (G14 durable-write-before-Interpret
   ordering — the same ordering invariant already enforced by `ingest()` for observation materialize;
   see [§1.1.8](#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)).
2. Return the resolved `Promise<void>` when the write is durable.
3. NOT deliver or materialize any observation as a side effect of a checkpoint call — a checkpoint is
   a state write only, not an observation yield.

The `checkpoint` callback is supplied only to `watch()` (via `ObservationContext`); `observe()` uses
the existing `nextState` field on `ObservationResult` for the same purpose.

#### Checkpoint timing

A watcher SHOULD call `checkpoint` at an interval approximately equal to the monitor's `interval`
field (or the default 30s if omitted). The implementation MAY coalesce rapid checkpoint requests
and is not required to checkpoint on every OS event.

A checkpoint failure (the write throws or rejects) MUST NOT abort the watcher — the source SHOULD
log a warning and continue watching. A failed checkpoint is a transient durability gap, not a watcher
protocol violation.

#### G14 ordering invariant

The durable checkpoint write MUST complete before any subsequent `ingest()` call processes an
observation yielded by the same watcher (the G14 ordering). Because `checkpoint` is called
independently of `yield`, the runtime MUST serialize these two paths per-watcher: if a checkpoint
write is in flight when an observation arrives, the runtime MUST await the checkpoint before
ingesting the observation.

> **Example.** A `file-fingerprint` watcher receives a burst of 10 OS events, updates its
> in-memory fingerprint map, yields 10 observations, and calls `checkpoint` once after the burst.
> The runtime ingests all 10 observations (funnelling each through `ingest()`), then persists the
> updated fingerprint state from the checkpoint. If the daemon is killed after the 10 observations
> are materialized but before the checkpoint write, a restart will reconcile from the pre-burst
> baseline — producing the same 10 observations again as reconcile observations. (This is a
> narrow window, bounded to the interval between burst completion and checkpoint write; it is
> preferable to the alternative of never persisting mid-watch state at all.)
>
> **Test implication.** A test that (a) stubs `context.checkpoint`, (b) has the watcher yield an
> observation, and (c) asserts that `checkpoint` was called with the updated state before
> `context.checkpoint` resolved MUST pass. A test that forces `context.checkpoint` to throw MUST
> confirm the watcher continues yielding subsequent observations and does NOT abort.

### 2.5 Tick result

`tick()` returns a `RuntimeTickResult` summarizing the tick:

- `evaluatedMonitors` — the ids of every monitor whose `observe()` was attempted this tick (including monitors whose outcome was `errored`).
- `emittedEventIds` — the ids of the durable events materialized this tick.
- `erroredObservations` — one `{ monitorId, message }` entry per monitor whose observation failed this tick (its `observe()` threw/rejected, or its `ingest()` failed). Each entry is pushed from the **same** code path that writes the `errored` row to `observation_history` (§15 `observation_history`), so the result is the single source of truth for tick-time failures — it is never recomputed by re-scanning history. A monitor that genuinely observed no change does **not** appear here.
- `skippedMonitors` — one `{ monitorId, nextDueAt }` entry per monitor found in the directory but skipped because it was not yet due (interval not elapsed for interval-based monitors; cron window not open for schedule monitors). Populated from the **same** scheduling decision that gates evaluation, so it is never recomputed. A monitor with an active continuous watcher does **not** appear here (it is driven by the watcher, not by the tick).

The runtime **MUST** surface `erroredObservations` so a caller (e.g. the CLI tick output, §10.1/§10.2) can report a failed observation rather than print a clean `emitted 0` that an author cannot distinguish from a genuine no-change.

The runtime **MUST** surface `skippedMonitors` so a caller can distinguish "monitors exist but are not yet due" from "no monitors found" — two situations that previously produced identical CLI output (issue #152).

Verified: `libs/core/src/runtime/types.ts` — `RuntimeTickResult`, `ErroredObservation`, `SkippedMonitor`; `libs/core/src/runtime/service.ts` — `tick()` populates `erroredObservations` in both the `observe()` and `ingest()` error branches alongside the `recordObservationHistory({ result: 'errored' })` write; populates `skippedMonitors` in the `!schedule.due` branch from the same scheduling decision.

## 3. Persisted Monitor State

Each monitor has persisted runtime state containing: `lastObservationAt`, `sourceState`, `notifyState`. `sourceState` is owned by the source plugin and returned via `nextState`. `notifyState` is owned by the runtime and records delivery timing state such as active suppression windows for throttle, pending observation batches for debounce, and the accumulated rollup batch (`pendingRollup`, [§4.4](#44-scheduled-rollup-pace-mode-current)) held between delivery windows.

This split is important: source plugins own change-detection state, while the runtime owns notification timing behavior.

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
  hook-state files, the startup-lock pid file, and the `.claude/agentmonitors.local.md` coordination
  file. (The `.claude` directory itself belongs to the host tool and is **not** re-moded — only the
  coordination file we own is.)
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
- **Degrade gracefully where the artifact is not ours.** Tightening never _fails_ an operation that
  only needs write access. When the target exists but is owned by another user (a caller pointed,
  say, `--hook-state-path` into a shared group-writable directory), the `chmod` returns
  `EPERM`/`EACCES`; the helpers emit **one structured stderr warning per path per process** and
  continue, leaving the mode unchanged — they do **not** throw. The daemon must never die because an
  artifact it was asked to write is not one it can chmod; correspondingly, a single malformed or
  unexpected IPC request is answered with an error response, never allowed to crash the daemon
  process ([§10.4](#104-ipc-wire-protocol)).
- **Windows.** POSIX modes are not meaningful; the helpers create the paths without mode enforcement.

Verified: `libs/core/src/security/local-permissions.ts` — `ensurePrivateDir`,
`restrictExistingPathMode`, `withRestrictedUmask`, `writePrivateFileAtomic`, `restrictSocketMode`;
`libs/core/src/inbox/db.ts` — `createDb`; `libs/core/src/hook-bridge/bridge.ts` +
`libs/core/src/runtime/service.ts` — hook-state writes; `apps/cli/src/daemon-ipc.ts` — socket,
startup lock, and the long-socket-path fallback ([§10.3](#103-socket-path-resolution));
`apps/cli/src/local-state.ts` — coordination file; tests: `local-permissions.test.ts`,
`inbox/db-permissions.test.ts`, `hook-bridge/bridge.test.ts`, `daemon-ipc.test.ts`, and the
real-binary UAT in `commands/cli.integration.test.ts`.

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

For `debounce`: incoming observations are accumulated in a pending batch; each new observation resets the batch's `dueAt` time to `observedAt + settle-for`; a later runtime tick at or after that due time flushes the full pending batch. This means debounce delivery is bounded by both the configured settle interval and the daemon's tick cadence.

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

2. **Window evaluation.** On each runtime tick the runtime evaluates the monitor's `window` cron
   expression against the current time using the configured `timezone` (defaulting to `UTC`). The
   window fires at most once per minute (same guard as the schedule source, §2.2). If the window
   matches and the accumulated batch is non-empty, the batch is flushed as a single composite
   emission and the accumulation state is cleared.

3. **Empty window.** If the window opens but no observations have accumulated since the last flush,
   the runtime produces no delivery (no empty pings — preserving C14).

4. **Batch representation.** The flushed batch becomes one or more `monitor_events` rows (one per
   accumulated observation) rather than a single merged row, so the full event history is
   queryable. The runtime **MAY** synthesize a composite summary for the delivery payload. The exact
   materialization shape is left to the implementation within these constraints.

5. **Relationship to urgency.** Urgency applies to the _accumulated_ observations individually.
   The effective urgency of the flush follows the most-escalated observation in the batch if the
   batch is flushed as a unit. If materialized as individual events, each event carries its own
   effective urgency.

6. **No per-change interrupts.** A monitor with `strategy: rollup` **MUST NOT** deliver anything
   outside a window opening. Observations accumulate silently between windows. This is the defining
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

## 5. Event Materialization

Each emitted observation becomes one row in the `monitor_events` table. The runtime **MUST** persist at least: `id`, `workspacePath`, `monitorId`, `sourceName`, `urgency`, `title`, `body`, `summary`, `payload`, `snapshotMetadata`, `snapshotText`, `diffText`, `objectKey`, `queryScope`, `tags`, `createdAt`.

Verified: `libs/core/src/runtime/service.ts` — `processObservation()` (lines 566–617); `libs/core/src/runtime/store.ts` — `insertEvent()` (lines 260–299).

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

Verified: `libs/core/src/runtime/service.ts` — `processObservation()`.

### 5.2 Snapshots and diffs

If an emitted observation includes `snapshotText`, the runtime **MUST**:

1. look up the latest stored snapshot for the same `(workspacePath, monitorId, objectKey)` triple
2. compute a textual diff if a previous snapshot exists
3. store the new snapshot after persisting the event

The diff format is a line-level unified-style representation capped at 20 changed lines, produced by `buildTextDiff`. If previous and current text are identical, `buildTextDiff` returns the empty string.

Verified: `libs/core/src/runtime/service.ts` — `processObservation()` lines 566–616; `libs/core/src/runtime/diff.ts` — `buildTextDiff()` (lines 7–26, cap at 20 lines visible at line 21).

This makes snapshot history an object-level concern rather than a monitor-level or session-level concern (SP5).

> **Pipeline model.** In the stage vocabulary of [§1.1](#11-post-processing-pipeline-model), the diff
> described here is the **shared object-level** diff against the latest stored object snapshot,
> retained on `monitor_events.diff_text` for `events list`/history. As of G10 PR-A the **delivered**
> Diff is computed **per recipient against that recipient's own baseline cursor**, right of the
> shared/per-recipient seam ([§1.1.2](#112-the-shared--per-recipient-seam)), and recorded on
> `session_event_state.diff_text`; the shared object-level diff here is its degenerate
> single-baseline case (a recipient at the shared baseline gets a byte-identical span).

## 6. Session Projection

Persisted events are not directly tied to one session. They are projected into matching sessions via `session_event_state`. When an event is inserted, the runtime **MUST** project it into matching **lead** sessions only.

Current projection rules: an event in workspace `W` projects into lead sessions whose `workspacePath` matches `W` **and** into lead sessions whose `workspacePath` is `null`, representing global visibility. Subagent sessions are tracked but do not receive automatic event projection.

As of G10 PR-A, the projection step also computes each recipient's **per-recipient delta** — the shared event's shaped artifact diffed against that session's own baseline cursor (`session_object_cursor`, [§1.1.2](#112-the-shared--per-recipient-seam)) — and records it on `session_event_state.diff_text`. A session's first projection of an object seeds its cursor to the pre-event state (so a late joiner hears only changes after it registered); `markClaimed` advances the cursor to the artifact the recipient was shown. Legacy rows (materialized before G10) carry a `NULL` `session_event_state.diff_text` and fall back to the shared `monitor_events.diff_text`.

Verified: `libs/core/src/runtime/store.ts` — `insertEvent()` filters `sessionsForWorkspace(event.workspacePath)` with `.filter(candidate => candidate.role === 'lead')` and computes/records the per-recipient `diff_text` in the same projection loop (durable before any Interpret await). `sessionsForWorkspace()` returns sessions matching the workspace path **or** sessions with a `null` workspace path. Proven by `libs/core/src/runtime/per-recipient-diff.test.ts`.

### 6.1 Session identity

Opening a session with the same `(adapter, hostSessionId)` pair resumes the existing AgentMon session record instead of creating a duplicate. Closing a session marks it dormant (`status = 'dormant'`, `dormantAt` set) but preserves all history.

Verified: `libs/core/src/runtime/store.ts` — `openSession()` (lines 102–152): checks for an existing row by `(adapter, hostSessionId)`; if found, sets `status = 'active'` and clears `dormantAt`. `closeSession()` (lines 175–188) sets `status = 'dormant'`.

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

Each element of the `events` array is a `DeliveryEventSummary` which carries: `eventId`, `monitorId`, `title`, `summary`, `urgency`, `createdAt` (ISO-8601 string), and `body`. The `body` field is the raw monitor body-instructions (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`). It carries what the agent should **do** when the monitor fires, so a delivery transport (e.g. hook, MCP channel) can surface the instructions, not just the title/summary.

Verified: `libs/core/src/runtime/service.ts` — `claimDelivery()` turn-interruptible high branch: `settledHigh` filters by age, payload includes `summarizeEvents(...)` and a full `events` array with `body: event.body`.

### 9.2 Normal urgency

At `turn-interruptible`, normal-urgency events are delivered as a generic inbox reminder (`NORMAL_INBOX_PROMPT = 'AgentMon messages are available. Read the inbox.'`) only if all unread normal-urgency events are still unclaimed. This coalesces multiple normal events into one reminder until the session acknowledges them. The `events` array is empty in this case.

**The reminder is coalesced-until-acknowledgment (issue #333).** Delivering the reminder claims the underlying events (`markClaimed` sets `firstNotifiedAt`; §9.4 — claiming never acknowledges), so once any unread normal event has been claimed-but-not-acknowledged, the `normalPending.length === unreadNormal.length` guard no longer holds and the reminder is **suppressed** — it does not re-fire until the claimed events are acknowledged **or** a fresh unclaimed normal event arrives. A second `hook claim --lifecycle turn-interruptible` after the first therefore correctly returns `null`. This is intended coalescing, **not** a lost signal: the events stay unread (re-discoverable via `events list --unread`) and durable. Because a silent `null` is indistinguishable from "nothing was ever pending," this suppression **MUST** be inspectable rather than presented as silence (the silent-failure-honesty invariant, [§1.1.8](#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool), capability C12): `monitor explain`'s projection-and-delivery stage ([§10.7](#107-monitor-pipeline-diagnosis)) names the suppression reason (`already-claimed` when every unread event of the band is claimed; `coalesced-until-ack` when a mix of claimed and unclaimed events holds the coalesced reminder back).

Verified: `libs/core/src/runtime/service.ts` — the `normalPending.length === unreadNormal.length` guard in `claimDelivery`; `NORMAL_INBOX_PROMPT` constant. The suppression diagnosis is `diagnoseReminderSuppression` (`libs/core/src/runtime/reminder-diagnosis.ts`), surfaced by the `delivery` stage of `explainMonitor`. Proven by `libs/core/src/runtime/reminder-diagnosis.test.ts`, the "normal-urgency reminder suppression is explainable (issue #333)" case in `libs/core/src/runtime/service.test.ts`, and the real-daemon/IPC "hook claim normal-urgency reminder + suppression diagnosis (issue #333)" case in `apps/cli/src/commands/cli.integration.test.ts`.

### 9.3 Low urgency

At `turn-idle`, low-urgency events are delivered as a generic reminder (`IDLE_INBOX_PROMPT = 'AgentMon has inbox updates ready for review.'`) only if all unread low-urgency events are still unclaimed. The `events` array is empty.

The low-urgency reminder is coalesced-until-acknowledgment exactly as the normal reminder is (§9.2): once an unread low event is claimed-but-not-acknowledged, the reminder is suppressed until acknowledgment or a fresh unclaimed low event, and the same `monitor explain` diagnosis (§10.7) names the reason (issue #333).

Verified: `libs/core/src/runtime/service.ts` — the `shouldSendLow` guard in `claimDelivery`; `IDLE_INBOX_PROMPT` constant. Suppression diagnosis: `diagnoseReminderSuppression` (`libs/core/src/runtime/reminder-diagnosis.ts`), proven for the `low`/`turn-idle` band by `libs/core/src/runtime/reminder-diagnosis.test.ts`.

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

Each request/response is a single newline-delimited JSON object. The server reads until it finds `\n`, parses the JSON, dispatches the method, and writes `{ id, result? }` or `{ id, error }` back before closing the connection.

Verified: `apps/cli/src/daemon-ipc.ts` — server `socket.on('data', ...)` handler (lines 244–278); `respond()` writes `JSON.stringify(payload) + '\n'` (line 241).

### 10.5 Exposed socket commands

The daemon socket exposes the following commands (the `DaemonMethod` enum):

| Method            | Description                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `ping`            | Health check; returns `{ ok: true }`                                                          |
| `status`          | Returns `RuntimeStatus` (session counts, event count)                                         |
| `stop`            | Requests graceful daemon shutdown                                                             |
| `session.open`    | Opens or resumes a session; returns `AgentSessionRecord`                                      |
| `session.close`   | Marks a session dormant; returns `AgentSessionRecord`                                         |
| `session.list`    | Returns all `AgentSessionRecord[]`                                                            |
| `events.list`     | Lists events, with optional filters; returns `MonitorEventRecord[]`                           |
| `events.ack`      | Acknowledges events for a session                                                             |
| `hook.claim`      | Claims a delivery payload for a session at a lifecycle point; returns `DeliveryClaim \| null` |
| `history.list`    | Lists recent observation-history rows, optionally filtered by monitor id                      |
| `monitor.explain` | Returns a read-only staged diagnosis for one monitor's current pipeline state                 |
| `daemon.tick`     | Runs one tick on the specified monitors directory                                             |

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
5. Materialization: recent `monitor_events`
6. Projection and delivery: `session_event_state` joined to `agent_sessions`, reported as
   `unread`, `claimed`, or `acknowledged`. When a session's unread normal/low events are already
   claimed (so the coalesced turn-interruptible/turn-idle reminder of §9.2/§9.3 is currently
   suppressed), this stage additionally reports a `reminderSuppression` finding per session-and-band
   naming the reason — `already-claimed` or `coalesced-until-ack` — so a `null` claim is explainable
   rather than silent (issue #333). The stage stays `ok` (the events are projected and claimed
   correctly; the paused reminder is expected behavior, not a fault).

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
- `failure` — a real fault: invalid definition, errored observe, a zero-file match diagnostic, or a missing expected projection.
  (An unreachable daemon is **not** itself a stage failure: the CLI falls back to an in-process read
  of the persisted store — see the no-daemon fallback below.)

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
3. `turn-idle` evaluates `shouldSendLow`: `pendingEventsForSession(sessionId, 'low').length > 0` and all low-urgency unread events are still unclaimed → returns a `DeliveryClaim` with `message: IDLE_INBOX_PROMPT`
4. the event remains unread until explicitly acknowledged

**What this example proves:** `low` urgency is real runtime behavior, not schema-only metadata; idle-time delivery differs intentionally from interruptible delivery.

### 13.3 Coalesced normal reminder, then its suppression (issue #333)

1. a `urgency: normal` monitor emits a change; the event is persisted and projected into a lead session (unread, unclaimed)
2. `turn-interruptible` evaluates the §9.2 guard — all unread normal events are unclaimed → returns a `DeliveryClaim` with `message: NORMAL_INBOX_PROMPT` and an empty `events` array, **and claims the event** (`markClaimed` sets `firstNotifiedAt`; not acknowledged)
3. a **second** `turn-interruptible` claim finds the event unread-but-claimed → the guard no longer holds → returns `null` (the coalesced reminder does not nag again until acknowledgment or a fresh unclaimed normal event)
4. `monitor explain <id>` reports the `delivery` stage as `ok` with a `reminderSuppression` finding naming the reason (`already-claimed`), so the `null` is explainable rather than silent

**What this example proves:** the normal reminder fires on the first claim (it is _not_ silently swallowed); coalescing-until-acknowledgment means a repeat claim is intentionally quiet; claiming is not acknowledgment (the event stays unread and durable); and the "why nothing surfaced" answer is inspectable via `monitor explain`, never presented as bare silence. This is the resolution of the blind-study S3 F2 report: a first-run subject who claimed once, then claimed again, saw `null` the second time and mistook intended coalescing for a broken delivery path.

## 14. Validation Implications

Runtime and persistence tests should be able to prove:

- stateful source state survives runtime restarts (persisted via `monitor_state.source_state`)
- schedule matching respects configured timezone via `Intl.DateTimeFormat`
- high-urgency delivery waits for the 15-second settle window before `claimDelivery` returns a payload
- normal reminders coalesce until unread events are acknowledged (guard: `normalPending.length === unreadNormal.length`)
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

| Column              | Type             | Notes                                           |
| ------------------- | ---------------- | ----------------------------------------------- |
| `id`                | TEXT PK          | ULID                                            |
| `workspace_path`    | TEXT nullable    | Path to the workspace; `NULL` for global events |
| `monitor_id`        | TEXT NOT NULL    | Stable monitor identifier                       |
| `source_name`       | TEXT NOT NULL    | Source plugin name                              |
| `urgency`           | TEXT NOT NULL    | `low \| normal \| high`                         |
| `title`             | TEXT NOT NULL    |                                                 |
| `body`              | TEXT NOT NULL    | Defaults to `''`                                |
| `summary`           | TEXT NOT NULL    | Defaults to `''`                                |
| `payload`           | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `snapshot_metadata` | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `snapshot_text`     | TEXT nullable    | Full snapshot content if provided               |
| `diff_text`         | TEXT nullable    | Line-level diff vs. previous snapshot           |
| `object_key`        | TEXT nullable    | Snapshot and diff keying                        |
| `query_scope`       | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `tags`              | TEXT NOT NULL    | JSON array; defaults to `[]`                    |
| `created_at`        | INTEGER NOT NULL | Observation timestamp                           |

### `monitor_snapshots`

Stores the full text content of each snapshot for diff computation. Keyed by `(workspace_path, monitor_id, object_key)`.

| Column           | Type             | Notes                     |
| ---------------- | ---------------- | ------------------------- |
| `id`             | TEXT PK          | ULID                      |
| `workspace_path` | TEXT nullable    |                           |
| `monitor_id`     | TEXT NOT NULL    |                           |
| `object_key`     | TEXT NOT NULL    |                           |
| `event_id`       | TEXT NOT NULL    | FK to `monitor_events.id` |
| `content`        | TEXT NOT NULL    | Full snapshot text        |
| `created_at`     | INTEGER NOT NULL |                           |

The draft omitted this table. It is required for snapshot diff computation (§5.2) and is populated by `RuntimeStore.saveSnapshot()`. Verified: `libs/core/src/runtime/store.ts` — `saveSnapshot()` (lines 375–394); `latestSnapshot()` (lines 396–416).

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

Stores the per-monitor polling and notification state. One row per monitor ID.

| Column                | Type             | Notes                                          |
| --------------------- | ---------------- | ---------------------------------------------- |
| `monitor_id`          | TEXT PK          |                                                |
| `last_observation_at` | INTEGER nullable | Used for due-interval computation              |
| `last_fingerprint`    | TEXT nullable    | Reserved; not currently written by the runtime |
| `source_state`        | TEXT NOT NULL    | JSON; owned by the source plugin               |
| `notify_state`        | TEXT NOT NULL    | JSON; `NotifyRuntimeState` shape               |
| `updated_at`          | INTEGER NOT NULL |                                                |

### `observation_history`

An audit trail of each due monitor's outcome per tick. For every evaluated monitor the runtime writes a row with `monitorId`, `sourceName`, `observationData`, and `result`. The `result` values are:

- `triggered` — ≥1 event was emitted (including a tick that flushes a previously-held debounce batch even when it returned no new observations). `observationData` is `{ observed, emitted }`.
- `suppressed` — observations were returned but none emitted this tick (throttled or held in a debounce batch). `observationData` is `{ observed, emitted }`.
- `no-change` — the source returned no observations and signalled no special outcome. `observationData` is `{ observed: 0, emitted: 0 }`.
- `no-files-matched` — the source returned zero observations and signalled that its file-system scope matched zero files. This is distinct from `no-change` because no watched target was actually observed. `observationData` is `{ observed: 0, emitted: 0 }`.
- `errored` — a failure occurred and was **isolated** so the tick (or watcher) continued. Two sub-cases:
  - `observe()` threw or rejected in the tick loop: `ingest()` was never called, so the monitor's persisted `sourceState` is left exactly as it was and no subsequent delta is dropped.
  - A single dispatched observation failed to materialize inside `ingest()` (tick or watch path, e.g. a DB insert error): the batch's other observations are unaffected and `emittedEventIds` reflects only what was durably written. Note: `insertEvent` and `saveSnapshot` are two separate writes; a `saveSnapshot` failure after a successful `insertEvent` is best-effort — the event row exists but has no snapshot (see TODO in `service.ts processObservation`).

  In both cases `observationData` is `{ error: "<message>" }`. The audit write itself is best-effort: a `recordObservationHistory` failure is swallowed so a failing audit row can never re-abort the tick.

- `rebaselined` — the source advanced its persisted baseline to the current point but could not compute a delta (e.g. a force-pushed or gc'd prior ref). The source returned zero observations and set `ObservationResult.outcome: 'rebaselined'`; the runtime maps this to `rebaselined` rather than `no-change`. The runtime enforces the zero-observation invariant: `rebaselined` is recorded **only** when the tick emitted nothing **and** returned zero observations — if a source sets the diagnostic while also returning observations (which are then held/suppressed), the tick is recorded as `suppressed`, not `rebaselined`. This outcome is distinct from `no-change` (genuinely nothing changed) and from `errored` (the source threw). `observationData` is `{ observed: 0, emitted: 0 }`.

_current_. Per-monitor isolation and the `errored` outcome are guaranteed by the runtime for both the tick loop and the watch path (issue #46). The `rebaselined` and `no-files-matched` outcomes are supported via the optional `ObservationResult.outcome` diagnostic field (issues #56 and #193). Verified: `RuntimeStore.recordObservationHistory` / `listObservationHistory`, written from `service.ts` `tick()` (observe-error and ingest-error catches), `ingest()` per-observation materialization catch, `ingest()` `sourceOutcome` classification, and `consumeWatch()` inner catch. Read via `agentmonitors monitor history` ([005 §6](./005-cli-reference.md)).

| Column             | Type             | Notes                                                                                |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| `id`               | TEXT PK          | ULID                                                                                 |
| `monitor_id`       | TEXT NOT NULL    |                                                                                      |
| `source_name`      | TEXT NOT NULL    |                                                                                      |
| `observation_data` | TEXT NOT NULL    | JSON                                                                                 |
| `result`           | TEXT NOT NULL    | `triggered \| suppressed \| no-change \| no-files-matched \| errored \| rebaselined` |
| `created_at`       | INTEGER NOT NULL |                                                                                      |

Verified: `libs/core/src/inbox/schema.ts` lines 104–113; `libs/core/src/inbox/db.ts` lines 98–107; `libs/core/src/runtime/service.ts` `tick()` catch blocks, `ingest()` per-observation catch, `ingest()` result classification, and `consumeWatch()` inner catch block.

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
