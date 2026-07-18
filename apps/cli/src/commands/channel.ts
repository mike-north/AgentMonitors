import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { DeliveryClaim } from '@agentmonitors/core';
import { claudeCodeAdapter } from '@agentmonitors/core';
import {
  acknowledgeEventsClient,
  commitDeliveryClient,
  openSessionClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import { renderChannelEvent } from '../channel-render.js';
import { ACK_TOOL, parseAckArgs } from '../channel-ack.js';

const DEFAULT_POLL_MS = 3000;

interface ChannelServeOptions {
  socket?: string;
  pollMs: string;
  hostSessionId?: string;
  workspace?: string;
}

export const channelCommand = new Command('channel').description(
  'Claude Code channel integration',
);

channelCommand
  .command('serve')
  .description(
    'Run the AgentMon channel: push pending turn-interruptible deliveries into the Claude Code session as channel events',
  )
  .option(
    '--socket <path>',
    'Daemon Unix domain socket path (default: the same per-workspace socket `session start` binds to when the workspace is enabled — this takes precedence over $AGENTMONITORS_SOCKET for `channel serve` specifically, since it is spawned automatically and a stale env var must not cross workspaces; otherwise $AGENTMONITORS_SOCKET or the global default)',
  )
  .option(
    '--poll-ms <ms>',
    'Delivery poll interval in milliseconds',
    String(DEFAULT_POLL_MS),
  )
  .option(
    '--host-session-id <id>',
    'Host session id (default: $CLAUDE_CODE_SESSION_ID)',
  )
  .option('--workspace <path>', 'Workspace path (default: $CLAUDE_PROJECT_DIR)')
  .action(async (options: ChannelServeOptions) => {
    await runChannelServe(options);
  });

/**
 * Resolve the socket `channel serve` connects to.
 *
 * `channel serve` is spawned **automatically** by the plugin's `.mcp.json` —
 * with no flags at all — exactly like a hook. That means its socket
 * resolution needs the same isolation guarantee `hook deliver` documents and
 * enforces (`apps/cli/src/commands/hook.ts`, "Require an EXPLICIT
 * per-workspace socket..."): a stale `AGENTMONITORS_SOCKET` left over from a
 * different workspace must never win over an **enabled** workspace's own
 * persisted-or-derived socket, or `channel serve` silently binds to another
 * workspace's daemon (a session-isolation break) or a dead socket
 * (reproducing issue #358's symptom).
 *
 * This is deliberately a *different* precedence than
 * {@link resolveManualDaemonSocketPath} (issue #335), which is correct for
 * commands a user types by hand (`session close`/`list`, `events`, `doctor`,
 * `daemon status`) — there, an explicitly-set env var is a deliberate,
 * interactive override and should win. `channel serve` has no such
 * interactive moment, so for it alone:
 *
 * 1. An explicit `--socket` flag (always wins).
 * 2. The **enabled** workspace's persisted socket, or — if none has
 *    persisted yet — the derived per-workspace socket
 *    ({@link workspacePaths}), matching the exact formula `session start`
 *    lazy-boots with (`resolveSocketPath(state.socket ?? workspacePaths(workspace).socket)`).
 * 3. `AGENTMONITORS_SOCKET`, then the global default — both handled by
 *    {@link resolveSocketPath}'s own fallback chain when neither 1 nor 2
 *    apply (e.g. the workspace is not enabled).
 *
 * Do not change {@link resolveManualDaemonSocketPath} to match this — its
 * env-first order for the manual commands is deliberate (issue #335).
 */
export function resolveChannelSocketPath(
  socket: string | undefined,
  workspace: string | undefined,
): string {
  if (socket) {
    return resolveSocketPath(socket, { explicit: true });
  }

  const workspacePath =
    workspace ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const state = readLocalState(workspacePath);
  if (state.enabled) {
    return resolveSocketPath(
      state.socket ?? workspacePaths(workspacePath).socket,
    );
  }

  // Not enabled: no per-workspace socket to prefer, so fall back to the
  // existing AGENTMONITORS_SOCKET / global-default chain.
  return resolveSocketPath(undefined);
}

/** The outcome of one {@link runChannelDeliveryCycle}. */
export type ChannelDeliveryOutcome =
  /** Nothing pending to surface this poll. */
  | 'idle'
  /** A claim was pushed and committed (surfaced, deduped from the hook path). */
  | 'surfaced'
  /** A claim was reserved but the push rejected; the reservation was released. */
  | 'push-failed';

/**
 * One reserve → push → commit/release delivery cycle for a bound session (006
 * §4, issue #300).
 *
 * Reserves the pending `turn-interruptible` delivery — which leases the rows so
 * the hook transport will not double-surface them (006 §4.5) — pushes the claim
 * via `push`, and COMMITS the claim only after the push resolves. If `push`
 * rejects (an MCP disconnect/rejection), the reservation is RELEASED so the rows
 * stay unclaimed and re-deliver via the hook transport or the next poll — a
 * transient failure never consumes the delivery. The rows are never
 * acknowledged by this path (BP2); a committed claim only means "was surfaced".
 *
 * Reserve/commit/release IPC errors propagate to the caller (the poll loop maps
 * them to "daemon unreachable → drop the cached session"); a `push` rejection is
 * handled here (release + `'push-failed'`), not thrown. The `push` seam is what
 * the integration test injects to exercise the success and disconnect paths
 * without a live Claude Code MCP host (channels are research-preview, §4/§6).
 */
export async function runChannelDeliveryCycle(
  boundSession: string,
  socketPath: string,
  push: (claim: DeliveryClaim) => Promise<void>,
): Promise<ChannelDeliveryOutcome> {
  const reservation = await reserveDeliveryClient(
    boundSession,
    'turn-interruptible',
    socketPath,
  );
  if (!reservation) return 'idle';
  try {
    await push(reservation.claim);
  } catch {
    // Push rejected/disconnected: release the reservation so the leased rows
    // return to pending and re-deliver via the hook path or the next poll (006
    // §4, issue #300). NEVER commit here — committing an unsurfaced claim is the
    // delivery-loss bug this cycle exists to prevent. Release is best-effort: if
    // it also fails (daemon unreachable), the reservation self-expires.
    await releaseDeliveryClient(reservation.reservationId, socketPath).catch(
      () => undefined,
    );
    return 'push-failed';
  }
  // Surfaced successfully: commit the claim now (the rows become claimed / "was
  // surfaced", deduped from the hook transport — 006 §4.5). Claim is not ack (BP2).
  await commitDeliveryClient(reservation.reservationId, socketPath);
  return 'surfaced';
}

/**
 * Run the channel as a two-way MCP server. Outbound: poll the daemon for settled
 * `turn-interruptible` deliveries and push each into the session as a `<channel>`
 * event. Each poll RESERVES the delivery, pushes it, and COMMITS the claim only
 * after the push succeeds — so a rejected or disconnected push never permanently
 * consumes the delivery; the leased rows are released back to the hook transport
 * (006 §4, issue #300). Reserving leases the rows, so cross-transport dedup (006
 * §4.5) still holds during the push. Inbound: expose an `agentmon_ack` tool that
 * routes through `events.ack` so the agent can acknowledge what it has handled
 * (006 §4.3).
 */
async function runChannelServe(options: ChannelServeOptions): Promise<void> {
  const hostSessionId =
    options.hostSessionId ?? process.env['CLAUDE_CODE_SESSION_ID'];
  const workspace = options.workspace ?? process.env['CLAUDE_PROJECT_DIR'];
  const socketPath = resolveChannelSocketPath(options.socket, workspace);
  const pollMs = Number.parseInt(options.pollMs, 10) || DEFAULT_POLL_MS;

  // The low-level Server is the correct API for a channel: it exposes the custom
  // `notification()` and the `experimental['claude/channel']` capability that the
  // high-level McpServer (tools/resources) does not. This is the "advanced use
  // case" the deprecation notice points to, and what the reference channels use.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
  const mcp = new Server(
    { name: 'agentmonitors', version: '0.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'AgentMon delivers monitor events here as <channel source="agentmonitors" ...>. ' +
        'Read each one and act on the work it describes. The tag meta carries urgency, ' +
        'event_count, and (for a single event) monitor_id and event_id. When you have ' +
        'handled events, call the agentmon_ack tool with their event_id values (or no ' +
        'arguments to acknowledge all unread).',
    },
  );

  let sessionId: string | undefined;
  // session.open is idempotent: it resumes the session a SessionStart hook already
  // opened for this (adapter, hostSessionId), or opens a new one. Shared by the
  // poll loop and the ack tool.
  const resolveSession = async (): Promise<string> => {
    if (!hostSessionId) {
      throw new Error('no host session id available');
    }
    sessionId ??= (
      await openSessionClient(
        claudeCodeAdapter.createSessionInput({
          hostSessionId,
          ...(workspace ? { workspacePath: workspace } : {}),
        }),
        socketPath,
      )
    ).id;
    return sessionId;
  };

  // Inbound: advertise the agentmon_ack tool and route it through events.ack.
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [ACK_TOOL] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== ACK_TOOL.name) {
      throw new Error(`unknown tool: ${request.params.name}`);
    }
    const parsed = parseAckArgs(request.params.arguments);
    if (!parsed.ok) {
      return {
        content: [{ type: 'text', text: `Invalid arguments: ${parsed.error}` }],
        isError: true,
      };
    }
    try {
      const boundSession = await resolveSession();
      // events.ack only touches rows projected to this session, so passing the
      // bound session id is the "outbound gate" that re-authorizes the ids (006 §4.3).
      await acknowledgeEventsClient(
        boundSession,
        parsed.args.eventIds,
        socketPath,
      );
      // events.ack silently ignores ids not projected to this session and does
      // not report a count, so for explicit ids we frame the result as a request
      // (some ids may be unknown/stale); the all-unread path is unambiguous.
      const text = parsed.args.eventIds
        ? `Requested acknowledgement of ${String(parsed.args.eventIds.length)} event(s); ids not projected to this session are ignored.`
        : 'Acknowledged all unread events for this session.';
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Acknowledge failed: ${message}` }],
        isError: true,
      };
    }
  });

  await mcp.connect(new StdioServerTransport());

  // Without a host session id we cannot bind to a session. Stay connected (the
  // ack tool reports an error if called), but do not poll.
  if (!hostSessionId) {
    process.stderr.write(
      'agentmonitors channel: no CLAUDE_CODE_SESSION_ID available; not binding to a session.\n',
    );
    return;
  }

  const poll = async (): Promise<void> => {
    try {
      const boundSession = await resolveSession();
      await runChannelDeliveryCycle(boundSession, socketPath, (claim) => {
        const { content, meta } = renderChannelEvent(claim);
        return mcp.notification({
          method: 'notifications/claude/channel',
          params: { content, meta },
        });
      });
    } catch {
      // Reserve/commit/release IPC failed → daemon unreachable / socket missing:
      // the hook-state transport still delivers durably (006 §7), and any
      // reservation we couldn't release self-expires. Drop the cached session id
      // and retry.
      sessionId = undefined;
    }
  };

  // Self-scheduling loop: the next poll is only armed after the current one
  // settles, so a slow daemon call can never overlap with the next poll.
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async (): Promise<void> => {
    await poll();
    if (!stopped) {
      timer = setTimeout(() => void loop(), pollMs);
      timer.unref();
    }
  };
  void loop();

  // MCP disconnect (stdin EOF): stop polling and close the transport, then let
  // the event loop drain naturally — no process.exit, so in-flight work and any
  // cleanup can complete first.
  process.stdin.on('end', () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    void mcp.close();
  });
}
