---
'@agentmonitors/cli': patch
---

Fix `agentmonitors doctor`'s `lead-session` remediation recommending a command that fails as printed.
It previously suggested `agentmonitors session open --role lead --workspace <path>`, but `session
open`'s `--host-session-id` is a required option — so copy-pasting the hint failed immediately with
`error: required option '--host-session-id' not specified`, and a manual/no-plugin CLI user has no
meaningful value to supply for it. The remediation now points at `agentmonitors session start` — the
flagless lazy-boot path that matches real usage (the `SessionStart` hook runs exactly this command):
it boots the project daemon if needed and registers a lead session in one shot, and has no required
options. For the manual case the hint prints the exact stdin payload `session start` reads, with a
`manual-cli-session` placeholder, so the printed command runs verbatim.
