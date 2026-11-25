## 2026-07-19 — Composite cumulative byte budget, `timeout` non-string/leading-zero/overflow validation (003 §4.1/§4.9, 004 §3.2) — Refs #304

Second round of review follow-ups on the #304 bounds, in the same PR before merge.

- **Composite cumulative body-byte budget (§4.9).** The per-part 10 MiB cap and the 5-worker
  concurrency bound each addressed a different risk, but neither bounded the AGGREGATE size of an
  assembled composite: a composite with many small parts (the reported case: 12 × 1 MiB parts,
  each individually far under the per-part cap) could still assemble and baseline a
  `snapshotText`/`nextState` many times the size of any single-URL monitor's response, persisted
  every tick. `api-poll` now tracks the running sum of every fetched part's body length across one
  composite and fails the whole observation — aborting every other in-flight part via the same
  shared `AbortSignal` the concurrency bound already uses — once the total exceeds the same 10 MiB
  figure (reused as a cumulative budget, not a second configurable knob).
- **`timeout` rejects a present non-string value instead of silently defaulting (§4.9/§11.1).**
  `parseOperationTimeoutMs` previously treated ANY non-string `timeout` — including a genuinely
  present but wrong-typed one (`timeout: 123`, `timeout: null`) — the same as an omitted field,
  silently falling back to the 30s default. Only `undefined` (truly omitted) now defaults; any
  other non-string value throws a descriptive error.
- **`timeout` rejects a leading zero, matching the schema pattern (§4.9/§11.1).** The JSON Schema
  `pattern` (`^[1-9]\d*[smhd]$`) has always required a non-zero leading digit, but
  `parseOperationTimeoutMs` called `parseDuration` directly, whose own `\d+` digit group happily
  accepted a leading zero (`"01s"`) — a schema/parser mismatch where a schema-valid config could
  behave differently than the same string parsed standalone. The parser now rejects a leading zero
  too, a deliberate validation tightening (also applies to `command-poll`, which shares the same
  helper — see its changeset).
- **`timeout` rejects a value exceeding Node's `setTimeout` max (§4.9/§11.1).** A duration like
  `"25d"` (2,160,000,000ms) exceeds the 32-bit signed `setTimeout` maximum
  (`2_147_483_647`ms, ~24.8 days); Node does not throw for an over-range delay, it silently
  overflows to a ~1ms timer (with a `TimeoutOverflowWarning`), firing almost immediately instead of
  the author's intended deadline. `parseOperationTimeoutMs` now rejects any value above the max.
  The JSON Schema `pattern` is a pure string grammar and cannot express this numeric bound, so this
  one check is parser-only — a documented, narrow schema/parser gap, not a parity bug.
- **§4.1's scope example and optional-field inventory now include `timeout`** (previously present
  in the schema and §4.9 but missing from the canonical example/field list), and 004 §3.2 gained
  required-scenario rows for the request/body deadline, the body cap's `status-code` exemption, and
  composite concurrency/fail-fast/cumulative-budget, closing a traceability gap between the #304
  bounds and their required-test-scenario inventory.

(Verified: `plugins/source-api-poll/src/index.ts`, `MAX_COMPOSITE_BYTES`, `observeComposite`;
`plugins/source-api-poll/src/index.test.ts`, "composite cumulative byte budget (issue #304 review,
second round)"; `libs/core/src/notify/notifier.ts`, `parseOperationTimeoutMs`,
`MAX_OPERATION_TIMEOUT_MS`; `libs/core/src/notify/notifier.test.ts`;
`plugins/source-command-poll/src/schema-parity.test.ts`.)

