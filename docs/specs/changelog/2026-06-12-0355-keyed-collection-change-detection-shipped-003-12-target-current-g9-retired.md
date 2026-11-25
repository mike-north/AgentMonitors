## 2026-06-12 — Keyed-collection change detection shipped (003 §12 target→current; G9 retired)

The `change-detection.collection` mode now turns a poll source's parsed JSON output into a
collection of keyed objects, promoting [003 §12](../003-source-plugins.md) from **target** to
**current** with `verified:` references.

- **Shared core helper.** The per-object diff is implemented **once** as `diffKeyedCollection`
  (`libs/core/src/observation/keyed-collection.ts`, exported from `libs/core/src/index.ts` alongside
  `parseKeyedCollectionConfig` and `resolveDottedPath`) and consumed by **both** `api-poll` and
  `command-poll`. The create/modified/descoped semantics are identical across the two sources;
  sharing the helper avoids a divergence risk that per-plugin copies would carry.
- **Semantics (§12 verbatim).** Each array element becomes a tracked object with
  `objectKey = <monitor-objectKey>#<key-value>`; per-object observations use the existing
  `ChangeKind` vocabulary — `created` (key appears), `modified` (present in both, content differs
  after `ignore-paths` removal), `descoped` (key disappears — never `deleted`). The baseline run
  records the keyed snapshot and emits nothing; reordering and whitespace are inherently ignored
  (comparison is per-key, not positional).
- **`path` syntax (resolving §12's open design point).** `path` is a **minimal `$.`-prefixed dotted
  path** (root `$`, then `.field` segments — `$.tasks`, `$.data.items`); no wildcards, indices,
  filters, or recursive descent. It MUST select exactly one array (a non-array/missing resolution is
  an error). `ignore-paths` entries use the same syntax, relative to each element.
- **BP3 rejection.** A `collection` block is only valid under `strategy: json-diff`. Under
  `text-diff`/`exit-code` (or a defaulted strategy) it is rejected by `agentmonitors validate` with
  `change-detection.collection requires strategy: json-diff` — enforced both by each source's
  generated schema (`if/then`) and by the shared `validate` path (for the actionable message).
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` (re-sorted → zero observations;
  one element changing → one `modified` with the keyed `objectKey`; addition → `created`; removal →
  `descoped`, not `deleted`; `ignore-paths` suppression; path-not-an-array error); per-source
  integration tests in `plugins/source-api-poll/src/index.test.ts` and
  `plugins/source-command-poll/src/index.test.ts`; and the `validate` rejection/acceptance tests in
  `apps/cli/src/commands/cli.integration.test.ts`. Roadmap **G9** retired.
- Minor changesets: `@agentmonitors/core` (new exported helper), `@agentmonitors/source-api-poll`
  and `@agentmonitors/source-command-poll` (new collection mode).

