## 2026-07-15 — Test-bearing packages must fail on a zero-test suite (004 §2.8, new) — Refs #288

Every test-bearing package (`libs/core`, `apps/cli`, `apps/agentmonitors`, every
`plugins/source-*`) configured `passWithNoTests: true`, so an accidentally emptied, renamed away
from, or excluded test suite left that package's Nx `test` target reporting green instead of
failing — a silent, high-leverage false pass for a repo that relies on package-level suites as
executable evidence for durable-state and delivery invariants. Only `apps/cli`'s serial
daemon-spawn suite (`vitest.serial.config.ts`) already had this correctly
(`passWithNoTests: false`).

- **004 — new §2.8, "Suite-discovery integrity (zero-test guard)".** Every test-bearing package's
  vitest config MUST reject an empty/misconfigured run (vitest's own default,
  `passWithNoTests: false`) rather than opting into `passWithNoTests: true`. `apps/cli`'s default
  and serial suites additionally MUST partition the package's test files without overlap or gaps.
- **Fix (current).** Flipped `passWithNoTests` to `false` (explicit, matching the already-correct
  serial-config pattern) in `libs/core`, `apps/cli`, `apps/agentmonitors`, and all five
  `plugins/source-*` vitest configs. No intentionally-testless project exists among the current
  test-bearing packages, so no documented exception was needed.
- **Verified by** `scripts/vitest-pass-with-no-tests.test.ts`: dynamically imports every guarded
  vitest config (the real module `vitest run` loads, not a hand-parsed approximation of the file's
  source text) and asserts none resolve to `passWithNoTests: true`; the guarded set derives from
  the authoritative `PACKAGE_DIRS` list (`scripts/publish-release-packages.mjs`) plus the serial
  CLI config, so a newly added publishable package is covered automatically and can't silently
  reintroduce `passWithNoTests: true`. `scripts/cli-suite-partition.test.ts`: runs the real
  `vitest list --filesOnly --json` resolution against both `apps/cli` vitest configs and asserts
  the result partitions the package's git-tracked test files with no overlap or gaps. Empirically
  confirmed pre-fix behavior by temporarily emptying a plugin's test directory and observing
  `vitest run` exit 0 with `passWithNoTests: true`, then exit 1 once flipped to `false`.

