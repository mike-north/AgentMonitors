## 2026-11-13 — Retired verify-artifact repair interruption acceptance (#615)

- **004 §3.4.2:** include the registered retired-artifact branch of both retry
  repairs in traced SIGKILL and write-fault coverage under all three pacing modes.
  Require coherent cleanup without events, snapshots, loss or error history,
  successful cleanup controls and a cleanup-DELETE mutation that fails the proof.
- Trace skip's legacy retry branch without an admission position: the loss INSERT
  uses the event high-water mark. Require both interruption modes and coherent skip
  recovery under each pacing policy.
- Rejected missing, nonterminal and wrong-route repairs have no durable writes.
  Validation coverage only; product behavior and public contracts are unchanged.

