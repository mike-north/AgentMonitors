---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
---

Add `agentmonitors monitor retry rearm <monitorId> <retryId>` and `agentmonitors monitor retry skip <monitorId> <retryId> [--reason <text>]` to get a monitor stopped by a terminal materialization retry moving again. Re-arm returns the retry to automatic retry; once it completes, the monitor takes newer input in order. Skip records the retry's observation as an outstanding loss, like any other dropped observation, with the retry's last error followed by `Retry skipped after <n> failed attempts[: <reason>].`; `doctor` and `monitor explain` report it until a later event for the same object supersedes it, and the monitor resumes. Both name the retry as `monitor explain` and `doctor` list it, refuse a retry that is not terminal, and work through the daemon or, with no daemon running, directly against the workspace's store. A daemon that received the request but did not reply is reported as an unknown outcome, never repaired a second time from the CLI. A skip's `--reason` is at most 200 characters.

The tick report, the `monitor explain` materialization reason and the `doctor` remediation for a stopped monitor now name both commands.

Core adds `AgentMonitorRuntime.rearmMaterializationRetry()` and `skipMaterializationRetry()`, with the `MaterializationRetryRepairInput` and `MaterializationRetrySkipInput` input types and the `MATERIALIZATION_RETRY_SKIP_REASON_MAX_LENGTH` bound.
