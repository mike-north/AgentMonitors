## 2026-07-16 — `verify --use-workspace-daemon` suppresses (not waits-to-retract) its scratch events (005 §16) — Refs #414

The #407 retraction (below) fixed the leak but WAITED a full extra poll interval + settle for the
scratch file's deletion event to re-materialize before retracting it — so `--use-workspace-daemon`
ran ~2× as long as plain `verify` (≈120s vs ≈59s) while still displaying plain `verify`'s ETA
(`~68s`). That reads as a hang and overran default 2-minute command/CI timeouts; a run killed
mid-cleanup left a permanently `active` verify session plus dangling scratch events that `doctor`
never flagged — the workspace ended up dirtier than before, the opposite of #407's intent.

- Rewrote §16 **step 9** (renamed **"Suppress"**): under `--use-workspace-daemon`, verify now deletes
  the scratch file and, in one non-blocking call, retracts the create event it already delivered AND
  installs a durable, self-expiring **object-event suppression** (tombstone) keyed to the synthetic
  scratch object. It no longer waits for the deletion — the daemon's tick sweeps the pending
  `File deleted: …/agentmonitors-verify-…` on the tick it materializes, before any later session sees
  it. So the mode finishes in ≈plain-`verify` time and its ETA is honest (criterion 1), while #407's
  no-leak guarantee is preserved.
- The suppression sweep deletes **by the scratch object key** — safe only because that key is a
  synthetic `…/agentmonitors-verify-<token><ext>` path no real object shares; a non-synthetic trigger
  (a real watched file verify merely edited) is never suppressed.
- **Interruption-safety** (criterion 2): the durable tombstone + verify's signal handler (which now
  runs the same teardown — revert, tombstone, close session — on `SIGINT`/`SIGTERM`) + a daemon
  **reap backstop** (when a stale `agentmonitors-verify-*` session is reaped to dormant, its scratch
  objects are tombstoned + retracted) together guarantee an interrupted run leaves no permanent stray
  session or event.
- Behavioral, not just clarifying: new runtime capability `suppressObjectEvents` (core service +
  store `object_event_suppressions` table, key-scoped `retractObjectEventsByKey`, and a per-tick
  suppression sweep), exposed over the daemon socket as the `events.suppressObject` IPC verb.

