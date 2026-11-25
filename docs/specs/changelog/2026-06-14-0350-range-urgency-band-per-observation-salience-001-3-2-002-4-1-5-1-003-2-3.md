## 2026-06-14 — Range urgency band + per-observation salience (001 §3.2, 002 §4.1/§5.1, 003 §2.3)

A monitor's `urgency` frontmatter is now an authored **band** `lo..hi`; a bare level is the degenerate
band `x..x` (unchanged behavior — fully backward compatible). A source observation may carry an
optional `salience`, and the runtime resolves the effective urgency as
`clamp(salience ?? band.lo, band.lo, band.hi)`.

- **Authored band (001 §3.2):** `urgency: normal..high` authorizes escalation within the band; a bare
  scalar can never be escalated. The schema rejects unknown bounds, malformed ranges, and inverted
  ranges (`lo > hi`). Parsed to `frontmatter.urgency` (low bound — the base/default) +
  `frontmatter.urgencyMax` (high bound).
- **Salience is observation, not policy (003 §2.3):** the per-observation field is named `salience`
  (PP3 — domain observation), reserving `urgency` for the monitor-level policy knob (PP5).
- **Effective urgency + debounce (002 §4.1, §5.1):** notify timing and the materialized
  `monitor_events.urgency` both use the clamped effective urgency. An escalated observation (effective
  urgency above the band's low bound) arriving in a held debounce batch flushes the **whole** batch
  early — it is not split (held-first ordering preserved).
- **Supersedes** the earlier "ceiling" design (min(monitor, source)): a source may now escalate within
  an explicitly authored band, not only de-escalate under a fixed ceiling.
- **Proof:** `libs/core/src/schema/monitor-schema.test.ts` (band parse + inverted/invalid rejection);
  `libs/core/src/parser/parse-monitor.test.ts` (YAML round-trip of a range band, inverted rejection);
  `libs/core/src/runtime/service.test.ts` (salience within band escalates; clamp above/below band;
  degenerate band never escalates; escalation flushes the whole held debounce batch without splitting).
- Minor changeset: `@agentmonitors/core` (public `Observation.salience`, `MonitorFrontmatter.urgencyMax`,
  and the banded-urgency / salience runtime semantics).

