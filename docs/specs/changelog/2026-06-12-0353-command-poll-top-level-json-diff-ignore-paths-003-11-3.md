## 2026-06-12 — `command-poll` top-level json-diff ignore paths (003 §11.3)

Resolved issue #106 in [003 §11](../003-source-plugins.md): plain `command-poll` `json-diff`
monitors may now set top-level `change-detection.ignore-paths` to remove noisy fields before output
comparison, without requiring keyed-collection mode.

- **Behavior:** `change-detection.ignore-paths: [duration]` under `strategy: json-diff` suppresses
  changes that only affect the parsed JSON `duration` field, while changes to non-ignored fields
  still emit the ordinary command-output `modified` observation.
- **Validation:** `command-poll` `change-detection` now has an explicit allow-list. Unknown keys
  such as `bogus-nonsense-key` fail `agentmonitors validate` instead of validating cleanly and
  silently no-oping. Top-level `ignore-paths` is valid only with `strategy: json-diff`.
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the plain `json-diff`
  suppression path, and `apps/cli/src/commands/cli.integration.test.ts` covers rejection of unknown
  `change-detection` keys.

