---
'@agentmonitors/source-api-poll': minor
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

`api-poll` change-detection robustness: non-2xx responses error instead of baselining, and `json-diff` warns on non-JSON bodies (Refs #219, #220)

**Non-2xx responses are now errored observations, not silent baselines (#220).** Previously
`api-poll` established its change-detection baseline from **any** HTTP response body, including a
`401` from a missing/invalid bearer token or a `500` error page — so a misconfigured-auth monitor
appeared to "work" while silently diffing error pages. For the `text-diff` and `json-diff` strategies,
a non-2xx status now throws a status-bearing error (`api-poll received HTTP <status> from <url> —
check auth/url; not establishing a baseline on an error response`). The runtime records the tick as
`errored` (no baseline advance, prior baseline preserved), `daemon once`/`run` report it,
`monitor history` shows `errored`, and `monitor test` reports `Observation failed: … HTTP <status>`.
2xx responses baseline/diff exactly as before. **Exception:** the `status-code` strategy still treats
a non-2xx as a legitimate observed signal (the status is the watched object), so 200 → 5xx detection
is unchanged.

**`json-diff` against a non-JSON body now warns (#219).** When `change-detection.strategy: json-diff`
is configured but the fetched body does not parse as JSON, the source attaches a non-fatal warning to
the `ObservationResult` (the new optional `ObservationResult.warnings` field) and `agentmonitors
monitor test` prints it, steering the author to `text-diff` for HTML/plain-text pages instead of
silently degrading to text comparison. The `api-poll` scaffold (`agentmonitors init`) and the
authoring docs now state strategy-by-content-type inline: `text-diff` for HTML/plain pages, `json-diff`
for JSON APIs.
