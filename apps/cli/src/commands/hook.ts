import { Command, Option } from 'commander';
import type {
  DeliveryClaim,
  DeliveryLifecycle,
  DeliveryReservation,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  claimDeliveryClient,
  commitDeliveryClient,
  diagnoseHookDeliveryClient,
  listSessionsClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import {
  MAX_ADDITIONAL_CONTEXT,
  packEventsUnderCap,
  renderHookDelivery,
  resolveHookClaimFit,
} from '../hook-deliver-render.js';
import { readHookPayload } from '../hook-payload.js';
import {
  isManualDaemonConnectionError,
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';
import {
  describeCapDeferral,
  describeClaim,
  describeDaemonUnreachable,
  describeDiagnosisFailure,
  describeHolds,
  describeInternalError,
  describeLifecycle,
  describeNoSessionId,
  describeNoSessionMatch,
  describeNoSocket,
  describeOutput,
  describePayload,
  describeSessionMatch,
  describeUnmappedLifecycle,
  describeUnreadCounts,
  describeWorkspace,
  describeWorkspaceDisabled,
} from '../hook-deliver-debug.js';
import {
  describeMalformedPayloadWarning,
  describeUnknownHostSessionWarning,
  describeUnmappedLifecycleWarning,
} from '../hook-deliver-warnings.js';

export const hookCommand = new Command('hook').description(
  'Claim hook-delivery payloads from the runtime',
);
type HookClaimLifecycle = DeliveryLifecycle;

hookCommand
  .command('claim')
  .description('Claim a pending delivery payload for a session')
  .requiredOption('--session <id>', 'AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--lifecycle <lifecycle>', 'Lifecycle point (required)')
      .choices(['turn-interruptible', 'turn-idle', 'post-compact'])
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('json'),
  )
  .action(
    async (options: {
      session: string;
      socket?: string;
      lifecycle: HookClaimLifecycle;
      format: string;
    }) => {
      try {
        const claim = await claimDeliveryClient(
          options.session,
          options.lifecycle,
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(claim, null, 2));
          return;
        }
        if (!claim) {
          console.log('No pending delivery.');
          return;
        }
        console.log(claim.message);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
      }
    },
  );

/**
 * Map a Claude Code hook event to the AgentMon {@link DeliveryLifecycle} it
 * should claim at. Only events that actually honor
 * `hookSpecificOutput.additionalContext` are mapped — i.e. the **context
 * events** `UserPromptSubmit`, `SessionStart`, and `PostToolUse`. Any other
 * event (including `PreToolUse`, which uses `permissionDecision`, and `Stop`,
 * which uses a top-level `decision`) returns `undefined`, so the command emits
 * nothing — injecting additionalContext there would be ignored by the host.
 *
 * @see https://code.claude.com/docs/en/hooks.md — JSON Output → "Context events
 *   (SessionStart, PostToolUse): use hookSpecificOutput.additionalContext".
 */
function lifecycleForEvent(
  hookEventName: string | undefined,
): DeliveryLifecycle | undefined {
  switch (hookEventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'turn-interruptible';
    case 'SessionStart':
      return 'post-compact';
    default:
      return undefined;
  }
}

/**
 * Upper bound on how many times {@link reserveSizedHookDelivery} will
 * reserve → discover an actual-claim size mismatch → release → retry before
 * forcing a single-event reservation (issue #442, PR #442 round-8 review).
 * Mirrors the channel transport's `MAX_CHANNEL_RESERVE_ATTEMPTS`
 * (`commands/channel.ts`) — same rationale, same bound.
 */
const MAX_HOOK_RESERVE_ATTEMPTS = 3;

/** The result of a successful {@link reserveSizedHookDelivery} call. */
export interface SizedHookDelivery {
  reservation: DeliveryReservation;
  moreDeferred: boolean;
  /**
   * The settled high-urgency preview count at the moment this reservation was
   * accepted — only meaningful (and only used) for the `--debug`
   * `describeCapDeferral` line when `moreDeferred` is true. `undefined` when
   * no preview was taken (non-`turn-interruptible` lifecycles, or a reminder
   * claim).
   */
  previewCount: number | undefined;
}

/**
 * Reserve — but do NOT yet claim — the delivery for `sessionId`/`lifecycle`,
 * sizing a `turn-interruptible` body-injection claim to fit the hook-deliver
 * `additionalContext` cap and RE-VALIDATING that fit against the ACTUALLY
 * reserved claim before the caller ever commits it (issue #442, PR #442
 * round-8 review).
 *
 * **Why re-validate at all.** `previewSettledHighDeliveryClient` (sizing) and
 * `reserveDeliveryClient` (reservation) are two SEPARATE IPC round-trips, so
 * the events the reservation actually returns can differ from the ones the
 * preview measured — most dangerously a **substitution**: a concurrent caller
 * claims/leases the previewed rows first, and the reservation instead fills
 * the same requested *count* from different, larger pending events whose
 * block sizes were never measured by that preview. The prior code claimed
 * directly on the unvalidated count (`claimDeliveryClient(..., fit)`): a
 * substituted, larger set would pass the COUNT check but still fail
 * `renderHookDelivery`'s own repack — and because `claimDelivery` sets
 * `first_notified_at` synchronously, the truncated-away tail of an
 * already-claimed row can **never redeliver** (§5.5's core guarantee, broken).
 *
 * **The fix.** Reserve first (leasing the rows — no durable claim yet), then
 * check the REAL reserved claim's fit via {@link resolveHookClaimFit} — the
 * SAME predicate `renderHookDelivery` uses to decide whether/how much it must
 * cut. A mismatch releases the reservation (the rows return to `pending`;
 * nothing is lost, since nothing was ever claimed) and retries with a
 * tightened cap — mirroring the channel transport's
 * `reserveSizedChannelDelivery` (`commands/channel.ts`) exactly. Bounded by
 * {@link MAX_HOOK_RESERVE_ATTEMPTS}; the final attempt forces `maxEvents: 1`,
 * which is always whole (a single-event claim's own block may still exceed
 * the cap, but `renderHookDelivery`'s mid-truncation backstop handles that
 * pathological case — see its doc comment), so this always terminates.
 *
 * **Scope.** Only a `turn-interruptible` BODY-INJECTION claim carries the
 * count/size risk this guards against — the per-event block cap only applies
 * there (issue #299). A reminder claim (`events: []`) is a single coalesced
 * `message`, not assembled from a variable number of per-event blocks, so
 * there is nothing for a substitution race to drop; `turn-idle`/`post-compact`
 * need no sizing either (the recap self-heals by re-showing all unread each
 * time, §5.5). Both are reserved with no `maxEvents` and accepted directly.
 *
 * Returns `null` when nothing is pending to reserve (mirrors `reserveDelivery`
 * returning `null`).
 */
export async function reserveSizedHookDelivery(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath: string,
): Promise<SizedHookDelivery | null> {
  let forcedCap: number | undefined;
  for (let attempt = 1; attempt <= MAX_HOOK_RESERVE_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_HOOK_RESERVE_ATTEMPTS;
    let maxEvents: number | undefined;
    let moreDeferred = false;
    let previewCount: number | undefined;

    if (lifecycle === 'turn-interruptible') {
      const highPreview = await previewSettledHighDeliveryClient(
        sessionId,
        socketPath,
      );
      previewCount = highPreview.length;
      if (isLastAttempt) {
        // Forward-progress fallback: repeated mismatches mean sizing keeps
        // racing with reservation. Force a single event so THIS attempt
        // cannot fail to make progress.
        maxEvents = 1;
        moreDeferred = highPreview.length > 1;
      } else if (highPreview.length > 0) {
        let fit = packEventsUnderCap(
          highPreview,
          sessionId,
          undefined,
          socketPath,
        );
        if (forcedCap !== undefined) fit = Math.min(fit, forcedCap);
        fit = Math.max(1, fit);
        maxEvents = fit;
        moreDeferred = fit < highPreview.length;
      } else if (forcedCap !== undefined) {
        // A prior attempt proved a smaller cap was needed, but this preview
        // raced empty — still force the known-safe cap so a freshly settled
        // event can't slip back in unbounded.
        maxEvents = forcedCap;
      }
    }

    const reservation = await reserveDeliveryClient(
      sessionId,
      lifecycle,
      socketPath,
      maxEvents,
    );
    if (!reservation) return null;

    // A reminder claim, or any non-`turn-interruptible` lifecycle, carries no
    // per-event sizing risk (see doc comment above) — accept directly.
    if (
      reservation.claim.events.length === 0 ||
      lifecycle !== 'turn-interruptible'
    ) {
      return { reservation, moreDeferred, previewCount };
    }

    // Trust only the ACTUAL reserved events from here — never the preview
    // that produced `maxEvents`, which can already be stale (substitution).
    // Validated against `resolveHookClaimFit` — the SAME predicate
    // `renderHookDelivery` uses — so a claim that would still be shrunk by
    // the renderer's marker-reserving repack is caught here too, before any
    // durable claim is made.
    const fit = resolveHookClaimFit(
      reservation.claim.events,
      sessionId,
      socketPath,
      moreDeferred,
      MAX_ADDITIONAL_CONTEXT,
    );
    if (fit.fits) {
      return { reservation, moreDeferred, previewCount };
    }

    // Mismatch: the actually-reserved set does not fit. Release it (the rows
    // return to pending — nothing is lost, since nothing was ever claimed)
    // and retry, tightening the cap to what was just measured.
    await releaseDeliveryClient(reservation.reservationId, socketPath);
    forcedCap = Math.max(1, fit.includedCount);
  }
  // Unreachable: the final (isLastAttempt) iteration above always returns,
  // since a single-event claim's fit is always whole. Kept only to satisfy
  // the return type.
  return null;
}

hookCommand
  .command('deliver')
  .description(
    'Claim pending events and emit advisory hook context at a turn boundary',
  )
  .addOption(
    new Option(
      '--lifecycle <lifecycle>',
      'Optional override; normally the lifecycle is derived from the firing event',
    ).choices(['turn-interruptible', 'turn-idle', 'post-compact']),
  )
  .addOption(
    new Option(
      '--format <format>',
      'Output format; default/json emit hook wire JSON, text emits advisory context only',
    ).choices(['text', 'json']),
  )
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--debug',
    'Write a diagnosis of why nothing was (or was) delivered to STDERR; ' +
      'STDOUT is byte-identical to a non-debug run in every mode (issue #334)',
  )
  .addHelpText(
    'after',
    `
Emission preconditions:
  Requires an enabled project, a per-workspace socket in .claude/agentmonitors.local.md
  (or --socket), a reachable daemon, and a matching tracked session for the hook payload session_id.
  Empty output means nothing is pending or this workspace/session is not configured.

Output formats:
  default/json  Compact Claude Code hook wire JSON when something is pending.
  text          Rendered additionalContext only, for manual inspection.

Always-on STDERR diagnostics (issues #329, #420):
  Three failure branches whose empty STDOUT is otherwise indistinguishable from
  "nothing pending" — and which never resolve on their own — ALWAYS write one line to
  STDERR, even without --debug. STDOUT and the exit code are unaffected:
    - malformed / non-hook payload (no session_id):
        hook deliver: no session_id in the stdin payload — ...
    - hook_event_name that maps to no delivery lifecycle:
        hook deliver: hook_event_name "<name>" does not map to a delivery lifecycle ...
    - session_id that matches no tracked session:
        hook deliver: no session registered for host session id "<id>"
  The expected (and silent) ~15s high-urgency claim-settle window still writes nothing.

Diagnosis:
  --debug  Writes a step-by-step diagnosis to STDERR only (session resolution,
           workspace/socket state, unread (unacknowledged) event counts by urgency, and the hold
           reason for anything not yet deliverable: settle window, already-claimed,
           coalesced-until-ack, or deferred-by-cap). STDOUT never changes.
`,
  )
  .action(
    async (options: {
      lifecycle?: DeliveryLifecycle;
      socket?: string;
      format?: 'text' | 'json';
      debug?: boolean;
    }) => {
      const debugEnabled = options.debug === true;
      const debug = (msg: string): void => {
        if (debugEnabled) process.stderr.write(`${msg}\n`);
      };

      // This command is invoked by Claude Code hooks.  ANY failure MUST be
      // silent on STDOUT (print nothing, exit 0) — surfacing an error there
      // would disrupt the user's session.  All IPC / resolution work is
      // wrapped in try/catch so no unhandled rejection can propagate. Debug
      // diagnosis writes ONLY to stderr and never alters this contract.
      try {
        // Claude Code delivers hook input as JSON on STDIN (not env vars).
        const payload = await readHookPayload();
        debug(describePayload(payload));

        // No session_id in the payload means this is not a real Claude Code
        // hook call, or the payload is malformed/empty. Emit a one-line stderr
        // diagnostic ALWAYS (issue #420 P1) — like the unknown-session branch
        // below (#329), the empty stdout is otherwise indistinguishable from
        // "nothing pending," and this failure never self-resolves. STDOUT and
        // the exit code are untouched. The plugin only wires this command into
        // events that carry a session_id, so this fires only on the manual path.
        const hostSessionId = payload.session_id;
        if (!hostSessionId) {
          process.stderr.write(`${describeMalformedPayloadWarning()}\n`);
          debug(describeNoSessionId());
          return;
        }

        // Derive the lifecycle from the firing event unless explicitly
        // overridden. Events that do not honor additionalContext map to
        // `undefined` → quiet no-op (emitting context there is useless).
        const hookEventName = payload.hook_event_name;
        const lifecycle = options.lifecycle ?? lifecycleForEvent(hookEventName);
        if (!lifecycle) {
          // additionalContext at an unmapped event would be silently ignored by
          // the host, so empty stdout is mistaken for "nothing pending." Emit a
          // one-line stderr diagnostic ALWAYS (issue #420 P1); STDOUT and the
          // exit code are untouched. Only reachable on the manual path — the
          // plugin wires this into UserPromptSubmit, which maps.
          process.stderr.write(
            `${describeUnmappedLifecycleWarning(hookEventName)}\n`,
          );
          debug(describeUnmappedLifecycle(hookEventName));
          return;
        }
        debug(
          describeLifecycle(
            lifecycle,
            options.lifecycle !== undefined,
            hookEventName,
          ),
        );

        // Resolve the socket: explicit flag → .local.md socket → give up.
        // The workspace comes from the payload's cwd, then CLAUDE_PROJECT_DIR,
        // then the process cwd.
        const workspacePath =
          payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
        const state = readLocalState(workspacePath);
        debug(describeWorkspace(workspacePath, state.enabled, state.socket));
        if (!state.enabled) {
          debug(describeWorkspaceDisabled(workspacePath));
          return;
        }

        // Require an EXPLICIT per-workspace socket (flag or `.local.md`). If
        // neither is present, bail rather than letting resolveSocketPath fall
        // back to AGENTMONITORS_SOCKET / the global default — that could connect
        // this workspace's hook to a different workspace's daemon, breaking
        // per-workspace isolation.
        const explicitSocket = options.socket ?? state.socket;
        if (!explicitSocket) {
          debug(describeNoSocket());
          return;
        }
        // Only a literal --socket flag is "explicit" for the substitution
        // warning (issue #337) — a socket read from .local.md is a derived
        // value the daemon itself chose at boot, not a user-typed request.
        const socketPath = resolveSocketPath(explicitSocket, {
          explicit: options.socket !== undefined,
        });

        if (!(await daemonAvailable(socketPath))) {
          debug(describeDaemonUnreachable(socketPath));
          return;
        }

        // Resolve the host session id to an AgentMon session record. Unlike
        // every other quiet-return branch above, an unresolvable session_id
        // is otherwise indistinguishable from the expected high-urgency
        // claim-settle window (up to ~15s of legitimately empty output,
        // 002 §9.1) — so this ONE branch always writes a one-line stderr
        // diagnostic, regardless of --debug (issue #329). STDOUT is
        // untouched either way.
        const sessions = await listSessionsClient(socketPath);
        const match = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!match) {
          process.stderr.write(
            `${describeUnknownHostSessionWarning(hostSessionId)}\n`,
          );
          debug(describeNoSessionMatch(hostSessionId, sessions));
          return;
        }
        debug(describeSessionMatch(match));

        // Pending-by-urgency counts + per-band hold reasons (issue #334). Pure
        // read (never claims/mutates); computed ONLY when --debug is set, so
        // the non-debug path makes no extra daemon round trip.
        if (debugEnabled) {
          try {
            const diagnosis = await diagnoseHookDeliveryClient(
              match.id,
              lifecycle,
              socketPath,
            );
            debug(describeUnreadCounts(diagnosis));
            for (const holdLine of describeHolds(diagnosis)) debug(holdLine);
          } catch (diagnosisError) {
            debug(describeDiagnosisFailure(diagnosisError));
          }
        }

        // Claim any pending deliveries for this session at this lifecycle
        // point.
        //
        // For a `turn-interruptible` high-urgency delivery the visible surface
        // is length-bounded (the 4000-char additionalContext, 006 §5.1), so we
        // must claim ONLY the events that actually fit — otherwise events
        // truncated out of the render would be marked claimed and never
        // re-delivered (issue #299). This is now a RESERVE → validate-fit →
        // COMMIT sequence, not a direct sized claim (issue #442, PR #442
        // round-8 review): `previewSettledHighDeliveryClient` (sizing) and the
        // eventual reservation are two separate IPC round-trips, so the events
        // actually returned can differ from the ones the preview measured (a
        // concurrent caller substitutes different, larger pending events into
        // the same requested count). Claiming directly on an unvalidated count
        // would let a substituted, oversized set pass the count check but then
        // fail `renderHookDelivery`'s own repack — and a synchronously-claimed
        // row's truncated-away tail can never redeliver.
        // `reserveSizedHookDelivery` re-validates the fit of the ACTUAL
        // reserved claim (never the stale preview) before anything here
        // commits, releasing and retrying on a mismatch (mirroring the channel
        // transport's `reserveSizedChannelDelivery`/`resolveChannelClaimFit`).
        // Non-high deliveries (normal/low reminders inject no bodies; the
        // post-compact recap self-heals by re-showing all unread) need no
        // sizing, so they are reserved+committed unsized.
        let claim: DeliveryClaim | null = null;
        let moreDeferred = false;
        const sized = await reserveSizedHookDelivery(
          match.id,
          lifecycle,
          socketPath,
        );
        if (sized) {
          moreDeferred = sized.moreDeferred;
          if (moreDeferred && sized.previewCount !== undefined) {
            debug(
              describeCapDeferral(
                sized.previewCount,
                sized.reservation.claim.events.length,
              ),
            );
          }
          claim = await commitDeliveryClient(
            sized.reservation.reservationId,
            socketPath,
          );
          if (!claim) {
            // The reservation vanished before commit could land (its lease
            // expired, or the daemon restarted and dropped its in-memory
            // lease) — effectively unreachable in the hook's synchronous,
            // single-invocation flow, but handled the safe way: nothing was
            // surfaced, so behave exactly as "nothing pending." The rows
            // return to pending and re-deliver at the next context event (or
            // via a concurrent channel poll) rather than being lost.
            debug('reservation committed to nothing (lease expired)');
          }
        }
        debug(describeClaim(claim));

        // Render and emit.  The echoed hookEventName must match the firing
        // event so the host honors the additionalContext. Null → nothing
        // pending → print nothing. The default remains the hook wire JSON
        // because this command is normally wired directly into Claude hooks;
        // text is an inspection aid for humans running it manually.
        const output = renderHookDelivery(claim, hookEventName ?? '', {
          moreDeferred,
          socketPath,
        });
        debug(describeOutput(output, options.format));
        if (output !== null) {
          if (options.format === 'text') {
            process.stdout.write(output.hookSpecificOutput.additionalContext);
          } else {
            process.stdout.write(JSON.stringify(output));
          }
        }
      } catch (error) {
        // Any internal error is swallowed: a hook that throws would interrupt
        // the user's session (BP2 / always-exit-0 contract). Debug mode still
        // names it on stderr — stdout stays untouched either way.
        debug(describeInternalError(error));
      }
    },
  );
