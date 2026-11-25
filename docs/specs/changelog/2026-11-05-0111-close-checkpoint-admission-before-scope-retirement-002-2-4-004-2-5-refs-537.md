## 2026-11-05 — Close checkpoint admission before scope retirement (002 §2.4, 004 §2.5) — Refs #537

Clarify the existing G14/notify-boundary guarantee across natural completion and iterator error.
Close admission immediately, retaining the monitor/workspace exclusion and cache lease until
accepted pre-close writes settle. A recovery rescan opens their gate without letting polling or
replacement sources overtake them; actual writes also recheck token/cancellation. Replace the
obsolete delete-before-drain/stable-reference description. Require source/SQLite/reopen evidence
that cursor 111 precedes a later source baseline 999, plus cancellation and scoped successor controls.

