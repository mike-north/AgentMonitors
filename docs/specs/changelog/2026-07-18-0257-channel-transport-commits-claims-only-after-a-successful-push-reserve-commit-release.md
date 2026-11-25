## 2026-07-18 — Channel transport commits claims only after a successful push: reserve → commit/release (006 §4.5.1) — Refs #300

Fixes a P1 delivery-loss defect in the channel transport. The channel marked a delivery **claimed
before** it knew the MCP push succeeded (`claimDelivery` then `await mcp.notification()`), so a
rejected or disconnected push permanently consumed the delivery: the rows stayed claimed and the hook
transport suppressed them as cross-transport duplicates (§4.5) even though nothing ever surfaced them
— violating the additive/fallback guarantee (§6 / NP-CH). No change to runtime notify/debounce timing,
urgency bands, or the unread/claimed/acknowledged model; the hook transport is unaffected.

- **New §4.5.1 (transport-state semantics: reserve → commit/release).** A transport surfacing claims
  over a fallible channel MUST NOT stamp `first_notified_at` ("was surfaced") before it actually
  surfaces the claim. The channel now **reserves** the delivery (renders the claim and **leases** its
  rows without any durable state change), **pushes**, and then **commits** on success (marks claimed,
  BP2 — still not acknowledged) or **releases** on failure (drops the lease, returning the rows to
  `pending` for the hook path or the next poll). Leased rows are hidden from a concurrent hook claim,
  so the in-flight window preserves cross-transport dedup (§4.5).
- **Guarantees:** no claim before surfacing (claim timestamps stay truthful); failed/disconnected
  pushes fall back to the hook path or retry; a successful push is durably deduplicated only once its
  commit resolves non-null — a null resolve permits ordinary redelivery, and a rejected commit leaves
  the daemon-side outcome uncertain (see the three-way outcome below); rows stay unacknowledged
  throughout. The reservation registry is in-memory and daemon-local, and a lost or self-expired lease
  safely returns rows to `pending` (PP1).
- **At-least-once boundary — three distinct commit outcomes, not two.** After a successful push,
  `commitDelivery` either resolves non-null (the rows are now claimed), resolves null (the lease had
  already lapsed mid-push or the daemon restarted — the rows are definitely still pending and
  re-deliver), or rejects (an IPC/transport error whose effect on the rows is genuinely uncertain —
  the daemon may have applied it before the response was lost). Only the null case is a known
  re-deliverable-pending state; the rejected case is a possible duplicate surface, never a lost
  delivery. The transport reports these distinctly and never treats an uncommitted push as a
  successful claim.
- **Lease-aware diagnostics:** while a reservation is in flight, the `hook deliver --debug` diagnosis,
  the reminder-suppression diagnosis, and the per-session hook-state projection all exclude leased
  rows from "pending claimable work" (routed through the same lease-aware accessor the claim decision
  uses), so they never advertise a row the reservation makes momentarily unclaimable. Reserve/release
  refresh the hook-state projection so it tracks the lease.
- **Realization:** core `reserveDelivery` / `commitDelivery` / `releaseDelivery` (backed by an
  in-memory `DeliveryReservationRegistry`) + `hook.reserve` / `hook.commit` / `hook.release` daemon
  IPC; the channel drives them via `runChannelDeliveryCycle`. `claimDelivery` is refactored into a
  pure decide + a mutating apply that both paths share (behavior-preserving for the hook path).
- **UAT:** [`docs/uat/channel-transport.md`](../uat/channel-transport.md) Part A-2 (steps 12a–12c)
  adds the transient-push-failure recipe (issue #277).

