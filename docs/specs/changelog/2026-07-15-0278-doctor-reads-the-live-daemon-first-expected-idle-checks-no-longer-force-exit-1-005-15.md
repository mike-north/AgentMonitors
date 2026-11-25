## 2026-07-15 — `doctor` reads the live daemon first; expected-idle checks no longer force exit 1 (005 §15) — Refs #373

Two bugfixes to `agentmonitors doctor`, both in 005 §15.

- **Transport (root cause of the under-reporting bug).** `doctor` previously read its per-monitor
  rollup **always** in-process (`doctorReportInProcess`), even when a live daemon was reachable. A
  separate SQLite reader connection opened fresh against the same on-disk file as a live writer's
  connection can observe that writer's commits with a lag — WAL visibility across processes is not
  the same immediacy guarantee same-connection reads get — so against a genuinely running daemon that
  had just materialized a real event, `doctor`'s rollup could freeze `last-observed`/`last-event` at
  an earlier tick and under-count `unread`/`claimed`/`acked`, while `events list`/`monitor history`
  (served straight from the live daemon's own connection) already showed the current, real state.
  Fixed by adding a `doctor.report` daemon-socket RPC method and preferring it whenever the daemon is
  reachable — mirroring the existing `monitor explain`/`monitor history` socket-first,
  in-process-fallback pattern — so the rollup is read from the exact connection that wrote the data.
  The in-process path (`doctorReportInProcess`) remains the fallback for when there genuinely is no
  live daemon to ask.
- **Exit-code semantics.** `daemon-reachable` and `lead-session` previously counted as `fail` even
  though both checks' own `detail` text (added by issue #331) already says failing is "expected when
  no agent session is currently open" — so a scripted/agent caller doing `agentmonitors doctor && …`
  treated a healthy idle workspace as broken. Both checks now use a new `idle` status (glyph `◇`,
  distinct from `pass` ✓ / `fail` ✗ / `skip` ○) instead of `fail` when they don't pass, and `idle`
  does not count toward the non-zero exit code — only a genuine `fail` does. Their remediation and
  "expected when idle" wording are unchanged; only the status classification and exit-code weight
  changed. Text/JSON summaries report a fourth `idle` count.
- **Verified by** `apps/cli/src/commands/cli.integration.test.ts` (`describe('doctor (issue #267)')`):
  a live-daemon test fires a real file-fingerprint change against a running daemon and asserts
  `doctor`'s JSON rollup (`lastObservedAt`/`lastEventAt`/`delivery.unread`) equals the newest rows
  from `monitor history`/`events list` for the same workspace; idle-only scenarios (daemon down, no
  lead session) assert exit 0 and the `◇`/`idle` status; a genuine failure (project not enabled)
  combined with idle checks still asserts exit 1, proving idle never masks a real problem.

