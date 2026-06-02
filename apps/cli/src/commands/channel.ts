import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { claudeCodeAdapter } from '@mike-north/core';
import { claimDeliveryClient, openSessionClient } from '../runtime-client.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { renderChannelEvent } from '../channel-render.js';

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
    'Run the AgentMon channel: push pending high-urgency deliveries into the Claude Code session',
  )
  .option('--socket <path>', 'Daemon Unix domain socket path')
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
 * Run the channel as a one-way MCP server: resolve the host session, then poll
 * the daemon for settled `turn-interruptible` deliveries and push each into the
 * session as a `<channel>` event. It reuses `claimDelivery`, so claimed-state and
 * cross-transport dedup with the hook-state path come for free (006 §4).
 */
async function runChannelServe(options: ChannelServeOptions): Promise<void> {
  const hostSessionId =
    options.hostSessionId ?? process.env['CLAUDE_CODE_SESSION_ID'];
  const workspace = options.workspace ?? process.env['CLAUDE_PROJECT_DIR'];
  const socketPath = resolveSocketPath(options.socket);
  const pollMs = Number.parseInt(options.pollMs, 10) || DEFAULT_POLL_MS;

  // The low-level Server is the correct API for a channel: it exposes the custom
  // `notification()` and the `experimental['claude/channel']` capability that the
  // high-level McpServer (tools/resources) does not. This is the "advanced use
  // case" the deprecation notice points to, and what the reference channels use.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
  const mcp = new Server(
    { name: 'agentmonitors', version: '0.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} } },
      instructions:
        'AgentMon delivers monitor events here as <channel source="agentmonitors" ...>. ' +
        'Read each one and act on the work it describes. The tag meta carries urgency, ' +
        'event_count, and (for a single event) monitor_id and event_id. One-way for now — ' +
        'no reply is expected.',
    },
  );

  await mcp.connect(new StdioServerTransport());

  // Without a host session id we cannot bind to a session. Stay connected so the
  // host is satisfied, but do not poll. (Workspace-only fallback is a later step.)
  if (!hostSessionId) {
    process.stderr.write(
      'agentmonitors channel: no CLAUDE_CODE_SESSION_ID available; not binding to a session.\n',
    );
    return;
  }

  let sessionId: string | undefined;

  const poll = async (): Promise<void> => {
    try {
      // session.open is idempotent: it resumes the session a SessionStart hook
      // already opened for this (adapter, hostSessionId), or opens a new one.
      sessionId ??= (
        await openSessionClient(
          claudeCodeAdapter.createSessionInput({
            hostSessionId,
            ...(workspace ? { workspacePath: workspace } : {}),
          }),
          socketPath,
        )
      ).id;

      const claim = await claimDeliveryClient(
        sessionId,
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

  const timer = setInterval(() => void poll(), pollMs);
  timer.unref();
  void poll();

  process.stdin.on('end', () => {
    clearInterval(timer);
    process.exit(0);
  });
}
