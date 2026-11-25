## 2026-11-23 — `monitor explain` counts net-suppressed rows separately

005 `monitor explain` now defines each delivery count. Rows the per-recipient net collapse
suppressed (002 §1.1.7) were stored as `claimed` and so inflated that count even though the
session never saw them; they are now reported under their own `netSuppressed` count, which an
ack by event ID no longer moves into `acknowledged`. The 005 text also states that `claimed`
includes rows covered only by a generic normal/low reminder.

002 §1.1.7 now states that the collapse suppresses only intermediates no earlier claim
surfaced. A `post-compact` recap over claimed-but-unacknowledged rows had been marking rows the
session was already shown as suppressed; those rows now stay claimed and unread until
acknowledged, so they also stay in later claims' `unreadCounts`. A recap that re-shows an
endpoint an earlier claim surfaced now keeps that endpoint's first-claimed delta; it had been
recomputing it against a cursor already at the endpoint and rendering it with no diff. Which
events are rendered and claimed, and the cursor advance, are unchanged. 005 notes that rows
marked suppressed by older versions after being shown keep counting as `netSuppressed`. Output
shape is otherwise unchanged. Implementation now matches the described behavior.

