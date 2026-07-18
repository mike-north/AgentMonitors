---
'@agentmonitors/core': patch
---

Fix `diffText` for `change-detection.strategy: json-diff` objects to render a structural diff
(added/removed/changed elements or key paths) instead of a compact-JSON line diff. Previously, a
single-line JSON snapshot (e.g. `gh pr list --json` output) losing or gaining one array element
rendered as a whole-line remove-all/add-all, since the line-based renderer saw the entire array
serialized onto one line. `json-diff` objects now render via the new `buildJsonDiff`, which diffs
arrays of objects by element identity (a stable-key heuristic, then deep-equality matching) with an
index-based fallback for non-object arrays, bounded to 20 diff entries. `text-diff`/`exit-code`/
omitted-strategy objects are unaffected. New public export: `buildDiff`.
