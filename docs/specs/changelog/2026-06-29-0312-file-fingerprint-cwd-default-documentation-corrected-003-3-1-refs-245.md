## 2026-06-29 — `file-fingerprint` `cwd` default documentation corrected (003 §3.1) — Refs #245

Clarified that project-level `file-fingerprint` monitors default `cwd` to the workspace/config root,
not the monitors directory.

- **003 §3.1 — clarified.** When `cwd` is omitted, relative `globs` match project files under the
  workspace/config root (`ObservationContext.workspacePath`, the project directory containing
  `.claude`). Relative `cwd` values resolve against that root; absolute `cwd` values are used as-is.
- **Source schema/docs.** The `cwd` field description now exposes the default through
  `source list`, and the authoring guide no longer says "monitors root."

