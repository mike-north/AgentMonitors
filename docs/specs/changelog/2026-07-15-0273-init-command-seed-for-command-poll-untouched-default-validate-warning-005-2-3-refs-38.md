## 2026-07-15 — `init --command` seed for command-poll + untouched-default `validate` warning (005 §2, §3) — Refs #388

`init <name> --type command-poll` always scaffolded the fixed default command `git ls-remote origin
refs/heads/main`, regardless of the author's intent. Because that default still **validates** and
still **runs**, a scaffold left untouched silently watched the wrong thing for any other intent
(e.g. an author wanting "uncommitted changes" — `git status --porcelain`) — worse than a hard
failure, which is at least visible (blind usability evaluation, issue #388).

- **005 §2 — new `--command` seed flag.** Mirrors `--glob`: repeatable, scaffold-form only, seeds
  `watch.command` **one argv token per flag, order-preserving** (`--command git --command status
--command --porcelain` → `command: [git, status, --porcelain]`). Each token is emitted as a
  single-quoted YAML scalar so leading-dash tokens / spaces / `#` / `:` round-trip verbatim; the CLI
  never whitespace-splits, so it never invents shell semantics the source lacks (spec 003
  command-poll is argv, no shell). Rejected for any `--type` other than `command-poll` with a clear
  stderr message and no directory created, mirroring `--glob`'s guard.
- **005 §2/§3 — untouched-default is no longer a silent trap.** The template keeps the illustrative
  upstream-tip default when `--command` is omitted (so it still validates and runs), but `validate`
  now emits a **soft, non-fatal warning** for a `command-poll` monitor whose `watch.command` still
  equals the exact untouched default. The warning does not change the valid/invalid counts or the
  exit code; it is safe to ignore when upstream-tip polling is the real intent.
- **005 §3 — additive `warnings` output.** Text output gains an optional `Warnings: <n>` section
  (omitted when empty); JSON output gains a `warnings: [{ id, warning }]` array (`[]` when none).
  Additive only — the valid/invalid counts, exit code, and existing JSON keys are unchanged, so
  existing consumers are unaffected.

