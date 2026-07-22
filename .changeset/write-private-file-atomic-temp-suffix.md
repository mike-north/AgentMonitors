---
'@agentmonitors/core': minor
---

`writePrivateFileAtomic` accepts an optional `tempSuffix` option, distinguishing the temp file used
during the atomic write (default: none, same as before). `apps/cli`'s transport-heartbeat writer
previously re-forked this exact atomic-write sequence (owner-only directory, `O_EXCL` temp file,
rename) solely to use a `.<pid>` temp suffix instead of the fixed one, so two transports refreshing
the same heartbeat record concurrently wouldn't race on the same temp path. It now calls the shared
helper instead of maintaining its own copy.
