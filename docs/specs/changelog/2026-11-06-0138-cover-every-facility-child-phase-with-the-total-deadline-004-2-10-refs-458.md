## 2026-11-06 — Cover every facility-child phase with the total deadline (004 §2.10) — Refs #458

The existing total deadline bounds the verdict before direct-child exit as well as
through pipe closure and group confirmation. A successful timeout SIGKILL request
without exit cannot leave the helper blocked: expiry returns a visible error,
releases readers and unreferences the direct-child handle while retaining lifecycle
error handling. This is not proof of termination or synchronous kernel interruption.
The cleanup reservation, timeout budgets, owned boundary and production sources are unchanged.

