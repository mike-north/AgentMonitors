## 2026-10-30 — Fresh reminder batches do not wait for old acknowledgments (002 §9, 006) — Refs #524

Deliberately replaces the normal/low `pending === unread` guard: a claimed-but-unacknowledged event
no longer blocks fresh pending events of the same band. Each eligible batch is claimed once; no
automatic acknowledgment or replay of old claims is introduced. Same-band reservations still hold
new reminders temporarily until commit/release/expiry, and high settle coalescing is unchanged.
Diagnostics now distinguish no-new-work (`no-new-work`) from a live lease (`reserved-in-flight`);
legacy `already-claimed` / `coalesced-until-ack` values remain accepted but are no longer emitted. This policy change
closes reminder starvation identified in the Chief of Staff reliability review; it is separate from
the earlier acknowledgment-instruction fix (#434) and from any claim-TTL design (#468).

Validation: tests first reproduced seven failures across hook/channel, normal/low and high-coalescing
cases; the forward-progress suite and both transport renderers now cover the revised contract.

