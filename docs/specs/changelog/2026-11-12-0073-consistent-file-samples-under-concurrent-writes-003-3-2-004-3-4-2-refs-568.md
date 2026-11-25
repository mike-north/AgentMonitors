## 2026-11-12 — Consistent file samples under concurrent writes (003 §3.2; 004 §3.4.2) — Refs #568

File fingerprints and snapshots now share one byte sample. Identity, size and high-resolution
metadata validation refuses detected concurrent writes without advancing the source checkpoint.
Reported size remains advisory for virtual files. A stable empty or partial file remains valid;
no writer-completion guarantee or retry is added.
The ingress fixture orders non-atomic input completion before each native-watch round and uses
state-only pulls for held-work flushes, avoiding synthetic truncate/write observations during
flush. Dedicated deterministic source tests cover read races and unchanged-content deduplication.

