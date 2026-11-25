## 2026-11-25 — Preserve navigation in specification history (004 §6.0) — Refs #669

Entry files now store inline file links relative to their own directory. Assembly
rebases those destinations to the specification directory, restoring historical
link text without changing the recorded headings or assembled bodies. The ignored
generated view lives alongside the numbered specifications so its links resolve.
Regression tests check entry navigation, assembled navigation at the documented
location, and the existing byte-preservation contract.

