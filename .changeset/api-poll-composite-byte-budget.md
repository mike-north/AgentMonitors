---
'@agentmonitors/source-api-poll': patch
---

Bound the cumulative size of a composite observation (issue #304 review, second round): the
existing 10 MiB per-part cap and 5-worker concurrency bound each addressed a different risk, but
neither bounded the aggregate — a composite with many small parts (e.g. 12 x 1 MiB parts) could
still assemble and baseline a snapshot many times larger than any single-URL monitor's response,
persisted every tick. `api-poll` now tracks the running sum of every fetched part's body across one
composite and fails the whole observation (aborting every other in-flight part, same as a non-2xx
or oversized part) once the total exceeds the same 10 MiB figure. Also adopts core's hardened
`parseOperationTimeoutMs`: a present non-string `timeout`, a leading-zero duration (`"01s"`), and a
duration exceeding Node's `setTimeout` maximum (`"25d"`) are now all rejected at parse time instead
of silently defaulting, being accepted, or overflowing to a near-instant timer, respectively.
