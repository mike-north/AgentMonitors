## 2026-07-18 — `json-diff` renders a structural `diffText`, not a text line diff (002 §5.2, 003 §4.2/§11.3) — Refs #437

Dogfood observation: a `command-poll` monitor with `change-detection: json-diff` watched
`gh pr list --json`, whose output is compact single-line JSON. When one array element changed (a PR
merged out of the list), `diffText` was a `buildTextDiff` line diff of the two ~700-char lines — the
entire array serialized onto one line each — so the delta rendered as remove-everything/add-everything.
The `json-diff` **strategy** correctly detected the change (it parses both sides as JSON and compares
structurally, per the existing `hasChanged` semantics); the rendered `diffText` was throwing that
structure away by always going through the line-level renderer regardless of strategy.

Fixed by making the runtime's diff renderer strategy-aware: `buildDiff(previous, current, strategy)`
(new, `libs/core/src/runtime/diff.ts`) reads the object's `change-detection.strategy` off the
observation's persisted `snapshot`/`snapshotMetadata` (`changeDetectionStrategyOf`) and dispatches to
`buildJsonDiff` for `strategy: json-diff`, falling back to the existing `buildTextDiff` for every
other strategy (including omitted) and whenever either side fails to parse as JSON — mirroring each
`json-diff` source's own `hasChanged` fallback so the renderer never disagrees with the strategy that
decided a change occurred. `buildJsonDiff` renders added/removed/changed elements or key paths,
diffing arrays of objects by a stable-key heuristic first (`id`/`key`/`uuid`/`_id`/`slug`/`sha`/
`number`/`name`, whichever is a unique scalar on every element of both sides), then whole-element
deep-equality matching when no such field exists, and index-based positional diffing for arrays of
non-object elements — bounded to 20 diff entries (an explicit `… N more changes elided` marker beyond
that, mirroring `buildTextDiff`'s existing 20-line cap) with each rendered value truncated at 300
characters, since this text reaches LLM context windows. All three `diffText` computation sites
(`processObservation`'s shared event diff, `insertEvent`'s per-recipient diff, and
`collapseNetForClaim`'s net-collapse recompute) now call `buildDiff` instead of `buildTextDiff`
directly. `buildTextDiff` itself is unchanged — every non-`json-diff` object renders byte-identically
to before.

002 §5.2 and 003 §4.2/§11.3 now document the renderer split; `buildDiff` is newly exported from
`@agentmonitors/core` (`buildJsonDiff` is module-internal, not part of the public API surface).

**Follow-up (same PR, review fix):** the stable-key and deep-equality array matchers used by
`buildJsonDiff` are themselves order-insensitive (they match by key/content, not position), but
`hasChanged` (003 §4.2/§11.3) is array-order-**sensitive** (it sorts object keys, never array
elements) — so a pure element reorder is a real detected change. The matchers now fall back to an
explicit `reordered` entry when they find no other diff, preserving the invariant "change detected ⟺
non-empty `diffText`" instead of silently rendering an empty diff for a change that was actually
observed. `diffJsonArrayByDeepEquality` also now threads the caller's field path through (previously
hardcoded to the array's own top level), so a nested array's removed/added entries keep their
location context.

**Follow-up (review round 2):** three additional defects in the structural renderer, found by review
and empirical repro:

- **Untrusted content in rendered paths (002 §5.2).** An object key or identity-key value is
  attacker/source-controlled JSON content, but was interpolated into the rendered path verbatim — a
  100,000-char `id` produced a 100,345-char one-entry diff (bypassing the documented 20-entry/
  300-char bounds), and an `id` containing a newline fabricated a fake second diff line. `diff.ts`
  now bounds every path segment to 60 chars and backslash-escapes path-syntax characters (`.`, `[`,
  `]`, `=`, `\`) and control characters (including the newline case) before interpolation, and adds a
  final 20,000-char cap over the fully-rendered `diffText` as a last-resort backstop. A field literally
  named `[x]` (previously indistinguishable from `[index]`/`[key=value]` array-element syntax) is now
  escaped to `\[x\]`. `renderJsonValue`'s existing 300-char truncation now cuts at a code-point
  boundary instead of a raw UTF-16 index, so an astral (surrogate-pair) character can no longer be
  split into a lone surrogate.
- **Quadratic no-identity array matching (002 §5.2).** `diffJsonArrayByDeepEquality` did a full
  `JSON.stringify(sortKeysDeep(...))` of both elements per probe — `O(N*M)` — making a reversed
  5,000-element array take roughly 1.5s of synchronous daemon-tick time. It now canonicalizes each
  element exactly once and matches via a counted multiset (`O(N+M)`). `deepEqualJson` no longer
  serializes whole subtrees at all (a genuine recursive structural comparison, short-circuiting on
  the first difference instead of re-canonicalizing every ancestor subtree at every recursion level),
  and the canonicalization helper now reuses `sortKeys` from `observation/keyed-collection.ts` instead
  of a duplicate copy. The unbounded entry list is no longer materialized before the 20-entry render
  cap: a small `DiffEntrySink` stops storing past `cap + 1` while still counting every entry the
  traversal visits, so the elision-count line stays exact.
- **Totality: a deeply nested JSON body could throw an uncaught `RangeError` (002 §5.2, ingest
  path).** `buildJsonDiff`'s try/catch covered only the two `JSON.parse` calls; the recursive
  traversal ran OUTSIDE it and stack-overflowed around 2,500 nesting levels (`JSON.parse` itself
  tolerates roughly 4.2M) — every `diffText` call site (`processObservation`, `insertEvent`,
  `collapseNetForClaim`) would have thrown instead of falling back to `buildTextDiff`, silently
  losing the event on the ingest path. `buildJsonDiff` now catches `RangeError` around the traversal
  and returns `undefined`, restoring the documented "falls back to `buildTextDiff`" totality.
- **Empty per-recipient diff for a formatting-only change.** Two byte-different snapshots that are
  structurally equal (key order/whitespace differ only) previously rendered `''` under `json-diff` —
  violating "change detected ⟺ non-empty `diffText`" wherever a caller (e.g. a stale per-recipient
  cursor) treats a byte-different snapshot as a real change. `buildJsonDiff` now renders
  `~ formatting-only change (no structural difference)` instead of the empty string in that case.

`buildDiff`'s `strategy` parameter is now the named `ChangeDetectionStrategy` union (`'json-diff' |
'text-diff' | 'exit-code' | 'status-code' | (string & {})`, exported from `@agentmonitors/core`)
instead of a bare `string`, since it is part of the curated public API surface. `sortKeys` is now
exported from `observation/keyed-collection.ts` (core-internal; not re-exported from `index.ts`) so
`diff.ts` can reuse it instead of duplicating it.

