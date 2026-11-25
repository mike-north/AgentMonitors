## 2026-11-05 — Isolate source validator exceptions (002 §2.0, 004 §2.2/§2.5) — Refs #554

Validate plugin-owned schemas on a private copy so frozen valid schemas remain
usable and validation cannot annotate the registered schema. Convert schema
setup/evaluation exceptions into explicit per-monitor rejection diagnostics through
the existing validation channels; never treat an exception as valid config or
abort healthy siblings, tick cleanup, or hook refresh. Tests-first real-source and
SQLite regressions cover malformed patterns, frozen schemas, ordinary controls,
retained baseline/cursor/held notify state, and recovery after correction. Existing
source-schema format, result types, cadence sizing and accepted #561/#562 deferral
remain unchanged; no ownership/lifetime repair is implemented here.

