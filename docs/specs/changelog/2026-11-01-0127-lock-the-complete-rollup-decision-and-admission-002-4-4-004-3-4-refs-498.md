## 2026-11-01 — Lock the complete rollup decision and admission (002 §4.4; 004 §3.4) — Refs #498

Require not-due rollup checks to read their authoritative batch, marker, source checkpoint and
observation time after obtaining the writer lock. Preserve fresh source/time state while committing
successful event prefix, retained suffix, batch clear and marker together. Empty windows persist a
marker without delivery/audit spam; non-emitting write failures roll back and remain monitor-local.
Controlled competing runtimes cover not-due/due/watch entrypoints; independent readers verify suffix
visibility before Interpret, rollback and restart. No public API changes or retry drain are introduced.

