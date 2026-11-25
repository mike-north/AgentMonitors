## 2026-11-23 — A reminder is never delivered for a session with no unread rows (002 §9.2) — Refs #473

002 §9.2 now states the rule and why it holds: decide time requires pending ⊂ unread, and a
session-wide acknowledgement skips rows an outstanding reservation holds. It records the two accepted
windows: a scoped acknowledgement of every reserved row between reservation and push, and a host
showing a notification it queued before the acknowledgement. Behavior is unchanged; regression tests
in `delivery-reservations.test.ts` pin it.

