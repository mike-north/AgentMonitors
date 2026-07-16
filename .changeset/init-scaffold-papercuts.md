---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fixed two `agentmonitors init <name>` scaffold papercuts (issue #375):

- When `--name` is omitted, the scaffolded `name:` frontmatter field now derives from the
  positional `<name>` argument (e.g. `watch-docs` → `Watch docs`) instead of surviving as the
  template's literal placeholder (`My monitor`, `Upstream branch monitor`, etc.) — a rushed author
  could otherwise commit a monitor that was never renamed. `--name` still overrides.
- The `command-poll` scaffold's inline comment no longer warns that local commands "such as
  `git status`" can stay stale until a fetch — that caveat applies only to a local read of a
  remote-tracking ref (e.g. `git rev-parse origin/main`). The scaffold's own `git ls-remote`
  queries the remote live and is always current, and `git status --porcelain` is local
  working-tree state with no fetch lag either. The previous wording contradicted the `skill.md`
  authoring guide's own recommended minimal `command-poll` example (`git status --porcelain`),
  leaving a new author unsure which to trust.
