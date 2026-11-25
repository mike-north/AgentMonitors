## 2026-07-21 — Cross-monitor coalescing hardening: withhold a due normal reminder until concurrent high-urgency work settles, and surface the coalesced reminder to bounded transports (002 §9.1.1) — Refs #441

PR #456 review found the first #441 fix (below) still preserved the two-interrupt failure and
introduced a claimed-but-unrendered gap:

1. **Preempt-then-preempt-again, not fixed.** With a settled-high batch and a due normal reminder
   created TOGETHER, an immediate `turn-interruptible` call reached the normal-alone branch (because
   `settledHigh` was still empty — the high event had not aged past its 15s settle window yet),
   firing the reminder standalone; a LATER call then delivered the high batch separately — the exact
   two-interrupt failure #441 set out to fix, just reordered. Fixed: `decideDelivery` now withholds
   a fully-due normal reminder whenever ANY high-urgency work is pending (settled or not), so it
   fires standalone only once no high-urgency work is pending at all — otherwise it waits and
   coalesces into the settled-high delivery once that work settles, in the SAME call.
2. **Claimed but never rendered (006 §5.5 violation).** `applyDelivery` claimed the coalesced normal
   rows alongside the surfaced high events, but both bounded transports (hook-deliver, channel) only
   ever rendered `events`/`message` — and neither consults `message` once `events` is non-empty — so
   the coalesced reminder text was claimed but never surfaced anywhere. Fixed: `DeliveryClaim` gained
   an optional `coalescedReminder: string` field, populated only when a reminder was folded in; both
   `renderHookDelivery` and `renderChannelEvent` render it as a cap-reserved footer after the packed
   event block(s).
3. **Sizing couldn't see the coalesced reminder.** A length-bounded transport previously sized how
   many event blocks fit purely from `previewSettledHighDelivery`, with no way to reserve room for a
   reminder appended afterward — risking either an over-cap render or a truncated-away reminder
   (another claimed-but-unrendered case). Fixed: added `previewCoalescedReminder` (core) /
   `previewCoalescedReminderClient` (CLI), which both `hook.ts` and `channel.ts` now call alongside
   the settled-high preview to reserve footer room before sizing, and the post-reservation fit checks
   size against the ACTUAL claim's `coalescedReminder` (not the earlier preview) for exactness.
4. **Stale diagnosis precedence.** `diagnoseHookDelivery` unconditionally skipped its normal-reminder
   hold check whenever settled high-urgency work existed, on the assumption settled-high always
   preempts the reminder — true only when the reminder is otherwise fully due (it then coalesces).
   It is false whenever the coalesced-until-ack guard (#333) is ALREADY blocking the reminder on its
   own, independent of any concurrent high-urgency work — that genuine hold went unreported. Fixed:
   the ordinary `already-claimed`/`coalesced-until-ack` check (`classifyReminderHold`) is now always
   evaluated, and a new `classifyCoalescingWithheldHold` reports the settle-window-withheld case (item
   1 above) as its own `settle-window`-reasoned hold on the `normal` band.

Also fixed the two Copilot-flagged doc issues from the same review: 001 §6.2's cross-reference now
points at 002 §9.1.1 (not §9.1), and §9.1.1 no longer claims "one channel tag / hook injection,
listing both" as if `events`/`message` alone conveyed the coalesced reminder — it now documents the
dedicated `coalescedReminder` field bounded transports must render explicitly.

