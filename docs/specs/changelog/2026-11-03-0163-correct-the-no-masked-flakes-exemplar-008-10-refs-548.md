## 2026-11-03 — Correct the no-masked-flakes exemplar (008 §10) — Refs #548

Replace #506 as the fixed exemplar. It widened an assertion to accept `write EBADF`, which hid a test
closing a descriptor twice. #548 removes that double close and narrows the assertion again. The contract
text is unchanged.

