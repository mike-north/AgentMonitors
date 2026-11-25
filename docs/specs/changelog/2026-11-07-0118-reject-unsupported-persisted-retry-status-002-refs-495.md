## 2026-11-07 — Reject unsupported persisted retry status (002) — Refs #495

Retry diagnostics now fail explicitly before constructing a summary when an exact-route row
contains an unsupported persisted status. Lifecycle remains `pending`/`terminal`; rows and private
envelopes remain unchanged. The status TEXT annotation does not validate SQLite reads. The reducer
previously allowed malformed values to corrupt summary fields; this does not establish a failure
from supported writers. Owned on-disk regression tests cover `records`, `bytes`, `blocked`, reopen,
valid totals, workspace isolation, and useful control-stripped diagnostic text. No new public API,
status, schema policy, automatic repair, or arbitrary secret redaction is introduced.

