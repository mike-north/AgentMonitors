---
'@agentmonitors/core': minor
---

Add the deterministic **Shape** stage (roadmap G15): author-declared derived
facts, render-then-diff, and payload form.

- **New `shape` frontmatter** — `shape.derive` is an ordered list of named
  derived facts, each a CEL boolean predicate over `(snapshot, now)`; `shape.render`
  opts into rendering the shaped state to a stable, byte-identical text artifact.
  When `shape` is declared the runtime diffs **that artifact**, not the raw source
  (002 §1.1.4–§1.1.5).
- **New `payload` frontmatter** — `payload.form` is one of `prose | structured |
artifact | rendered` (a stable contract the follow-on Interpret stage builds on).
  For `form: structured` a turnkey `payload.transform` runs over the canonical JSON
  snapshot: `jq` reshapes the delivered payload; a `cel` gate of `false` suppresses
  delivery entirely (002 §1.1.6). A malformed transform fails `validate`.
- Derived facts are a pure function of `(snapshot, injected now)`; the only time
  input is the runtime-supplied tick clock, never an ambient `Date.now()`.

**New public API:** `PayloadForm`, `PayloadEncoding`, `ShapeConfig`,
`PayloadConfig`, `shapeSchema`, `payloadSchema`; `computeDerivedFacts`,
`renderArtifact`, `renderShapeArtifact`, `validateCelPredicate`; `applyPayloadTransform`,
`validatePayloadTransform`, `PayloadTransform`, `TransformLanguage`, `TransformOutcome`;
`shapeObservation`, `ShapeStageConfig`, `ShapedObservation`; `DerivedFact`,
`DerivedFactRule`.

The transform evaluator is CSP/Workers-safe — both `cel-js` (Chevrotain-based) and
`jq-in-the-browser` (a PEG parser-combinator) parse and interpret expressions
without the `Function` constructor or `eval` (the same constraint that drove
`@cfworker/json-schema` over `ajv`).

Fully backward compatible: a monitor with no `shape`/`payload` block behaves
exactly as before (raw `snapshotText` is the diff input).
