## 2026-06-29 — `file-fingerprint` bare-string `ignore` shorthand (003 §3.1) — Refs #241

`file-fingerprint` now accepts `ignore` as either a bare string or a string array, matching the
existing `globs` shorthand.

- **003 §3.1 — clarified.** A single exclude glob may be written as `ignore: '**/x.txt'` and is
  normalized to the same internal `string[]` representation as `ignore: ['**/x.txt']`.

- **Parser/schema parity.** Both `parseScopeConfig` and `scopeSchema` accept the string form and
  still reject blank or whitespace-only patterns. `schema-parity.test.ts` pins the accepted
  bare-string case and rejected blank-string case.

