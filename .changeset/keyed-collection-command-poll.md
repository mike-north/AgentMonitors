---
'@agentmonitors/source-command-poll': minor
---

Support keyed-collection change detection (003 §12). Under `change-detection.strategy: json-diff`, a `collection: { path, key, ignore-paths }` block treats the command's stdout as a collection of keyed objects and emits per-object `created` / `modified` / `descoped` observations with stable `<objectKey>#<key>` ids, instead of one opaque "Command output changed" blob. A re-sorted collection produces zero observations. The `collection` block requires `json-diff` and is rejected by `validate` under other strategies.
