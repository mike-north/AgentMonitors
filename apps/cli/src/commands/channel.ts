import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { claudeCodeAdapter } from '@agentmonitors/core';
import {
  acknowledgeEventsClient,
  claimDeliveryClient,
  openSessionClient,
} from '../runtime-client.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
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
    'Daemon Unix domain socket path (default: the same per-workspace socket `session start` binds to when the workspace is enabled; otherwise $AGENTMONITORS_SOCKET or the global default)',
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
 * Mirrors {@link resolveManualDaemonSocketPath} — the same per-workspace-aware
 * resolution `session`/`events`/`hook`/`daemon` already use (issue #335) — so a
 * `session start`-lazy-booted daemon for an **enabled** workspace is reachable
 * with no flags, exactly as the plugin's `.mcp.json` spawns `channel serve`
 * (no `--socket`, no `AGENTMONITORS_SOCKET`). Before this fix, `channel serve`
 * called {@link resolveSocketPath} directly and only ever considered an
 * explicit `--socket`/`AGENTMONITORS_SOCKET`/the bare global default — landing
 * on a socket with no daemon listening for the only supported activation flow
 * (issue #358).
 *
 * Precedence, unchanged from before this fix: explicit `--socket` wins, then
 * `AGENTMONITORS_SOCKET`; only then does workspace-aware resolution (or the
 * global default) apply.
 */
export function resolveChannelSocketPath(
  socket: string | undefined,
  workspace: string | undefined,
): string {
  return resolveSocketPath(
    resolveManualDaemonSocketPath(socket, workspace) ?? socket,
  );
}

/**
 * Run the channel as a two-way MCP server. Outbound: poll the daemon for settled
 * `turn-interruptible` deliveries and push each into the session as a `<channel>`
 * event (reusing `claimDelivery`, so claimed-state and cross-transport dedup come
 * for free, 006 §4). Inbound: expose an `agentmon_ack` tool that routes through
 * `events.ack` so the agent can acknowledge what it has handled (006 §4.3).
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
      const claim = await claimDeliveryClient(
        boundSession,
        'turn-interruptible',
        socketPath,
      );
      if (claim) {
        const { content, meta } = renderChannelEvent(claim);
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content, meta },
        });
      }
    } catch {
      // Daemon unreachable / socket missing: the hook-state transport still
      // delivers durably (006 §7). Drop the cached session id and retry.
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
