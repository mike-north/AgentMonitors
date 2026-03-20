import { Command, Option } from 'commander';
import { claudeCodeAdapter } from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  closeSessionClient,
  listSessionsClient,
  openSessionClient,
} from '../runtime-client.js';

export const sessionCommand = new Command('session').description(
  'Manage agent sessions tracked by AgentMon',
);

sessionCommand
  .command('open')
  .description('Open or resume an agent session')
  .requiredOption(
    '--host-session-id <id>',
    'Host session id from the integrating runtime',
  )
  .option('--workspace <path>', 'Workspace path for the session', process.cwd())
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option('--agent-identity <id>', 'Explicit AgentMon identity')
  .option('--hook-state-path <path>', 'Override hook-state file path')
  .addOption(
    new Option('--role <role>', 'Session role')
      .choices(['lead', 'subagent'])
      .default('lead'),
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (options: {
      hostSessionId: string;
      workspace: string;
      socket?: string;
      agentIdentity?: string;
      hookStatePath?: string;
      role: 'lead' | 'subagent';
      format: string;
    }) => {
      try {
        const session = await openSessionClient(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: options.hostSessionId,
            workspacePath: options.workspace,
            ...(options.agentIdentity
              ? { agentIdentity: options.agentIdentity }
              : {}),
            role: options.role,
            ...(options.hookStatePath
              ? { hookStatePath: options.hookStatePath }
              : {}),
          }),
          options.socket,
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(session, null, 2));
          return;
        }
        console.log(`Opened session: ${session.id}`);
        console.log(`Agent identity: ${session.agentIdentity}`);
        console.log(`Hook state: ${session.hookStatePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

sessionCommand
  .command('close')
  .description('Mark an agent session dormant')
  .argument('<sessionId>', 'AgentMon session id')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (sessionId: string, options: { socket?: string; format: string }) => {
      try {
        const session = await closeSessionClient(sessionId, options.socket);
        if (options.format === 'json') {
          console.log(JSON.stringify(session, null, 2));
          return;
        }
        console.log(`Closed session: ${session.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

sessionCommand
  .command('list')
  .description('List known agent sessions')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (options: { socket?: string; format: string }) => {
    const sessions = await listSessionsClient(options.socket);
    if (options.format === 'json') {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    for (const session of sessions) {
      console.log(
        `${session.id}  ${session.status}  ${session.agentIdentity}  ${session.workspacePath ?? '(global)'}`,
      );
    }
  });
