## 2026-11-12 — Spec 004 gap markers reconciled with shipped coverage; gap-drift check (004 §3.0/§3.1/§3.5/§5.1; roadmap) — Closes #287

The three remaining gap markers in 004 described coverage that already exists: `low` urgency
acceptance (T1), the `schema generate` command wire-up and `session list`/`session close` (T4).
Each now cites the exact test file and `describe › it` names. The §5.1 mismatch bullet that said the
`low` loop omits `low` is corrected; the duplicate-ID and source-validation bullets already matched
the code. No genuine gap remains, so no marker is open.

New §3.0 defines tracked gap ids (`T<n>`) and the marker convention, and the roadmap's "Test gaps"
list uses the same ids. `scripts/spec-gap-drift.test.ts` (in `pnpm test:scripts`) fails when the
roadmap lists a gap closed while a numbered spec still carries its marker, when a marker has no id,
or when a spec cites a test file that does not exist.

