## 2026-06-15 — Deterministic Shape stage: derived facts, render-then-diff, author-declared payload form (001 §5.1–§5.2, 002 §1.1.4–§1.1.6, 003 §2.7) (#144)

Formalizes the **deterministic Shape stage** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S2 areas C/E/G, §S3 Tier 1, §S5 item 5; ledger rows **C41/C42/C43/C46**, with C3/C4/C5/C21 as
the surrounding Shape area and E8 as the flagship cost story). Spec-only; **every new rule is marked
target**, not current. Builds directly on the just-formalized pipeline-shape framing (002 §1.1) and
does **not** contradict any _current_ rule: today's object-level textual diff (002 §5.2) is the
degenerate case where Shape does no compute/render, and the source/runtime split (PP3, AP3, 003 §2.5)
is reaffirmed, not changed.

- **002 §1.1.4 — Shape: deterministic derived facts (target, C41).** The Shape stage MAY compute
  derived/relative facts (timestamp → "past due"/"due soon", all-tasks-blocked → "stalled",
  defer-threshold-crossed → "revealed", priority+proximity → "urgent") as a **pure function of
  `(shaped snapshot, injected now)`** — no model, no ambient clock — on the **shared** side of the
  seam, **before** Pace and Diff (so a fact appearing/changing is itself a diffable delta). Author-
  declared and optional. Kills the E8 "≈100% waste" of an agent re-deriving these every poll.
- **002 §1.1.5 — Shape: render to a stable artifact, then diff the artifact (target, C42/C43).** Shape
  MAY render the shaped state to a stable, token-efficient, markdown-ish (not JSON) artifact, and the
  runtime MUST diff **that rendered artifact**, never the raw source — pinning the order
  `Observe → [Compose] → Shape(compute → render) → Pace → ⟦seam⟧ → Diff(of the artifact) → …`. Render
  is deterministic (byte-stable, or it produces phantom diffs) and shared; the diff **baseline** is
  per-recipient. Deterministic render is a prerequisite for a useful diff — the structural reason
  Shape precedes Diff.
- **002 §1.1.6 — author-declared payload form (target, C46).** The author declares the payload form —
  `prose | structured | artifact | rendered`. `prose` is the only form that invokes the optional
  Interpret stage; the others are deterministic-floor forms (`structured` is the explicit way to avoid
  a lossy digest for a computing recipient, E6). `structured` is produced by a **turnkey declarative
  transform** — **jq** (reshaping) or **CEL** (predicate) — evaluated over the **canonical JSON** form
  of the shaped snapshot (output `encoding` — json/yaml/toon/toml — is a downstream serialization
  concern, not part of predicate semantics); the transform is constrained, **not** arbitrary code, and
  runs once on the shared side of the seam.
- **001 §3 / §5.1 / §5.2 — authoring surface (target).** Adds optional `shape` (derived facts +
  render) and `payload` (form + transform + encoding) frontmatter blocks, with authoring rules,
  examples, and validation obligations. The §3 frontmatter table gains `shape` and `payload` rows
  marked _target_. Omitting both preserves today's textual delivery.
- **003 §2.7 — sources surface raw facts; the runtime computes derived facts (target, C41).** Draws
  the source/runtime line for **facts** (mirroring §2.5 for diffs): a source surfaces the raw
  primitives (a `due` timestamp, child task states) **as observed** and MUST NOT bake in time-relative
  or aggregate derived facts (which depend on runtime-`now` and would churn the diff); the runtime
  Shape stage derives them. This is where the raw facts the §1.1.4 rules consume originate.
- Glossary entries added (derived fact, rendered artifact, payload form). Roadmap gains target gap
  **G15** (deterministic Shape: derived facts + render-then-diff + payload form), with proof criteria;
  it is the per-stage detail under the §1.1 umbrella that G10 names.
- **Acceptance (004 §6):** every rule is normative + marked _target_; each tricky rule carries an
  example (E8 derived facts, E6↔E8 payload poles) and a test implication (fixed-`now` reproducibility,
  byte-stable render, jq-projection output). No contradiction resolved beyond reaffirming the existing
  split, so the resolution is recorded here per 004 §5.
- Spec-only — no implementation or published-package behavior change, so no changeset. Refs #144.

