## 2026-11-23 — Nx cache contract for package targets

004 §2.14 records which root configs, cross-project files and host facilities each cached
target hashes. Before this, editing `tsconfig.base.json` or a shared API Extractor config
replayed cached builds and checks, a CLI source edit replayed core's signal-inventory test,
and a host gaining or losing `jq` or Docker replayed a result recorded with different
coverage. The Nx daemon is disabled because it would reuse a stale host fingerprint.
`pnpm affected` documents the development path; `pnpm verify` remains the gate.

