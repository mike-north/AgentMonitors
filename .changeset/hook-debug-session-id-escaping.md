---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Harden `hook deliver --debug` so it never leaks a hostile stdin payload to the operator's
terminal/logs raw. The always-on unknown-session warning already control-safe-escaped and
length-bounded the untrusted `session_id` it renders; the `--debug` diagnosis path rendered the
same untrusted `session_id` / `hook_event_name` / `cwd` fields unescaped and unbounded on the
adjacent lines (`describePayload`, `describeUnmappedLifecycle`, `describeLifecycle`,
`describeWorkspace`, `describeWorkspaceDisabled`, `describeNoSessionMatch`). A hostile payload
(control characters, terminal escape sequences, U+2028/U+2029, or a multi-KB flood) reached stderr
raw whenever `--debug` was set. Both paths now share one rendering function
(`sanitizeUntrustedField`), so they cannot drift again. Only `--debug` stderr wording changes;
stdout and the exit code are unaffected in every mode.
