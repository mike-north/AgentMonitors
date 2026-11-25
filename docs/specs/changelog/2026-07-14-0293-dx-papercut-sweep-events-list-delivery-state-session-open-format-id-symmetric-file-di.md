## 2026-07-14 — DX papercut sweep: `events list` delivery state, `session open --format id`, symmetric file/directory redirects, bootstrap wording (005 §2, §6, §10.1, §11.1) — Refs #338

A blind DX study batch (S1 F3, S2 F4/F5, S5 F3/F4/F5/F7) found five small, independently-minor
frictions in CLI output and help text.

- **005 §11.1 — clarified (current).** `events list --unread` filters on an unacknowledged event
  (`acknowledgedAt IS NULL`, 002 §7), which **includes** claimed-but-unacknowledged events — a
  surprise for a debugger reading "unread" as "never seen" (S1 F3). Each returned
  `MonitorEventRecord` now carries an optional
  `deliveryState: 'unread' | 'claimed' | 'acknowledged'` field (only present for the session-scoped
  `events list` query) so a caller can tell the two apart; the CLI's text output gained a visible
  `deliveryState` column.
- **005 §10.1 — new `--format id` choice (current).** `session open --format id` prints just the
  bare session id — no JSON parsing needed to pull `.id` out of the `--format json` payload in a
  verification script (S2 F4).
- **005 §6, §3 — cross-referenced (current).** `monitor test` (a single-file command) given a
  directory now redirects to `agentmonitors validate`, symmetric with `validate`'s existing
  file-argument redirect to `monitor test` (S5 F3); previously it surfaced a raw `EISDIR` error.
- **005 §2 — reworded (current).** The bootstrap's "what happens next" summary no longer claims
  unconditionally that "monitoring starts automatically when you open a Claude Code session" (S5
  F5) — that's true only with the Claude Code plugin installed. It's now conditioned on the plugin
  being present, with the manual `agentmonitors daemon run` alternative stated on the next line.
- **Not a spec change — CLI-only:** required options (`session open --host-session-id`,
  `events list`/`ack --session`, `hook claim --session`/`--lifecycle`) now render `(required)` in
  their own `--help` description text (S5 F4); the `agentmonitors doctor` text-output banner now reads
  `agentmonitors doctor` instead of `AgentMon doctor`, matching the same command's own remediation
  text elsewhere in its output (S5 F7 — "AgentMon" stays the prose product name, never a command
  reference).
- **Verified, not changed:** S2 F5's "`command-poll` baselines on the first tick, detects on the
  second" claim (skill.md) is accurate for a fresh runtime database. The one observed run that
  contradicted it traced to the verification recipe reusing one database across runs
  (`daemon run`/`daemon once` defaulted to the machine-wide `~/.local/share/agentmonitors/inbox.db`
  at the time; since #349 they derive a per-workspace path, which reruns in the same directory
  still share) rather than a source-source bug; the recipe now exports an isolated
  `AGENTMONITORS_DB` per run, matching the pattern already used for its throwaway `$SOCKET`.

