---
'@agentmonitors/source-api-poll': minor
---

Add composite-observation mode to `api-poll` (003 §2.6)

`api-poll` can now assemble **one** observation from **many** sub-resource calls under a single `objectKey`. A monitor configures `change-detection.composite` with an `object-key` and a list of `parts` (each an `id` + `url`); `observe()` fetches every part within one cycle and reduces them into one stable, deterministic composite `snapshotText` (parts rendered sorted by `id`, so call ordering never churns the snapshot). The runtime diffs that single composite snapshot against the consumer's baseline exactly as it would a single-call snapshot — the source returns a current-state snapshot, never a pre-diffed delta (003 §2.5).

A failed underlying call fails the whole observation (the prior baseline is preserved); `change-detection.composite` and `change-detection.collection` are mutually exclusive. Backward compatible: the top-level `url` modes are unchanged, and a monitor with neither `url` nor `composite` is still rejected.
