---
'@mike-north/core': minor
---

Add a standalone consumer smoke test and narrow the published core type surface so external consumers can install and typecheck `@mike-north/core` without leaking Drizzle implementation types.

This release also removes the `schema` re-export from `@mike-north/core` and makes `InboxDb` an opaque public type instead of exposing the concrete Drizzle database type.
