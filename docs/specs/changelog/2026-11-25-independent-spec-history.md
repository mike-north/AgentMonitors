## 2026-11-25 — Independent specification history entries (004 §5, §6) — Refs #669

Specification changes now live in separate files under `docs/specs/changelog/`.
The stable index explains the authoring format and the on-demand assembly command.
Workspace validation rejects malformed entries, duplicate date/title pairs and
legacy additions to the index. Historical headings and bodies remain unchanged;
assembly sorts dates descending and retains filename order within each date.

