---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
'agentmonitors': minor
---

Make a suppressed normal/low-urgency inbox reminder explainable instead of silent. The generic
`turn-interruptible` (normal) and `turn-idle` (low) reminders coalesce until acknowledgment: once an
unread event of that band has been claimed but not yet acknowledged, the reminder is intentionally
suppressed until the claimed events are acknowledged or a fresh unclaimed event arrives — so a
repeated `hook claim` correctly returns `null`. Previously that `null` was indistinguishable from
"nothing was ever pending." Now `monitor explain`'s projection-and-delivery stage reports a
`reminderSuppression` finding per session-and-band naming the reason (`already-claimed` or
`coalesced-until-ack`) and pointing at the remedy, so "why did nothing surface?" is answerable
rather than a dead end. The delivery stage stays healthy — a paused reminder is expected behavior,
not a fault — and no signal is lost (the events remain unread and durable).
