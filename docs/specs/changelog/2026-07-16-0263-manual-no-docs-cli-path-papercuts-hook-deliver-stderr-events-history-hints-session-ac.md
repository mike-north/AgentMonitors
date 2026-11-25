## 2026-07-16 — Manual/no-docs CLI-path papercuts: hook-deliver stderr, events/history hints, session acks, scan exit code (005 §4, §10, §11, §12) — Refs #420

Six small, thematically-unified CLI-ergonomics fixes for the surface a user hits when driving
events/hooks by hand rather than via `verify` — making the manual/no-docs path self-explanatory. No
change to runtime notify/debounce timing, delivery semantics, or any hook **stdout** wire format.

- **§12.2 `hook deliver` — two new always-on stderr diagnostics (P1).** Alongside the existing
  unresolvable-`session_id` warning (#329), the command now writes one stderr line — **without
  `--debug`** — when the stdin payload carries no `session_id` (malformed / non-hook payload) or when
  `hook_event_name` maps to no delivery lifecycle. Both were previously silent-empty (exit 0),
  indistinguishable from "nothing pending" — the single most-repeated "looks broken, user gives up"
  moment on the manual path. **stdout stays byte-identical** and the exit code is unchanged; untrusted
  payload values are control-safe-escaped and length-bounded. The plugin only wires `hook deliver`
  into `UserPromptSubmit` with a well-formed payload, so neither fires in normal operation.
- **§11 `events list` / `events ack` — `--session` discovery hint (P2).** The bare `error: required
option '--session <id>' not specified` now gets a second stderr line, `Run \`agentmonitors session
  list\` to find a session id.`, and `--help` repeats the pointer. Default error line + exit
  unchanged.
- **§10.4/§10.5 `session start` / `session end` — success acks on stderr (P3).** On successful
  registration/deregistration each prints a one-line stderr ack (`AgentMon: session <id> registered;
daemon at <socket>` / `session <id> ended`). Silent success previously forced a second `session
list` to confirm. **stdout stays wire-clean** (`session start`'s recap JSON is untouched); the acks
  never fire on the quiet-exit paths.
- **§4 `scan` — meaningful exit code (P4).** Previously always exited 0. Now exits **0** on a clean
  scan (empty `errors` + empty `duplicateIds`, any format) and **1** when the scan surfaces a real
  problem (a parse error or a duplicate monitor id), so `scan && <next-step>` scripts are meaningful.
  A missing/invalid scan directory still exits 1 via the shared directory check.
- **§10 `monitor history` — `--dir` remediation, not a silent alias (P5).** `--dir` (the monitors
  directory, per `init`/`validate`/`monitor explain`) is a different concept from history's
  `--workspace` (the project root), so aliasing it would resolve the wrong workspace. Instead the
  `unknown option '--dir'` error gains a second stderr line pointing at `--workspace`.
- **getting-started + skill Phase-5 docs — durable-proof note for `verify --use-workspace-daemon`
  (P6).** The "presentable proof" recipe now states that `verify`'s synthetic PASS is a scratch probe
  and is **not** persisted as a durable event (so it won't appear in `events list`/`doctor`), and
  directs a security-proof user who wants a durable, queryable artifact to make one real edit + deliver
  it. Documentation-only; `verify`'s suppression behavior (Refs #418) is unchanged.

