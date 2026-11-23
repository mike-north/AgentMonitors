---
'@agentmonitors/core': minor
---

`createDb()` now creates durable storage for external event receipts, per-object sequence
high-water marks, and database compatibility markers, separate from source checkpoint state.
Nothing writes these tables yet. Opening a database that already has them keeps their rows,
replaces the earlier compatibility-marker index so global and empty-string workspace identities
stay distinct, and refuses a table shape the current schema cannot use without changing the
database. Several processes opening one fresh database at the same time now all succeed instead
of one failing with `SQLITE_BUSY` while enabling write-ahead logging.
