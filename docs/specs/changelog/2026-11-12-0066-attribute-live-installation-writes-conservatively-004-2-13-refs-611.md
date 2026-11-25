## 2026-11-12 — Attribute live installation writes conservatively (004 §2.13; Refs #611)

Replace the unconditional-diff failure rule with a per-file exception for the same
pre-run foreign process holding an existing regular file at both snapshots.
Read-only process/open-file inspection must prove identity and outside lineage;
unknown inspection stays strict. Descriptor identity must match the snapshot,
including when macOS reports a replaced predecessor under the same name.
Creation/removal/replacement and unheld changes
still fail. Diagnostics name PID, command, and files. Document the shared-held-file
blind spot and isolation's primary role. Acceptance now reports whole inventories
and the comparison excluding exactly those diagnosed files, without claiming the
whole installation stayed byte-identical while its daemon was active.

