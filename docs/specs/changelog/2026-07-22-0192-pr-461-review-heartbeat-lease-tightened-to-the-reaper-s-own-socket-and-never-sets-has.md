## 2026-07-22 — PR #461 review: heartbeat lease tightened to the reaper's own socket, and never sets hasSeenSession (002 §10.2, 006 §12.8) — Refs #435

Two follow-up tightenings to the Option A contract below, found in review of PR #461:

- **Same-socket, not just same-workspace.** The `channelAttached` check now additionally compares
  `heartbeat.socketPath` against the reaper's OWN `socketPath`, not only `heartbeat.workspacePath`
  against its own workspace path. Two daemon instances can independently resolve the same
  `workspacePath` (e.g. an orphaned daemon from a prior boot, bound to a stale socket); without the
  socket comparison a live channel keeping a _different_ daemon alive would wrongly suppress reaping
  on _this_ one. Verified by a new `daemon-reaper-lease.integration.test.ts` case: a channel heartbeat
  naming a different socket does not exempt.
- **A channel-only exemption never sets `hasSeenSession`.** `shouldReap` previously set
  `nextHasSeenSession: true` whenever EITHER `openCount > 0` OR `channelAttached`, conflating "a real
  session opened" with "a channel is merely attached." `hasSeenSession` specifically gates the
  boot-grace window (`max(reapAfterMs, bootGraceMs)`); a channel can attach before any session ever
  registers, and if it then detaches cleanly before one does, the boot-grace window must still apply
  on the next check — not fall through to the shorter post-session `reapAfterMs` as if a session had
  already been seen. Verified by a new `reap-decision.test.ts` case.
- The reaper also now skips reading the transport registry entirely when reaping is disabled
  (`--reap-after-ms 0`), since `shouldReap` short-circuits on that case regardless of
  `channelAttached` — avoiding a pointless registry scan on every tick of a daemon that will never
  reap.

