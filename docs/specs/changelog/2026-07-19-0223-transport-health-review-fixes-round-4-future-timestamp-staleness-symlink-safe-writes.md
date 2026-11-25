## 2026-07-19 — Transport-health review fixes round 4: future-timestamp staleness, symlink-safe writes, delivery-diagnosis-unavailable (006 §12; 005 §15) — Refs #425

A further round of review on the delivery-transport health surface found three defects, two of which
change verdict semantics:

- **A future `updatedAt` used to read as fresh forever (blocker).** `isHeartbeatStale` computed
  `now - updatedAt > ttlMs`; a record whose `updatedAt` is ahead of `now` (clock skew, or a corrupt or
  forged record) makes that difference negative, which is never `> ttlMs`. Such a record would never
  age out — blocking the opportunistic GC introduced in the prior round, and letting `doctor` report a
  dead or bogus transport as `running` indefinitely. Fixed by treating any `updatedAt` more than a
  small clock-skew tolerance ahead of `now` as stale, the same conservative direction already used for
  an unparseable timestamp.
- **The heartbeat write followed a pre-planted symlink at its temp path.** The write used a plain
  `writeFileSync` to a deterministic sibling temp path (`<target>.<pid>.tmp`) before renaming it into
  place. Because the registry directory predates the 0700-owner-only migration in some installs, a
  symlink planted there while it was still permissive would be followed, letting a routine heartbeat
  refresh overwrite an arbitrary file the symlink points at. Fixed by mirroring
  `writePrivateFileAtomic` (000, local-permissions.ts): remove whatever sits at the temp path first,
  then (re)create it with `O_EXCL`, which refuses to follow a symlink planted between the two calls.
- **A failed delivery-diagnosis call read as "checked, nothing suppressed" (blocker; new problem
  code).** `doctor` asks the daemon's `hook.diagnose` RPC, per lead session, whether reminders are
  currently suppressed. A thrown call (an older daemon rejecting it as unsupported, or a connection
  error) was silently dropped, leaving the diagnosis set indistinguishable from a clean "not
  suppressed" answer — so `deliverable` could read `true` even though the check never actually ran. A
  new problem code, `delivery-diagnosis-unavailable`, makes the distinction explicit and, unlike the
  existing advisory codes, is blocking: `deliverable` can never be `true` while it is present.

