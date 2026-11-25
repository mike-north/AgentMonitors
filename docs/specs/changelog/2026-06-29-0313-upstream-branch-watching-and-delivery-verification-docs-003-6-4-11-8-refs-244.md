## 2026-06-29 — Upstream branch watching and delivery verification docs (003 §6.4, §11.8) — Refs #244

Documented the source-agnostic upstream-branch recipe and the end-to-end delivery verification path.

- **003 §11.8 — added.** `command-poll` with
  `git ls-remote origin refs/heads/<branch>` and `text-diff` is the recommended way to watch a
  remote branch tip without fetching or mutating local refs.
- **003 §6.4 — clarified.** `incoming-changes` observes local commit-graph advances after pull,
  merge, fast-forward, or local commit; it is not a remote-ahead detector.
- **Authoring docs/scaffold.** `authoring-monitors` now links `api-poll` and `command-poll` authors
  to the shared `.claude/agentmonitors.local.md` enable + `session start` + `hook deliver`
  verification recipe. The `command-poll` init template now uses the upstream-safe `git ls-remote`
  example instead of a local `git status --porcelain` command.

