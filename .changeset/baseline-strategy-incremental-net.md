---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Author-declared baseline strategy: `baseline-strategy: incremental | net` (roadmap G13)

A monitor may now declare a `baseline-strategy` frontmatter field that controls how the
per-recipient Diff stage spans a recipient's catch-up span (the observations that accumulated since
its baseline):

- `baseline-strategy: incremental` (**default**) — every observation in the span is delivered as its
  own ordered delta (play-by-play). This is the existing, backward-compatible behavior.
- `baseline-strategy: net` — the span is collapsed per object to a **single** net delta (the last
  observation of each object's run, diffed against the prior snapshot baseline); intermediate churn
  is discarded.

Omitting the field is equivalent to `incremental`, so existing monitors are unaffected.

- **core**: new optional schema field (`z.enum(['incremental', 'net']).default('incremental')`),
  surfaced on `MonitorFrontmatter` as `baselineStrategy`; new exported `BaselineStrategy` type; the
  runtime `ingest()` collapses the emitted catch-up span for `net`.
- **cli**: `agentmonitors validate` accepts `baseline-strategy: incremental | net` and rejects any
  other value.
