---
'@agentmonitors/source-api-poll': patch
---

Redact credentials, query strings, and fragments from URLs surfaced in diagnostics. This now covers both the `json-diff` non-JSON warning and the non-2xx HTTP error messages (single-URL and composite-part), which are persisted durably to observation history — so a credential-bearing URL no longer leaks on the common 401/403 failure path.
