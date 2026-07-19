---
'@agentmonitors/source-api-poll': patch
---

Fix review findings on the issue #304 request/response bounds: the declared-Content-Length
oversize rejection now aborts the request and releases the connection instead of leaking it;
`change-detection.strategy: status-code` monitors skip reading the response body entirely (and are
therefore exempt from the 10 MiB byte cap), fixing a regression where a large endpoint watched only
for its status transitions started erroring on every tick; a slow/failing composite part now fails
the whole batch immediately instead of waiting for every other in-flight part to reach its own
deadline, and cancels those siblings; a mid-body-read abort/teardown race is classified as the
documented "timed out" error instead of a raw undici error; and a `timeout: "0s"`-style zero-length
deadline is now rejected at parse/validation time instead of aborting every request instantly.
