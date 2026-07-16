/**
 * Pure line-formatting for `hook deliver`'s always-on (non-`--debug`) stderr
 * diagnostics (issues #329, #420 P1).
 *
 * `hook-deliver-debug.ts` covers `--debug`-gated diagnosis — every line there
 * is silent unless the operator opts in. This module is different in kind:
 * it formats the lines that `hook deliver` writes to stderr on EVERY
 * invocation that hits the relevant branch, regardless of `--debug`. `hook
 * deliver`'s STDOUT contract stays unconditionally silent-on-idle (006 §5.1)
 * — the Claude Code host never sees stderr — but an operator polling
 * `hook deliver` manually while diagnosing a broken hook wire does.
 *
 * Scope is deliberately narrow: the three branches here are the ones whose
 * empty stdout is otherwise indistinguishable from "nothing pending" AND can
 * never resolve on their own —
 *   - a malformed / non-hook stdin payload (no `session_id`),
 *   - a `hook_event_name` that maps to no delivery lifecycle, and
 *   - an unresolvable host `session_id` (stale/mistyped; #329).
 * A payload that IS a real hook call but is merely held by the expected
 * high-urgency claim-settle window (the runtime debounces high-urgency
 * delivery for up to ~15s; empty output during that window is normal and MUST
 * NOT warn — 002 §9.1) stays silent, as does every other quiet-return branch
 * (disabled workspace, unreachable daemon, nothing pending, …), each of which
 * remains diagnosable via `--debug` (`hook-deliver-debug.ts`). The plugin only
 * wires `hook deliver` into `UserPromptSubmit` with a well-formed payload, so
 * none of these lines fire in normal operation — only on the manual/no-docs
 * path these diagnostics exist to unblock.
 *
 * @see ./commands/hook.ts (writes these lines to stderr, unconditionally, on
 *   the relevant branch)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */

/**
 * Force an untrusted string field from the stdin payload into a single-line,
 * control-safe, quoted form suitable for an unconditional stderr line. Any of
 * these lines can be emitted for a pathological / hostile payload, so the raw
 * value must never carry terminal escape sequences or line breaks.
 *
 * `JSON.stringify` escapes newlines, tabs, ESC, and every other C0 control
 * character (plus quotes and backslashes); a follow-up pass escapes what it
 * leaves raw — DEL, the C1 controls (U+0080–U+009F, e.g. CSI), and the
 * U+2028/U+2029 line/paragraph separators (terminal/log injection; same
 * C0/C1 concern as hook-deliver-render.ts's sanitize). The length bound keeps
 * a pathological payload from flooding stderr, and truncation cuts at a
 * code-point boundary (not a raw UTF-16 index) so a surrogate pair is never
 * split into a lone surrogate that renders as a garbled \ud83d-style escape
 * (same rationale as hook-deliver-render.ts's truncateForCap).
 */
function sanitizeUntrustedField(value: string): string {
  const MAX_LENGTH = 128;
  let truncated = value;
  if (value.length > MAX_LENGTH) {
    let out = '';
    for (const ch of value) {
      if (out.length + ch.length > MAX_LENGTH) break;
      out += ch;
    }
    truncated = `${out}…`;
  }
  // None of these code points can appear inside an escape sequence
  // JSON.stringify already produced, so a post-pass over the serialized string
  // is safe and keeps the output a valid, round-trippable JSON string.
  return JSON.stringify(truncated).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The hook payload's `session_id` did not match any AgentMon session tracked
 * by the daemon at this socket. Returned WITHOUT a trailing newline; the
 * caller (`hook deliver`) appends one when writing to `process.stderr`.
 * `session_id` comes from untrusted stdin JSON, so it is control-safe-escaped
 * (see {@link sanitizeUntrustedField}).
 */
export function describeUnknownHostSessionWarning(
  hostSessionId: string,
): string {
  return `hook deliver: no session registered for host session id ${sanitizeUntrustedField(hostSessionId)}`;
}

/**
 * The stdin payload carried no `session_id`, so it is not a real Claude Code
 * hook invocation, or the payload is malformed/empty. Emitted unconditionally
 * (issue #420 P1): silence here is otherwise indistinguishable from "nothing
 * pending," the single most-repeated "looks broken, user gives up" moment on
 * the manual/no-docs path. Returned WITHOUT a trailing newline; the caller
 * appends one. The plugin only ever wires `hook deliver` into events that
 * carry a `session_id`, so this fires only on the manual/malformed path, never
 * in normal operation.
 */
export function describeMalformedPayloadWarning(): string {
  return (
    'hook deliver: no session_id in the stdin payload — expected a Claude Code ' +
    'hook JSON payload on stdin; nothing delivered.'
  );
}

/**
 * The payload's `hook_event_name` did not map to a delivery lifecycle (only
 * `UserPromptSubmit`, `PostToolUse`, and `SessionStart` do). Emitted
 * unconditionally (issue #420 P1) for the same reason as
 * {@link describeMalformedPayloadWarning}: injecting additionalContext at an
 * unmapped event would be silently ignored by the host, so empty stdout is
 * otherwise mistaken for "nothing pending." `hook_event_name` comes from
 * untrusted stdin JSON, so it is control-safe-escaped. Returned WITHOUT a
 * trailing newline; the caller appends one. The plugin only wires
 * `hook deliver` into `UserPromptSubmit` (which maps), so this fires only on
 * the manual path.
 */
export function describeUnmappedLifecycleWarning(
  hookEventName: string | undefined,
): string {
  const name =
    hookEventName === undefined
      ? '(none)'
      : sanitizeUntrustedField(hookEventName);
  return (
    `hook deliver: hook_event_name ${name} does not map to a delivery ` +
    'lifecycle (only UserPromptSubmit, PostToolUse, and SessionStart do); ' +
    'nothing delivered.'
  );
}
