---
'@agentmonitors/cli': patch
---

An explicit `--socket <path>` exceeding the AF_UNIX socket path length limit (100 characters) now prints a warning to stderr naming the requested path, the limit exceeded, and the substituted path before falling back to the hashed `/tmp/agentmonitors-<hash>.sock` socket — the substitution itself is unchanged, but it is no longer silent. `daemon run`, `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim`, `hook deliver` (only for an explicit `--socket`, not the `.local.md`-derived socket), `channel serve`, `monitor explain`, and `monitor history` all warn on an over-limit explicit `--socket`. Env-var, local-state, and default-derived candidates continue to hash silently, unchanged.
