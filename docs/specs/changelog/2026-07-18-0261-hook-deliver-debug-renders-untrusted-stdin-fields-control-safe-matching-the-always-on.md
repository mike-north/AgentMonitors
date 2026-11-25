## 2026-07-18 — `hook deliver --debug` renders untrusted stdin fields control-safe, matching the always-on warning (005 §12.2.1, 006 §5.2.1) — Refs #365

The always-on unknown-session warning (#329/#362/#363) JSON-string-escapes and length-bounds the
untrusted `session_id` it renders. The `--debug` diagnosis path (`hook-deliver-debug.ts`) interpolated
the SAME untrusted stdin fields — `session_id`, `hook_event_name`, and `cwd` — raw, on the adjacent
lines: `describePayload`, `describeUnmappedLifecycle`, `describeLifecycle`, `describeWorkspace`,
`describeWorkspaceDisabled`, and `describeNoSessionMatch`. A hostile payload (control characters,
terminal escapes, U+2028/U+2029, or a multi-KB flood) reached the operator's stderr raw whenever
`--debug` was set. Both specs now document that every untrusted field a `--debug` line interpolates
gets the identical rendering as the always-on warning. Implementation: the escaping/bounding logic
moved out of `hook-deliver-warnings.ts` into a new shared module
(`apps/cli/src/hook-deliver-sanitize.ts`, `sanitizeUntrustedField`/`sanitizeUntrustedFieldOrNone`) so
the always-on and `--debug` paths share one definition of "render untrusted id safely" rather than
risk drifting again.

