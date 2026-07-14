---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
'agentmonitors': minor
---

DX papercut sweep from a blind DX study batch (S1 F3, S2 F4/F5, S5 F3/F4/F5/F7): help-text
precision, claimed-vs-unread clarity, branding consistency, and symmetric path-argument errors.

- **`events list` reports each event's delivery state.** `--unread` matches an unacknowledged
  event (002 §7), which includes events already claimed at a delivery lifecycle but not yet
  acknowledged — a surprise for a debugger reading "unread" as "never seen". Each returned event
  now carries a `deliveryState: 'unread' | 'claimed' | 'acknowledged'` field (new optional field on
  `@agentmonitors/core`'s `MonitorEventRecord`, present for the session-scoped `events list`
  query), and the CLI's text output gained a visible `deliveryState` column.
- **`session open --format id`** prints just the bare session id — no more hand-rolled
  JSON-parsing one-liner needed to pull `.id` out of a verification script.
- **`monitor test` given a directory now redirects to `agentmonitors validate`**, symmetric with
  `validate`'s existing redirect to `monitor test` for a single-file argument — instead of a raw
  `EISDIR` read error.
- **`agentmonitors init`'s bootstrap summary** no longer claims unconditionally that "monitoring
  starts automatically when you open a Claude Code session" — that's conditioned on the Claude Code
  plugin being present, with the manual `agentmonitors daemon run` alternative on the next line.
- **Required CLI options are now marked `(required)`** in their own `--help` output
  (`session open --host-session-id`, `events list`/`ack --session`,
  `hook claim --session`/`--lifecycle`).
- **The `agentmonitors doctor` banner** now reads `agentmonitors doctor`, matching the real
  invocation (and the same command's own remediation text elsewhere in its output), instead of the
  prose product name "AgentMon".
