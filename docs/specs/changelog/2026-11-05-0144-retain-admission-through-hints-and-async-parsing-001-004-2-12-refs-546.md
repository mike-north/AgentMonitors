## 2026-11-05 — Retain admission through hints and async parsing (001, 004 §2.12) — Refs #546

Optional validation diagnostics must not bypass bounded monitor intake: skip hints
for admission errors and use the shared bounded reader for ordinary-error hints,
even if a file grows or is replaced after discovery. Export the existing synchronous
reader for this composition and record its API. Collection declarations must be raw
arrays; reject non-array Promise/thenable inputs before preprocessing can unwrap
them or visit elements/compile CEL. Preserve exact array boundaries, ordinary type
diagnostics, native Shape guards, and legacy-hint controls.

