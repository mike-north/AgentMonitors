import type {
  AgentSessionRecord,
  DeliveryClaim,
  HookDeliveryDiagnosis,
} from '@agentmonitors/core';
import type { HookPayload } from './hook-payload.js';
import {
  sanitizeUntrustedField,
  sanitizeUntrustedFieldOrNone,
} from './hook-deliver-sanitize.js';

/**
 * Pure line-formatting for `hook deliver --debug` (issue #334).
 *
 * `hook deliver`'s stdout contract is silent-on-idle by design (006 §5.1) — a
 * hook that ever printed diagnostic noise to stdout would corrupt the Claude
 * Code wire format. `--debug` writes a parallel diagnosis to **stderr**, one
 * line per resolution/diagnosis step, so "correctly idle" and "misconfigured"
 * stop being indistinguishable (DX study S3 F3) without touching stdout at
 * all. Every function here is a pure string builder — no I/O — so the exact
 * wording is unit-testable without a daemon; `apps/cli/src/commands/hook.ts`
 * writes the returned lines to `process.stderr` only when `--debug` is passed.
 *
 * `--debug` is opt-in, but the lines below still interpolate the SAME
 * untrusted stdin payload fields (`session_id`, `hook_event_name`, `cwd`) that
 * the always-on warnings in `hook-deliver-warnings.ts` render — a hostile
 * payload reaches the operator's terminal/logs raw with `--debug` on unless
 * every such interpolation goes through the shared
 * {@link sanitizeUntrustedField} (issue #365, hardening the same vector
 * closed for the always-on path by #362/#363).
 *
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */

const DEBUG_PREFIX = 'agentmonitors hook deliver --debug:';

function line(message: string): string {
  return `${DEBUG_PREFIX} ${message}`;
}

/**
 * Echoes the parsed stdin payload's relevant fields (§5.0 input contract).
 * All three fields are untrusted stdin JSON, so each is rendered via
 * {@link sanitizeUntrustedFieldOrNone} (issue #365) — the same escaping the
 * always-on warnings apply to the identical fields.
 */
export function describePayload(payload: HookPayload): string {
  return line(
    `stdin payload — session_id=${sanitizeUntrustedFieldOrNone(payload.session_id)} ` +
      `hook_event_name=${sanitizeUntrustedFieldOrNone(payload.hook_event_name)} ` +
      `cwd=${sanitizeUntrustedFieldOrNone(payload.cwd)}`,
  );
}

/** The payload carried no `session_id` — not a real Claude Code hook call. */
export function describeNoSessionId(): string {
  return line(
    'no session_id in the stdin payload — not a Claude Code hook invocation ' +
      '(or the payload is malformed); nothing to resolve.',
  );
}

/**
 * `hook_event_name` did not map to a delivery lifecycle (§5.4).
 * `hookEventName` is untrusted stdin JSON — sanitized (issue #365).
 */
export function describeUnmappedLifecycle(
  hookEventName: string | undefined,
): string {
  return line(
    `hook_event_name ${sanitizeUntrustedFieldOrNone(hookEventName)} does not map to a ` +
      'delivery lifecycle (only UserPromptSubmit, PostToolUse, and ' +
      'SessionStart do) — additionalContext would be ignored, so nothing is injected.',
  );
}

/**
 * The lifecycle that will actually be claimed at, and how it was derived.
 * `hookEventName` is untrusted stdin JSON — sanitized (issue #365).
 */
export function describeLifecycle(
  lifecycle: string,
  explicitOverride: boolean,
  hookEventName: string | undefined,
): string {
  return line(
    explicitOverride
      ? `resolved lifecycle: ${lifecycle} (explicit --lifecycle override)`
      : `resolved lifecycle: ${lifecycle} (derived from hook_event_name ${sanitizeUntrustedFieldOrNone(hookEventName)})`,
  );
}

/**
 * The resolved workspace path and its enabled/socket configuration.
 * `workspacePath` is derived from the untrusted stdin `cwd` field when
 * present — sanitized (issue #365). `socket` comes from local config, not
 * the payload, and is left unsanitized.
 */
export function describeWorkspace(
  workspacePath: string,
  enabled: boolean,
  socket: string | undefined,
): string {
  return line(
    `workspace ${sanitizeUntrustedField(workspacePath)} — enabled=${String(enabled)}, configured socket=${socket ?? '(none)'}`,
  );
}

/**
 * The workspace is not enabled — the primary "cwd mismatch" symptom.
 * `workspacePath` is derived from the untrusted stdin `cwd` field when
 * present — sanitized (issue #365).
 */
export function describeWorkspaceDisabled(workspacePath: string): string {
  return line(
    `workspace ${sanitizeUntrustedField(workspacePath)} is not enabled ` +
      '(.claude/agentmonitors.local.md is missing, or enabled: false) — ' +
      'run `agentmonitors init`, or set `enabled: true`. If this path is ' +
      "unexpected, check the hook payload's cwd against the workspace you configured.",
  );
}

/** Neither `--socket` nor `.local.md`'s `socket:` provided a socket path. */
export function describeNoSocket(): string {
  return line(
    'no explicit per-workspace socket is configured (neither --socket nor ' +
      '.claude/agentmonitors.local.md `socket:`) — refusing to fall back to a shared default socket.',
  );
}

/** The daemon did not answer a ping at the resolved socket path. */
export function describeDaemonUnreachable(socketPath: string): string {
  return line(
    `daemon not reachable at socket ${socketPath} — is \`agentmonitors daemon run\` running for this workspace?`,
  );
}

/**
 * No tracked session's `hostSessionId` matched the payload's `session_id`.
 * `hostSessionId` is untrusted stdin JSON — sanitized (issue #365), the same
 * escaping the always-on unknown-session warning applies to this same field
 * (`hook-deliver-warnings.ts`'s `describeUnknownHostSessionWarning`).
 */
export function describeNoSessionMatch(
  hostSessionId: string,
  sessions: readonly AgentSessionRecord[],
): string {
  return line(
    `no tracked AgentMon session matches host session_id ${sanitizeUntrustedField(hostSessionId)} ` +
      `(${String(sessions.length)} session(s) known to the daemon at this socket) — ` +
      'run `agentmonitors session start`, or check for a workspace/session mismatch.',
  );
}

/** The resolved AgentMon session record for the matched host session id. */
export function describeSessionMatch(match: AgentSessionRecord): string {
  return line(
    `resolved session ${match.id} (workspace ${match.workspacePath ?? '(none)'}, status ${match.status})`,
  );
}

/** Unread (unacknowledged — includes claimed-but-unacked) counts by urgency band. */
export function describeUnreadCounts(diagnosis: HookDeliveryDiagnosis): string {
  const { unreadCounts } = diagnosis;
  return line(
    `unread (unacknowledged) events by urgency for session ${diagnosis.sessionId} at ${diagnosis.lifecycle}: ` +
      `high=${String(unreadCounts.high)} normal=${String(unreadCounts.normal)} ` +
      `low=${String(unreadCounts.low)} (total ${String(unreadCounts.total)})`,
  );
}

/** One line per held band (settle window / already-claimed / coalesced-until-ack). */
export function describeHolds(diagnosis: HookDeliveryDiagnosis): string[] {
  if (diagnosis.holds.length === 0) {
    return [line('no held events for this lifecycle right now.')];
  }
  return diagnosis.holds.map((hold) =>
    line(`held (${hold.urgency}, ${hold.reason}): ${hold.message}`),
  );
}

/** The read-only diagnosis RPC itself failed (e.g. daemon dropped mid-call). */
export function describeDiagnosisFailure(error: unknown): string {
  return line(
    `diagnosis query failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Settled high-urgency events existed but some were deferred by the
 * transport's 4000-char `additionalContext` cap (issue #299, 006 §5.5) — a
 * hold reason owned by the hook-deliver transport itself, not the runtime.
 */
export function describeCapDeferral(
  previewCount: number,
  claimedCount: number,
): string {
  return line(
    `held (high, deferred-by-cap): ${String(previewCount - claimedCount)} of ` +
      `${String(previewCount)} settled high-urgency event(s) deferred by the ` +
      '4000-char context cap; will redeliver at the next context event.',
  );
}

/** Summarizes what `claimDelivery` actually returned. */
export function describeClaim(claim: DeliveryClaim | null): string {
  return line(
    claim
      ? `claim: mode=${claim.mode}${claim.urgency ? ` urgency=${claim.urgency}` : ''} events=${String(claim.events.length)}`
      : 'claim: null — nothing to deliver at this lifecycle right now (see hold reasons above, if any).',
  );
}

/** Whether the render step will emit anything to stdout, and how large. */
export function describeOutput(
  output: unknown,
  format: string | undefined,
): string {
  return line(
    output
      ? `stdout: emitting ${format === 'text' ? 'text (additionalContext only)' : 'hook wire JSON'} (${String(Buffer.byteLength(JSON.stringify(output), 'utf8'))} bytes).`
      : 'stdout: nothing to emit (render produced no output — null claim, or an empty reminder).',
  );
}

/** The outer try/catch swallowed an internal error (always-exit-0 contract). */
export function describeInternalError(error: unknown): string {
  return line(
    `internal error swallowed (the hook path always exits 0 on stdout): ${error instanceof Error ? error.message : String(error)}`,
  );
}
