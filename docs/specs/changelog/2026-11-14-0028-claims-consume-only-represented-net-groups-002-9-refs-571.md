## 2026-11-14 — Claims consume only represented net groups (002 §9) — Refs #571

Rendering and claim persistence use the same selected net groups for every lifecycle.
Defer newer normal endpoints sharing a net group with rendered settled high work, so an interrupt showing
the high version cannot advance its cursor to an unseen normal endpoint. An unsettled high
version cannot authorize consuming an intervening normal version. Older normal intermediates
may fold into a rendered high endpoint in durable event order. Independent monitor
reminders still coalesce, even when their object keys match. Recap claims and suppresses only
groups represented within its ten-endpoint cap. Unrepresented rows remain unread and pending
across restart; a claim never acknowledges. This corrects the previous mixed-band collapse
and full-unread recap mutation. Runtime regressions verify durable projection state, cursors
and subsequent delivery through direct claims and reserve/commit across all three lifecycles.

