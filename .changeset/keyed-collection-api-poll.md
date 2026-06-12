---
'@agentmonitors/source-api-poll': minor
---

Support keyed-collection change detection (003 §12). Under `change-detection.strategy: json-diff`, a `collection: { path, key, ignore-paths }` block treats the response body as a collection of keyed objects and emits per-object `created` / `modified` / `descoped` observations with stable `<url>#<key>` ids, instead of one opaque "API response changed" blob. A re-sorted collection produces zero observations. The `collection` block requires `json-diff` and is rejected by `validate` under other strategies.
