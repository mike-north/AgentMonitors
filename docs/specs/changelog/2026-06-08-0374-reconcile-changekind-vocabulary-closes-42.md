## 2026-06-08 — Reconcile `changeKind` vocabulary (closes #42)

The `changeKind` vocabulary is now canonical across the standard and the codebase. The
four values `created | modified | deleted | descoped` were already the implementation
contract in `libs/core/src/observation/types.ts`; this entry records the corresponding
update to the outward standard.

- `docs/standard/monitor-md-standard.md` §2: replaced the five-row table (which listed
  `appeared` and `elapsed`) with the four canonical values; folded "a new member of a
  collection/feed appeared" into the `created` row; removed the "being reconciled"
  caveat blockquote (the vocabularies now agree).
- `libs/core/src/observation/types.ts`: rewrote the `ChangeKind` doc-comment to make
  `created` and `descoped` crisply distinct. `created` = a new object or member entered
  the monitor's scope (including new items in a watched collection/feed); `descoped` =
  still exists upstream but left the monitor's scope (no information lost).
- No runtime behavior change — the type was already `created | modified | deleted | descoped`.

