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
 * Scope is deliberately narrow: the four branches here are the ones whose
 * empty stdout is otherwise indistinguishable from "nothing pending" AND can
 * never resolve on their own —
 *   - a malformed / non-hook stdin payload (no `session_id`),
 *   - a `hook_event_name` that maps to no delivery lifecycle,
 *   - an enabled workspace with no per-workspace socket configured (#389 P2), and
 *   - an unresolvable host `session_id` (stale/mistyped; #329).
 * A payload that IS a real hook call but is merely held by the expected
 * high-urgency claim-settle window (the runtime debounces high-urgency
 * delivery for up to ~15s; empty output during that window is normal and MUST
 * NOT warn — 002 §9.1) stays silent, as does every other quiet-return branch
 * (disabled workspace, unreachable daemon, nothing pending, …), each of which
 * remains diagnosable via `--debug` (`hook-deliver-debug.ts`).
 *
 * The no-per-workspace-socket branch is NOT manual-only (issue #389 review
 * finding 6, correcting an earlier claim here): `session start`'s own
 * SessionStart-hook lazy boot can time out mid-session, leaving the workspace
 * enabled with no socket persisted — the SAME shape as a workspace that has
 * never had a session start at all. {@link describeNoSocketWarning} covers
 * the latter (a genuinely manual/no-docs invocation); {@link
 * describeBootFailedNoSocketWarning} covers the former, reading `.local.md`'s
 * `lastBootFailureAt` marker (`local-state.ts`) to tell the two apart and
 * pointing at automatic retry rather than a manual override. Every OTHER
 * branch in this module remains genuinely manual-only — the plugin only wires
 * `hook deliver` into `UserPromptSubmit` with a well-formed payload, so a
 * malformed payload, an unmapped lifecycle, or an unresolvable session_id
 * only ever occur on that manual/no-docs path.
 *
 * @see ./commands/hook.ts (writes these lines to stderr, unconditionally, on
 *   the relevant branch)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */

import { sanitizeUntrustedField } from './hook-deliver-sanitize.js';

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
 * The workspace is enabled but has no per-workspace socket to connect to —
 * neither `--socket` nor a `socket:` entry in `.claude/agentmonitors.local.md`
 * — so `hook deliver` refuses to fall back to a shared default socket (that
 * would cross workspace isolation). Emitted unconditionally (issue #389 P2)
 * for the same reason as the siblings above: the empty stdout is otherwise
 * indistinguishable from "nothing pending," and this state never self-resolves
 * until something writes the socket. Returned WITHOUT a trailing newline; the
 * caller appends one.
 *
 * Covers the case where NO session has ever started in this workspace at all
 * (e.g. `init --enable-only` ran, but the plugin's SessionStart hook — or a
 * manual `session start` — has not fired yet): the caller (`hook.ts`) uses
 * this variant when `.local.md` carries no `lastBootFailureAt` marker.
 * {@link describeBootFailedNoSocketWarning} is the OTHER case — a lazy boot
 * that DID run but failed (issue #389 review finding 6) — where "start a
 * daemon yourself" is misleading advice, since the automated path will retry
 * on its own.
 */
export function describeNoSocketWarning(): string {
  return (
    'hook deliver: no per-workspace socket configured (neither --socket nor a ' +
    '`socket:` entry in .claude/agentmonitors.local.md) — refusing to fall back ' +
    'to a shared default socket; nothing delivered. Start a daemon for this ' +
    'workspace with `agentmonitors daemon run --detach`, or pass --socket.'
  );
}

/**
 * Same missing-socket state as {@link describeNoSocketWarning}, but for the
 * OTHER way a workspace ends up enabled with no socket persisted (issue #389
 * review finding 6): `session start`'s own SessionStart-hook lazy boot ran
 * this session and timed out (`session.ts`'s `BOOT_TIMEOUT_MS` guard) before
 * it could persist `socket:` — recorded as `.local.md`'s `lastBootFailureAt`
 * (`local-state.ts`). Unlike the never-configured case, "run `daemon run
 * --detach` yourself" is misleading here: the SAME automated path that just
 * failed will retry on its own the next time a session starts in this
 * workspace, so the honest remediation leads with that and treats the manual
 * command as an optional stopgap, not the primary fix. Returned WITHOUT a
 * trailing newline; the caller appends one.
 */
export function describeBootFailedNoSocketWarning(): string {
  return (
    'hook deliver: no per-workspace socket configured — the last automatic ' +
    'daemon boot for this workspace (via the SessionStart hook) failed to come ' +
    'up in time; nothing delivered. It will retry automatically the next time a ' +
    'session starts here — run `agentmonitors daemon run --detach` yourself ' +
    'only if you need it available before then.'
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
