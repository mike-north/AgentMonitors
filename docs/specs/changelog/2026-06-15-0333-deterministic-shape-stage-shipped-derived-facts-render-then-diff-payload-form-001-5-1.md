## 2026-06-15 — Deterministic Shape stage shipped: derived facts + render-then-diff + payload form (001 §5.1–§5.2; 002 §1.1.4–§1.1.6; 003 §2.7; roadmap G15) — Refs #172

Implements roadmap **G15**, moving the deterministic Shape stage from _target_ to _current_.

- **001 §5.1 — Shape declaration (current).** The `shape` frontmatter field is accepted by the
  schema: `shape.derive` is an ordered list of `{ name, when }` derived-fact rules whose `when` is a
  CEL boolean predicate over `(snapshot, now)`; `shape.render: rendered` opts into the diffable
  artifact. A malformed CEL predicate is rejected at validate. Statically rejecting a predicate that
  _references an identifier outside `(snapshot, now)`_ remains **target** (CEL is structurally pure,
  so determinism holds regardless; such a reference evaluates to "fact does not hold").

- **001 §5.2 — Payload form (current).** The `payload` frontmatter field is accepted: `payload.form`
  is `prose | structured | artifact | rendered`, exported as the stable named type `PayloadForm`
  (a contract the follow-on G14 Interpret stage builds on). For `form: structured`, `payload.transform`
  runs a `jq` reshape or a `cel` gate over the canonical JSON snapshot; a transform under any other
  form, a malformed `jq`/`cel` expression, or an unknown form/language/encoding is rejected.

- **002 §1.1.4 — derived facts (current).** Computed as a pure function of `(shaped snapshot, injected
now)` on the shared side of the seam, before Pace and Diff. `now` is the injected tick clock, never
  an ambient `Date.now()`.

- **002 §1.1.5 — render-then-diff (current).** When `shape` is declared, the runtime renders the
  shaped state (snapshot + facts) to a byte-stable, markdown-ish artifact and diffs **that artifact**,
  not the raw source. The same shaped state renders byte-identically (no phantom diff); a newly-held
  fact is exactly one added line.

- **002 §1.1.6 — payload form (current).** `jq` reshapes the delivered payload; a `cel` gate of
  `false` **suppresses delivery entirely** (no event materialized). The optional Interpret stage that
  `prose` invokes remains **target** (§1.1.8, G14).

- **003 §2.7 — sources surface raw facts (current).** A source surfaces raw timestamps/fields; the
  runtime Shape stage derives the relative facts against `now`.

**Transform evaluator (CSP/Workers-safe).** Both `cel-js` (Chevrotain parser/interpreter) and
`jq-in-the-browser` (PEG parser-combinator) evaluate expressions without the `Function` constructor
or `eval` — the same constraint that drove `@cfworker/json-schema` over `ajv`. `jq-in-the-browser`
implements a practical jq subset (explicit object keys, `map(...)` for array collection); the §5.2
example is updated to that syntax.

Implementation + published-package behavior change — `@agentmonitors/core` minor changeset added.
Refs #172.

