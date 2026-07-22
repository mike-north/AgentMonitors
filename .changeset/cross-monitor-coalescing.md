---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fix cross-monitor delivery coalescing (issue #441): two monitors watching overlapping state (e.g. a
high-urgency label monitor and a normal-urgency review-queue monitor both firing off the same
underlying change) previously interrupted a session TWICE for one action — a settled high-urgency
delivery in one `turn-interruptible` claim, then a separate normal-urgency reminder in a later one.

When both a settled high-urgency batch and a due normal-urgency reminder are decided in the same
`claimDelivery`/`reserveDelivery` call, they now fold into ONE `DeliveryClaim`: the `events` array
and top-level `urgency: 'high'` are unchanged from a pure high delivery (never downgraded by the
coalesced reminder), the normal reminder's generic prompt is appended to the message (never
escalated into per-event detail), and both event sets are claimed together — so there is no leftover
second interrupt for the same action. A normal-only reminder (no high-urgency event pending) is
unaffected and still reports `urgency: 'normal'`.

Also: a due normal reminder is now withheld (not fired standalone) while sibling high-urgency work
is still pending but unsettled, so it coalesces into that delivery once it settles instead of
preempting a separate, later high-urgency interrupt. `DeliveryClaim` gained an optional
`coalescedReminder: string` field carrying the coalesced text explicitly — `events`/`message` alone
were not enough for the hook-deliver/channel transports to notice it, which meant the coalesced
normal rows were claimed but never rendered. Both transports now render it as a footer after the
packed event block(s), and a new `previewCoalescedReminder`/`previewCoalescedReminderClient` lets a
length-bounded transport reserve room for it before sizing how many event blocks fit.
`diagnoseHookDelivery` (`hook deliver --debug`) also now reports this withheld state, and correctly
reports the pre-existing coalesced-until-ack hold even when settled high-urgency work is
simultaneously being delivered.
