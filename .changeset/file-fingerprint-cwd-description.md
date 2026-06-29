---
'@agentmonitors/source-file-fingerprint': patch
---

Clarify the file-fingerprint `cwd` schema description.

The source schema now says omitted `cwd` defaults to the workspace/config root, that relative `cwd`
values resolve against that root, and that absolute `cwd` values are used as-is. This metadata is
visible through `agentmonitors source list`.
