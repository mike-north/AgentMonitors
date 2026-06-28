---
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Teach the inline pipeline idiom for `command-poll` (003 §11.1)

`command` remains argv-only (spawned with `shell: false` — no injection surface), but the common
mistake of writing a shell pipeline as a bare string is now self-correcting: `parseScopeConfig`
rejects a string `command` with a message that names the supported inline form,
`['sh', '-c', '<pipeline>']`, and the `init --type command-poll` scaffold documents it in a comment.
No behavior change for existing argv monitors; this only improves the error and the template.
