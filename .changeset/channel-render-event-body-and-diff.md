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
  even alone; that one event is mid-truncated as PART OF the push, before the reservation is
  committed, so at that point it is genuinely unknown whether the redelivery-suppressing commit that
  follows will land — its marker stays outcome-neutral rather than promising a specific outcome
  either way. It names the exact, directly-runnable recovery command for that session and socket
  (`` `agentmonitors events list --session <id> --socket <path> --unread` `` — `events list` requires
  `--session`, so a bare `--unread` form would fail, and the explicit `--socket` guards against a stale
  `$AGENTMONITORS_SOCKET` silently querying the wrong workspace's daemon), pointing at the still-unread,
  un-truncated copy of the full event (claiming an event is never the same as acknowledging it).
- A reminder tag's `event_count` now reports the pending unread total the reminder refers to, instead
  of the confusing `0`.
- The hook-deliver transport's `additionalContext` blocks also grow by up to ~800 chars of change
  summary per event now that `diffText` is rendered there too, so `packEventsUnderCap` fits fewer
  events per delivery under the existing 4000-char cap than it did before this change — expected,
  not a regression: the deferred remainder still re-delivers at the next context event.
- The hook-deliver transport uses the same **two distinct, session- and socket-scoped markers** as
  the channel side: a genuinely-deferred-remainder marker ("more monitor updates are pending; ...
  redeliver") and a claimed-unread marker for THIS claim's own content being cut (a single oversized
  event, or a truncated reminder message) — not other pending work being deferred. Rendering now
  happens BEFORE the reservation is committed, so the claimed-unread marker deliberately does not
  assert a specific claimed/redelivery outcome (it stated "will not redeliver automatically" in an
  earlier round, which was false whenever the following commit resolved null — and simply uncertain
  whenever it rejected instead); it instead reads "the full copy stays unread", true regardless of
  which of the three commit outcomes occurs. Both markers can now appear together in the same
  `additionalContext` when the sole reserved event is itself oversized AND further, different
  high-urgency work also stays genuinely pending beyond it — previously the claimed-unread marker
  alone silently suppressed that second, real signal. The channel transport has the identical mixed
  case and the identical fix: when the sole reserved event is itself oversized and further
  high-urgency work also stays genuinely pending, `renderChannelEvent` now appends its deferral marker
  alongside the truncation marker instead of the truncation marker alone, which previously silently
  dropped the "more work is pending" signal on the channel side.
- Both transports now validate a `turn-interruptible` claim's fit against the SAME budget the renderer
  uses **before ever durably claiming it**: `hook deliver` reserves (leases, does not claim), re-checks
  the actual reserved claim's fit, and only then commits — closing a race where the sizing preview and
  the eventual claim are separate round-trips and a concurrent caller could substitute different,
  larger pending events into the same requested count, passing the count check but overflowing the
  cap on an already-(and now irreversibly-)claimed row.
- `hook deliver` renders off the reservation's own (not-yet-committed) claim, writes it to stdout,
  and only commits AFTER that write **fully** completes — awaited through the write's own completion
  callback (or a stream `'error'` event, whichever fires first), never `stdout.write`'s synchronous
  return value, which only signals backpressure. A write can return `true` immediately and still fail
  asynchronously afterward (e.g. `EPIPE` once the reading end has closed); previously that async
  failure could arrive after the reservation was already committed, silently losing the delivery. A
  write failure (synchronous or asynchronous) now releases the reservation instead of committing.
- A reminder claim raced down from a settled-high sizing preview no longer inherits that preview's
  stale `moreDeferred: true` — it is always reported `false` for an eventless reminder, mirroring the
  channel transport's identical handling of the same preview↔reserve race.
- Both markers' `--socket <path>` clause is now rendered with a shared, transport-safe path escaper
  (bash/zsh ANSI-C quoting, hex-escaping any byte outside a conservative safe set) instead of a plain
  POSIX single-quote: a socket path is interpolated into the recovery command AFTER the surrounding
  content's own tag-safety sanitization has already run, so a path containing `<`/`>`/`[`/`]` (or a
  backtick / control character) could otherwise reintroduce those forbidden bytes into the pushed
  content raw. The new escaping is both tag-safe and shell-round-trip-safe.

See docs/specs/006-agent-integration.md §4.2.1 and §5.5.
