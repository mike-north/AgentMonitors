---
'@mike-north/source-incoming-changes': minor
---

Add new bundled observation source plugin `@mike-north/source-incoming-changes`. Reports per-file diffs when a git ref advances (pull, merge, fast-forward, or local commit) touching configured path prefixes. Uses the last-seen commit SHA as a durable resumption token so restarts and offline periods accumulate the net diff correctly.
