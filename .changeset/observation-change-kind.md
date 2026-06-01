---
'@mike-north/core': minor
'@mike-north/source-file-fingerprint': minor
---

Add a source-agnostic `changeKind` to the observation model. `Observation` gains an optional `changeKind` field (exported `ChangeKind` type: `created` | `modified` | `deleted` | `descoped`), and the runtime copies it into the materialized event's `queryScope.changeKind` so it is filterable without each source duplicating it. `deleted` (object destroyed upstream — information lost) and `descoped` (object still exists upstream but left the monitor's scope) are deliberately distinct.

`file-fingerprint` is the first emitter: it now reports `created`, `modified`, `deleted`, and `descoped` observations (stat-ing the path to distinguish a true disk deletion from a file that merely no longer matches the globs), instead of only `modified`. The baseline run still emits nothing.
