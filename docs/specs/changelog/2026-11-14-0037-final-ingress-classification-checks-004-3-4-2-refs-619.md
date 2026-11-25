## 2026-11-14 — Final ingress classification checks (004 §3.4.2) — Refs #619

Require diagnostic drains after the final tick, after watch consumption and at
cleanup, including child stop. A caught late audit write must fail with its SQL;
cleanup must retain an existing scenario failure alongside classification errors.
Validation coverage only; runtime behavior and public contracts are unchanged.

