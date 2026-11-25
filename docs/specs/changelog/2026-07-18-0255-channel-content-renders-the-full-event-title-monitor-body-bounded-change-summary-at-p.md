## 2026-07-18 — Channel `content` renders the full event (title + monitor body + bounded change summary), at parity with the hook path (006 §4.2.1) — Refs #436

Fixes a delivery-completeness defect on the channel surface. A body-injection claim (a settled
high-urgency delivery) rendered only the event **title** into the `<channel>` tag body; the monitor
body (the author's instructions for what to do when the monitor fires) and the change summary
(`diffText`) never reached the agent, so the receiving agent had to already know what the monitor
meant and separately run `events list` to see what changed — defeating push delivery. This violated
§6 ("same events, same urgency … only the surface"): the channel is a rendering surface over the same
semantics as the hook-deliver transport, not a lesser summary.

- **New §4.2.1 (`content` rendering contract).** The channel tag body now renders the **same
  per-event block the hook-deliver transport injects** (§5.1), via a transport-shared block builder
  (`apps/cli/src/delivery-event-render.ts`): `### <monitor_id> (<urgency>)`, the title, the monitor
  body, and — when present — a `Changes:` section carrying a **bounded** `diffText` (per-event cap
  with an explicit elision marker). The only per-transport difference is content sanitization (the
  channel strips `<>[]` for tag safety, §4.6; the hook path preserves them). Reminder claims
  (`normal`/`low`) still render their generic coalesced message as-is, subject to the same tag-safety
  sanitization (002 §9.2) — unchanged. (The channel surface is not length-bounded — see the
  claimed-set-equals-rendered-set reconciliation below.)
- **`DeliveryEventSummary.diffText` (new, optional).** The delivery summary a transport receives now
  carries the event's change summary, so a transport can surface _what changed_, not just the title
  and instructions. This is the **recipient-specific** delta (`session_event_state.diff_text`, G10 /
  002 §1.1.2) — the diff THIS recipient's own baseline cursor produces against the shared observation
  — falling back to the shared `MonitorEventRecord.diffText` only for a legacy pre-G10 row whose
  per-recipient column is `null`. Absent when the event carried no diff at all. Additive core API
  change (minor bump — no behavior change to existing consumers).
- **`event_count` on a reminder tag.** A reminder claim carries no concrete events, so `event_count`
  now reports the session's **unread total** (the pending events the reminder refers to) rather than
  `0`, which read like a bug. A body-injection claim still reports its coalesced event count.
- **Parity is now enforced by a real test.** `channel-hooks-ipc-parity.test.ts` renders one
  `DeliveryClaim` through both real renderers and asserts both surface the identical per-event block.

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

