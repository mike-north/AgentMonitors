## 2026-06-15 — Author-declared baseline strategy: `incremental` vs `net` per-recipient Diff (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #146

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../../product/monitoring-capability-exercises.md)
§S5.1; ledger rows **C6** and **C7**). Spec-only; all new rules are marked **target**, not current.
Builds on the per-recipient seam already formalized in [002 §1.1.2](../002-runtime-delivery.md).

- **001 §3.7 — `baseline-strategy` authoring field (target).** A new optional frontmatter field
  with two values: `incremental` (default) — each intermediate observation since the recipient's
  baseline delivered in order (play-by-play); `net` — a single net delta of where things stand
  now vs. the recipient's baseline (intermediate churn collapsed). Omitting the field is
  equivalent to `incremental` — backward compatible with today's sequential delivery. The field
  is per-monitor author intent; the runtime enforces it in the per-recipient Diff stage right of
  the seam (§1.1.2). Motivation and cross-references to C6 / C7 / E1 / E2 / §S5.1 included.

- **001 §7.4 — net-delta spec-doc authoring example (target).** Illustrates `baseline-strategy: net` for a shared spec-doc monitor serving a fleet of agents at divergent baselines (the E2
  scenario), paired with `notify: debounce` — the field works alongside any Pace mode.

- **002 §1.1.7 — Diff: catch-up span and baseline-strategy semantics (target).** Defines the
  **catch-up span** (the set of shaped observations between a recipient's last-seen baseline and
  the current delivery point) and specifies how the Diff stage processes it under each strategy.
  `incremental` delivers _N_ deltas in order for a span of _N_ observations; `net` delivers one
  net delta by comparing the baseline snapshot against the endpoint observation's snapshot,
  collapsing all intermediate observations. Backward compatibility named: the current runtime's
  sequential delivery is the degenerate `incremental` case. Interaction with Pace (independent),
  interaction with the seam (per-recipient concern, right of seam), and test implications included.

- **Roadmap G13** — implementation gap for `baseline-strategy`, P2, with four proof criteria:
  validate acceptance, `net` collapse of a multi-observation span, `incremental` delivery of _N_
  deltas, and omit-equals-incremental backward compatibility. Governs
  [001 §3.7], [002 §1.1.7], C6/C7/§S5.1.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #146.

