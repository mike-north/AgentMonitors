## 2026-06-15 — CLI: `--format toon|json|text` with agent/human auto-detection on structured-output commands (#121)

**005 §1 (output formats), §4 (scan), §7.1 (source list), §11.1 (events list), §6 (monitor history / explain):**

- Added `toon` as a `--format` choice on all five structured-output commands (`events list`, `scan`, `monitor history`, `monitor explain`, `source list`). All three choices — `toon`, `json`, `text` — are now available on every command.
- **Default is auto-detected per invocation context** (via `is-agentic-tui`): agent-driven invocations (e.g. `CLAUDECODE=1`, `CURSOR_AGENT=1`) default to `toon`; interactive human terminals default to `text`. An explicit `--format` flag always overrides detection. Per-command `Default` column in §4, §6, §7.1, §11.1 updated to `auto (see §1)`.
- `--format json` output is **byte-for-byte identical** to the pre-change behaviour — no regressions for JSON consumers.
- TOON is a rendering-only transform at the CLI output edge. Durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire stay JSON everywhere.
- Round-trip safety: `decode(encode(value))` equals the original JSON value; asserted by tests for each command.
- Libraries: `@toon-format/toon@^2.3.0` (MIT, no deps) and `is-agentic-tui` (ISC, no deps). Both confirmed free of `new Function`/`Function(` — pass the CSP/Workers constraint.
- Layer B (delivered observation payload) is explicitly out of scope — deferred pending a standard-level design decision in §006 / the Monitor Standard.

