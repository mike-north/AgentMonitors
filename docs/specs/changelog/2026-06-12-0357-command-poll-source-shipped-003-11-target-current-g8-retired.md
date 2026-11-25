## 2026-06-12 — `command-poll` source shipped (003 §11 target→current; G8 retired)

The local-process sibling of `api-poll` is now a bundled source, promoting
[003 §11](../003-source-plugins.md) from **target** to **current** with `verified:` references.

- **New package `@agentmonitors/source-command-poll`** implements §11.1–§11.6 verbatim: argv-only
  `command` spawned directly (`execFile`, `shell: false` — never a shell, so metacharacters pass
  through as literal arguments); `cwd`/`env`/`timeout`/`key`/`interval` scope; `text-diff` (default) /
  `json-diff` / `exit-code` strategies; a 1 MiB stdout cap marking `truncated: true` and diffing
  stably on the capped leading slice; SIGTERM→SIGKILL-after-5s timeout handling that leaves no orphan
  process; `stateful` baseline (first successful run records `{ stdout, exitCode }` and emits
  nothing); and transition-edge failure health (`ok ↔ failing` observations only on the edge — a
  nonzero exit **with** output is a result that gets diffed, while spawn failure and timeout are
  failures that keep prior state). `env` values are never written to any payload, snapshot, or state
  row.
- **Registered** via `registerCoreSources` (`apps/cli/src/sources.ts`) and scaffolded by
  `agentmonitors init --type command-poll` (`apps/cli/src/commands/init.ts`).
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the §11.7 list (no-shell
  metacharacter pass-through, per-strategy detection, nonzero-exit-is-a-result, spawn/timeout
  transition edges, env-not-persisted, 1 MiB stable truncation, no-orphan-on-timeout);
  `apps/cli/src/commands/cli.integration.test.ts` covers registration, the init template, and
  `validate` accepting/rejecting a `command-poll` monitor. Roadmap **G8** retired.
- Keyed-collection (§12) and the cursor protocol (§13) remain unbuilt targets (roadmap G9).
- Minor changesets: `@agentmonitors/source-command-poll` (new package) and `@agentmonitors/cli` (new
  source registered + init template).

