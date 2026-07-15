/**
 * Pure line-formatting for `hook deliver`'s always-on (non-`--debug`) stderr
 * diagnostics (issue #329).
 *
 * `hook-deliver-debug.ts` covers `--debug`-gated diagnosis — every line there
 * is silent unless the operator opts in. This module is different in kind:
 * it formats the ONE line that `hook deliver` writes to stderr on EVERY
 * invocation that hits the relevant branch, regardless of `--debug`. `hook
 * deliver`'s STDOUT contract stays unconditionally silent-on-idle (006 §5.1)
 * — the Claude Code host never sees stderr — but an operator polling
 * `hook deliver` manually while diagnosing a broken hook wire does.
 *
 * Scope is deliberately narrow: an unresolvable host `session_id` is the ONE
 * quiet-return branch that is otherwise indistinguishable from the expected
 * high-urgency claim-settle window (the runtime debounces high-urgency
 * delivery for up to ~15s; empty output during that window is normal and
 * MUST NOT warn — 002 §9.1). A stale or mistyped `session_id`, by contrast,
 * can never resolve, so silence there misleads an operator into polling
 * forever against a session that will never deliver. Every other
 * quiet-return branch (disabled workspace, unreachable daemon, settle
 * window, nothing pending, …) stays silent by default and remains
 * diagnosable via `--debug` (`hook-deliver-debug.ts`).
 *
 * @see ./commands/hook.ts (writes this line to stderr, unconditionally, when
 *   no tracked session matches the hook payload's session_id)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */

/**
 * The hook payload's `session_id` did not match any AgentMon session tracked
 * by the daemon at this socket. Returned WITHOUT a trailing newline; the
 * caller (`hook deliver`) appends one when writing to `process.stderr`.
 */
export function describeUnknownHostSessionWarning(
  hostSessionId: string,
): string {
  return `hook deliver: no session registered for host session id "${hostSessionId}"`;
}
