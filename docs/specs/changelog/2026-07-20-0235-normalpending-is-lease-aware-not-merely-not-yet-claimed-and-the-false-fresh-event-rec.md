## 2026-07-20 — `normalPending` is lease-aware (not merely "not-yet-claimed"), and the false "fresh event" recovery clause is removed from every normative surface (002 §9.2/§9.3/§13.3, 006 §5.1.1) — Refs #438, #434, PR #445 review round 8

Two follow-on defects found on round 8 of reviewing the same change.

**1. §9.2/§9.3/§13.3 promised a fresh unclaimed event restores a suppressed reminder.** They do not:
starting from one claimed-but-unacknowledged row (`normalPending = 0`, `unreadNormal = 1`), a fresh
unclaimed row makes it `1` and `2` — the equality guard (`normalPending.length === unreadNormal.length`)
stays unsatisfied until the claimed row is specifically acknowledged, regardless of how many new
unclaimed rows arrive. Removed the "or a fresh unclaimed event arrives" alternative from §9.2, §9.3, and
the §13.3 worked example, and from the matching prose/messages in `reminder-diagnosis.ts` and
`hook-delivery-diagnosis.ts` (both diagnostics' `coalesced-until-ack` branch already stated the correct,
ack-only condition — only the `already-claimed` branch carried the false alternative).

**2. §5.1.1 described `normalPending` as merely "not-yet-claimed."** `pendingForClaim` (issue #300) also
excludes rows held by an in-flight channel-push reservation, so an unread, unclaimed, but currently
leased row is absent from `normalPending` too — proven by the committed reservation regression, which
shows a concurrent reminder stays suppressed until the lease releases. Reworded §5.1.1 to describe
`normalPending` as pending **and currently claimable (not leased)**. This also means both diagnostics'
`claimedCount = unreadCount - pendingCount` reports a leased-but-unclaimed row as `already-claimed`
alongside truly claimed rows; documented that lease-aware overlap in both modules' doc comments rather
than distinguishing it with a new reason (a public-API change to `HookDeliveryHoldReason`), and pinned
the leased case with a dedicated regression.

