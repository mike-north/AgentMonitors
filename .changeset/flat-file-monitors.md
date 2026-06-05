---
'@mike-north/core': minor
---

Author monitors as flat `.claude/monitors/<id>.md` files (id derived from the filename), in addition to the folder form `<id>/MONITOR.md`. The scanner discovers both forms (markdown assets nested inside a folder monitor are ignored). Frontmatter `name` is now optional; `MonitorDefinition` gains a `displayName` field that resolves to the frontmatter name when present, or the monitor id when omitted.
