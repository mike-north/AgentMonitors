## 2026-11-12 — Runtime snapshot races remain report-only (004 §2.13; Refs #611)

Clarify that disappearance and replacement during directory or symlink reads are
runtime observations, including same-type identity changes. They must not fail a
suite or combine metadata from different entries. Strict installation-path and
foreign-holder evidence rules remain unchanged.

