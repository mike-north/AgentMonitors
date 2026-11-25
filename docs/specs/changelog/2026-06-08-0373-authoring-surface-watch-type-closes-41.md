## 2026-06-08 — Authoring surface → `watch: { type }` (closes #41)

Replace the mechanism-first `source:` + `scope:` frontmatter pair with an
intent-first `watch:` block carrying an explicit `type` discriminator. This is a
**hard cut** — the old `source:`/`scope:` shape no longer validates.

### New canonical shape

```yaml
name: ...               # optional, unchanged
watch:
  type: <source-name>   # e.g. file-fingerprint, api-poll, schedule, incoming-changes
  <...per-source config flat here...>
urgency: normal         # unchanged
notify: {...}           # optional, unchanged
tags: [...]             # optional, unchanged
```

Per-source config keys (including `interval`) live **flat inside `watch:`** as
siblings of `type`. There is no nested `scope:` object.

### Files changed

- `libs/core/src/schema/monitor-schema.ts`: replaced `source` (string) + `scope`
  (record) with `watch` (object with validated `type` + `.catchall(z.unknown())`
  for per-source config).
- `libs/core/src/runtime/service.ts`: all `frontmatter.source` → `frontmatter.watch.type`;
  all `frontmatter.scope` → `watchConfig(frontmatter.watch)` (helper that returns the
  `watch` block minus `type`).
- `libs/core/src/schema/validate-scope.ts`: unchanged — callers now pass the watch config
  object (watch minus type) instead of `scope`.
- `libs/core/src/observation/schema-generator.ts`: updated to discriminate on
  `watch.type` instead of `source`; required fields are now `['watch', 'urgency']`.
- `apps/cli/src/commands/init.ts`: all templates rewritten to `watch:` shape; `--source`
  option renamed to `--type`.
- `apps/cli/src/commands/validate.ts`, `scan.ts`, `monitor-test.ts`: updated to read
  `frontmatter.watch.type` instead of `frontmatter.source` and pass watch config to
  `validateScope`.
- `.claude/monitors/spec-changes/MONITOR.md`: dogfood monitor converted to `watch:` shape.
- All test fixtures in `libs/core/src/` and `apps/cli/src/` updated.
- `docs/specs/001-monitor-definition.md` §3 updated to document `watch:` block.

### api-extractor

`monitorFrontmatterSchema` and `MonitorFrontmatter` public API changed; report
regenerated.

