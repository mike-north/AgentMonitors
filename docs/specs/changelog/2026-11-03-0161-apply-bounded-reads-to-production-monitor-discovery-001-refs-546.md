## 2026-11-03 — Apply bounded reads to production monitor discovery (001) — Refs #546

Route asynchronous scans through the same byte-budget reader as direct file
parsing. Previously scans allocated and decoded complete files before rejecting
them. Deterministic admission tests now observe scan read counts, descriptor
closure, oversized flat/folder diagnostics, exact-boundary acceptance, and valid
sibling results. Discovery retains asynchronous filesystem I/O.

