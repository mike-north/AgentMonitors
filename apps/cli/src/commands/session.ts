import { Command, Option } from 'commander';
import path from 'node:path';
import { claudeCodeAdapter } from '@mike-north/core';
import { reportError } from '../output.js';
import {
  closeSessionClient,
  listSessionsClient,
  openSessionClient,
} from '../runtime-client.js';
import { daemonAvailable } from '../daemon-ipc.js';
import { readLocalState, writeLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import { spawnDetachedDaemon } from '../detached-spawn.js';

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

sessionCommand
  .command('start')
  .description(
    'Lazy-boot the project daemon (if needed) and register this session',
  )
  .action(async () => {
    const workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (!hostSessionId) return; // not a Claude session; nothing to do

    const state = readLocalState(workspacePath);
    if (!state.enabled) return; // quick-exit: monitoring not enabled here

    const paths = workspacePaths(workspacePath);
    const socket = state.socket ?? paths.socket;
    const db = state.db ?? paths.db;
    const monitorsDir = path.join(workspacePath, '.claude', 'monitors');

    const BOOT_TIMEOUT_MS = 8_000;
    if (!(await daemonAvailable(socket))) {
      spawnDetachedDaemon({
        monitorsDir,
        workspacePath,
        socket,
        db,
        pollMs: 1000,
        ...(state.reapAfterMs !== undefined
          ? { reapAfterMs: state.reapAfterMs }
          : {}),
      });
      // wait for the socket to come up
      const bootStart = Date.now();
      while (
        Date.now() - bootStart < BOOT_TIMEOUT_MS &&
        !(await daemonAvailable(socket))
      ) {
        await new Promise((r) => setTimeout(r, 150));
      }
      // Guard: if the daemon never came up, report and bail — don't fall through
      // to writeLocalState/openSessionClient pointing at a non-existent socket.
      if (!(await daemonAvailable(socket))) {
        reportError(
          `Daemon failed to start within ${String(BOOT_TIMEOUT_MS / 1000)}s`,
          false,
        );
        return;
      }
    }
    // persist the resolved paths for sibling hooks (deliver/end)
    writeLocalState(workspacePath, { ...state, socket, db });

    try {
      await openSessionClient(
        claudeCodeAdapter.createSessionInput({
          hostSessionId,
          workspacePath,
        }),
        socket,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, false);
    }
  });

sessionCommand
  .command('end')
  .description('Deregister this session (lets the idle daemon reap itself)')
  .action(async () => {
    const workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (!hostSessionId) return;
    const state = readLocalState(workspacePath);
    if (!state.enabled || !state.socket) return;
    if (!(await daemonAvailable(state.socket))) return;
    // resolve this host session's runtime id, then close it
    const sessions = await listSessionsClient(state.socket);
    const match = sessions.find((s) => s.hostSessionId === hostSessionId);
    if (match) {
      try {
        await closeSessionClient(match.id, state.socket);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, false);
      }
    }
  });
