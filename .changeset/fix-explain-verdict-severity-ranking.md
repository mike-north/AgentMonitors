---
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
---

fix(explain): verdict selects highest-severity stage; materialization is pending during debounce

`explainVerdict()` previously picked the _first_ stage whose status was not `'ok'`. After
the `healthy` idle status was introduced in #98, a healthy Observation stage short-circuited
the scan and masked downstream `failure` or `pending` stages (#149 regression).

The verdict now selects the _highest-severity_ stage using the ranking
`failure > pending > healthy > ok`. A healthy or idle observation stage can never mask a
downstream fault.

Also fixes the Materialization stage status for the debounce-pending case: when the Notify
stage is holding a batch (`pending`), the Materialization stage now correctly reports
`pending`/⏳ rather than `failure`/✗ — the absence of materialized events is expected
behavior while the debounce settle window has not yet expired.
