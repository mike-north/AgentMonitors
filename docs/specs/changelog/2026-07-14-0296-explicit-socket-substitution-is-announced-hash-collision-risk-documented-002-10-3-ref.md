## 2026-07-14 — Explicit `--socket` substitution is announced; hash-collision risk documented (002 §10.3) — Refs #337

`resolveSocketPath()` now takes a `ResolveSocketPathOptions.explicit` flag. When a caller-supplied
override came from a literal `--socket` CLI flag (as opposed to `AGENTMONITORS_SOCKET`, a
`.claude/agentmonitors.local.md`-derived value, or the computed default) and the resolved path
exceeds the 100-character AF_UNIX limit, one warning line is now printed to stderr naming the
requested path, the limit exceeded, and the substituted path, before the existing hash-fallback
substitution proceeds unchanged. `daemon run`, `daemon status`, `daemon stop`, `session open/close/
list`, `events list/ack`, `hook claim`, `hook deliver` (only when `--socket` — not the
`.local.md`-derived socket — is the over-limit value), `channel serve`, `monitor explain`, and
`monitor history` all thread this through their own `--socket` flag. Env/default/local-state-derived
candidates continue to hash silently (unchanged).

Acceptance criterion 3 (stale-daemon safety for hash collisions) is satisfied at its documented
minimum bar rather than its preferred bar: the daemon IPC does not expose a single "this daemon's
workspace" identity a caller could check against without breaking the already-supported case of one
daemon serving sessions for multiple workspaces on the global default DB (§10.2), so an automatic
"error on workspace mismatch" was scoped out as a follow-up rather than risk a false-positive
regression. The risk itself, and why a wider fix needs a real per-daemon workspace handshake, is
documented in §10.3.

- **Proof:** `apps/cli/src/daemon-ipc.test.ts` — `resolveSocketPath()` unit coverage (explicit
  over-limit warns with requested/limit/substituted path; explicit under-limit is silent; non-explicit
  over-limit stays silent as before). `apps/cli/src/commands/cli.integration.test.ts` — a real
  `daemon run --socket <over-limit path>` subprocess: the pre-fix silent substitution now fails, and
  the stdout "listening on" line (§10.2) is unchanged.
- Patch changeset: `@agentmonitors/cli` (new stderr diagnostic on an existing CLI code path; no
  behavior change to what socket is ultimately used).

