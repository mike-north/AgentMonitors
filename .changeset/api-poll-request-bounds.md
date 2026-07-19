---
'@agentmonitors/source-api-poll': patch
---

Bound `api-poll` request duration, response size, and composite concurrency so a stalled or huge
endpoint can no longer wedge a tick, delay unrelated monitors, or exhaust daemon memory. A single
request/body deadline (default `30s`, overridable per-monitor via the new `timeout` scope field)
now bounds the entire exchange — connecting, headers, and streaming the body — including a
stalled/trickling chunked body, not just the initial `fetch()` call. Response bodies are capped at
10 MiB, checked both as an early rejection against a declared `Content-Length` and, since
`Content-Length` can be absent or wrong, via a streamed running count that is the real authority.
Composite mode (`change-detection.composite`) now runs at most 5 parts concurrently instead of
starting every part at once, with the same per-part deadline and byte cap as a single-URL monitor.
A timeout or oversize response errors the observation cleanly (no `nextState` advance, no partial
body baselined or persisted) — the same semantics as an existing non-2xx or network-error failure.
