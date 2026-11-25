## 2026-07-19 — Cross-monitor delivery coalescing: a due normal reminder folds into a concurrent settled-high delivery instead of a separate later interrupt (002 §9.1.1) — Refs #441

Two monitors watching overlapping state (a high-urgency label monitor and a normal-urgency
review-queue monitor both firing off the same underlying change) previously interrupted a session
TWICE for one action: `decideDelivery`'s `turn-interruptible` branch always returned early once a
settled high-urgency batch was found, leaving a simultaneously-due normal reminder for a SEPARATE,
later `claimDelivery` call — one interrupt, one ack, then a second interrupt, then a second ack, for
work the session had already handled. Added 002 §9.1.1: when both a settled high batch and a due
normal reminder are decided in the SAME call, they are folded into ONE `DeliveryClaim` — the
`events` array and top-level `urgency: 'high'` are unchanged from a pure high delivery (never
downgraded), the normal reminder's text is appended to the message (never escalated into per-event
detail), and both event sets are claimed together so there is no leftover second interrupt. Also
added 001 §6.2 and the `setup-monitors` skill's authoring guidance: the runtime cannot coalesce two
_independently-authored_ monitor definitions into one, so overlapping monitors should be merged into
one branching monitor or scoped disjointly by the author.

Deliberately out of scope for this change (see the #441 decision-brief comment on the issue for the
full writeup): the ack-race closure (an ack-all sweep racing a sibling monitor's event materializing
one tick later) and self-caused-event suppression — both are three-state-model / attribution
decisions reserved for Mike, not mechanical fixes.

