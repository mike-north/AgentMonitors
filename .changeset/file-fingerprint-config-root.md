---
'@agentmonitors/core': minor
'@agentmonitors/source-file-fingerprint': patch
'@agentmonitors/cli': patch
---

`file-fingerprint` project monitor globs now resolve relative paths from the runtime workspace/config root instead of the daemon process cwd.

Core now passes `workspacePath` to source observation contexts and records a distinct `no-files-matched` observation outcome when a source can tell that a zero-observation run matched no files. The bundled `file-fingerprint` source uses that context for relative `globs` and relative `cwd`, while preserving absolute `cwd` values and absolute glob patterns. `agentmonitors monitor test` now derives the same config root from the supplied `MONITOR.md` path so dry-runs match daemon ticks.
