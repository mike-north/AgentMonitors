---
'@agentmonitors/source-api-poll': minor
'@agentmonitors/source-command-poll': minor
'@agentmonitors/source-file-fingerprint': minor
'@agentmonitors/source-incoming-changes': minor
'@agentmonitors/source-schedule': minor
---

Re-export `ChangeKind`, `JsonSchema`, `Observation`, `ObservationContext`, `ObservationResult`,
`ObservationSource`, and `Urgency` (all from `@agentmonitors/core`) from each package's own entry
point.

Every bundled source's default export is typed `ObservationSource`, but that type — and the core
types its interface shape transitively references — were previously reachable only via
`@agentmonitors/core` directly, not from the source package itself. Enabling API Extractor's report
generation (issue #285) surfaced this as `ae-forgotten-export` warnings embedded in each package's
checked-in API report; re-exporting resolves it with a clean signature. No runtime behavior changes.
