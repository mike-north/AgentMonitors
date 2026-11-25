## 2026-07-19 — Composite byte-budget exact-render check and Unicode-code-point `id`-length parity (003 §4.9) — Refs #304

Fourth round of review follow-ups on the #304 bounds, in the same PR before merge, closing two gaps
left open by the round below.

- **The cumulative byte budget still undercounted the final artifact.** `framedPartByteLength`
  tallies each part's framed section (`## <id>\n<body>`) as it is observed, but
  `renderCompositeSnapshot` also inserts `\n\n` separators between sections when assembling the
  final artifact — bytes the running per-part tally never counted. A reviewer reproduced the gap
  directly against the real helpers: a fixture built to sit exactly at the 10 MiB budget by the
  summed-helper math rendered to 10,485,762 bytes against the running tally's 10,485,760, a 2-byte
  (98 bytes at the 50-part cap) undercount that let an over-budget composite through.
  `observeComposite` now performs a final `Buffer.byteLength` check on the actual rendered artifact
  (separators included) before accepting the observation — exact regardless of part order or count
  — and the boundary fixtures were re-derived to assert the final RENDERED byte length at and one
  byte over the budget, not the pre-render running tally.
- **The part-`id` length check counted UTF-16 code units, not Unicode code points**, while the
  JSON Schema `maxLength` keyword (and `agentmonitors validate`) counts code points — so a
  200-emoji `id` (200 code points, `id.length === 400` in UTF-16) passed schema validation and then
  was wrongly rejected by `source.observe`, an authoring-time-green/runtime-red split. The parser
  now counts code points (`Array.from(id).length`) to match the schema's `ucs2length` semantics; new
  parity tests cover a 200-emoji `id` accepted by both surfaces and a 257-code-point `id` rejected
  at the boundary by both.

(Verified: `plugins/source-api-poll/src/composite.ts`, `renderCompositeSnapshot`;
`plugins/source-api-poll/src/index.ts`, `observeComposite`; `plugins/source-api-poll/src/index.test.ts`,
"a composite whose cumulative RENDERED bytes sit exactly at the budget succeeds (boundary)",
"parseCompositeConfig counts part ids in Unicode code points, not UTF-16 code units (astral emoji)",
"parseCompositeConfig rejects an id with one more than MAX_PART_ID_LENGTH emoji code points (astral
boundary)".)

