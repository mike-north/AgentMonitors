---
'@agentmonitors/cli': minor
---

feat(cli): add `--format toon` to structured-output commands, default to TOON (issue #121, Layer A)

Adds TOON (Token-Oriented Object Notation, `@toon-format/toon@^2.3.0`) as a `--format` option on the five structured-output commands — `events list`, `scan`, `monitor history`, `monitor explain`, and `source list` — and changes their default from `text` to `toon`.

- `--format toon` (new default): compact, human-readable encoding designed for LLM context windows; ~40% fewer tokens for typical monitor output shapes
- `--format json` output is **byte-for-byte unchanged** — no regressions for existing JSON consumers
- `--format text` is still available and unchanged
- TOON is a rendering-only transform at the CLI output edge; durable storage (SQLite, IPC wire) stays JSON
- Round-trip safety: `decode(encode(value))` returns the identical JSON value (asserted in tests)
- Layer B (delivered observation payload) is out of scope — deferred pending a standard-level design decision
