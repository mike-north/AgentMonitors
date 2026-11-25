## 2026-06-12 — Clarify source config wording and old-shape validation hints (003 §7.3, 004 §2.1–§2.3/§3.5, 005 §3/§7.1)

Issue #92 resolves the remaining author-facing ambiguity after the `watch: { type, ... }` migration.
`source list` text now says `Config fields` instead of `Scope fields`, JSON output includes
`configFields` while keeping `scopeFields` as a backwards-compatible alias, and `validate` appends a
targeted hint when a monitor still uses the old top-level `source:` + `scope:` shape. The specs now
distinguish the plugin API term `scopeSchema` from the authoring surface: source config is written
flat inside `watch:` alongside `type`.

- CLI behavior/docs/tests; patch changeset for `@agentmonitors/cli`.

---

