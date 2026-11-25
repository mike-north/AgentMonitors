## 2026-07-15 — `file-fingerprint` filters directory entries from glob matches (003 §3.2) — Refs #377

A globstar pattern like `docs/**` matches the directory entry `docs/` itself, in addition to every
path under it — `glob`'s documented globstar behavior, not a pattern-authoring mistake. The source
previously passed every matched path (including directory entries) to `fs.readFile`, crashing with
an unhandled `EISDIR` the first time an author wrote the most natural "watch a folder" glob. Two
independent usability-evaluation subjects hit this as their top blocker.

- **003 §3.2 — behavior fix (current).** `expandGlob` now calls `globSync` with `nodir: true` (in
  addition to the existing `absolute: true`), for both `globs` and `ignore` expansion. Directory
  entries never enter the matched-files set, so `docs/**` behaves as "every file under `docs/`,
  recursively" and no longer crashes. This is a **fix**, not a new contract: the intended behavior
  was always "hash the files a glob matches," and a directory was never meant to be treated as a
  file to hash. `nodir` alone is incomplete: it is `lstat`-based, so a symlink whose target is a
  directory survives it unfiltered. A second, `stat`-based (symlink-following) directory check
  (`isDirectory`) now runs immediately before hashing each matched path, closing that gap so the
  same `EISDIR` can't recur via a symlinked directory.
- **003 §3.2 — clarification (current).** A glob that matches only directory entries (e.g. an empty
  directory watched with `**`) already fell into the existing `no-files-matched` outcome path once
  directory entries are filtered — this was already specified as a healthy non-error outcome, and no
  contract change was needed there.
- **CLI diagnosability (`apps/cli/src/commands/monitor-test.ts`).** `agentmonitors monitor test`'s
  `no-files-matched` message now names the configured `watch.globs` value (e.g. `No files matched this monitor's globs (globs: **/*.ts). Check watch.globs and watch.cwd relative to workspace: <path>`),
  so an author can tell "bad glob" from "no changes since baseline" without opening `MONITOR.md`.

