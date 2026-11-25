## 2026-06-15 — Interpret stage: cheap agentic digest + significance gate via the user's own AI tool, formalized as _target_ (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #145

Formalizes the **cheap agentic Interpret tier** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../../product/monitoring-capability-exercises.md)
§S4, resolved §S5 item 3; ledger rows **C45/C10/C11/C38/C12**, with E5 as the flagship). Spec-only;
**every new rule is marked target**, not current. Builds on the locked pipeline order (002 §1.1.1,
where Interpret is already a named per-recipient stage after Diff, before Deliver), the
author-declared payload form (002 §1.1.6 / 001 §5.2, where `prose` is the form that invokes
Interpret), and the deterministic `structured`-`cel` significance gate (002 §1.1.6). It does **not**
contradict any _current_ rule: today every monitor delivers its textual diff with no agentic reading,
so an absent Interpret stage is the degenerate, default case, and the host-agnostic-core invariant
(002 §11.1, AP3) is reaffirmed, not changed.

- **002 §1.1.8 — Interpret stage (target).** An **optional** stage that runs **after** the
  per-recipient Diff, on the **per-recipient delta** (right of the seam, §1.1.2), invoked **only** when
  the author declares `payload.form: prose`. It produces a **cheap natural-language digest** sized to
  the span (C10) and **may** apply an **agentic significance gate** that suppresses
  not-substantive changes (C11/C38). Key rules: (a) it runs via the **user's own installed AI tool**
  (e.g. `claude -p …`) — **Agent Monitors ships no model and holds no credentials**, inheriting the
  user's data-governance/egress posture by construction (C45, a first-class trust principle); (b) the
  tool invocation is **host-agnostic, behind an adapter interface, never in the runtime core** (like
  the Claude hook adapter, §11.1, AP3); (c) it is **never on the critical path** — an Interpret
  failure falls back to the deterministic `rendered` artifact (§1.1.5) and is recorded as explainable,
  so delivery correctness never depends on a model call; (d) it **judges the change against author
  criteria, never the recipient's private state** (the stable E2/E5 boundary); (e) the **agentic**
  significance gate is **distinct from** the deterministic shared `cel` gate (§1.1.6) — a comparison
  table fixes the difference and the "deterministic-first, agentic-second" composition; (f) **every
  suppress/deliver decision is recorded and explainable** so "why nothing fired" is inspectable (C12,
  the silent-failure-honesty invariant) — recorded on the **per-recipient** projection surface
  (`session_event_state`, surfaced by `monitor explain` §10.7), **not** the shared tick-level
  `observation_history` where the deterministic `cel`-gate suppression lands.

- **006 §2.1 — the Interpret adapter is upstream of transports, not a transport (target).** Pins the
  boundary: the AI-tool invocation lives behind an adapter (like `claudeCodeAdapter`) and is **not** a
  delivery transport — it helps **produce** the `prose` packet (and may suppress it) **before** any
  transport surfaces it, where a transport (§2) only **surfaces** an already-produced `DeliveryClaim`.

- **roadmap G14** — implementation gap for the Interpret stage, P2, with five proof criteria
  (prose-only invocation, fake-adapter digest, agentic suppression recorded + explainable via
  `monitor explain`, best-effort fallback on tool failure, no-model/no-credentials boundary). Governs
  [002 §1.1.8], [006 §2.1], C45/C10/C11/C38/C12 / §S5 item 3.

Spec-only — no implementation or published-package behavior change, so no changeset.

