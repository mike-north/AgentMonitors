## 2026-07-14 — Plugin manifest must not re-reference the auto-discovered hooks/hooks.json (006 §hooks transport)

Claude Code auto-loads a plugin's conventional `hooks/hooks.json` and **rejects** a manifest
`hooks` entry that resolves to that same file ("Duplicate hooks file detected"), which failed the
plugin's hook load on install. The manifest `hooks` field may only name _additional_ hook files.

- **006 — clarified (current).** The lifecycle hooks remain authored as host-native
  `hooks/hooks.json`, but the doc now states the file is auto-discovered and that a manifest
  reference to it is a load-failing duplicate.
- **Implementation.** Removed `"hooks": "./hooks/hooks.json"` from
  `agent-plugins/agentmonitors/.claude-plugin/plugin.json`. Regression coverage added to the
  plugin config-drift UAT (`apps/cli/src/commands/cli.integration.test.ts`): the suite parses the
  real manifest and fails if any `hooks` reference resolves to the auto-discovered path.

