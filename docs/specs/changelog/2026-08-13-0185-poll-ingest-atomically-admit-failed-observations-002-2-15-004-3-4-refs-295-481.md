## 2026-08-13 — Poll ingest atomically admit failed observations (002 §2, §15; 004 §3.4) — Refs #295, #481

One immediate transaction now commits successful event materializations, ordered retry envelopes,
and source/notify state. A state or outbox failure rolls the whole batch back to the prior source
baseline. Tick ids, errors, and history reflect only committed work, and Interpret runs only after
commit. Retry draining follows in the next stack layer.

