---
'@agentmonitors/source-api-poll': minor
---

Bound `api-poll` request duration, response size, and composite fan-out so a stalled or huge
endpoint can no longer wedge a tick, delay unrelated monitors, or exhaust daemon memory. Minor, not
patch: the new `timeout` scope field is additive public authoring surface (precedent: the earlier
`api-poll` composite option was likewise classified `minor — new authoring surface`).

- A single request/body deadline (default `30s`, overridable per-monitor via the new `timeout`
  scope field) now bounds the entire exchange — connecting, headers, and streaming the body,
  including a stalled/trickling chunked body — not just the initial `fetch()` call. A declared-
  oversize `Content-Length` is rejected early and aborts the request instead of leaking the
  connection; a `change-detection.strategy: status-code` monitor skips reading the body entirely and
  is exempt from the byte cap.
- Response bodies are capped at 10 MiB via a streamed running count (the real authority once
  `Content-Length` is absent or wrong, not just the early `Content-Length` check).
- Composite mode (`change-detection.composite`) runs at most 5 parts concurrently instead of
  starting every part at once, with the same per-part deadline and byte cap as a single-URL
  monitor; a failing/timed-out part fails the whole batch immediately and cancels its siblings
  instead of waiting for every in-flight part to reach its own deadline.
- The per-part cap alone didn't bound the _aggregate_: a composite is now also bounded on every
  other axis — a cumulative 10 MiB budget across the rendered (framed) artifact, `parts` capped at
  50 entries, and each part `id` capped at 256 Unicode code points — enforced identically in the
  JSON Schema (rejected at authoring time by `agentmonitors validate`) and the parser (defense in
  depth for a hand-edited `MONITOR.md`), which also bounds worst-case tick duration to
  `ceil(parts / 5) * timeout`.
- Adopts core's hardened `parseOperationTimeoutMs`: a present non-string `timeout`, a leading-zero
  duration (`"01s"`), and a duration exceeding Node's `setTimeout` maximum (`"25d"`, now rejected by
  the JSON Schema `pattern` too — see the `@agentmonitors/core` changeset) are all rejected at parse
  time instead of silently defaulting, being accepted, or overflowing to a near-instant timer.
- A timeout, oversize response, or over-budget composite errors the observation cleanly (no
  `nextState` advance, no partial body baselined or persisted) — the same semantics as an existing
  non-2xx or network-error failure.
