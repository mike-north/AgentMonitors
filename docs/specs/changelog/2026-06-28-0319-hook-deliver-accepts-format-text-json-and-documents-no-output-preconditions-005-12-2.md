## 2026-06-28 — `hook deliver` accepts `--format text|json` and documents no-output preconditions (005 §12.2, 006 §5) — Refs #203

`agentmonitors hook deliver` now accepts the same `--format text|json` shape as the sibling
hook-delivery inspection command while preserving the installed hook wire behavior by default.

- **005 §12.2 — clarified.** The command reference now lists `--format <format>`, explains that the
  omitted/default format and `--format json` emit compact Claude Code hook wire JSON, and documents
  `--format text` as an inspection mode that prints only the rendered `additionalContext`.
- **005 §12.2 / CLI help — clarified.** Emission preconditions are explicit: an enabled project, a
  per-workspace socket in `.claude/agentmonitors.local.md` or `--socket`, a reachable daemon, and a
  matching tracked session. Empty output means nothing is pending or the workspace/session is not
  configured.
- **006 §5.1-§5.3 — clarified.** Hook registration continues to use the default/json wire object, all
  no-op paths remain empty stdout + exit 0, and `--format text` is only for manual inspection.

The always-exit-0 hook safety contract is unchanged. Affects published-package behavior
(`@agentmonitors/cli`), so a changeset accompanies this change.

