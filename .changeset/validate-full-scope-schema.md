---
'@mike-north/core': minor
---

Validate monitor `scope` against the full per-source JSON Schema, not just required-field presence. Adds an exported `validateScope(scope, scopeSchema)` helper that runs full draft-07 validation (types, enums, `items`, `required`, …); `agentmonitors validate` now rejects a scope like `{ globs: 42 }` that the old presence-only check accepted. The validator is `@cfworker/json-schema`, which walks the schema at runtime instead of compiling with the `Function` constructor, so it is safe under restrictive CSP / Workers-style environments.
