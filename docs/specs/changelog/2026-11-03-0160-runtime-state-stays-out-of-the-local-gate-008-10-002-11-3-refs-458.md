## 2026-11-03 — Runtime state stays out of the local gate (008 §10, 002 §11.3) — Refs #458

`pnpm check` failed in any checkout of this repo with an open session, because
`prettier --check .` read `.agentmonitors/sessions/<id>/hook-state.json`. CI never has that file.
`init` has ignored the directory in users' projects since #336, but this repo's own `.gitignore`
never had the rule.

- **008 §10 — extends "Local gate ≡ CI gate"** to files that exist only because a tool is running
  on this machine, and adds the guard to the test implications.
- **002 §11.3 — records the format-check consequence** of the `.gitignore` line, including that
  Prettier reads only the `.gitignore` in the directory it runs from.
- **No change to what the runtime writes or to `init`.** Only this repo's ignore rules and its
  guard change.

