## 2026-06-15 — monitor explain verdict uses severity ranking, not first-non-ok (005 §6.4, regression #149)

`explainVerdict()` previously selected the _first_ stage whose status `!== 'ok'`. After the `healthy`
idle status was introduced in #98, a healthy Observation stage (not `'ok'`) short-circuited the scan
and masked a downstream `failure` or `pending` stage (#149 regression).

**Fix (005 §6.4):** the verdict now selects the _highest-severity_ stage. Severity order:
`failure(3) > pending(2) > healthy(1) > ok(0)`. A `healthy` or `ok` observation stage can never
mask a downstream fault. The `verdict.status` field in JSON output may now be `"healthy"` for a
fully idle monitor (spec corrected from `"ok|pending|failure"` to `"ok|pending|healthy|failure"`).

**Related fix (005 §6.4):** when the Notify stage is `pending` (debounce/throttle holding a batch)
and no event has materialized yet, the Materialization stage now reports `pending`/⏳ instead of
`failure`/✗ — the absence of materialized events is correct behavior when the notify layer is
holding, not a fault.

