## 2026-11-14 — Portable external JSON brands and explicit input domain (002 §16) — Refs #596

Refuse genuine crypto keys across symbol-backed and private-slot Node 24 runtimes,
using captured crypto predicates only after full record descriptor/child checks.
Specify deterministic gate ordering and the trusted-runtime capture assumption.
Refuse Headers and Intl Segments with hook-free, state-preserving probes. Exclude
FormData because its inspector can call stored array methods and mutate values.
Replace the detection-limit claim with a tested refusal list and non-exhaustive
examples outside the plain-data domain. Keep crypto-symbol accessor cases only on
runtimes that expose that representation; always run the genuine-key matrix.

