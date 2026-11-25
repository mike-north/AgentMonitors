## 2026-11-11 — The ordering rebuild carries every column it does not define (002 §5.2/§15, 004) — Refs #569

The rebuild that adds the private `sequence` key to `monitor_events` and `monitor_snapshots`
copied a fixed column list. A database whose table held another column lost that column's
values, and if an index referenced it, recreating the index failed and rolled the open back on
every attempt, so the daemon could not start. 0.0.1–0.3.0 created `monitor_events.event_kind`,
which later versions stopped creating without removing it. The rebuild now derives its target
from the live table: current columns take their current definitions, and every other column is
carried with its values, declared type and default (keeping `NOT NULL` only with a default), so
every index and trigger is recreated unchanged and none is dropped. A rebuild that cannot carry a
row or column (a generated column; `NULL` in a required column) reports a `SchemaMigrationError`
naming the table and column, and the database is left unchanged. 004 adds a released-layout
suite that opens each layout released versions produced.

