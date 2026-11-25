## 2026-11-12 — Keep retry repair IDs positional (002 §2.7; 005 §6, §15) — Refs #584

Repair suggestions from the tick report, explain and doctor put all flags before `--` and the
monitor/retry IDs after it. This current contract makes valid leading-hyphen monitor names such as
`-watcher` repairable without changing workspace scoping or shell quoting. Extra flags such as
`--format` and `--reason` also precede `--`. The CLI accepts the terminator through Commander.
Four regressions execute both repairs printed by explain and doctor verbatim through `/bin/sh`
from another directory, with a real terminal retry and persisted-state assertions. Previously these
suggestions failed with `unknown option '-watcher'`.

