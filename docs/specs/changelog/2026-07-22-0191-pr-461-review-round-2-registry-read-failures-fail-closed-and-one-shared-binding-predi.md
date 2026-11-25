## 2026-07-22 — PR #461 review round 2: registry read failures fail closed, and one shared binding predicate (002 §10.2, 006 §12.8) — Refs #435

Two more follow-up fixes to the Option A contract below, found in a second round of review of PR #461:

- **A transport-registry read failure now fails CLOSED, not open.** `readTransportHeartbeats()`
  already treated any `readdirSync` failure (a transient `EMFILE`/`EACCES`, etc.) the same as an
  empty registry, returning `[]`. That is the right behavior for `doctor`/`transport-health`, but the
  reaper was reusing the same function, so a transient read failure made `channelAttached` false —
  letting the idle clock advance toward reaping a possibly-**live** channel, the exact #435 failure
  this lease exists to prevent. A new `readTransportHeartbeatsResult()` (`apps/cli/src/transport-
heartbeat.ts`) returns `{ records, readFailed }`, distinguishing a genuinely unreadable directory
  (`readFailed: true`) from a missing (`ENOENT`, never-run) or empty one (`readFailed: false`);
  `readTransportHeartbeats()` is now a thin, contract-unchanged wrapper over it. The daemon's reap
  check uses the new function directly and treats `readFailed` the same as an attached channel for
  that tick only — never asserting a session was seen — so the very next tick re-scans from scratch
  and a genuinely absent channel resumes normal reaping as soon as reads succeed again. Verified by a
  new `daemon-reaper-lease.integration.test.ts` case (replaces the registry directory with a plain
  file to force `ENOTDIR`) and `transport-heartbeat.test.ts` unit cases for the read-result
  distinction.
- **One shared "does this heartbeat match this binding" predicate.** The workspace+socket comparison
  existed divergently: the reaper's `channelAttached` filter compared both via `path.resolve`, while
  `transport-health`'s socket-mismatch check compared `socketPath` as a raw string — so a trailing
  slash or a `./` segment could read as matched in one place and mismatched in the other. Both now
  call one exported `heartbeatMatchesBinding(heartbeat, { workspacePath, socketPath })`
  (`transport-heartbeat.ts`), which resolves both fields on both sides (no symlink/realpath
  resolution — tracked separately). In `transport-health`, this only widens normalization tolerance
  for the socket comparison (a raw-equal pair remains equal after resolving); the `workspace-
mismatch`/`socket-mismatch` codes stay distinct. Verified by new `heartbeatMatchesBinding` unit
  cases (trailing slash, `.`/`..` segments) in `transport-heartbeat.test.ts`.

