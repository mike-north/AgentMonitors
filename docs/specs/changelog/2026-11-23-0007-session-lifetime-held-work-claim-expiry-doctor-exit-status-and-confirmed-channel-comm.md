## 2026-11-23 — Session lifetime, held work, claim expiry, doctor exit status and confirmed channel commits (target) — Refs #396, #636, #468, #462, #535

Five target decisions for delivery honesty. Current behaviour is unchanged until each one ships;
roadmap G22 tracks them.

- **002 §6.3, 007 §4.4 (#396).** A session is alive while its host process is alive. Inactivity is
  no longer a liveness signal, because an agent may wait for a delivery with no hook activity.
  Liveness checks are process checks that never reach the model. An explicit end reaps ephemeral
  monitors. Losing the host without an end suspends them, and a resume re-arms them. Retention, not
  a timer, retires a session that is never resumed. `suspended` is a session status, and a watch
  of a suspended session reports `suspended`; a suspended session does not keep the daemon alive.
  §6.2's inactivity trigger is marked for replacement.
- **002 §6.4 (#636).** Held notify work is never held forever or discarded silently. A cancel or a
  retirement records a durable, visible terminal disposition. Suspension keeps the work and
  releases it on resume.
- **002 §7.1 (#468).** Claim expiry: a claim that is not acknowledged within a configurable claim
  TTL goes from claimed back to pending, so it is delivered again; it stays unread. Expiry is
  measured from the durable claim time. In-flight leases are unaffected. Delivery is at-least-once.
- **005 doctor (#462).** `channel-session-unmatched` becomes advisory, and `channel-lead-uncovered`
  does not block while the hook path covers that lead. `doctor`'s exit status agrees with the
  delivery verdict.
- **006 §4.5.2, §12.6 (#535).** A channel commits a delivery only when the host confirms the push
  reached the session. For Claude Code the evidence is the `enqueue` entry the host writes to the
  session transcript. A model-facing check is ruled out, because it costs a model turn. Without
  evidence the push is released, the route is marked unproven, and the hook path delivers.

