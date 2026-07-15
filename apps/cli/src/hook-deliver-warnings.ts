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
 *
 * `session_id` comes from untrusted stdin JSON, and this line is emitted
 * unconditionally — so the id is forced into a single-line, control-safe
 * form: `JSON.stringify` escapes newlines, tabs, ESC, and every other C0
 * control character, and a follow-up pass escapes what `JSON.stringify`
 * leaves raw — DEL, the C1 controls (U+0080–U+009F, e.g. CSI), and the
 * U+2028/U+2029 line/paragraph separators (terminal/log injection; same
 * C0/C1 concern as hook-deliver-render.ts's sanitize). The length bound
 * keeps a pathological payload from flooding stderr.
 */
export function describeUnknownHostSessionWarning(
  hostSessionId: string,
): string {
  const MAX_ID_LENGTH = 128;
  let truncated = hostSessionId;
  if (hostSessionId.length > MAX_ID_LENGTH) {
    // Cut at a code-point boundary, not a raw UTF-16 index: a `slice` can
    // split a surrogate pair, leaving a lone surrogate that renders as a
    // garbled \ud83d-style escape (same rationale as hook-deliver-render.ts's
    // truncateForCap).
    let out = '';
    for (const ch of hostSessionId) {
      if (out.length + ch.length > MAX_ID_LENGTH) break;
      out += ch;
    }
    truncated = `${out}…`;
  }
  // JSON.stringify only escapes C0 controls (< U+0020), quotes, and
  // backslashes. DEL, the C1 controls, and U+2028/U+2029 pass through raw —
  // and a raw CSI (U+009B) or line separator still breaks the "one
  // control-safe line" contract. Escape them ourselves; none of these code
  // points can appear inside an escape sequence JSON.stringify already
  // produced, so a post-pass over the serialized string is safe and keeps
  // the output a valid, round-trippable JSON string.
  const escaped = JSON.stringify(truncated).replace(
    // eslint-disable-next-line no-control-regex -- escaping controls is the point
    /[\u007f-\u009f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `hook deliver: no session registered for host session id ${escaped}`;
}
