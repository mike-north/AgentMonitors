## 2026-06-04 — Flat-file monitor authoring; `name` optional

- Monitors may now be authored as a flat `.claude/monitors/<id>.md` file (id = filename), in
  addition to the folder form `<id>/MONITOR.md` (id = directory). The scanner discovers both;
  markdown assets nested inside a folder monitor are not treated as monitors
  ([001 §scanning](./001-monitor-definition.md)). Verified: `parse-monitor.ts` id derivation and
  `scan-monitors.ts` combined glob.
- `name` is now **optional** in frontmatter and defaults to the monitor id. Minor
  `@agentmonitors/core` changeset.

