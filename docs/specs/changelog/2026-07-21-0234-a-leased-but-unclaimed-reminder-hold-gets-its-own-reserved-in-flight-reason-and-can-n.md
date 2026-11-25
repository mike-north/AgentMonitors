## 2026-07-21 — A leased-but-unclaimed reminder hold gets its own `reserved-in-flight` reason and can no longer be acknowledged away (002 §10.7, 006 §5.2) — Refs #438, #434, PR #445 review round 10

Round 8 documented (but did not fix) that a row LEASED by an in-flight channel-push reservation
(issue #300) reads identically to a truly claimed row to the reminder-suppression diagnosis — both
report `already-claimed`/`coalesced-until-ack`, and both messages recommend `agentmonitors events
ack`. Round 10 proved that overlap unsafe rather than merely misleading: `acknowledgeSession`'s
implicit "ack everything unread" path (the literal remedy the shared message recommends) would sweep
the still-leased row too. `acknowledgeEvents` sets `acknowledgedAt` without requiring
`firstNotifiedAt`, so if the in-flight push then rejects/disconnects and the lease releases the row
back to `pending`, the row is already (wrongly) acknowledged and can never redeliver — event loss.

Fixed on both sides:

1. **Diagnosis** (`hook-delivery-diagnosis.ts`, `reminder-diagnosis.ts`): `HookDeliveryHoldReason`
   and `ReminderSuppressionReason` gain a `reserved-in-flight` variant, reported whenever a band has
   no durably claimed row but at least one leased row (`claimedCount === 0 && leasedCount > 0`). Its
   message never mentions `events ack`. A mix of a durable claim and a live lease still reports
   `coalesced-until-ack` (ack remains the correct remedy for the claimed portion) but now names the
   leased portion separately so it isn't implied to need the same action. `HookDeliveryHold` and
   `ReminderSuppressionFinding` both gain a `leasedCount` field.
2. **The actual bug**: `AgentMonitorRuntime.acknowledgeSession(sessionId)` (no explicit `eventIds`)
   now excludes rows currently leased by an outstanding reservation from its default "every unread
   event" set. A scoped ack (explicit `eventIds`, e.g. a hook body-injection's per-batch instruction)
   is unaffected — it names rows the caller actually saw. Regression: reserving a delivery, calling
   `acknowledgeSession` with no ids, then releasing the reservation proves the row is still `unread`
   and re-claimable, never silently lost.

Updated 006 §5.2's `--debug` hold-reason list and 002 §10.7's `monitor explain` description to name
`reserved-in-flight` and its no-ack constraint.

