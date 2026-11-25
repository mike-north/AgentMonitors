## 2026-06-15 — Roadmap gap dedupe: Deterministic Shape gap renumbered G12→G15 (roadmap) — Refs #168

The roadmap contained two `### G12` headings introduced by separate PRs (#144 and #147), making gap
IDs non-unique and non-monotonic (sequence read G10, G11, G12, G12, G13, G14). No behavior change.

- The Deterministic Shape stage gap (originally G12 from #144) is **renumbered to G15** and
  **relocated** to appear after G14 (Interpret stage), making it the last gap in the sequence.
- The Scheduled-rollup Pace gap (#147) **retains G12**; G13 and G14 are unchanged.
- This file's reference to the Shape gap (the `Post-processing pipeline…` entry below) is updated
  from G12 to G15 to match.
- Gap IDs are now unique and monotonic: G10, G11, G12, G13, G14, G15.

Docs-only — no implementation or published-package behavior change, so no changeset.

