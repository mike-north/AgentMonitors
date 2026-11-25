## 2026-06-12 — Keyed-collection paths accept bare dotted authoring form (003 §12)

Resolved an authoring compatibility gap in [003 §12](../003-source-plugins.md): keyed-collection
`path` and `ignore-paths` now accept either explicit-root dotted paths (`$.items`, `$.duration`) or
bare root-relative dotted paths (`items`, `duration`). The two forms are equivalent. This preserves
the original minimal dotted grammar (no wildcards, array indices, filters, or recursive descent)
while matching the monitor-author shorthand used in real `command-poll` configurations.

- **Behavior:** `change-detection.collection.path: items` now resolves to the root `items` array and
  emits per-object `modified`/`created`/`descoped` observations the same way `$.items` does.
  `ignore-paths: [duration]` is treated as element-relative `$.duration`.
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` covers bare `path` and
  `ignore-paths`; `plugins/source-command-poll/src/index.test.ts` covers the issue #105
  modify/create/descope sequence with `path: items`.

