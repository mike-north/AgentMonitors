## 2026-07-19 — `command-poll` drains excess stdout/stderr instead of killing the command (003 §11.2) — Refs #302

Clarifies the drain-not-kill contract for `command-poll`'s 1 MiB stdout cap, and documents an
independent stderr retention cap. An earlier implementation used `execFile({ maxBuffer })`, which
kills the child the instant either stream crosses the cap and reports the overflow as a truncated
success with a fabricated zero exit code — losing the command's real exit status, mislabeling
stderr-only overflow as stdout truncation, and potentially baselining a command that never actually
finished its side effects. §11.2 now states explicitly that neither stream's retention cap is ever a
kill trigger: both streams are consumed as they arrive (never buffered to completion), stdout retains
its leading 1 MiB, stderr is bounded independently to a small cap sized for diagnostics, and the
command always runs to its real completion with its real exit code reported.

- No schema or persisted-shape change — `payload`/`snapshot`/`nextState` still carry
  `{ command, exitCode, strategy, stdout, truncated }`; only the mechanics behind that `exitCode` and
  `truncated` are now spelled out.
- §11.7 gains four verification bullets: an overflow-then-side-effect-then-nonzero-exit case, a
  large-stderr/small-stdout case, a simultaneous-large-stdout-and-stderr case, and a
  keeps-writing-past-both-caps case that must still resolve promptly rather than hang the tick.

