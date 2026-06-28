---
applyTo: '**/*.test.ts'
---

# Test Guidance

- Prefer behavior-oriented tests that model real daemon, CLI, adapter, and
  session flows.
- Test restart safety, session isolation, unread projection behavior,
  debounce/coalescing behavior, and recap semantics.
- Avoid sleep-heavy timing tests when explicit clock or state control is
  possible.
- Docker-backed tests are useful when they model a realistic home directory and
  installed-tool environment, but they should stay deterministic and narrowly
  scoped.
- If a change affects persistence or delivery policy, add coverage that would
  fail on regression across restart or replay scenarios.
- Some skill / README / spec content is guarded by content-assertion tests (e.g.
  `apps/cli/src/agent-plugin-skill.test.ts`). When you change guarded content,
  update the guard to assert the INTENDED new content (spec-first). Never loosen
  a guard just to make it pass, and never let a content rewrite silently drop a
  guaranteed string the guard existed to protect.
- New source plugins require a schema ↔ parser parity test (see
  `schema.instructions.md`): a shared `{ label, input, expectValid }` corpus
  asserting the JSON-Schema verdict (`validateScope`) and the `parseScopeConfig`
  verdict agree for every case, including blank/whitespace and missing-field
  rejection. See `plugins/source-file-fingerprint/src/schema-parity.test.ts`.
