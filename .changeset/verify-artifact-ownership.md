---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Keep `verify --use-workspace-daemon` scratch files out of later sessions after any delay, restart or config repair.

The run now registers exact ownership of its scratch file with the workspace daemon before creating it. Once the run finishes, or its session ends or is reaped, the daemon retracts the verified monitor's events for that file and drops that monitor's later observations of it, including held work, with no expiry. Legitimate changes, other workspaces and real watched paths are unaffected, and sibling monitors that happen to watch the scratch path are not covered. Against an older daemon, verify falls back to the previous time-limited cleanup.

Core adds `AgentMonitorRuntime.registerVerifyArtifact`, `requestVerifyArtifactCleanup` and `listVerifyArtifacts`, the `VerifyArtifactRecord`, `RegisterVerifyArtifactInput`, `VerifyArtifactCleanupResult` and `VerifyArtifactCleanupCause` types, and an additive `verify_artifacts` table. The session reaper no longer installs a time-limited suppression for scratch-named paths it did not see registered.
