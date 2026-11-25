## 2026-11-03 — Nested worktrees stay out of the local gate (008 §10) — Refs #458

`pnpm check` could not pass in a main checkout holding worktrees under `.claude/worktrees/`. With 16
of them, `eslint .` ran out of memory at its 4 GB heap limit after 90 seconds, and `prettier --check .`
reported 372 files inside them, because anchored rules such as `apps/website/` do not reach a
worktree's copy. The directory was excluded only through `.git/info/exclude`, which neither tool reads.

- **008 §10 — extends "Local gate ≡ CI gate"** to these worktrees, and adds the guard to the test
  implications. CI has no such directory, so only asking the tools directly can catch a missing rule.
- **No change to what the gate checks inside a worktree.** A check run from a worktree's own root
  still covers that worktree; only a run from above it skips it.

