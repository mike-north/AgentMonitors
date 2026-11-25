## 2026-10-30 — Partial read-only Codex ownership diagnostic (006 §11.7) — Refs #316

Document the explicit-socket ownership diagnostic and its bounded refusal behavior. The tool
checks version, loaded identity, and workspace without session or turn mutations. It supplies
partial diagnostic evidence only: no existing desktop endpoint, delivery capability, lifecycle
mapping, or adapter support is established, and all Codex matrix cells remain target. Synthetic
socket tests are explicitly separate from the live probe evidence required by §11.6.

Adversarial repair: the success boundary also rejects failures observed after resolution of the
final read response, including additional complete frames in the same parsing turn. This is a
bounded snapshot guarantee, not a promise about later unobserved peer activity.

