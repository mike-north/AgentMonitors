## 2026-07-19 — `api-poll`/`command-poll` timeout hardening and composite fail-fast fix (003 §4.9/§11.1) — Refs #304

Follow-up review fixes on top of the #304 bounds below, in the same PR before merge.

- **`status-code` is exempt from the byte cap (§4.9).** The response byte cap was enforced before
  `resolveStrategy`, so a `status-code` monitor watching a large endpoint (the body is irrelevant to
  that strategy — only the status transition is watched) regressed to erroring on every tick once
  the cap shipped. `api-poll` now skips reading the body entirely when
  `change-detection.strategy` is explicitly `status-code`, releasing the unread response back to
  the connection pool instead of buffering or counting it — cheaper, and exempt from the cap by
  construction. The inferred-strategy path (§4.2) is unaffected: inference never resolves to
  `status-code`, so it always reads the body.
- **Declared-Content-Length rejection no longer leaks the connection (§4.9).** The early-rejection
  path threw without aborting the request or releasing the response body, unlike the streamed-count
  path (which already aborted); undici kept the socket open with the unconsumed body pending — one
  leaked connection per tick, multiplied by up to 5 in composite mode. Both oversize paths now abort
  symmetrically.
- **Composite concurrency fails fast and cancels doomed siblings (§4.9).** The bounded worker pool
  only checked a shared failure flag _between_ items, so a part that failed instantly (e.g. a 401)
  still waited for every other in-flight sibling to reach its own full per-part deadline before the
  composite surfaced the failure — re-lengthening exactly the tick this bound exists to shorten. The
  pool (now its own module, `map-with-concurrency.ts`) races a dedicated failure promise against the
  worker pool and hands every part a shared `AbortSignal`, so the batch rejects the instant the
  first part fails and cancels every other in-flight part instead of letting them run to completion.
- **Mid-body abort classification hardened (§4.9).** `readBoundedBody`'s catch now also checks
  `controller.signal.aborted` (mirroring `fetchBody`'s own fallback), so an HTTP/2 or
  socket-teardown race that rejects a mid-body read with a raw `TypeError: terminated` (instead of
  the `AbortError` the timer itself produces) is still classified as the documented "timed out"
  error rather than leaking the raw undici error.
- **Zero-length `timeout` is rejected (§4.9/§11.1).** `timeout: "0s"` (or `"0m"`/`"0h"`/`"0d"`)
  previously passed both the JSON Schema `pattern` and `parseDuration`, producing a deadline that
  aborts every request/command before it can ever complete. A new core-level helper,
  `parseOperationTimeoutMs` (exported next to `parseDuration`, alongside
  `DEFAULT_OPERATION_TIMEOUT_MS` and the updated `OPERATION_TIMEOUT_PATTERN`,
  `^[1-9]\d*[smhd]$`), now backs the `timeout` field for **both** `api-poll` and `command-poll` —
  replacing each plugin's previously hand-maintained, byte-for-byte-identical copy of the
  default/parse/pattern — and rejects a zero-length value up front with a descriptive error at
  both validation and observe time.

(Verified: `libs/core/src/notify/notifier.ts`, `parseOperationTimeoutMs`; `libs/core/src/notify/notifier.test.ts`;
`plugins/source-api-poll/src/index.ts`; `plugins/source-api-poll/src/map-with-concurrency.ts`;
`plugins/source-api-poll/src/index.test.ts`; `plugins/source-api-poll/src/map-with-concurrency.test.ts`;
`plugins/source-command-poll/src/index.ts`; `plugins/source-command-poll/src/schema-parity.test.ts`.)

