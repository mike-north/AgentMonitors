---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Existing monitors with config rejected by their source schema now stop observing intentionally. Runtime ticks and continuous watcher startup validate before source effects; daemon output, monitor explain and doctor show the same diagnostic as validate. Correct the reported config to resume using the retained source baseline and pending notify work, including after restart.

Tick `skippedMonitors` entries now include either `validationError` for invalid config or `nextDueAt` for a valid monitor that is not yet due. Consumers must check which field is present before reading a due time.

Source-config validation uses a private schema copy so valid frozen source schemas work without mutation. Validator setup/evaluation exceptions now reject only the affected monitor with an explicit diagnostic, allowing healthy siblings, tick cleanup and watcher startup to proceed. Baselines, cursors and pending notify work are retained until the schema is corrected.
