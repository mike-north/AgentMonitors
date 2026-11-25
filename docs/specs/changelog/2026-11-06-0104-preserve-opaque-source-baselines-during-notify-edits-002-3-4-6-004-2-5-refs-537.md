## 2026-11-06 — Preserve opaque source baselines during notify edits (002 §3/§4.6, 004 §2.5) — Refs #537

Clarify the existing source-state ownership rule for guard-only resets and held drains: effective
policy adoption updates notify metadata and materialization artifacts without reserializing raw
source state, clearing fingerprints or changing observation clocks. Require tick/startup and
full-reopen proofs of the next actual source's previousState, clock-only scheduling in fixtures,
real notify-write rollback and a narrow broad-setter reversion. Ordinary ingestion/checkpoint
semantics and ordinary flush recovery remain separate.

