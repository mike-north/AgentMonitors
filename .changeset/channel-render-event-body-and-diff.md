---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Render the full event on the Claude Code channel surface. A high-urgency channel delivery previously
rendered only the event **title** into the `<channel>` tag body; the monitor body (the author's
instructions for what to do when the monitor fires) and the change summary never reached the agent,
so a pushed event forced the receiving agent to already know what the monitor meant and separately
run `events list` to see what changed — defeating push delivery.

- The channel tag body now renders the **same per-event block the hook-deliver transport injects**:
  `### <monitor> (<urgency>)`, the title, the monitor body, and — when present — a `Changes:` section
  carrying a bounded change summary (per-event cap with an explicit elision marker). Both transports
  share one block builder, so the channel is a rendering surface over the same semantics, differing
  only in content sanitization. Normal/low reminder claims still render their generic coalesced
  message.
- The delivery summary a transport receives (`DeliveryEventSummary`) now carries an optional
  `diffText` (the event's change summary), so a transport can surface _what changed_. This is an
  additive `@agentmonitors/core` public-API change (minor bump — precedent: `DeliveryEventSummary.body`
  in #60 and the `schedulingDefaults` export); existing consumers are unaffected. The surfaced
  `diffText` is each recipient's **per-recipient** change summary (its own baseline span), not the
  shared latest-snapshot delta — so two sessions at divergent cursors each receive the correct,
  complete evidence (session isolation).
- The channel surface is now **bounded by packing WHOLE event blocks under a content ceiling before
  reserving**, not by cutting an already-claimed render: `channel serve` previews the settled
  high-urgency delivery, sizes how many whole blocks fit, and reserves/claims exactly that many —
  mirroring how the hook-deliver transport sizes its `additionalContext` cap. The claimed set still
  always equals the rendered set; any events that do not fit stay pending and re-deliver on a later
  poll (only the per-event change summary was ever bounded before this).
- Two distinct situations can leave settled work out of a push, and each is now signposted with its
  own marker: some settled-high events genuinely did not fit and stay pending — they **will**
  re-deliver on a later poll (`... more monitor updates are pending; they will surface on a later
poll`). The other, rarer case is a single event whose own block still exceeds the content ceiling
  even alone; that one claimed event is mid-truncated and — because the claim is already committed by
  the time it renders — it will **not** re-deliver later. Its marker instead names the exact,
  directly-runnable recovery command for that session
  (`` `agentmonitors events list --session <id> --unread` `` — `events list` requires `--session`, so a
  bare `--unread` form would fail), pointing at the still-unread, un-truncated copy of the full event
  (claiming an event is never the same as acknowledging it).
- A reminder tag's `event_count` now reports the pending unread total the reminder refers to, instead
  of the confusing `0`.
- The hook-deliver transport's `additionalContext` blocks also grow by up to ~800 chars of change
  summary per event now that `diffText` is rendered there too, so `packEventsUnderCap` fits fewer
  events per delivery under the existing 4000-char cap than it did before this change — expected,
  not a regression: the deferred remainder still re-delivers at the next context event.

See docs/specs/006-agent-integration.md §4.2.1 and §5.5.
