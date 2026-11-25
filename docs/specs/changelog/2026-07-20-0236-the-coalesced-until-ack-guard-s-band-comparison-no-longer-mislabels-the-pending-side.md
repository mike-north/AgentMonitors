## 2026-07-20 — The coalesced-until-ack guard's band comparison no longer mislabels the pending side as claimed (006 §5.1.1) — Refs #438, #434, PR #445 review round 7

One follow-on defect found on round 7 of reviewing the same change.

**1. §5.1.1 described `normalPending` as the claimed-but-unacknowledged set.** `pendingForClaim`
delegates to `pendingEventsForSession`, which requires `first_notified_at IS NULL` — so `normalPending`
holds only not-yet-claimed rows. `unreadNormal` is the superset that additionally contains any
claimed-but-unacknowledged row. The mixed-recap conclusion in the prior correction (round 6, above) was
correct — `normalPending` is 1 (the fresh unclaimed row) while `unreadNormal` is 2 (that row plus the
still-claimed recap row) — but describing the LHS as "claimed" could mislead an implementer into
reversing the guard. Reworded lines 624-633 to say the runtime compares the band's pending/unclaimed
count against its total unread count, and that claimed-but-unacknowledged rows appear only in the
latter.

