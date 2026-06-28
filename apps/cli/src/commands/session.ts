import { Command, Option } from 'commander';
import path from 'node:path';
import { claudeCodeAdapter } from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  claimDeliveryClient,
  closeSessionClient,
  listSessionsClient,
  openSessionClient,
} from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState, writeLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import { spawnDetachedDaemon } from '../detached-spawn.js';
import { readHookPayload } from '../hook-payload.js';
import { renderHookDelivery } from '../hook-deliver-render.js';
import {
  isManualDaemonConnectionError,
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';

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
        const socket = resolveManualDaemonSocketPath(
          options.socket,
          options.workspace,
        );
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
          socket,
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(session, null, 2));
          return;
        }
        console.log(`Opened session: ${session.id}`);
        console.log(`Agent identity: ${session.agentIdentity}`);
        console.log(`Hook state: ${session.hookStatePath}`);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
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
        const session = await closeSessionClient(
          sessionId,
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(session, null, 2));
          return;
        }
        console.log(`Closed session: ${session.id}`);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
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
    try {
      const sessions = await listSessionsClient(
        resolveManualDaemonSocketPath(options.socket),
      );
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
    } catch (error) {
      reportError(
        manualDaemonErrorMessage(error),
        !isManualDaemonConnectionError(error) && options.format === 'json',
      );
    }
  });

sessionCommand
  .command('start')
  .description(
    'Lazy-boot the project daemon (if needed) and register this session',
  )
  .action(async () => {
    // Claude Code delivers hook input as JSON on STDIN (not env vars). The host
    // session id comes from the payload's `session_id`; there is NO
    // `CLAUDE_CODE_SESSION_ID` env var in a real hook invocation. This is the
    // same contract `hook deliver` reads.
    const payload = await readHookPayload();
    const hostSessionId = payload.session_id;
    if (!hostSessionId) return; // not a Claude session; nothing to do

    const workspacePath =
      payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

    const state = readLocalState(workspacePath);
    if (!state.enabled) return; // quick-exit: monitoring not enabled here

    const paths = workspacePaths(workspacePath);
    // Resolve the socket up-front through the SAME transform `daemon run` applies
    // when it binds (resolveSocketPath falls back to a short /tmp socket when the
    // derived path exceeds the ~100-char Unix limit). Resolving here keeps the
    // spawner, the daemonAvailable poll, openSessionClient, and the persisted
    // `.local.md` socket all pointing at the actual bound socket — and stores the
    // REAL path so sibling hooks (end, deliver) read a socket that exists.
    const socket = resolveSocketPath(state.socket ?? paths.socket);
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
      const opened = await openSessionClient(
        claudeCodeAdapter.createSessionInput({
          hostSessionId,
          workspacePath,
        }),
        socket,
      );

      // SessionStart is a context event, so this command ALSO surfaces the
      // post-compact recap — from the SAME stdin payload we already read.
      // The plugin runs `session start` as ONE hook command; a separately
      // chained `agentmonitors hook deliver` would see an already-consumed
      // stdin (one hook invocation = one stdin stream), parse `{}`, and
      // silently no-op. Reading once and delivering here is the fix. On a
      // fresh start nothing is pending → renderHookDelivery returns null →
      // nothing is printed; on a compact-resume the unread events are recapped.
      const claim = await claimDeliveryClient(
        opened.id,
        'post-compact',
        socket,
      );
      const delivery = renderHookDelivery(claim, 'SessionStart');
      if (delivery !== null) {
        // stdout is the SessionStart hook's wire channel: it MUST contain only
        // this JSON. Do NOT add `console.log`/diagnostics to stdout in this
        // command — anything else here corrupts the hook output Claude reads.
        process.stdout.write(JSON.stringify(delivery));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, false);
    }
  });

sessionCommand
  .command('end')
  .description('Deregister this session (lets the idle daemon reap itself)')
  .action(async () => {
    // Same stdin contract as `session start` / `hook deliver`: the host session
    // id is the payload's `session_id`, not an env var.
    const payload = await readHookPayload();
    const hostSessionId = payload.session_id;
    if (!hostSessionId) return;
    const workspacePath =
      payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const state = readLocalState(workspacePath);
    if (!state.enabled || !state.socket) return;
    const socket = resolveSocketPath(state.socket);
    if (!(await daemonAvailable(socket))) return;
    // `session end` runs from a SessionEnd hook and must be a quiet no-op even if
    // the daemon disappears between the availability check and the list/close
    // (a TOCTOU race, or a self-reap firing concurrently). Wrap the whole
    // resolve-id-then-close in try/catch so a vanished daemon never surfaces as
    // an unhandled hook error.
    try {
      const sessions = await listSessionsClient(socket);
      const match = sessions.find((s) => s.hostSessionId === hostSessionId);
      if (match) await closeSessionClient(match.id, socket);
    } catch {
      // daemon went away mid-deregister — the idle reaper is the backstop; no-op.
    }
  });
