## 2026-11-14 — External JSON crypto representation and inherited hooks (002 §16) — Refs #596

Select the crypto representation from a genuine key at module load. Symbol-backed
Node 24 refuses keys at the own-symbol gate and never invokes property-reading
crypto wrappers, preserving hook freedom after inherited symbol getters are added.
Private-brand Node 24 runs crypto predicates after full descriptor/child validation.
Pin first-invalid-child and accessor errors before key refusal through both entry
points on both representations.

