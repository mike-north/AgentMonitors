## 2026-07-16 — `verify` cleanup uses two mechanisms with non-overlapping safe domains (005 §16) — Refs #418

The #414 tombstone (below) is a **by-object-key sweep**: on the tick a suppressed key's event
materializes, the daemon deletes _every_ event for that `(monitor, key)`. That is safe **only** for a
synthetic scratch key no real monitored file shares. But the previous change routed **both**
verify-created cases through it — including the **literal single-file glob whose watched file verify
created**, whose object key is a **real** monitored path. A later genuine event at that real path,
within the tombstone's TTL window, would then be swept and **silently lost** — event loss, the
highest-severity class of defect the runtime is meant to prevent. It also left #407's id-scoped
`retractObjectEvents` (added the release before) as dead code.

- Split §16 **step 9** (renamed **"Clean up"**) into the **two mechanisms** by object-key nature:
  - **Synthetic scratch key** (`…/agentmonitors-verify-<token><ext>`) → the durable, **non-blocking
    tombstone** (#414). Safe precisely because the key is synthetic.
  - **Real watched path** (a literal single-file glob verify created) → the **id-scoped
    `retractObjectEvents`** (#407): wait for verify's own create + delete, retract only those exact
    ids. Never a by-key sweep at a real path. A literal file that pre-existed (edited + restored) is
    still never erased.
- Enforced the invariant at the **trust boundary**: `AgentMonitorRuntime.suppressObjectEvents` and
  the `events.suppressObject` IPC verb now **reject a non-synthetic object key** outright (the shared,
  now-exported `isVerifyScratchObjectKey` predicate — fixed to recognize both `/` and `\` separators
  so a Windows object key resolves). A real path can never reach the by-key sweep.
- Scope correctness: `suppressObjectEvents` normalizes an omitted `workspacePath` to the **NULL scope
  once** and passes the same value to both the tombstone upsert and the immediate retraction, so an
  omitted workspace no longer retracts across **every** workspace (it would have been broader than the
  tombstone it installs). The unscoped by-key sweep stays an explicit opt-in of `retractObjectEventsByKey`.
- Reap-backstop TTL: the orphan-session tombstone's life is now derived from the object's **own
  monitor cadence** (`max(5min, interval + settle + margin)`), so a long-interval monitor's late
  deletion still lands inside the window instead of undershooting a flat 5-minute floor.
- No new public runtime capability beyond #414/#407; `isVerifyScratchObjectKey` is newly exported.

