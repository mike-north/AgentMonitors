---
'@agentmonitors/source-file-fingerprint': minor
---

`file-fingerprint` now emits `salience: 'high'` for `deleted` observations (file removed from disk — information permanently lost) and no `salience` for `created`, `modified`, or `descoped` observations. This makes RANGE urgency (`urgency: normal..high`) reachable end-to-end with a bundled source: a deletion fires at `high` urgency within the band; all other changes remain at the band floor (`normal`). Monitors with a bare scalar `urgency` are unaffected (backward compatible).
