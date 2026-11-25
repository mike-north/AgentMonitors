## 2026-11-14 — Diagnose held notify work despite rejected definitions (005 §6, §15; 002 §10.7) — Refs #574

Explain keeps debounce and rollup counts, stored pacing and definition-repair
guidance beside definition failures. Doctor reports the same batches independently
of parsed monitor rollups, including missing, parse-failed and duplicated ids.
Both read the runtime's existing scoped hold queries. A quiet latest tick cannot
make downstream stages healthy while earlier accepted work is still held and no
event has materialized. Notify release timing and health exit codes are unchanged.

