## 2026-11-03 — Test-run build ownership and first-attempt launcher gate (004 §2.9) — Refs #547

Remove the launcher suite's blanket retry after tracing the failure it masked to a real race: a CLI
integration test ran `pnpm build`, whose clean step removed `apps/cli/dist` while the concurrent
launcher suite executed it. The contract now forbids a test from starting a package build, makes the
CLI's test targets depend on `build`, and requires the launcher to pass on its first attempt. Its
unknown-subcommand assertion requires the CLI's own error, because a load failure also exits 1.
Its subprocess bound drops from a nominal 30s, which vitest's 5s test timeout already overrode
without evidence, to 4.5s, so overruns report their status and output.

