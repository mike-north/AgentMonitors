import { Command, Option } from 'commander';
import type { DeliveryLifecycle } from '@agentmonitors/core';
import { reportError } from '../output.js';
import { claimDeliveryClient, listSessionsClient } from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { renderHookDelivery } from '../hook-deliver-render.js';

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
          options.socket,
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
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

/**
 * The Claude Code hook payload AgentMon reads from STDIN. Claude Code delivers
 * hook input as a JSON object on stdin (NOT environment variables); there is no
 * `CLAUDE_CODE_SESSION_ID` env var in a real hook invocation. Only the fields
 * this command consumes are typed; everything else is ignored.
 *
 * @see https://code.claude.com/docs/en/hooks.md (Hook Input)
 */
interface HookPayload {
  /** Host session id; matched against tracked AgentMon sessions' hostSessionId. */
  session_id?: string;
  /** The firing event, e.g. `UserPromptSubmit` / `PostToolUse` / `SessionStart`. */
  hook_event_name?: string;
  /** Workspace path for this invocation. */
  cwd?: string;
}

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
 * Read ALL of stdin and parse it as a Claude Code hook payload (JSON). The read
 * is **non-blocking against a missing stdin**: if stdin is a TTY (interactive /
 * no piped payload) we resolve `{}` immediately without consuming the stream, so
 * the command never hangs waiting for input that will not arrive. Any empty or
 * unparseable payload also resolves to `{}` — the caller treats a payload with
 * no `session_id` as "not a Claude session" and quietly exits 0.
 */
async function readHookPayload(): Promise<HookPayload> {
  const stdin = process.stdin;
  // No piped input (interactive TTY) → don't wait on the stream at all.
  if (stdin.isTTY) return {};

  const raw = await new Promise<string>((resolve) => {
    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.on('end', finish);
    // If the stream errors or is otherwise unreadable, fall back to empty
    // rather than hanging or throwing.
    stdin.on('error', finish);
  });

  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as HookPayload;
    }
    return {};
  } catch {
    return {};
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
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .action(
    async (options: { lifecycle?: DeliveryLifecycle; socket?: string }) => {
      // This command is invoked by Claude Code hooks.  ANY failure MUST be
      // silent (print nothing, exit 0) — surfacing an error would disrupt
      // the user's session.  All IPC / resolution work is wrapped in try/catch
      // so no unhandled rejection can propagate.
      try {
        // Claude Code delivers hook input as JSON on STDIN (not env vars).
        const payload = await readHookPayload();

        // Not a Claude Code session — quiet no-op. There is NO session-id env
        // var; the only source is the stdin payload.
        const hostSessionId = payload.session_id;
        if (!hostSessionId) return;

        // Derive the lifecycle from the firing event unless explicitly
        // overridden. Events that do not honor additionalContext map to
        // `undefined` → quiet no-op (emitting context there is useless).
        const hookEventName = payload.hook_event_name;
        const lifecycle = options.lifecycle ?? lifecycleForEvent(hookEventName);
        if (!lifecycle) return;

        // Resolve the socket: explicit flag → .local.md socket → give up.
        // The workspace comes from the payload's cwd, then CLAUDE_PROJECT_DIR,
        // then the process cwd.
        const workspacePath =
          payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
        const state = readLocalState(workspacePath);
        if (!state.enabled) return;

        // Require an EXPLICIT per-workspace socket (flag or `.local.md`). If
        // neither is present, bail rather than letting resolveSocketPath fall
        // back to AGENTMONITORS_SOCKET / the global default — that could connect
        // this workspace's hook to a different workspace's daemon, breaking
        // per-workspace isolation.
        const explicitSocket = options.socket ?? state.socket;
        if (!explicitSocket) return;
        const socketPath = resolveSocketPath(explicitSocket);

        if (!(await daemonAvailable(socketPath))) return;

        // Resolve the host session id to an AgentMon session record.
        const sessions = await listSessionsClient(socketPath);
        const match = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!match) return;

        // Claim any pending deliveries for this session at this lifecycle point.
        const claim = await claimDeliveryClient(
          match.id,
          lifecycle,
          socketPath,
        );

        // Render and emit.  The echoed hookEventName must match the firing
        // event so the host honors the additionalContext. Null → nothing
        // pending → print nothing.
        const output = renderHookDelivery(claim, hookEventName ?? '');
        if (output !== null) {
          process.stdout.write(JSON.stringify(output));
        }
      } catch {
        // Any internal error is swallowed: a hook that throws would interrupt
        // the user's session (BP2 / always-exit-0 contract).
      }
    },
  );
