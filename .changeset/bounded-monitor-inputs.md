---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Bound monitor files to 1 MiB through shared bounded reads in direct parsing and production scans, tags to 256 entries, and derive rules to 128 before element validation. Exported collection schemas now preprocess admission, and parse errors optionally carry INPUT_LIMIT_EXCEEDED. Bound daemon requests to 1 MiB, 1000 entries per collection, 10000 values, and depth 32 before schema validation or runtime mutation. Rejected requests return a structured wire error without affecting existing sessions.
