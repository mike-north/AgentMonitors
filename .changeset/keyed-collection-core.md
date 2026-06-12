---
'@agentmonitors/core': minor
---

Add keyed-collection change detection (003 §12) as a shared, exported helper. `diffKeyedCollection` (with `parseKeyedCollectionConfig` and `resolveDottedPath`) treats a parsed JSON output as a collection of keyed objects and emits per-object `created` / `modified` / `descoped` observations with stable `<monitor-objectKey>#<key>` ids — the baseline run records the keyed snapshot and emits nothing, reordering and whitespace are inherently ignored, and `ignore-paths` strips churn fields before comparison. `path` is a minimal `$.`-dotted path that must select exactly one array. The helper is source-agnostic so `api-poll` and `command-poll` share one implementation.
