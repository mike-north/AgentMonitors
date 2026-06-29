---
'@agentmonitors/source-api-poll': minor
'@agentmonitors/cli': patch
---

`api-poll` infers the change-detection strategy from the response `Content-Type` (Refs #230)

`change-detection.strategy` is now **optional**. When it is omitted, `api-poll` infers the strategy
from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
`+json` suffix, e.g. `application/ld+json`) → `json-diff`; everything else — `text/html`,
`text/plain`, or a missing/unknown `Content-Type` → `text-diff`. The common "watch a web page" case is
now zero-config: drop the `change-detection` block entirely and the source picks `text-diff` for an
HTML page and `json-diff` for a JSON API automatically.

**An explicit `change-detection.strategy` always wins** — it is used verbatim, with no inference and no
Content-Type override (user specification is absolute). An explicit `json-diff` against an HTML page
stays `json-diff` (and still triggers the existing #219 json-diff-on-non-JSON warning); an explicit
`text-diff` against a JSON body stays `text-diff`. The #219 warning now fires **only** for the explicit
`json-diff` case — an inferred strategy never warns, because inference picks `json-diff` solely for JSON
`Content-Type`s and so never mismatches the body.

The `api-poll` scaffold (`agentmonitors init --type api-poll`) and the authoring docs now show the
zero-config "watch a page" example and document that `change-detection` is optional and inferred, with
an explicit override honored. No public-type change.
