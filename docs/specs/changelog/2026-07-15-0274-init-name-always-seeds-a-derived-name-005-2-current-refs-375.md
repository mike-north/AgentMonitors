## 2026-07-15 — `init <name>` always seeds a derived `name:` (005 §2 current) — Refs #375

`init <name>`'s scaffold path previously left `name:` as the chosen `--type`'s literal template
placeholder (`My monitor`, `Upstream branch monitor`, …) whenever `--name` was omitted, so a
rushed author could commit a monitor that was never renamed to describe what it watches.

- **005 §2 — current.** `--name` is no longer the only way `name:` gets seeded: when omitted, the
  scaffold now derives a readable value from the positional `[name]` (`-`/`_`-separated segments
  joined with spaces, first segment capitalized — e.g. `watch-docs` → `Watch docs`) and seeds that
  instead. `--name` still overrides with its own value, verbatim. This only affects the named
  scaffold path (`init <name>`); the bare bootstrap path (`init`, no name) is unaffected, per the
  issue #330 non-goal that bootstrap scaffolding stays untouched by seed-flag work.
- **005 §2 — current.** The `command-poll` template's inline comment previously warned that local
  commands "such as `git status`" can stay stale until a fetch — backwards advice that
  contradicted the `skill.md` authoring guide's own recommended minimal `command-poll` example,
  `git status --porcelain`. The comment now scopes that staleness caveat to a local read of a
  remote-tracking ref (e.g. `git rev-parse origin/main`); the scaffold's own `git ls-remote`
  queries the remote live and is always current, and `git status --porcelain` is local
  working-tree state with no fetch lag — so the comment no longer discourages a correct,
  guide-recommended setup.

