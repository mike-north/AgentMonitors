## 2026-06-15 — `monitor explain` / `monitor history` read the persisted DB in-process when no daemon is running (005 §6, 002 §10.7, #150)

`monitor explain` and `monitor history` were socket-only: with no daemon running — including right
after `daemon once` materialized events — both failed, and `monitor explain` reported a false
`✗ Scheduling: failure` for a monitor that had actually fired. On a genuine `DaemonConnectionError`
the CLI now runs the same read-only `explainMonitor` / `listObservationHistory` **in-process**
against the persisted SQLite store (the `daemon once` pattern) and renders the real diagnosis,
prefixed with the banner _"No daemon running — showing persisted state from the last tick."_ (text)
or annotated with a `"notice"` field (JSON). Only when the daemon is down **and** there is genuinely
nothing persisted (no `observation_history` and no `monitor_events` rows) does the CLI print an
actionable remediation line (`agentmonitors daemon run`, or `monitor test` for a one-shot) instead
of a raw `connect ENOENT …`. A daemon-side application error is still surfaced verbatim, never masked
as "daemon not running" (the #94/#98 distinction holds).

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('monitor explain / history
without a live daemon (issue #150)')`: after `daemon once` with no daemon, `monitor explain` shows
  the real diagnosis + banner and **no** false scheduling failure (text and `--format json`);
  `monitor history` returns the persisted rows; daemon-down-with-nothing-persisted yields the
  remediation message, not an `ENOENT`.
- Minor changeset: `@agentmonitors/cli` (CLI behavior change; no core public-surface change).
- Refs: issue #150 (relates to #94, #149).

