## 2026-07-14 — `hook deliver` warns on stderr, unconditionally, for an unresolvable `session_id` (005 §12.2/§12.2.1, 006 §5.2/§5.2.1) — Refs #329

`agentmonitors hook deliver` exited 0 with byte-empty stdout when the hook payload's `session_id`
matched no tracked AgentMon session — identical to the _expected_ empty output during the ~15s
high-urgency claim-settle window (002 §9.1). Issue #334 already added `--debug` for exactly this
class of ambiguity, but it is opt-in; an operator who does not know to reach for `--debug` cannot
tell "will never resolve" from "still settling" and ends up polling forever against a session that
can never deliver.

- **006 §5.2 step 6 / 005 §12.2 step 5 — changed (current).** When no tracked session matches the
  payload's `session_id`, the command now ALSO writes one line to **stderr**, unconditionally (not
  gated behind `--debug`): `hook deliver: no session registered for host session id "<id>"`. Stdout
  and the exit code are byte-for-byte unchanged — the Claude Code host never sees this line.
- **006 §5.2.1 / 005 §12.2.1 — clarified (current).** Documents this as the ONE quiet-return branch
  that is not silent by default, and why: every other branch (disabled workspace, unreachable
  daemon, settle-window hold, nothing pending, …) either resolves itself or reflects a genuinely
  idle state, so those remain `--debug`-gated exactly as issue #334 shipped them. An unresolvable
  `session_id` cannot resolve on its own, which is what makes silence there actively misleading
  rather than merely uninformative.
- **Implementation:** `apps/cli/src/hook-deliver-warnings.ts` (new) holds the pure line formatter,
  deliberately kept separate from `hook-deliver-debug.ts` (issue #334) since that module's lines are
  ALL gated behind `--debug` — a different concern from an always-on diagnostic. `apps/cli/src/commands/hook.ts`
  writes the line to `process.stderr` directly in the `!match` branch, before the existing (still
  `--debug`-gated) `describeNoSessionMatch` diagnosis.
- **No behavior change to stdout, exit codes, or the settle-window/holding branches** — those stay
  exactly as silent as before; only the never-resolvable unknown-session branch gained a signal.

