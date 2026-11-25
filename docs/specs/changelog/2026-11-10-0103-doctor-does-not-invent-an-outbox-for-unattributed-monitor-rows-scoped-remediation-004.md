## 2026-11-10 — Doctor does not invent an outbox for unattributed monitor rows; scoped remediation (004, 005) — Refs #496

Doctor attributes each retry outbox once. A monitor row whose id has an orphan group claims no
count: JSON omits `materializationRetries` and the text rollup shows `retry-outbox=orphaned`. Any
other row without a summary, including a duplicated id with no retained work and every row of an
older daemon report that carries no orphan groups, gets the empty summary (`0/0`). Retained-work remediation names
`monitor explain` with `--workspace`/`--dir` when doctor was given non-default values. 004 now
describes the retry CLI suite as running the shared Nx-built bundle, not an owned package layout.

