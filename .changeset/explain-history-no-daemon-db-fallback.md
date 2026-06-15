---
'@agentmonitors/cli': minor
---

`monitor explain` and `monitor history` now read the persisted SQLite store **in-process** when no daemon is reachable, instead of failing. Previously both were socket-only, so with no daemon running — including right after `daemon once` materialized events — they errored with a raw `connect ENOENT …`, and `monitor explain` reported a false `✗ Scheduling: failure` for a monitor that had actually fired. A read-only diagnosis tool must not require a live daemon.

On a genuine connection failure the CLI runs the same read-only diagnosis against the local DB and renders the real per-stage report, labeled with a banner ("No daemon running — showing persisted state from the last tick.") in text mode or a `notice` field in `--format json`. When the daemon is down **and** there is genuinely nothing persisted to read, it prints an actionable remediation line (start `agentmonitors daemon run`, or use `monitor test` for a one-shot) rather than a raw `ENOENT`. A daemon-side application error is still surfaced verbatim, never masked as "daemon not running".
