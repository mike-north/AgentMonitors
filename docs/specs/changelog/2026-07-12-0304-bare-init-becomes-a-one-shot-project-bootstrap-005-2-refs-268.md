## 2026-07-12 — Bare `init` becomes a one-shot project bootstrap (005 §2) — Refs #268

`init <name>` only scaffolded a `MONITOR.md`; onboarding still required hand-creating
`.claude/agentmonitors.local.md` with `enabled: true`, fixing `.gitignore`, and knowing to do both
— steps documented only in the `setup-monitors` skill. Since time-to-first-signal is the product's
core adoption metric, that manual gap is now automated.

- **005 §2 — extended (current).** The section is now "Bootstrap the project, or scaffold a
  monitor". The `<name>` argument is documented as optional: with a name, `init` keeps its exact
  prior scaffold behavior (byte-for-byte); with no name, `init` runs a bootstrap that (1) enables
  the project using the skill's minimal `enabled: true` shape, (2) ensures `.gitignore` ignores
  `.claude/*.local.*`, (3) optionally scaffolds a first monitor (interactive on a TTY, `--yes`
  non-interactively, `--enable-only` to skip), (4) validates the result in-process, and (5) prints
  a next-steps + verify-firing summary. Added the `--enable-only` and `--yes` flags to the flag
  table and an idempotency note (a re-run on an already-set-up project changes nothing).
- **Non-goals (unchanged behavior):** no host-plugin install, no daemon start/persistence (lazy
  boot via `session start` already covers it — §10.4), no MCP, no changes to the monitor schema or
  the `validate` command. `init <name> --type …` output is unchanged.

