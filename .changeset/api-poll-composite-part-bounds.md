---
'@agentmonitors/source-api-poll': patch
---

Bound composite part count, part-id length, and the rendered artifact (issue #304 review, third
round): the cumulative byte budget added in the prior round summed only response-body bytes, so it
never bounded the composite's request count, the assembled artifact's per-part framing overhead, or
worst-case tick duration. A reviewer reproduced both 100,000 empty-body parts (0 cumulative body
bytes, 100,000 requests, a 1.7 MB baseline) and a single empty-body part with an 11 MiB `id` (an
11.5 MB baseline) sailing past the existing check. `change-detection.composite.parts` is now capped
at 50 entries and each part's `id` at 256 characters — enforced identically in the JSON Schema
(`agentmonitors validate` rejects it at authoring time) and the parser (defense in depth for a
hand-edited `MONITOR.md`) — which also bounds worst-case tick duration to
`ceil(parts / 5) * timeout`. The cumulative byte budget now sums each part's _rendered_ framed
section (`## <id>\n<body>`, matching the final snapshot text) rather than the raw body, so id
overhead counts toward it too.
