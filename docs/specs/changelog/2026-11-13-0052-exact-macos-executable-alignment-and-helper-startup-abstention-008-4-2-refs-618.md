## 2026-11-13 — Exact macOS executable alignment and helper startup abstention (008 §4.2) — Refs #618

Use XNU's eight-byte target-pointer alignment after the executable path, excluding
the separately returned argc. Require exactly the calculated NUL padding before
counting nonempty argv entries; extra NULs, malformed padding and unproven envp
remain unreadable. Native path residues must retain marks and be reaped on restart,
while empty argv[0] at each residue retains an abstention. Synchronous helper spawn
errors follow the same scope-wide unavailable-evidence path as emitted errors.

