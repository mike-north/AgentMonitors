## 2026-07-20 — Transport-health review round 6: hook coverage, non-finite lease rejection, scoped ack remediation, stale GC docs (006 §12, 005 §15) — Refs #425

A sixth review round against the head that closed round 5, plus the write-only GC fix above, found
four more defects — three additional false greens/unsafe remediations, and one documentation
contradiction the GC fix itself introduced:

- **The every-active-lead-covered rule (round 5) only applied to `channel`, not `hook` (blocker).**
  Hook heartbeats already carry `hostSessionId`, but `computeTransportHealth` ignored it and treated
  one workspace-keyed hook record as valid evidence for every active lead. With active leads `a` and
  `b` and a hook heartbeat naming only `a`, the result read `deliveryWillReachThisSession: 'hook'` and
  `deliverable: true` for the whole workspace even though `b` had no hook invocation evidence at all —
  the same false-green shape the round-5 `channel-lead-uncovered` code fixed for channel, one
  transport over. Because `hook`'s single record is workspace-keyed (not session-keyed, by design —
  see 006 §12.3), "uncovered" here means "every active lead other than the one this one record
  names", not "no record at all". A symmetric `hook-lead-uncovered` problem code now reports every
  such uncovered lead, and disqualifies `hook` from being the listening method while any are
  uncovered (006 §12.4's problem-code list; 005 §15 `transport:hook` behavior).

- **A persisted `ttlMs` of `1e309` (which `JSON.parse` overflows to `Infinity`) was accepted as a
  valid lease (blocker).** `isTransportHeartbeat` only checked `typeof ttlMs === 'number'`, and
  `Infinity` passes that check. `isHeartbeatStale`'s `age > ttlMs` is then `false` forever, so the
  record never ages out and can never be reaped — the identical never-expires failure mode the
  future-`updatedAt` clamp (round 4) already hardens against, reached through a different field.
  `ttlMs` (and `pid`/`schemaVersion`) must now be finite; `ttlMs` must additionally be positive, since
  a zero or negative lease is not a lease at all.

- **The reminders-suppressed remediation was an unscoped, blanket acknowledgement (blocker).**
  `agentmonitors events ack --session <id>` with no `--event-ids` acks EVERY unread row for that
  session — including events the agent never claimed or even saw — and the remediation also omitted
  `--socket`, so it could target a different daemon than the one this `doctor` invocation actually
  diagnosed. `HookDeliveryDiagnosis`'s holds now carry the exact `claimedEventIds` responsible for the
  suppression (computed in `diagnoseHookDelivery` as unread-minus-pending), and the rendered
  remediation names those ids plus the resolved socket, so following the advice can never clear
  unrelated unseen work or target the wrong daemon.

- **The write-only GC fix left two contradicting "reaped on both read and write" paragraphs in the
  specs.** 005 §15 and 006 §12.2 each still described the OLD read-and-write reaping contract
  immediately alongside (006 §12.2, adjacent to) the new write-only rule, so the same head specified
  mutually exclusive semantics for whether `doctor` mutates state. Both paragraphs — and the stale
  `readTransportHeartbeats`/`doctor.ts` code comments describing an optional `now` parameter and
  read-side deletion that no longer exist — are corrected to state the write-only contract
  unambiguously.

