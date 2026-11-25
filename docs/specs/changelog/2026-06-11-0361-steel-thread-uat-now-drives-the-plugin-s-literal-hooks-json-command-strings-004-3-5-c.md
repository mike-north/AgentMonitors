## 2026-06-11 — Steel-thread UAT now drives the plugin's literal `hooks.json` command strings (004 §3.5 config-drift coverage)

Follow-up to the steel-thread entry below (issue #89, review point 2 of #83, deferred at merge). The
existing steel-thread UAT drives `['session','start']` / `['hook','deliver']` as **argv** with
hand-built stdin — it proves the CLI's stdin contract but skips the seam the #83 bug actually lived
in: the mismatch between the plugin's `hooks.json` command **strings** and that contract (the
now-removed vestigial `&& agentmonitors hook deliver` chain was dead precisely because the first
command had already consumed stdin — invisible to an argv-level test).

A new **plugin hooks.json config-drift UAT** (`apps/cli/src/commands/cli.integration.test.ts`) closes
that gap: it parses the real
[`agent-plugins/agentmonitors/hooks/hooks.json`](../../../agent-plugins/agentmonitors/hooks/hooks.json)
at test time (no copies) and runs each `SessionStart` / `UserPromptSubmit` / `SessionEnd` command
**verbatim** through `/bin/sh -c`, with an `agentmonitors` PATH shim satisfying the commands' own
`command -v agentmonitors` guard. It asserts the same end-to-end outcomes as the steel thread (daemon
boots + session registers; the dropped monitor's body arrives as `additionalContext`; session
deregisters; no orphan daemons) plus the missing-CLI fallback branch (empty PATH → the printed
fallback JSON parses and carries the `npm i -g @agentmonitors/cli` install hint). The test therefore
fails if a command string drifts incompatibly (a flag re-added, the binary renamed, the chain
broken), if the stdin contract regresses, or if the fallback emits invalid JSON. Recorded as a new
[004 §3.5](../004-validation-testing.md) scenario row.

- Test-and-spec only — no implementation or published-package behavior change, so no changeset.

