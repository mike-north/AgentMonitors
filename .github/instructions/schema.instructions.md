---
applyTo: 'libs/core/src/schema/**/*.ts,plugins/**/src/index.ts'
---

# Schema And Parser Parity Guidance

- The hand-authored JSON Schema and the runtime parser are two views of ONE
  contract. The Zod `monitorFrontmatterSchema` / each plugin's `parseScopeConfig`
  is the runtime parser; `generateMonitorSchema` / each plugin's `scopeSchema`
  (validated via `validateScope`) is the editor-tooling JSON Schema.
- A change to one view MUST be mirrored in the other. They must accept AND reject
  the same inputs — including required-field presence and blank/whitespace-only
  rejection — not merely overlap on the happy path.
- When you touch a Zod schema or a `parseScopeConfig`, update the corresponding
  `generateMonitorSchema` / `scopeSchema` in the same change (and vice versa).
  Past drift: `urgency` was made optional in the parser but stayed `required` in
  the JSON Schema; `scopeSchema` accepted whitespace-only / blank globs that
  `parseScopeConfig` rejects.
- New source plugins MUST ship a schema ↔ parser parity test (see
  `tests.instructions.md`): a shared corpus of `{ label, input, expectValid }`
  cases asserting the JSON-Schema verdict and the `parseScopeConfig` verdict
  agree for every case, including blank/whitespace and missing-field rejection.
