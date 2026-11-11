---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
---

Keep an observation that was dropped because the retry outbox could not retain it visible until a later observation of that monitor completes cleanly. `monitor explain` now fails at the materialization stage and `doctor` fails the monitor's check, naming the error. The doctor report and its JSON add `unretainedObservationLoss`. The history row for a dropped observation now records its position in the span, its `objectKey` and its `title`, as bounded, control-free text, and never its payload.
