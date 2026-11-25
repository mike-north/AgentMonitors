## 2026-11-01 — Durable snapshot materialization order across writers (002 §5.2/§15, 004) — Refs #293

Snapshot predecessor selection now uses a private SQLite AUTOINCREMENT sequence rather
than wall-clock timestamps and process-local monotonic ULIDs. Equal-clock independent
writers and clock reversals can no longer select an older retained snapshot. Public
snapshot IDs/results are unchanged; allocation remains inside materialization atomicity.

Legacy tables rebuild transactionally, preserving row data and explicit indexes/triggers.
Current hidden rowid order is the stated bootstrap policy, not a claim to reconstruct
historical chronology or regenerate old diffs. Specs document rollback, deletion,
VACUUM/reopen, concurrent migration, and older-reader limitations. Tests use genuine
independent process factories and verify the adjacent diff predecessor. Event/history
ordering is outside this snapshot repair.

