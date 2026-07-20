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
