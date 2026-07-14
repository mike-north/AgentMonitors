import { Command, Option } from 'commander';
import type { DeliveryLifecycle } from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  claimDeliveryClient,
  diagnoseHookDeliveryClient,
  listSessionsClient,
  previewSettledHighDeliveryClient,
} from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import {
  packEventsUnderCap,
  renderHookDelivery,
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

export const hookCommand = new Command('hook').description(
  'Claim hook-delivery payloads from the runtime',
);
type HookClaimLifecycle = DeliveryLifecycle;

hookCommand
  .command('claim')
  .description('Claim a pending delivery payload for a session')
  .requiredOption('--session <id>', 'AgentMon session id')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--lifecycle <lifecycle>', 'Lifecycle point')
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

        // Not a Claude Code session — quiet no-op. There is NO session-id env
        // var; the only source is the stdin payload.
        const hostSessionId = payload.session_id;
        if (!hostSessionId) {
          debug(describeNoSessionId());
          return;
        }

        // Derive the lifecycle from the firing event unless explicitly
        // overridden. Events that do not honor additionalContext map to
        // `undefined` → quiet no-op (emitting context there is useless).
        const hookEventName = payload.hook_event_name;
        const lifecycle = options.lifecycle ?? lifecycleForEvent(hookEventName);
        if (!lifecycle) {
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
<<<<<<< HEAD
        if (!explicitSocket) return;
        // Only a literal --socket flag is "explicit" for the substitution
        // warning (issue #337) — a socket read from .local.md is a derived
        // value the daemon itself chose at boot, not a user-typed request.
        const socketPath = resolveSocketPath(explicitSocket, {
          explicit: options.socket !== undefined,
        });
=======
        if (!explicitSocket) {
          debug(describeNoSocket());
          return;
        }
        const socketPath = resolveSocketPath(explicitSocket);
>>>>>>> 33df3ee (feat(cli,core): add hook deliver --debug for diagnosing silent output (#334))

        if (!(await daemonAvailable(socketPath))) {
          debug(describeDaemonUnreachable(socketPath));
          return;
        }

        // Resolve the host session id to an AgentMon session record.
        const sessions = await listSessionsClient(socketPath);
        const match = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!match) {
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

        // Claim any pending deliveries for this session at this lifecycle point.
        //
        // For a `turn-interruptible` high-urgency delivery the visible surface is
        // length-bounded (the 4000-char additionalContext, 006 §5.1), so we must
        // claim ONLY the events that actually fit — otherwise events truncated
        // out of the render would be marked claimed and never re-delivered
        // (issue #299). We therefore PREVIEW the settled high events first, size
        // how many whole blocks fit under the cap, then claim exactly that many;
        // the deferred remainder stays pending and re-delivers at the next
        // context event. Non-high deliveries (normal/low reminders inject no
        // bodies; the post-compact recap self-heals by re-showing all unread)
        // need no sizing, so they take the plain claim.
        let claim = null;
        let moreDeferred = false;
        if (lifecycle === 'turn-interruptible') {
          const highPreview = await previewSettledHighDeliveryClient(
            match.id,
            socketPath,
          );
          if (highPreview.length > 0) {
            const fit = packEventsUnderCap(highPreview);
            claim = await claimDeliveryClient(
              match.id,
              lifecycle,
              socketPath,
              fit,
            );
            moreDeferred = fit < highPreview.length;
            if (moreDeferred)
              debug(describeCapDeferral(highPreview.length, fit));
          } else {
            claim = await claimDeliveryClient(match.id, lifecycle, socketPath);
          }
        } else {
          claim = await claimDeliveryClient(match.id, lifecycle, socketPath);
        }
        debug(describeClaim(claim));

        // Render and emit.  The echoed hookEventName must match the firing
        // event so the host honors the additionalContext. Null → nothing
        // pending → print nothing. The default remains the hook wire JSON
        // because this command is normally wired directly into Claude hooks;
        // text is an inspection aid for humans running it manually.
        const output = renderHookDelivery(claim, hookEventName ?? '', {
          moreDeferred,
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
