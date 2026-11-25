## 2026-07-14 — Fresh-environment install-to-first-signal E2E, hooks path (004 §2.7, §3.5) — Refs #276

Added a new validation surface: a global-install, no-workspace-`node_modules` E2E proof
(`scripts/test-e2e-fresh-install-hooks.mjs`) that packs every publishable package, installs the
`agentmonitors` launcher from those tarballs into an isolated npm prefix, bootstraps a fresh
project with `agentmonitors init`, fires a `file-fingerprint` monitor, and confirms delivery
through the real `agentmonitors hook deliver` stdin/stdout contract ([006 §5](./006-agent-integration.md))
with a genuine `UserPromptSubmit` payload. Not a behavior change — the runtime/CLI contract is
unchanged; this closes a coverage gap (every other proof surface in 004 §2 runs inside the repo's
own workspace). Wired into CI per-PR (`.github/workflows/ci.yml`); measured runtime ~50-70s, in
line with the existing standalone-consumer step and the Docker-backed daemon tests
(`*.docker.test.ts`) that already run inside the generic Test step gating every PR.

Follow-up fixes from review: every CLI invocation now runs through the launcher package's own
installed entry point (`<prefix>/lib/node_modules/agentmonitors/bin/agentmonitors.cjs`) rather than
the `<prefix>/bin/agentmonitors` symlink, because `@agentmonitors/cli` and the `agentmonitors`
launcher both declare that bin name and npm's global install links it to whichever package sorts
first (`@agentmonitors/cli` always wins) — the symlink alone was silently testing the CLI's own
bin, never the launcher's `require.resolve` indirection this surface exists to prove. The baseline
sleep before mutating the watched file was replaced with a forced tick through the `daemon.tick`
socket method ([002 §10.4](./002-runtime-delivery.md), §10.5), which is deterministic rather than
racing the daemon's own poll interval.

