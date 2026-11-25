## 2026-08-13 — Failed materialization has a bounded durable retry outbox (002 schema, 004 §3.4, 005 §15) — Refs #295, #481

Core now persists failed stored-observation envelopes in a workspace-scoped, per-monitor outbox
before a later runtime change adopts it for source ticks. Batch enqueue is capacity-atomic at 256
records or 8 MiB. Envelopes must round-trip through JSON without conversion, trusted routes are
checked before mutation, and safe errors are control-stripped and bounded. The lifecycle layer adds
fixed retry delays, terminal state after five failures, explicit re-arm, and transaction-coupled
completion so a thrown materialization cannot delete its durable retry. Operator diagnostics follow
with bounded id/status/attempt/error/timestamp metadata in core reports; stored envelopes and
payloads never cross that reporting boundary. `monitor explain` renders those records, `doctor`
names the exact monitor command and fails for pending or terminal work, and reports from older
daemons default to an empty outbox instead of breaking the CLI.

