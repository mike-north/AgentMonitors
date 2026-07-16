---
'@agentmonitors/cli': patch
---

Fix `agentmonitors init`'s post-scaffold guidance recommending an unreachable resource. Both the
named `init <name>` scaffold path and the bare `init`/`init --yes` bootstrap path previously named
only the `setup-monitors` skill's "Verify It Fires" section as the "full fire-and-deliver recipe" — a
dead end for a no-plugin/no-docs CLI user, who has no way to reach that skill. The guidance now
recommends `agentmonitors verify <name> --dir <dir>` (appending `--manual` for any `--type` other
than `file-fingerprint`, since `verify`'s auto-trigger today only fabricates a change for
`watch.globs`-based sources) — a real, CLI-only command that proves the monitor delivers end-to-end
in one shot. The `setup-monitors` skill reference is kept, but now clearly labeled as a
Claude-Code-plugin-only supplement alongside `verify`, never the only pointer.
