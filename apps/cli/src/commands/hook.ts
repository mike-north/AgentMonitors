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

hookCommand
  .command('deliver')
  .description(
    'Claim pending events and emit advisory hook context at a turn boundary',
  )
  .addOption(
    new Option(
      '--lifecycle <lifecycle>',
      'Lifecycle point: turn-interruptible | turn-idle | post-compact',
    )
      .choices(['turn-interruptible', 'turn-idle', 'post-compact'])
      .makeOptionMandatory(),
  )
  .option(
    '--hook-event-name <name>',
    'Claude Code hook event name to echo in the output (e.g. PreToolUse)',
    'PreToolUse',
  )
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .action(
    async (options: {
      lifecycle: DeliveryLifecycle;
      hookEventName: string;
      socket?: string;
    }) => {
      // This command is invoked by Claude Code hooks.  ANY failure MUST be
      // silent (print nothing, exit 0) — surfacing an error would disrupt
      // the user's session.  All IPC / resolution work is wrapped in try/catch
      // so no unhandled rejection can propagate.
      try {
        // Not a Claude Code session — quiet no-op.
        const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
        if (!hostSessionId) return;

        // Resolve the socket: explicit flag → .local.md socket → give up.
        const workspacePath =
          process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
        const state = readLocalState(workspacePath);
        if (!state.enabled) return;

        const socketPath = resolveSocketPath(
          options.socket ?? state.socket ?? undefined,
        );

        if (!(await daemonAvailable(socketPath))) return;

        // Resolve the host session id to an AgentMon session record.
        const sessions = await listSessionsClient(socketPath);
        const match = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!match) return;

        // Claim any pending deliveries for this session at this lifecycle point.
        const claim = await claimDeliveryClient(
          match.id,
          options.lifecycle,
          socketPath,
        );

        // Render and emit.  Null → nothing pending → print nothing.
        const output = renderHookDelivery(claim, options.hookEventName);
        if (output !== null) {
          process.stdout.write(JSON.stringify(output));
        }
      } catch {
        // Any internal error is swallowed: a hook that throws would interrupt
        // the user's session (BP2 / always-exit-0 contract).
      }
    },
  );
