---
'@agentmonitors/source-file-fingerprint': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fix a crash in `file-fingerprint` when a `watch.globs` pattern matches a directory entry.
Globstar patterns like `docs/**` match the directory `docs/` itself, in addition to every file
under it; the source previously tried to `fs.readFile` that directory entry and crashed with an
unhandled `EISDIR`. Directory entries are now filtered out before fingerprinting, so `docs/**`
behaves as "every file under `docs/`, recursively" and no longer crashes.

`agentmonitors monitor test`'s "no files matched" message now names the configured `watch.globs`
value, so authors can tell a genuinely bad glob apart from a glob that matched files with no
changes since baseline.
