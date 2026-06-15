---
'@agentmonitors/cli': minor
---

feat(cli): add `--format toon|json|text` with agent/human auto-detection to structured-output commands (issue #121, Layer A)

Adds TOON (Token-Oriented Object Notation, `@toon-format/toon@^2.3.0`) as a `--format` option on the five structured-output commands — `events list`, `scan`, `monitor history`, `monitor explain`, and `source list`.

- `--format toon`: compact, human-readable encoding designed for LLM context windows; ~40% fewer tokens for typical monitor output shapes; round-trips losslessly to the identical JSON value
- `--format json` output is **byte-for-byte unchanged** — no regressions for existing JSON consumers
- `--format text` human-readable columnar output (unchanged)
- **Default auto-detected per invocation context** via `is-agentic-tui`: agent-driven invocations (Claude Code, Cursor, Gemini CLI, etc.) default to `toon`; interactive human terminals default to `text`; explicit `--format` always overrides
- TOON is a rendering-only transform at the CLI output edge; durable storage (SQLite, IPC wire) stays JSON
- Layer B (delivered observation payload) is out of scope — deferred pending a standard-level design decision
