# Ideal Monitoring Exercises → Capability Ledger

> **Status:** Living working doc.
> **Purpose:** Work through *ideal monitoring setups* one at a time, and for each, derive exactly
> what the **observation + post-processing pipeline must be able to do** to deliver that outcome.
> Every capability an exercise surfaces accumulates into the **Master Capability Ledger** below.
> **Audience:** us. Feeds future spec changes and a `needs-decision` issue; not user-facing.

> **Scope discipline (deliberate).** These exercises are about **capabilities** — what the product
> must be *able to do*. They are **not** about `MONITOR.md` syntax and **not** about architecture
> (no daemon/runtime/storage talk). "How would the product need to function" = which capabilities,
> in what order, shared vs. per-agent — nothing lower than that. Syntax lives in
> [use-cases.md](./use-cases.md) and the standard; architecture lives in `docs/specs/`. Keep them out
> of here.

---

## The method (how we run one exercise)

1. **Ideal setup.** State the outcome the human wants to be *true*, in plain language — what they
   want their agent to know/do, and what they never want to be bothered with. No mechanism.
2. **Walk the pipeline as capabilities.** Move the scenario through the five capability buckets
   (below) and, at each, name the specific thing the product must be able to do.
3. **Tag shared vs. per-agent.** For every capability, mark whether the work is **shared** across
   all agents watching this thing, or **per-agent** (because each agent's baseline — what it last
   saw — differs). This is the question that most shapes what we build.
4. **Harvest into the ledger.** Add new capabilities to the Master Ledger (dedupe against ones
   prior exercises already raised); bump the "seen in" count on repeats. Give a first-cut
   sequencing call (Foundational / Important / Can-wait) that firms up as evidence accumulates.

## The five capability buckets (vocabulary, not components)

These are *stages of what happens to a signal*, named as capability groups. They are not modules.

| Bucket | The capability, in one line |
| --- | --- |
| **Observe** | Acquire the current state of a watched thing, on a cadence — including things that never push or diff themselves. |
| **Shape** | *Deterministic* reduce/transform/identify: keep only what matters, recognize elements by stable identity. Cheap, reliable, reproducible. |
| **Pace** | *When to carry a change forward* — settle/debounce/rollup. A separate clock from the observe cadence. |
| **Interpret** | *Cheap agentic* judgment after Shape+Pace: summarize the change, and decide if it's even worth notifying. |
| **Deliver** | Get the right packet to the right agent at the right moment — possibly *different* packets to different agents from one monitor. |

The working hypothesis for **order** is `Observe → Shape → Pace → Interpret → Deliver`. Each exercise
tests whether that order holds and where per-agent divergence enters the chain.

---

## Master Capability Ledger

> `Shared` = computed once, serves every agent watching this thing. `Per-agent` = must be done
> relative to each agent's own baseline (dedupe by identical baseline/span where possible).
> Sequencing is a *first cut*, refined as exercises accumulate evidence.

| ID | Capability | Bucket | Shared / Per-agent | Configurable? | Seen in | Sequencing |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Acquire a watched thing's current state on an author-set cadence | Observe | Shared | Yes (cadence) | E1, E6, E7 | Foundational |
| C2 | Observe things that never push and can't diff themselves (a doc's content, an API body, a file, a CLI's output) | Observe | Shared | — | E1, E6, E7, E8 | Foundational |
| C3 | Reduce a snapshot to only the relevant substructure, discarding the rest | Shape | Shared (per snapshot) | Yes (what to keep) | E1, E2, E4, E5, E6, E7, E8 | Foundational |
| C4 | Identify elements within that substructure by stable identity, so add/remove/edit are recognized as such (not opaque text change) | Shape | Shared | Partly (key rule) | E1, E6, E7 | Foundational *(partly shipped: keyed-collection)* |
| C5 | Group logically-related elements into a unit (a thread = root + replies) vs. independent items | Shape | Rule shared; applied result per-agent | Yes (grouping rule) | E1 | Important |
| C6 | Determine, per agent, what is new relative to what *that* agent last saw | Shape→Deliver | **Per-agent** (dedupe by identical baseline) | No (intrinsic) | E1, E2, E8 | Foundational *(the moat)* |
| C7 | Size/shape the change to the span — one added item vs. a whole new unit of many | Shape→Interpret | Per-agent (follows C6) | — | E1, E2 | Important |
| C8 | Hold carry-forward until the watched signal has been quiet for a configured period (settle), independent of observe cadence | Pace | Shared | Yes (settle window) | E1, E2, E3 | Foundational |
| C9 | Run the settle clock on the **shaped** signal, not raw observations (a typo elsewhere doesn't reset the comment-settle timer) | Pace | Shared | — | E1, E2, E3 | Important *(forces Shape-before-Pace)* |
| C10 | Produce a short, cheap natural-language summary of the net change, sized to it, so the expensive agent needn't read/diff | Interpret | Per-agent (dedupe by identical span) | Yes (intent/prompt) | E1, E2, E5 | Important |
| C11 | Decide whether a change is substantive enough to notify; stay silent if not | Interpret | Per-agent | Yes (intent) | E1, E5 | Important *(binary case of C38; core value for triage)* |
| C12 | Record every suppress/deliver decision + reason, so silence is explainable (why nothing fired) | Interpret/Deliver | Shared infra, per-agent record | — | E1, E2, E3, E4, E5, E6, E7, E8 | Important *(honesty: ties to silent-failure work)* |
| C13 | Deliver *different* packets to different agents from one monitor | Deliver | **Per-agent** | — | E1, E2 | Foundational |
| C14 | A fully caught-up agent receives nothing (no empty notifications) | Deliver | Per-agent | — | E1, E2, E5 | Foundational |
| C15 | Compute shared upstream work once and fan out to N agents; multiply only the genuinely per-baseline work, deduped by identical baseline/span | Cross-cutting | Shared + per-agent | — | E1, E2 | Important *(correctness first, then this efficiency)* |
| C16 | Observe local files event-driven and low-latency (an OS file-watcher, e.g. Watchman), not just interval polling | Observe | Shared | Yes (paths) | E2 | Foundational for file cases *(sub-second latency = optimization over a poll fallback)* |
| C17 | Address a monitor's output to a dynamically-determined **fleet** (all agents of a project), decoupled from *where* the watched thing lives | Deliver/scope | Shared watch; per-agent membership | Yes (membership) | E2, E4 | Foundational |
| C18 | Deliver to each agent at its earliest **safe** boundary; promptness tracks agent state — mid-task ≈ near-immediate, stopped ≈ next wake | Deliver | Per-agent | Influenced by urgency | E2, E5, E6, E7, E8 | Foundational |
| C19 | Hold a change durably so an agent idle/stopped at change time still receives it when it next wakes (catch-up across downtime) | Deliver/durability | Per-agent | — | E2, E5, E6, E7, E8 | Foundational |
| C20 | Scope the watch to a **canonical location**, distinct from each agent's own working copy of the same files (provenance) | Observe/scope | Shared | Yes (location) | E2, E3, E7 | Important |
| C21 | Produce a deterministic content/text diff of *what* changed in prose, not just "it changed" | Shape | Shared artifact; per-agent baseline | — | E2, E8 | Important |
| C22 | Anchor the trigger window to a *dynamic* external event (a calendar meeting that moves), self-adjusting as it changes; offset it ("the day before") | Observe/Pace | Shared | Yes (event + offset) | E3, E4 | Later *(trigger-composition layer)* |
| C23 | Compose a trigger as an *ordered dependency across sources* (calendar window gates watching the Slack channel) | Observe/cross-source | Shared | Yes (the chain) | E3 | Later |
| C24 | Recognize & extract from a *specific triggering message in a noisy stream* (which message is the VP's selection; which incident names) — may need cheap interpretation, not just snapshot-diff | Observe/Shape | Shared | Yes (what to match) | E3, E4 | Later |
| C25 | Expand one trigger into per-item work across a derived set (N selected incidents) and aggregate the results | Reaction | n/a (within one reaction) | — | E3 | Later *(reaction layer)* |
| C26 | Route a well-formed work packet to a **reaction executor** (an actor with tools), distinct from the end recipient; keep mechanics off the recipient | Reaction/Deliver | n/a | Yes (which executor) | E3, E4, E6, E7 | Later *(AM senses & routes; an agent acts; executor may = recipient)* |
| C27 | As part of the reaction, drive external tools/services to produce a derived artifact and capture its result handle (the NotebookLM URL) | Reaction | n/a | — | E3, E4, E6, E7 | Later |
| C28 | Conditionally enrich an item via retrieval over a historical corpus and branch the action (relate to a past incident → comparison) | Reaction | n/a | Yes (the enrichment) | E3 | Later *(optional per item)* |
| C29 | Durably track progress through a multi-step, time-spanning trigger+reaction — survive restart, don't drop, don't double-fire (idempotent, resumable) | Reliability | Shared | — | E3, E4 | Foundational *for the reaction layer* |
| C30 | Deliver only the *final derived artifact* (podcast URL, possibly still producing) as the payload; the recipient never handles the mechanics | Deliver | Per-recipient | — | E3, E4 | Later |
| C31 | Fire on a *deadline* (a computed time relative to an anchor) and **evaluate state then** — not in response to a change | Pace/Observe | Shared | Yes (deadline/offset) | E4 | Later *(trigger-composition layer)* |
| C32 | Treat **absence / non-occurrence** as a first-class condition (nobody signed up by the deadline → act) — the dog that didn't bark | Detection | Shared | Yes (the expected thing) | E4 | Later *(impossible in a change-only model)* |
| C33 | Branch the reaction on the evaluated state (empty → cancel; signed-up → podcast) | Reaction | n/a | Yes (the branches) | E4 | Later |
| C34 | A reaction may be a **consequential external mutation** (cancel a meeting). **Authorization is out of scope** — assume the host is **pre-authorized** (device-client-cert); HITL/consent is handled by separate projects. AM stays *consequence-aware* but ships no gate | Reaction/safety | n/a | — | E4 | Out of scope *(host pre-authorized; HITL handled elsewhere)* |
| C35 | Recipients can be **humans** derived from the anchor object (the meeting's attendees), delivered on their channel — not only agents | Deliver/scope | Per-recipient | — | E4 | Later |
| C36 | Treat a source as a **stream of discrete events**, reacting per-event, rather than as state to snapshot-and-diff | Observe | Shared | — | E5 | Important |
| C37 | Decide using **author-supplied reference data** (a VIP roster / allow- or watch-list) combined with the event — deterministic lookup | Shape | Shared | Yes (the list) | E5 | Important |
| C38 | **Multi-class agentic triage**: classify an event into author-defined categories via cheap reasoning and route by category (passing → drop; question/VIP/action → notify) | Interpret | Shared (per event) | Yes (categories/criteria) | E5 | Important *(the core value for noisy-stream triage; C11 is its binary case)* |
| C39 | Deliver **structured observed data** (sets / weights / RPE / HR) for the recipient to compute over — *not* a prose digest or artifact handle; skip Interpret when digesting would be lossy | Deliver | Per-recipient | — | E6 | Important *(payload type depends on recipient: prose for humans/high-level agents, data for computing domain agents)* |
| C40 | Assemble **one observation from many queries/calls** to a source (many `ofocus` calls → one composite whole-body snapshot) | Observe | Shared | — | E8 | Important |
| C41 | Deterministically **compute the *derived/relative* facts** the recipient would otherwise reason about: timestamp → "past due"/"due soon", all-blocked → "stalled", defer-threshold-crossed → "revealed", priority + proximity → "urgent" | Shape | Shared | Yes (the rules) | E8 | Foundational *(kills the "≈100% waste" timestamp/aggregate reasoning)* |
| C42 | **Render** the shaped state into a stable, token-efficient, human-readable **artifact** (markdown-ish, not JSON) — cheap to read, clean to diff | Shape | Shared | Yes (the rendering) | E8 | Important |
| C43 | **Diff the *derived/rendered* artifact**, not the raw source — so deltas are semantic and cheap (a new line appears, "urgent" shows up) | Shape→Deliver | Per-recipient baseline | — | E8 | Foundational *(pins Observe → Shape/render → diff → deliver order)* |
| C44 | **Scheduled / windowed rollup** Pace mode (e.g. a 9am daily digest of everything accumulated) — cuts interruption noise *and* lets observation cadence relax, lowering token + observation cost | Pace | Shared | Yes (schedule/window) | CoS rollup *(resolved 2026-06-14)* | Important |
| C45 | Run the cheap **Interpret** stage by invoking the **user's own installed AI tool** (e.g. `claude -p …`) — AM ships **no model and holds no credentials**, inheriting the user's existing **data-governance / compliance** posture | Interpret | Shared | Yes (which tool) | E1/E5 *(resolved 2026-06-14)* | Core *(trust/compliance principle)* |
| C46 | Turnkey **declarative transform/filter** (jq, CEL) over structured formats (JSON / YAML / TOON / TOML); the author **declares the payload form** (prose \| structured \| artifact \| rendered) | Shape/Deliver | Shared | Yes (transform + form) | E5/E8 *(resolved 2026-06-14)* | Important |

---

## Synthesis — what to build, in what order

Drawn from Exercises 1–8 (below) and the 43-capability ledger (above). This is the section the fleet
should read first; the exercises are the evidence.

### S1. The pipeline, locked

Eight scenarios converge on one order, with a single **per-recipient seam**:

```
Observe / Trigger  →  [Compose]  →  Shape  →  Pace  →  ║seam║  →  Diff  →  Interpret  →  Deliver  →  [React]
 (acquire state or    (assemble    (filter/   (settle/         (what's-new   (cheap        (well-timed,  (executor
  compose a trigger)   from many    identify/  deadline/        per recipient agentic,       durable,      agent acts;
                       calls)       compute/   immediate;       C6/C43)       optional      per recipient)  may = recipient)
                                    render)    on shaped sig)                 C10/C11/C38)
```

- **Everything left of the seam is SHARED** — computed once no matter how many recipients (one poll,
  one reduce, one compute/render, one settle decision). **Everything right of the seam is PER-RECIPIENT**
  — because the only useful diff is against *that recipient's* baseline. This seam is the most
  important structural fact in the whole study, and it's what makes fan-out cheap (C15).
- **Shape runs before Pace** (settle the *shaped* signal, C9) and **before Diff** (diff the
  *post-processed/rendered* artifact, C43 — deterministic render is a prerequisite for a useful diff).
- **Interpret operates on the per-recipient delta**, and is **optional** (E1/E2 ran on the
  deterministic floor), **essential** (E5 triage is irreducibly agentic), or **harmful** (E6 — a prose
  digest destroys data a domain agent must compute on). Never on the critical path by default.
- **Three independent clocks** (E2): observation latency, Pace (settle/deadline/immediate), and
  per-recipient delivery timing. They compose; they don't conflict.

### S2. Capability areas (the 43, grouped)

| Area | Capabilities | One-line |
| --- | --- | --- |
| **A. Observe / acquire** | C1, C2, C16, C36, C40 | Poll, watch files low-latency, ingest event streams, observe-the-unpushable (API/file/CLI), compose from many calls |
| **B. Trigger composition** | C22, C23, C24, C31, C32 | Dynamic anchors, cross-source sequencing, deadlines, **absence** — the "when" can be the hard part |
| **C. Shape (deterministic)** | C3, C4, C5, C21, C37, C41, C42 | Reduce, keyed identity, group, text-diff, reference-data lookup, **compute derived facts**, **render an artifact** |
| **D. Pace** | C8, C9, (C31) | Settle / deadline / immediate — a separate clock from observe cadence |
| **E. Per-recipient differencing** | C6, C7, C43, C15 | What's-new vs. baseline, size-to-span, diff-the-rendered-artifact, fan-out efficiency — **the seam** |
| **F. Interpret (cheap agentic)** | C10, C11, C38, C12 | Summarize / suppress / triage on the delta — judges the *change* against author criteria, never the recipient's private state |
| **G. Deliver** | C13, C14, C17, C18, C19, C30, C35, C39, C42 | Per-recipient, empty-aware, fleet/membership addressing, well-timed, durable catch-up, payload = prose \| structured \| artifact \| rendered |
| **H. React** | C25, C26, C27, C28, C29, C33, C34 | Executor (may = recipient), external tools, fan-out-within, branch-on-state, consequence-gate, idempotent/durable workflow |

### S3. Ship order

- **Tier 1 — the monitoring spine (build first).** A, C(reduce/identity C3/C4), D(settle C8/C9),
  E(what's-new C6), G(well-timed C18 + durable C19 + per-recipient/empty C13/C14), plus explainability
  (C12). This alone delivers E1, E2, the E5 *floor*, E6, E7. **The deterministic compute+render+diff
  (C40/C41/C42/C43) belongs in Tier 1 too** — it's the E8 flagship, the strongest cost story, and
  self-dogfooded today.
- **Tier 2 — cheap agentic Interpret (F: C10/C11/C38, + reference data C37).** Optional for E1/E2/E8,
  *the point* for E5 — and E5 is the most broadly relatable persona ("ears on a noisy human stream"),
  so build it soon after the floor, not "much later."
- **Tier 3 — trigger composition (B: C22/C23/C24/C31/C32).** Dynamic anchors, cross-source sequencing,
  deadlines, absence. Independently valuable even for pure *notification* (a calendar-anchored Slack
  watch that just notifies is useful) — so it can land before the reaction layer.
- **Tier 4 — the reaction layer (H: C25–C30, C33/C34).** Heaviest and latest. Gated by reliability:
  **C29 (idempotent, resumable, no-double-fire) is foundational *for this tier* and must land with it.**
- **Fleet addressing (C17)** is foundational wherever multi-agent fleets exist (E2); **fan-out
  efficiency (C15)** is an optimization *after* correctness.

### S4. The execution-layer fork — answered

Across E3/E4/E6/E7 the evidence converges on: **Agent Monitors is a guardrailed router with a
reliability spine — not an orchestrator, and not a dumb pipe.**

- **AM owns:** observe / trigger composition / Pace / deterministic Shape / per-recipient diff /
  **reliability + idempotency + durability** (C29) / routing a well-formed work packet (C26) /
  surfacing the artifact (C30) / explainability (C12).
- **Authorization is out of scope (C34).** Assume the host is **pre-authorized** (device-client-cert);
  HITL/consent is solved by separate projects. AM stays *consequence-aware* but ships no gate — which
  keeps the reaction layer lean.
- **The executor agent owns the doing** — multi-step production, external tool calls, the actual
  mutations. It may be a purpose-built worker (E3 podcasts) or **the recipient itself** (E6 trainer,
  E7 chief-of-staff) when the recipient should be burdened with mechanics.
- **The cheap Interpret tier is a core built-in — implemented by calling the user's own installed AI
  tool** (e.g. `claude -p …`), so **AM ships no model and holds no credentials (C45)**. This is a
  first-class **trust/compliance principle**: in corporate environments, summarization runs through
  the user's *existing* tooling, inheriting their data-governance and egress policy by construction.
  Distinct from the heavy executor (also the user's own agent).
- This honors the positioning spine exactly: **AM senses & routes; an agent acts; AM surfaces the
  result** — and, with C45, **AM never becomes a model vendor or a data-exfiltration surface.**

### S5. Resolved (2026-06-14)

1. **Baseline strategy = author's choice; default incremental.** (Config on C6.)
2. **Scheduled / windowed rollup Pace mode: YES, build it (C44).** Not mere convenience — for
   chief-of-staff cases a daily roll-up cuts interruption noise *and* lets observation cadence relax,
   lowering both token cost and deterministic-observation cost.
3. **Cheap Interpret = core built-in, implemented via the user's own AI tool (C45).** Summarization is
   common enough to be first-class; implement by shelling out to whatever AI CLI the user has (e.g.
   `claude -p`). **AM ships no model, holds no credentials** — so corporate **data-governance/egress
   policy is inherited** from the user's existing tooling. Major trust/compliance principle.
4. **Authorization / HITL is out of scope (C34).** Assume a **pre-authorized host** (device-client-cert);
   other in-flight projects solve consent well. AM stays consequence-aware but ships no gate.
5. **Payload form is author-declared (C46),** with **turnkey transform/filter affordances** — jq, CEL —
   over structured formats (JSON / YAML / TOON / TOML).

**Remaining (design when we build Tier 4):** the exact **reaction work-packet contract** AM hands an
executor (schema + lifecycle). Not blocking the Tier 1–3 spine.

### S5a. Implications worth propagating

- **C45's data-governance principle is a positioning asset, not just an implementation choice.** "Ships
  no model, holds no credentials, inherits your existing data-governance by calling your own AI CLI"
  is a strong enterprise-trust story that complements local-first — it belongs in
  `messaging-and-site-brief.md` and the vision/positioning doc.
- **C44 (rollup) closes the last Pace gap.** Pace modes are now: immediate (E5), settle (E2), deadline
  (E4), **scheduled rollup (C44)** — a complete set.
- **C46 partly answers the old "how expressive is deterministic Shape?" question:** declarative via
  jq/CEL over standard structured formats — not arbitrary user code.

### S6. Where this lands in the specs (when we formalize)

Capability-level only — not a design yet. Body grammar & trigger composition → [001](../specs/001-monitor-definition.md);
new pipeline stages (compute/render, diff-the-artifact, Pace modes, the per-recipient seam, the
reaction layer + idempotency) → [002](../specs/002-runtime-delivery.md); source contract (snapshots
not diffs, composite/stream/CLI/file-watch acquisition) → [003](../specs/003-source-plugins.md); the
reaction layer likely warrants its **own** new spec.

---

## Exercise 1 — Comments on a shared spec doc, many agents, divergent baselines

### Ideal setup

A chief-of-staff agent (and, it turns out, *several* such agents, started at different times) keeps
an eye on the team's product-spec doc. The human wants:

- When people **comment** on the spec, the agent is told in **real terms** — *"Jane opened a thread
  questioning the Friday launch; 6 replies, the room is leaning no"* — not *"the doc changed."*
- Told **only once the discussion has settled** (people stop adding to it for a while), not as each
  partial sentence lands.
- The human **never** wants to be pinged for edits to the doc's *prose* through this monitor — this
  one is about **comments**.
- Different agents that have been away for different lengths of time each hear **the right thing for
  them**: one that's caught up hears nothing; one that missed a single comment hears about that
  comment; one gone since yesterday hears the thread-level story.

### Walk the pipeline (as capabilities)

**Observe.** The product must acquire the doc's current state on a cadence the author sets — say
every few minutes (**C1**) — from a resource that offers no push and no native diff (**C2**). One
acquisition serves every agent. *Shared.*

**Shape (deterministic).** It must reduce that snapshot to **only the comments**, throwing away the
prose (**C3**) — directly satisfying "never ping me for prose edits *here*", cheaply and with no
model. It must recognize each comment/thread by **stable identity** (**C4**, the keyed-collection
capability already shipped) so a new comment reads as *an addition*, not as "this big blob of text
differs." And it must understand that a root comment plus its replies form **one thread** rather
than five unrelated additions (**C5**). The reduction and the identity/grouping *rules* are the same
for everyone — *Shared per snapshot* — but note that *which* of them a given agent perceives depends
on its baseline (below).

**Per-agent divergence enters here.** "What's new" is only definable **relative to what each agent
last saw** (**C6**). This is the crux the three-agent case exposes:
- Agent A is caught up → nothing is new.
- Agent B missed exactly one comment → the new thing is *one comment*.
- Agent C has been gone since yesterday → the new thing is *a whole thread of many comments*.
The product must therefore **size the change to each agent's span** (**C7**): the same monitor yields
"one comment" for B and "a thread of six" for C. *Per-agent* (agents that happen to share a baseline
share this result).

**Pace.** It must hold everything until the **comments have been quiet for a configured period**
(e.g. 10 minutes), independent of how often it polls (**C8**) — poll every 3 min, but don't carry
forward until 10 min of comment-silence. Crucially the settle clock watches the **shaped** signal
(comments), so an edit to the doc's *prose* — already discarded in Shape — does **not** reset the
comment-settle timer (**C9**). Whether the doc as a whole is "settled" is a property of the doc, not
of any one agent. *Shared.*

**Interpret (cheap agentic).** Once settled, and only then, it must produce a **short cheap summary
of the net change, sized to the span** (**C10**) — "one new comment from Jane: '…'" for B, but "new
thread 'Ship Friday?' — 6 comments, leaning no" for C — so the expensive agent is *told*, never made
to read or diff. Because the change differs per baseline, the summary is **per-agent** (computed once
per *distinct* span: A's empty span, B's one-comment span, C's thread span — three summaries, not
"one per agent" if more agents shared a baseline). For pure additive comments the suppress decision
(**C11**) rarely fires here, but the product must still **record** what it chose and why (**C12**) so
"you heard nothing" is explainable rather than indistinguishable from a broken monitor.

**Deliver.** From this *one* monitor, the product must hand **different packets to different agents**
(**C13**): A gets nothing at all (**C14** — no empty pings), B gets the one-comment note, C gets the
thread story — each at that agent's own next safe moment.

### Shared vs. per-agent, for this exercise

| Work | Shared across all agents | Per-agent (by baseline) |
| --- | --- | --- |
| Acquire the doc (C1, C2) | ✅ one poll feeds everyone | |
| Reduce to comments, keying, thread-grouping *rules* (C3–C5) | ✅ once per snapshot | |
| Settle / "has it gone quiet" (C8, C9) | ✅ property of the doc | |
| "What's new for me" (C6, C7) | | ✅ A=nothing, B=one, C=thread |
| Summary of the change (C10) | | ✅ differs by span (dedupe by identical span) |
| Suppress/deliver decision + record (C11, C12) | infra shared | ✅ decision is per-agent |
| The packet that arrives (C13, C14) | | ✅ different per agent |

**The efficiency this implies (C15):** the expensive shared work (poll, reduce, key, group, settle)
happens **once** no matter how many agents watch — that's the fan-out advantage. Only the genuinely
baseline-dependent work (what's-new, summarize) multiplies, and even that collapses across agents
that share a baseline. So "N agents on one doc" is *not* N× the work; it's `shared work + (distinct
baselines)× the cheap per-span work`.

### What Exercise 1 tells us

- **Order holds, with a clear seam.** `Observe → Shape → Pace → Interpret → Deliver` survives, and
  the **per-agent seam sits after the shared Shape** (C6 onward). Everything before the seam is
  shared; everything after can diverge. That seam is the single most important structural fact so far.
- **Shape must precede Pace** (C9): you settle on the *filtered* signal, or trivial noise keeps you
  waiting forever.
- **Interpret is per-span, not per-agent** — the cost lever is "dedupe by identical baseline/span,"
  not "run the model once globally" (impossible — summaries genuinely differ) nor "run per agent"
  (wasteful when baselines coincide).
- **Foundational set, from this one exercise:** acquire-the-unpushable (C1/C2), reduce + identity
  (C3/C4), per-agent what's-new (C6), settle decoupled from poll (C8), per-agent/empty-aware delivery
  (C13/C14). Agentic summary (C10) and suppression (C11) are the *layer above* — important, but the
  basic outcome (told about real comment changes, only when settled, only what's new for me) stands
  on the deterministic floor alone.

---

## Exercise 2 — Spec docs change in main; a fleet of worktree agents must be apprised

### Ideal setup

The human is building software in a Git repo. Some **spec documents are Git-tracked markdown files**
in that repo. A **fleet of agents** each works on a different task in its **own Git worktree**. The
human wants:

- Whenever the **main repo's spec docs change**, **every** agent — in whatever worktree it's working
  — is apprised, so it can **decide for itself** whether to adjust the scope or implementation of its
  current task.
- Account for **agent state at the moment of change**: some agents have **stopped** and won't act
  until their next hook fires (could be ~20 min later); others are **mid-task** and could be told
  **almost immediately**.
- Account for the human **editing the spec docs in real time** — **wait 3 minutes for the docs to
  settle** before telling anyone.
- Observe the file changes with **very low latency** (something like **Watchman**), not lazy polling.

### Walk the pipeline (as capabilities)

**Observe.** The product must watch specific files **event-driven and low-latency** — an OS
file-watcher, not an interval poll (**C16**) — so a change is *detected* within moments. It must
scope the watch to the **canonical** spec docs in the main repo, **distinct from each agent's own
working copy** of those same files in its worktree (**C20**) — otherwise an agent editing its local
copy would masquerade as "the spec changed." One watch, on one canonical location. *Shared.*

**Shape (deterministic).** It must turn raw file-touch events into a meaningful **content diff of
what actually changed** in the prose (**C21**) — not "a file was touched." (This is the text-diff
sibling of E1's keyed-collection identity, C4.) It can also discard non-substantive churn (formatting)
deterministically before anything downstream. *Shared per snapshot.*

**Pace.** It must **wait until the spec docs have been quiet for 3 minutes** before carrying anything
forward (**C8**), and that settle clock runs on the **shaped content signal** (**C9**) — a save that
changes nothing meaningful, or churn the human is mid-keystroke on, shouldn't fire a fleet-wide
interruption. Note the deliberate tension the setup builds: *detecting* fast (C16) and *waiting* 3
minutes (C8) are **different clocks** and don't conflict — see findings. *Shared* (the docs' settle
state is a property of the docs, not of any agent).

**Interpret (cheap agentic).** Once settled, produce a **short cheap summary of what changed in the
spec** (**C10**) so each agent is *told* the substance, not handed two blobs to diff. Critically, the
**relevance judgment — "does this change affect *my* task?" — is NOT the monitor's job here** (see
findings): it depends on each agent's private task context, so the monitor delivers *the change*, and
the receiving agent decides. So suppression (C11) is light in this exercise; explainability of what
fired (**C12**) still holds. *Summary shared when baselines coincide; per-agent for stragglers.*

**Deliver (the heart of this exercise).** From one watch, the product must reach a **dynamically
determined fleet — every agent of this project — wherever its worktree lives** (**C17**); the
recipients are defined by *membership*, not by which tree the change happened in, and the set changes
as agents come and go. For each recipient it must pick the **earliest *safe* moment** to deliver
(**C18**): a mid-task agent gets it at its next turn boundary (near-immediate); a stopped agent gets
it **on its next wake** — and the change must be **held durably so the stopped agent still receives
it 20 minutes later** (**C19**). An agent already working against the latest spec gets nothing
(**C14**). For an agent that's been gone across *several* edit bursts, "what changed" is **cumulative
since that agent's baseline** (**C6/C7**), not just the most recent burst. *Per-agent.*

### Shared vs. per-agent, for this exercise

| Work | Shared across the fleet | Per-agent (by baseline / state) |
| --- | --- | --- |
| Low-latency watch on canonical spec docs (C16, C20) | ✅ one watch | |
| Content diff / discard formatting churn (C21) | ✅ once per change | |
| 3-min settle on the shaped signal (C8, C9) | ✅ property of the docs | |
| Summary of *the change* (C10) | ✅ when baselines coincide | ✅ cumulative for stragglers |
| "Does this affect my task?" | | ✅ **receiving agent decides** (private context) |
| Reaching the fleet (C17) | ✅ one fan-out | ✅ membership resolved per agent |
| When each agent actually hears it (C18, C19) | | ✅ now / next-wake / held-durably |
| The packet that arrives (C13, C14) | often same for live, synced agents | ✅ differs for stragglers; empty for caught-up |

### What Exercise 2 tells us

- **Three independent clocks, not a conflict.** Detection latency (Watchman, ~instant), settle (3
  min of quiet), and per-agent delivery timing (ASAP-when-safe) are *orthogonal*. You **observe fast,
  settle on the shaped signal, then deliver as promptly as each agent's state allows.** This extends
  E1's two-clock finding (observe-cadence ≠ settle) to a three-way independence — and it's the
  resolution to the setup's apparent paradox. ("Almost immediately" means *immediately after settle,
  at the first safe boundary* — not during the 3-minute window.)
- **Addressing is membership-based and dynamic, decoupled from the watched location (C17).** This is
  genuinely new: in E1 the recipients were "agents watching this doc"; here they're "every agent of
  this project," and the change happened somewhere none of them is working (the main tree, not their
  worktrees). The product must resolve *who belongs to the fleet right now*.
- **Durability/catch-up is foregrounded, not incidental (C19).** The required outcome explicitly
  includes agents that **were not live at change time**. The change must outlive the agent's downtime
  and find it on next wake — and for the long-absent agent, accumulate across the windows it missed.
- **This scenario votes for *net/cumulative* baseline semantics.** "What does the spec look like now
  vs. what I'm building against" is the useful question — not the keystroke-by-keystroke play-by-play.
  Contrast E1, where a comment thread's incremental story was fine. Reinforces that **net-vs-incremental
  is an intent-driven authoring choice**, not a global default.
- **Sharpened Interpret/Deliver boundary.** The cheap interpreter summarizes *the change*; it does
  **not** judge *per-recipient relevance* when that needs the recipient's private context. Relevance
  stays with the receiving orchestrator. (Contrast E1: "is this comment edit trivial?" *is* judgable
  without the recipient's context, so it can live in Interpret. Rule of thumb: **Interpret may judge
  properties of the change itself; it may not judge fit-to-a-recipient's-private-goal.**)
- **The foundational spine is now corroborated by two very different scenarios** (a hosted SaaS doc;
  local files across worktrees): observe-the-thing (C2/C16), per-agent what's-new (C6), settle-
  decoupled-from-observe (C8), and **well-timed, durable, per-agent, fleet-wide delivery**
  (C13/C14/C17/C18/C19). The agentic layer (C10/C11) sits above and is not required for the basic
  outcome. Fan-out efficiency (C15) is the optimization on top of the (foundational) ability to reach
  the fleet at all (C17).

---

## Exercise 3 — Incident-review prep: a moving meeting, a Slack selection, podcasts per incident

### Ideal setup

An engineering leader runs a weekly incident-review meeting — nominally Wednesday 8:30am, but it
**moves** (holidays, onsites, exec schedule); the authoritative time is **whatever's on Google
Calendar**. **The day before** the meeting, a program manager posts ~12 candidate incidents in the
incident-review Slack channel; the **VP of eng selects some by name** as the ones to review. The
leader wants:

- Once the **selection lands**, kick off a process: for **each selected incident**, feed its report
  to **NotebookLM** to generate a **per-incident podcast**, driven by a standing prompt describing the
  leader, their role, and what they want discussed about any incident.
- **Optionally**, if an incident **relates to a past one**, also feed the past report and ask for a
  **comparison** — *"are we failing to learn from our mistakes? is there a common remediation?"*
- The leader's **chief-of-staff agent should receive only the final podcast URLs** (or the in-progress
  NotebookLM URLs) — **never** any of the mechanics.

### Walk the pipeline (as capabilities)

This scenario's difficulty is front-loaded into the **trigger** (the "when") and back-loaded into the
**reaction** (the "then"). The middle is thin.

**Observe / compose the trigger.** The product must **anchor to a moving calendar event** — track the
incident-review meeting and derive the active window as "the day before," **self-adjusting** when the
meeting moves (**C22**). That window **gates** watching the Slack channel — an **ordered dependency
across sources** (**C23**): only around "the day before" does it watch for the selection. Within the
channel it must **recognize the specific triggering message** (the VP's selection, not PM chatter or
unrelated posts) and **extract the selected incident names** (**C24**) — which may need cheap
interpretation, since names arrive in prose, not a tidy list. Scope the watch to the right channel
(**C20**). And it must **stabilize the selection before acting** — the VP may add or edit names over a
few minutes (**C8/C9** — settle, here motivated by "don't launch N expensive jobs on a half-made
decision"). *All shared* (one person's workflow).

**Shape.** Thin: the meaningful output of Shape here is "the settled set of selected incident names +
handles to their reports."

**Interpret/React (the heavy end).** On firing, the product must **expand the one trigger into
per-incident work and aggregate** (**C25**). It must **route a well-formed work packet to a reaction
executor** — an actor with tools — *distinct from the chief-of-staff*, keeping every mechanic off the
recipient (**C26**). For each incident the executor **fetches the report, drives NotebookLM with the
standing prompt, and captures the resulting URL** (**C27**); **optionally**, it **searches past
incidents for a relation and, if found, branches to a comparison** with the historical report
(**C28**). The whole thing must be **durable across days and restarts — no drop, no double-fire**
(**C29**), because the trigger spans days and five services.

**Deliver.** Surface **only the final artifacts** — the podcast URLs (or in-progress NotebookLM URLs)
— to the chief-of-staff, mechanics hidden (**C30**). **Single recipient** — the per-recipient fan-out
that dominated E1/E2 is absent here. Explainability (**C12**) matters *more*, not less: if NotebookLM
fails on incident #3, or the window passes with no selection, the leader must be able to see what
happened.

### Who owns what (the axis that matters here)

E1/E2 split work *shared vs. per-recipient*. This scenario is single-recipient; the meaningful split
is **by role/tier**:

| Role | Owns |
| --- | --- |
| **Agent Monitors (sense + route)** | Compose & track the trigger (C22–C24, C8), reliability/idempotency (C29), route the work packet (C26), surface the final artifact (C30), explain what happened (C12) |
| **Reaction executor (an agent with tools)** | The multi-step production: fetch reports, drive NotebookLM, capture URLs (C25, C27), conditional historical comparison (C28) |
| **Chief-of-staff (recipient)** | Nothing but *receiving the URLs* — deliberately kept out of all mechanics |

### What Exercise 3 tells us

- **This crosses the monitoring → reaction boundary.** E1/E2 ended at "deliver a notification"; here
  the payload is the **output of a triggered, multi-step action**. Most new capabilities (C25–C30)
  live on the **reaction** side the spine doesn't yet cover. The **honesty guardrail holds and is
  load-bearing:** AM **senses the trigger and routes a work packet; an agent performs the action; AM
  surfaces the artifact.** AM never "makes the podcast."
- **A three-role model, not three agents-by-accident.** *Sense+route* (AM), *act/produce* (executor
  agent with tools), *receive* (chief-of-staff). The entire point of the scenario is **keeping the
  expensive recipient out of the mechanics** — which validates a clean executor tier between AM and
  the recipient.
- **"When" can be the hardest capability.** The trigger is *composed, dynamic, multi-source, stateful*:
  a moving calendar event anchors a window (C22) that gates a stream-watch (C23) that fires on a
  recognized-extracted-settled message (C24, C8). "A thing changed" doesn't begin to cover it.
  **Trigger-composition is its own capability area**, and it's independently valuable even *without*
  the reaction half (a calendar-anchored Slack watch that merely *notifies* "selection landed" is
  already useful) — so C22–C24 can sequence ahead of C25–C30.
- **Two distinct meanings of "fan-out," now both on the board.** E1/E2 = fan-out across *recipients*
  (one change → many agents). E3 = fan-out across *work-items within one reaction* (one trigger → N
  incidents → aggregate). Same word, different machinery.
- **Settle reappears as "stabilize a decision."** Not "wait for a doc to go quiet" but "wait for the
  selection to stop changing before committing N expensive actions." Same clock; here the cost of
  premature firing is high (N podcast jobs).
- **Reliability is foundational *for the reaction half*.** C29 (durable, idempotent, resumable, no
  double-fire, no missed window) gates everything in the reaction layer — far more load-bearing than
  in the single-shot E1/E2 cases, because the trigger spans days and services.
- **The open product fork this raises (capability-level, your call next):** does the product itself
  **provide an execution layer** that runs these multi-step reactions, or does AM only **hand a
  well-formed packet to a user-designated executor agent** and stay out of the orchestration? Our
  positioning ("AM senses & routes; agents act") points to the latter — AM owns sense/trigger/route/
  surface/reliability; the user's own agent (or a purpose-built worker) owns the doing. But "kick off
  a process per incident, drive NotebookLM, compare to a past incident" is a lot of orchestration that
  *someone* must own and make reliable. **How much reaction machinery the product itself provides is
  the biggest unresolved question across all three exercises so far.**

---

## Exercise 4 — Architecture review: cancel if nobody signed up, else make a prep podcast

### Ideal setup

The leader runs architectural reviews with a **sign-up sheet** (Google Doc) for topics, against a
standing **"hold for architecture review"** meeting on Tuesdays. The desired behavior, evaluated
**24 hours before the slot**:

- **If nobody has signed up** for that date → **cancel the meeting**.
- **If someone has signed up** → take the review doc and **create a NotebookLM podcast**, so
  participants can spin up on the topic ahead of time by listening.

### Walk the pipeline (as capabilities)

The defining feature: **the trigger is a deadline, and one branch fires on an *absence*.**

**Observe / compose the trigger.** Anchor to the standing meeting (which can move) and compute the
deadline "**24 hours before**" (**C22**). At that deadline, **fire and evaluate state** — *not* in
response to any change (**C31**). This is the structural break from E1–E3: there may be **nothing to
react to**, and that's precisely the signal.

**Shape.** Read the sign-up doc and reduce it to "**is there an entry for this date?**" (**C3**,
**C24**) — extracting the relevant rows, possibly with cheap interpretation.

**Evaluate the condition — including absence.** The empty branch fires on **non-occurrence**: nobody
signed up by the bound (**C32**). A change-only monitor *cannot express this* — you can only see "the
dog didn't bark" by evaluating at a deadline.

**React — and branch on the result (C33).**
- *Empty →* **cancel the meeting** — a **consequential external mutation**. Per the model, AM senses &
  routes; an **agent** performs the cancel — but a destructive, outward action needs a **confirmation
  / standing-authorization gate** before it runs (**C34**).
- *Signed-up →* drive NotebookLM on the review doc to produce a **podcast** (**C26, C27**), and deliver
  it.

**Deliver.** The podcast goes to the **review participants** — *humans*, derived from the meeting's
**attendee list** (**C35**, a human-recipient flavor of C17's membership addressing), on a channel
they'll see (the invite, a Slack post). The whole deadline→evaluate→branch→act flow must be **durable
and idempotent** (**C29**) — don't double-cancel, don't double-produce — and **explainable**
(**C12**): *"canceled — nobody signed up"* is exactly the kind of action a human must be able to
trace, especially because it's destructive.

### Branch table (the axis that matters here)

| At deadline − 24h, the doc is… | Reaction | Consequence class | Gate? |
| --- | --- | --- | --- |
| **Empty** (nobody signed up — C32) | Cancel the meeting | Destructive external mutation | **Yes (C34)** |
| **Has a topic** | NotebookLM podcast → participants | Produce + deliver artifact | No |

### What Exercise 4 tells us

- **The trigger can be a *deadline*, and the condition can be an *absence* (C31, C32).** This is a
  structural addition, not a variation: a system that only reacts to *changes* literally cannot
  express "nobody signed up by Tuesday minus 24h." You must be able to **fire on a time and evaluate
  state**, and treat **non-occurrence** as first-class. This is the single most important new idea in
  the exercise.
- **One deadline-evaluation can branch to *opposite* reactions (C33)** — cancel vs. produce —
  generalizing E3's optional enrichment into primary conditional routing.
- **Not all reactions produce artifacts; some mutate the world, and destructive ones need a gate
  (C34).** First scenario with a consequential action. AM still only senses & routes and the agent
  acts — but "acts" now includes "cancel," so a **confirmation / standing-authorization** affordance
  becomes a required guardrail. The **fail-safe direction differs by consequence**: if the system was
  *down* at the deadline, a *missed* cancel (meeting just happens) is safer than a missed-then-late
  cancel, whereas a late podcast is fine — so reliability behavior is **consequence-aware**.
- **Recipients can be humans, derived from the anchor object (C35).** The artifact's consumer is the
  *meeting's attendees*, not an agent — broadening "delivery" beyond the agent-to-agent framing.
- **The reaction layer is consolidating (E3 + E4):** C22 (anchor), C26 (executor), C27 (tool →
  artifact), C29 (durable/idempotent), C30 (deliver artifact) now recur across both reaction
  scenarios; C12 (explainability) is universal (E1–E4). The reaction half has a stable spine forming.
- **Adds weight to the execution-layer fork.** If AM "only routes a packet to your agent," then *who*
  enforces the destructive-action gate (C34) and the consequence-aware fail-safe (C29)? Those feel
  like they must live in **AM's routing/guardrail layer**, even if the agent performs the act. So E4
  nudges the answer toward: **AM owns sense + trigger + reliability + guardrails + routing + surface;
  the agent owns the doing** — AM needs *some* reaction-side machinery, not zero.

---

## Exercise 5 — Triage my Slack mentions: notify only on questions, action, or VIPs

### Ideal setup

The leader is drowning in Slack. They want an agent that, **whenever they're @-mentioned**, uses
**lightweight reasoning** to classify the mention:

- a **passing mention** ("you should meet with @me") → ignore;
- **being asked a question** → notify;
- a mention by a **VIP** (executives, other architects, a maintained VIP list) trying to pull them in
  → notify.

If it looks like the leader **needs to act**, or it's **someone important they must at least
acknowledge**, the **chief-of-staff agent needs to know**. **No debouncing — low latency is better.**

### Walk the pipeline (as capabilities)

**Observe.** Watch Slack as a **stream of discrete events** — react per mention, not by
snapshotting-and-diffing state (**C36**). Push-capable and low-latency.

**Shape (deterministic, cheap-first).** Pre-filter the firehose to **just mentions of me** (**C3**),
discarding everything else before any reasoning runs. Then a deterministic **reference-data lookup**:
is the sender on the **VIP roster** (**C37**)? Cheap, no model — do it before the agentic step.

**Interpret (lightweight agentic — *this is the value*).** On what survives, run **multi-class
triage** (**C38**): passing vs. question vs. VIP-involvement vs. action-needed, by the author's
criteria. Passing → drop (**C11**, the binary case). Question / VIP / action → notify. This judgment
is **irreducibly agentic** — you cannot decide "is this a question I must answer" with a filter.

**Pace.** **None.** Immediate — no settle, low latency end-to-end. (Pace is a per-monitor setting that
here is simply *off*.)

**Deliver.** Notify the **chief-of-staff** promptly, at its next safe boundary (**C18**), holding it
durably if the agent is momentarily offline (**C19**); passing mentions produce **nothing** (**C14**).
Single recipient — no fan-out. And it's a **notification**, not an artifact (unlike E3/E4) — back to
the E1/E2 delivery shape. Explainability (**C12**): the leader can ask *why* a mention did or didn't
surface. *Shared per event; one recipient — the shared/per-agent axis is trivial here.*

### What Exercise 5 tells us

- **First scenario where the agentic Interpret layer *is* the product, not a layer above the floor.**
  E1/E2 delivered their core outcome on the deterministic floor alone; here the triage
  ("passing vs. question vs. involve-me") is **irreducibly agentic** — there is no deterministic floor
  that does it. So the cheap-interpret tier is sometimes the whole point — which **raises its priority
  for the "ears on a noisy human stream" use case**, the most broadly relatable persona (the brief's
  "you are the polling loop" / "ChatGPT to search my email"). Interpret isn't uniformly "Later."
- **Pace = immediate is first-class.** No debounce, low latency. Confirms Pace spans **immediate (E5)
  → settle (E2) → deadline (E4)**, fully per-monitor. (We got the "instant" finding here without
  needing the CI case.)
- **Event-stream vs. state-snapshot is a real Observe distinction (C36).** E1–E4 mostly observed
  *state* and diffed it; E5 reacts to *discrete events* per-event. Both are first-class Observe models.
- **The cheap stage is configured with reference data + criteria, and it splits cleanly (C37 + C38).**
  VIP-roster membership is a **deterministic lookup** (cheap — do first); intent-classification is
  **agentic** (do on what survives). This is the "rich, configurable post-processing" steering made
  concrete: deterministic-first, agentic-second, each author-configured.
- **Interpret's boundary firms up.** It may judge the event against **author-supplied criteria and
  reference data** ("is this a question?", "is the sender a VIP?") — in remit. It still does **not**
  need the *receiving agent's private runtime context* (E2's line). Rule, now stable across E2 + E5:
  **Interpret judges the event against author-provided criteria/data; it never needs the recipient's
  private state.**
- **A clean "reference shape" for the simplest valuable monitor:** foundational observe + cheap
  prefilter + cheap triage + prompt notify — no reaction, no artifact, no fan-out, no settle. This is
  arguably the canonical "give your agent ears" monitor.

---

## Exercise 6 — Hevy workout → tell my trainer agent, which tunes my weights

### Ideal setup

The user logs strength training in **Hevy** (a clean public API). Whenever they **complete a
workout**, within **~20–30 minutes** their **personal-trainer/nutritionist agent** should learn the
details — **sets, weight, RPE per set, heart-rate** — and **adjust weights as needed** (too hard / too
easy) by calling the **Hevy API (or an MCP tool around it)**. Marked as a *simpler, earlier-lifecycle*
case.

### Walk the pipeline (as capabilities)

Almost entirely reuse — the point of running it is to confirm the spine covers a whole new domain.

**Observe.** Poll the Hevy API on a relaxed cadence (**C1**, ~20–30 min is fine) — an API body that
doesn't push (**C2**). Detect a **newly-completed workout** as a keyed addition (**C4**), not by
diffing opaque blobs.

**Shape.** Reduce to the fields that matter — sets, weight, RPE, HR (**C3**).

**Pace.** A **relaxed latency budget** ("within 20–30 min") — not instant (E5), not settle (E2), not a
deadline (E4); just a tolerant cadence. Pace here is simply *nothing special*.

**Interpret.** **Deliberately skipped.** The trainer agent needs the **structured data** to compute
weight adjustments (RPE 9 on the last set → back off 5%); a prose "good chest day" digest would be
**lossy and useless**. So deliver the structured workout data (**C39**), not a summary.

**Deliver + react.** Hand the structured workout to the **trainer agent** at its next safe boundary
(**C18**), held durably if it's offline so no workout is lost (**C19**). That agent is **both the
recipient and the executor** (**C26**, executor = recipient): it reasons and then **writes adjusted
weights back to Hevy** via its own tools (**C27**) — a **closed loop on one system**. The mutation is
routine and reversible, so it runs **ungated** (contrast E4's cancel). Explainable throughout
(**C12**). Single recipient; no fan-out.

### What Exercise 6 tells us

- **Mostly recurrence — the spine generalizes to the personal / quantified-self domain** with almost
  no new machinery (cadence-poll an API, keyed detection, structured delivery, recipient-acts). A
  healthy sign the model is converging; and per your read, an **early, simple, high-frequency shape**
  to target early in the lifecycle.
- **Recipient and reaction-executor can be the *same* agent (C26, executor = recipient).** The trainer
  both receives the workout and tunes the weights with its own Hevy tools. Contrast E3/E4, where we
  deliberately *separated* recipient (CoS) from executor. The choice is whether to burden the recipient
  with mechanics: a **purpose-built domain agent should act**; a **high-level orchestrator should be
  spared**. Both first-class.
- **Payload type depends on the recipient — and digesting can be *harmful* (C39).** This is the
  opposite pole from E5: there, agentic Interpret *was* the value; here, a prose digest would destroy
  the numeric signal the trainer must compute on. Rule: **prose digest for humans/high-level agents;
  structured data for computing domain agents.** Interpret is optional (E1/E2), essential (E5), *or
  counterproductive* (E6) depending on who's listening.
- **Gating is consequence-scaled (refines C34).** Adjusting a training weight is routine and
  reversible → ungated by author intent; canceling a meeting (E4) is consequential → gated. The gate
  attaches to *consequence*, not to *mutation in general*.
- **Closed-loop on a single system.** Observe Hevy → reason → write back to Hevy, often through the
  same MCP wrapper. A clean, common pattern ("watch X and tune X") that the model supports for free.

---

## Exercise 7 — Voice-dumped inbox tasks, triaged by the chief-of-staff

> Tool: `ofocus`, the user's OmniFocus CLI (the task heart of the chief-of-staff agent).

### Ideal setup

The user mostly creates tasks via the agent, but also **dumps tasks into the OmniFocus inbox by
phone** (Apple voice assistant), with no metadata. Whenever a task lands in the inbox, the
**chief-of-staff** should **triage** it — apply a standard **due date by rules** about the kind of
task, file it into an **appropriate project** if one exists, and **flag urgent** if it seems urgent —
so the user can brain-dump by voice and let the agent build the rich representation. *"Pretty simple."*

### Walk the pipeline (as capabilities)

- **Observe.** Poll the inbox by running `ofocus` (**C1/C2** — acquire state by invoking a CLI; the
  inbox doesn't push). Detect a **new inbox task** as a keyed addition (**C4**); reduce to what
  matters (**C3**).
- **Scope.** Watch only the **inbox** — the canonical "untriaged" location (**C20**) — so tasks the
  agent already enriched don't re-trigger.
- **Pace.** None — triage promptly, no settle.
- **Deliver + react.** Hand the new task to the **chief-of-staff** at its next safe boundary (**C18**),
  held durably if offline (**C19**). The CoS is **recipient = executor** (**C26**): it writes due date
  / project / urgency back to OmniFocus with its own tools (**C27**) — a **closed loop on one system**,
  **ungated** (routine, reversible). Explainable throughout (**C12**).

### What Exercise 7 tells us

- **Pure recurrence — E6-shaped.** Closed-loop, executor = recipient, ungated, scope-to-canonical-
  location, **no new capability**. A second domain (task management) riding the same spine confirms
  "observe a new item on a clean tool → a domain agent enriches it in place" is a stable, simple,
  **early** shape.
- **The only nuance is provenance/scope (C20):** watch the *inbox*, not all tasks, so the agent's own
  well-formed tasks don't trigger re-triage.

---

## Exercise 8 — A diffed, token-efficient top-level OmniFocus overview

### Ideal setup

The chief-of-staff needs a **whole-body view** of OmniFocus: what's **past due**, what's **coming
due**, which projects are **stalled** (all tasks blocked → no way forward), and which tasks are
**newly revealed** (deferred until a date threshold crossed — e.g. "ask me in a week"). The user wants
this assembled from many `ofocus` calls into a **token-efficient, markdown-ish summary** — explicitly
*not* JSON — and then wants **that artifact diffed**, so the CoS just sees **new lines appear**
(hidden → revealed), an **"urgent"** label show up next to a task about to be due, and clear
**past-due** markers — *without* reasoning about timestamps or computing diffs itself. **Low latency**
is wanted. Today this is *"nearly 100% waste"*: a similar thing runs by making high-frequency raw CLI
calls and making the CoS do timestamp- and diff-reasoning it shouldn't need.

### Walk the pipeline (as capabilities)

- **Observe.** **Compose one snapshot from many CLI calls** (**C40**) — the whole-body state isn't a
  single fetch.
- **Shape (the star).** Deterministically **compute the derived facts** the agent would otherwise burn
  tokens on (**C41**): timestamp → "past due"/"due soon", all-blocked → "stalled", defer-threshold-
  crossed → "revealed", priority + proximity → "urgent". Then **render** it into a **stable, token-
  efficient, diff-friendly text artifact** (**C42**) — markdown-ish, not JSON.
- **Diff the rendered artifact (the other star).** Diff the **derived artifact**, not the raw source
  (**C43**) — so the delta is semantic and cheap: a new line for a revealed task, an "urgent"
  appearing, a past-due marker. This pins the order: **Observe → compose → Shape/compute/render →
  diff-the-rendered-artifact → deliver delta.**
- **Pace.** Fast / low-latency; no settle.
- **Deliver.** Give the CoS the **delta** of the artifact at its next safe boundary (**C18**), held
  durably (**C19**). The CoS reads a few changed lines — not raw JSON, no recomputation.

### What Exercise 8 tells us

- **Deterministic post-processing can *compute derived facts*, not just filter (C41) — the flagship
  value.** The "≈100% waste" today is exactly the absence of this: timestamp math, stall detection,
  defer-reveal, urgency — all deterministic, all currently done (wastefully) by the agent. Moving it
  below the model is the whole point.
- **Render to a stable artifact (C42), then diff *that* (C43).** The diff operates on the
  **post-processed representation**, intentionally shaped to diff cleanly — so "a task appeared" or
  "became urgent" falls out as a new/changed line with zero agent reasoning. Deterministic render is a
  **prerequisite** for the useful diff; this firmly orders the pipeline.
- **Payload form is recipient-and-purpose dependent — reconciling E6 and E8.** E6 delivers
  **structured data** because the trainer must *compute* on it; E8 renders to **diffable text** because
  the CoS *watches/reads* it. C39 ↔ C42 are two poles — pick by "compute precisely on it" vs. "monitor
  it for change / read a status."
- **This is the scaling-wall + quality pillars in one, and it's self-dogfooding.** Today: high-
  frequency raw CLI calls + agent timestamp/diff reasoning = token-heavy, latency-bound, ~100% waste.
  Monitors flip it: compute + render + diff **once** (cheap, no model), deliver only the **delta**,
  **crank latency down without scaling tokens** — and a deterministic diff can't hallucinate or miss a
  change the way an agent eyeballing JSON would. The user runs a worse version of exactly this today:
  strong proof, and a strong demo.
- **A script could produce the render + diff today; the *monitor* is what adds delta-level delivery +
  low latency without a token blow-up.** State it plainly: the value isn't only the markdown artifact
  (a script gets that) — it's observing it on a tight loop and delivering *only the change*, cheaply.

---

## Backlog of scenarios to run as future exercises

Seeded from the conversation; reorder/replace freely. Each becomes an "Exercise N" section above and
feeds the ledger.

- **Substantive vs. trivial *prose* edits** to a doc ("flag a flipped decision or a new section;
  ignore punctuation/word-choice"). The sharpest test of **agentic suppression (C11)** and of
  net-vs-incremental change over a settle window. *(Partially probed in E2; deserves its own run with
  suppression front and center.)*
- **PR review comments on my open PR** (deterministic-terminal: keyed additions, fast, *no* agentic
  stage needed) — tests graceful degradation and a very different Pace profile.
- **CI / deploy failure on main** (high-urgency, near-instant, no "settle for quiet") — tests that
  Pace varies enormously per monitor and that "instant" is a first-class point on the spectrum;
  probes whether urgency can shorten/skip settle.
- **Low-urgency dependency releases** ("don't interrupt me per release; one digest at 9am") — tests
  whether a **scheduled-rollup** Pace mode is needed beyond settle/throttle.
- **Email/Slack from a specific sender** — tests Observe on a push-capable channel and how Shape
  differs when the source *can* push.
