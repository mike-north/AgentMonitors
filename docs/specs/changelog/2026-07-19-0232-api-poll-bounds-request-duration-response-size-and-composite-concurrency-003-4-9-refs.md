## 2026-07-19 — `api-poll` bounds request duration, response size, and composite concurrency (003 §4.9) — Refs #304

Fixes a P1 daemon-availability defect: `api-poll` could wait forever on a stalled connection or
body, buffer an unbounded response into memory, and fan out an unbounded number of concurrent
requests in composite mode — any of which could wedge a tick, delay unrelated monitors, or exhaust
memory.

- **New §4.9 (request/body deadline, response size cap, composite concurrency).** A single
  `AbortController`-backed deadline (default `30s`, override via the new `timeout` scope field,
  duration string) now bounds the entire request/response exchange — not just the initial `fetch()`
  — including a stalled/trickling chunked body. A 10 MiB response body cap is enforced twice: an
  early rejection against a (trusted-but-not-authoritative) declared `Content-Length`, and a
  streamed running count that is the real authority. Composite mode (§2.6) now runs at most 5 parts
  concurrently (a bounded worker pool) instead of starting every part at once via `Promise.all`,
  with the same per-part deadline and byte cap as a single-URL monitor.
- **Errored-observation semantics preserved.** Both the deadline and the byte cap throw (not
  truncate-and-continue) — the runtime records an `errored` observation, `nextState` never advances,
  and any prior baseline is preserved, matching the existing non-2xx (§4.8) and network-error (§4.6)
  behavior. This is deliberately unlike `command-poll`'s stdout cap (§11.2), which truncates and
  still treats the capped output as a valid result — a stalled/incomplete HTTP body is not a
  meaningful baseline the way capped command output is.

