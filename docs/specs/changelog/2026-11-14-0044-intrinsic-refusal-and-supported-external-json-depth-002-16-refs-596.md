## 2026-11-14 — Intrinsic refusal and supported external JSON depth (002 §16) — Refs #596

Reject native intrinsic brands before accepting record prototypes, including when
those prototypes have been replaced. Cap caller-selected maximum depth at 512
and refuse unsupported configurations with TypeError before inspecting input.
Keep the inclusive limit, scalar leaves and state/envelope depths 32/34. Add
explicit scalar byte vectors and specify lossless lone-surrogate escaping.

