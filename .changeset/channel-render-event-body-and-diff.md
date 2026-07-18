---
'@agentmonitors/core': patch
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
  `diffText` (the event's change summary), so a transport can surface _what changed_. Additive core
  change; existing consumers are unaffected. The surfaced `diffText` is each recipient's
  **per-recipient** change summary (its own baseline span), not the shared latest-snapshot delta — so
  two sessions at divergent cursors each receive the correct, complete evidence (session isolation).
- The channel surface is **not length-bounded**: it claims the full delivered set, so it renders the
  full set with no overall content cap. A cap would have let an early event's body crowd out later
  blocks while the whole claim was still committed, silently omitting claimed-but-unrendered events;
  the claimed set now always equals the rendered set (only the per-event change summary stays bounded).
- A reminder tag's `event_count` now reports the pending unread total the reminder refers to, instead
  of the confusing `0`.

See docs/specs/006-agent-integration.md §4.2.1 and §5.5.
