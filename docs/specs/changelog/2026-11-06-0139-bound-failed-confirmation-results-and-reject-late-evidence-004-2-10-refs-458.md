## 2026-11-06 — Bound failed confirmation results and reject late evidence (004 §2.10) — Refs #458

An asynchronous confirmation failure releases held driver readers and returns its error
without waiting for the failed group to close inherited pipes. Confirmation checks its
absolute budget before and after asynchronous queries, between proc reads, and before
accepting success. Pending supported queries are aborted best-effort and the verdict is
raced against the existing deadline; this does not claim synchronous kernel-I/O interruption.
No normal diagnostic-drain policy, deadline, facility boundary, or production source changed.

