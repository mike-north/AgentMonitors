---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

`agentmonitors init <name> --type <source>` now accepts three optional seed flags that land
verbatim in the generated `MONITOR.md` frontmatter, instead of requiring a hand-edit afterward:

- `--glob <pattern>` (repeatable) seeds `watch.globs` for `file-fingerprint` or `watch.paths` for
  `incoming-changes`; rejected with a clear error for any other `--type` (those templates have no
  path-pattern list to seed).
- `--name <name>` seeds the frontmatter `name:` field.
- `--urgency <low|normal|high>` seeds the frontmatter `urgency:` field.

Every seeded scaffold still passes `agentmonitors validate`. Omitting all three flags leaves
`init <name>` byte-for-byte unchanged.
