## 2026-07-19 — `daemon run --detach`'s log/parent-dir creation is owner-only from birth, and its ready-timeout report now states whether cleanup succeeded (002 §3.1, 005 §9.2) — Refs #389

Round-4 review follow-up, two independent findings.

**Log/dir creation followed the process umask.** `openLogFd` used a plain `mkdirSync`/`openSync`
for `--log`'s parent directory and file. Under a common `umask 022` this created the parent `0755`
and the log `0644` — readable by every other local user — for a file that carries the daemon's
stdout/stderr (workspace paths, socket paths, monitor failure messages). It now uses
`ensurePrivateDir` (the same AgentMon-owned-directory helper every other runtime-data directory
uses) for the parent, `restrictExistingPathMode` to tighten a pre-existing log file before appending
to it, and `PRIVATE_FILE_MODE` (`0600`) on open — so the file is owner-only from birth regardless of
umask, and a permissive artifact left by an earlier version is migrated forward on the next boot,
matching the rest of 002 §3.1's local-data permission model.

**The ready-timeout/spawn-error branch discarded `terminateSpawnedDetachedDaemon`'s result.** 005
§9.2 item 5 already promises "the error message states whether the cleanup succeeded" — the
unproven-identity branch (the prior 2026-07-19 entry above) honors that, but the ready-timeout/
spawn-error branch `await`ed the same cleanup call and dropped its return value, so its own report
could never say whether the spawned child was actually confirmed gone. Both non-success `--detach`
branches now share one formatter (`describeSpawnedCleanupOutcome`) so the wording — and its cleanup
-succeeded/cleanup-FAILED unit coverage — cannot drift between them again.

