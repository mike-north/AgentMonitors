## 2026-07-14 — Clarify: the normal/low reminder is coalesced-until-ack, and its suppression is explainable (002 §9.2, §9.3, §10.7, §13.3) — Refs #333

A blind DX study subject reported that a durable, unread `urgency: normal` event produced **no**
surfacing at any lifecycle: `hook claim --lifecycle turn-interruptible` returned `null` and
`turn-idle` returned "No pending delivery." Investigation verdict: **not a delivery bug.** §9.2's
guard was working exactly as written — the subject had run an _earlier_ `turn-interruptible` claim
that surfaced the reminder **and** claimed the event; the second identical claim was then correctly
suppressed because the reminder coalesces until acknowledgment. The real defect was that the
suppression presented as bare silence, indistinguishable from "nothing was ever pending."

- **002 §9.2 / §9.3 — clarified (current).** Spell out that delivering the generic reminder _claims_
  the underlying events, so once any unread normal/low event is claimed-but-not-acknowledged the
  guard no longer holds and the reminder is suppressed until acknowledgment or a fresh unclaimed
  event. A repeat claim returning `null` is intended coalescing, not a lost signal (the events stay
  unread and durable). No behavior change — the guard is unchanged; this documents what it already
  does.
- **002 §10.7 — extended (current).** The `monitor explain` projection-and-delivery stage now reports
  a `reminderSuppression` finding per session-and-band naming the reason (`already-claimed` /
  `coalesced-until-ack`) when the coalesced reminder is currently suppressed, so a `null` claim is
  inspectable (the silent-failure-honesty invariant, §1.1.8 / capability C12). The stage stays `ok`
  — a paused reminder is expected behavior, not a fault.
- **002 §13.3 — new example flow (current).** Documents the exact study sequence (first claim
  surfaces + claims; second claim `null`; `monitor explain` names the reason).
- **Core (current).** New pure `diagnoseReminderSuppression` (`libs/core/src/runtime/reminder-diagnosis.ts`),
  wired into the `delivery` stage of `explainMonitor`. No public-type or schema change; the finding
  rides the existing `MonitorExplainStage.details` record. Proven at three layers:
  `reminder-diagnosis.test.ts` (pure), the issue-#333 case in `service.test.ts` (real tick + explain),
  and the issue-#333 case in `cli.integration.test.ts` (real daemon + IPC `hook claim` + `monitor
explain`).

