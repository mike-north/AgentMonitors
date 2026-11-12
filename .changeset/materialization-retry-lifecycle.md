---
'@agentmonitors/core': minor
---

Add bounded retry backoff, terminal re-arm, summary, and atomic completion operations. Completion owns synchronous event materialization rather than accepting callbacks, rejects terminal work until rearmed, and preserves retained work on failure. Expose typed lifecycle errors, keep retry diagnostics single-line, and round persisted deadlines upward so delays never shorten.
