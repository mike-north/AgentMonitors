---
'@agentmonitors/core': minor
---

Export `baselineStrategyValues` (backing `BaselineStrategy`) and `inboxItemState` (backing
`InboxItemState`) from the package entry point.

These consts already backed already-public types via `typeof X[number]`, but were not themselves
reachable from `index.ts` — a real "forgotten export" gap surfaced by enabling API Extractor's
report generation (issue #285), which otherwise embeds an `ae-forgotten-export` warning banner
into the checked-in API report instead of a clean signature. No runtime behavior changes.
