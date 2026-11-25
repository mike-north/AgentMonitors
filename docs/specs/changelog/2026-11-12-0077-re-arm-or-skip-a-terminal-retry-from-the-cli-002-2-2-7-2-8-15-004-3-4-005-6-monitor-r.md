## 2026-11-12 — Re-arm or skip a terminal retry from the CLI (002 §2/§2.7/§2.8/§15; 004 §3.4; 005 §6 `monitor retry`, §15) — Refs #584

A terminal materialization retry pauses its monitor (§2.7), and until now the only way out was
editing the store by hand. Add two operator repairs, `agentmonitors monitor retry rearm
<monitorId> <retryId>` and `agentmonitors monitor retry skip <monitorId> <retryId> [--reason]`,
backed by `AgentMonitorRuntime.rearmMaterializationRetry` / `skipMaterializationRetry` and the
daemon methods `retry.rearm` / `retry.skip`, with an in-process fallback when no daemon is
reachable. They name a retry as retry diagnostics list it and refuse, unchanged, a retry that is
not terminal or does not belong to the named workspace/monitor. Re-arm returns the row to
`pending` with its attempts reset (the existing store transition). Skip records the observation as
an outstanding loss through the one loss record every drop uses (§2), with its own `skipped: true`
marker and an error of the retry's last error followed by
`Retry skipped after <n> failed attempts[: <reason>].`, and deletes the row in the same
transaction. The loss is superseded like any drop, measured from the retry's own admission
position, so younger retained work for the same key clears it.
A repair wakes a watcher of that monitor paused in the same process. The tick report, the explain
materialization reason and the `doctor` remediation for a stopped monitor now name both commands;
`doctor` previously said the CLI had no retry action. Attempt limit and backoff are unchanged.
The CLI falls back in-process only when no daemon accepted the connection; once a daemon has the
request, a missing reply (a 15-second wait, which covers both the daemon's own tick and the repair
each waiting up to the store's 5-second lock timeout, or a dropped connection) is reported as an
unknown outcome with nothing written, since the daemon may already have applied it or may still
apply it. A daemon blocked on a lock for longer than the wait can apply the repair after the CLI has
given up. A skip's `--reason` is at most 200 characters after trimming (a longer one
is refused), so the skip note and reason always survive the diagnostic cap and only a long last
error is shortened, with `…`. The skip's `monitor explain` hint is quoted and `--workspace`-scoped
like `doctor`'s remediation commands.

With 002 §2.8's verify-artifact ownership, a terminal retry whose observation is a verify artifact
with cleanup authority in effect is not lost work: either repair removes it through the ownership
discard (the same predicate, inside the repair's own immediate transaction) and records no loss and
no `errored` row, re-arm never re-arms it, and the command reports the outcome
`verify-artifact-cleanup` (002 §2.7 "Operator repair", §2.8 boundary 3; 005 `monitor retry`).
Recording a loss there would have left `doctor` and `explain` reporting it forever, since every
later observation of the scratch key is dropped and none could supersede it. Both repairs now return
`MaterializationRetryRepairResult` (`outcome` plus the retry's safe metadata), and the CLI's JSON
output carries `outcome`.

The daemon client now settles when a daemon closes the connection without replying, for every
daemon-backed command. Before, such a command was left waiting and exited 0 with no output. Now
`monitor history`, `session list`, `events list` and `daemon stop` exit 1 with an error, `doctor`
exits 1 and reports `daemon-unreachable`, and `monitor explain` falls back in-process as it does
when no daemon is reachable.

