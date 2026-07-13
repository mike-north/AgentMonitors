---
'agentmonitors': patch
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
'@agentmonitors/source-api-poll': patch
'@agentmonitors/source-command-poll': patch
'@agentmonitors/source-file-fingerprint': patch
'@agentmonitors/source-incoming-changes': patch
'@agentmonitors/source-schedule': patch
---

Declare the supported Node runtime and complete npm package metadata on every published package.
Each package now declares `"engines": { "node": ">=24" }` — a floor at Node 24, the version CI tests — so
an install on an unsupported Node release gets an actionable npm compatibility warning instead of
an opaque runtime/native-addon failure. Each package also declares consistent
`repository`/`bugs`/`homepage` metadata (pointing at its subdirectory of this repo) and ships a
`README.md`, and the root README states the Node 24 requirement in its install instructions. The
release-collateral validation run by `pnpm publish:packages:dry-run` (and CI's `publish-dry-run`
job) now fails loudly if any published package is missing `engines.node`, `repository`, `bugs`,
`homepage`, `README.md`, or `LICENSE`.
