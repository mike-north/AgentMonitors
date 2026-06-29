---
'@agentmonitors/cli': patch
---

Use an upstream-safe command-poll scaffold.

`agentmonitors init --type command-poll` now scaffolds a `git ls-remote origin refs/heads/main`
`text-diff` monitor instead of a local `git status --porcelain` command, so the generated example
can watch remote branch tips without relying on stale local refs.
