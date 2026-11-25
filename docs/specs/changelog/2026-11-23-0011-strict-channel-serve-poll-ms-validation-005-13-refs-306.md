## 2026-11-23 — Strict `channel serve --poll-ms` validation (005 §13) — Refs #306

`--poll-ms` previously went through `parseInt(value) || 3000`, so negative values, partly
numeric strings and fractions were silently truncated, out-of-range values reached
`setTimeout` (which clamps them to 1 ms), and an explicit `0` became the default. The flag now
accepts only plain decimal digits from 100 to 2147483647. Any other value is rejected with a
one-line stderr diagnostic and exit code 1 before the MCP server starts. Omitting the flag
still means 3000 ms. A shared CLI parser (`apps/cli/src/integer-option.ts`) holds the rule;
other numeric flags keep their current ranges.

