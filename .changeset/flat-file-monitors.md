---
'@mike-north/core': minor
---

Author monitors as flat `.claude/monitors/<id>.md` files (id derived from the filename), in addition to the folder form `<id>/MONITOR.md`. The scanner discovers both forms (markdown assets nested inside a folder monitor are ignored), and frontmatter `name` is now optional, defaulting to the monitor id.
