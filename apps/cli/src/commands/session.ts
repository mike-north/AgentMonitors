import { Command, Option } from 'commander';
import path from 'node:path';
import { claudeCodeAdapter, scanMonitors } from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  closeSessionClient,
  listSessionsClient,
  openSessionClient,
} from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState, writeLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import { spawnDetachedDaemon } from '../detached-spawn.js';
import { readHookPayload } from '../hook-payload.js';
import { renderMonitoringDisabledAdvisory } from '../hook-deliver-render.js';
import {
  reserveRenderAndCommitHookDelivery,
  writeAndCommitHookDelivery,
  writeStreamChunk,
} from './hook.js';
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
    'Host session id from the integrating runtime (required)',
  )
  .option(
    '--workspace <path>',
    'Workspace path for the session (defaults to the current working directory; resolved to an absolute path, same as `doctor`)',
    process.cwd(),
  )
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
      // `id` prints just the bare session id (no JSON parsing needed) -- the
      // common case for verification recipes that only need to capture the
      // AgentMon session id for later commands (issue #338, item 4).
      .choices(['text', 'json', 'id'])
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
        // Resolve to an absolute, normalized path the SAME way `doctor` and
        // `daemon once`/`daemon run` do (issue #335) — an unresolved relative
        // value (or a trailing slash / `.`/`..` segment) would be stored
        // verbatim on the session record and silently fail the exact-string
        // workspace match `doctor`'s lead-session check performs, even though
        // it is the same directory.
        const workspace = path.resolve(options.workspace);
        const socket = resolveManualDaemonSocketPath(options.socket, workspace);
        const session = await openSessionClient(
          claudeCodeAdapter.createSessionInput({
            hostSessionId: options.hostSessionId,
            workspacePath: workspace,
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
        if (options.format === 'id') {
          console.log(session.id);
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
    if (!state.enabled) {
      // Quick-exit: monitoring not enabled here. A silent quick-exit is a
      // dead-end for a user who authored monitors and simply missed the
      // enable step (issue #269) — they get zero signal forever. So before
      // exiting, check whether the project actually has monitor definitions
      // sitting unwatched; if so, surface a one-line advisory through the
      // SAME additionalContext mechanism used by the recap below. Still
      // exits 0 and still does NOT open a session or boot a daemon — this
      // is advisory only (non-goals: never auto-enable, never boot).
      //
      // A workspace with NO monitor definitions stays fully silent (never
      // nag a user who hasn't opted in at all yet).
      const disabledMonitorsDir = path.join(
        workspacePath,
        '.claude',
        'monitors',
      );
      const scan = await scanMonitors(disabledMonitorsDir);
      const monitorCount = scan.monitors.length + scan.errors.length;
      if (monitorCount > 0) {
        const advisory = renderMonitoringDisabledAdvisory(
          monitorCount,
          'SessionStart',
        );
        // stdout is the SessionStart hook's wire channel — see the identical
        // note on the recap write below.
        process.stdout.write(JSON.stringify(advisory));
      }
      return;
    }

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

      // One-line success ack on STDERR (issue #420 P3). stdout is this
      // command's hook wire channel and MUST stay clean (it carries only the
      // post-compact recap JSON below, if any) — so a hand-wiring user who
      // needs to confirm the session registered gets it on stderr, which the
      // Claude Code host never reads. Silent success was a dead end that forced
      // a second `session list` just to tell it worked.
      console.error(
        `AgentMon: session ${opened.id} registered; daemon at ${socket}`,
      );

      // SessionStart is a context event, so this command ALSO surfaces the
      // post-compact recap — from the SAME stdin payload we already read.
      // The plugin runs `session start` as ONE hook command; a separately
      // chained `agentmonitors hook deliver` would see an already-consumed
      // stdin (one hook invocation = one stdin stream), parse `{}`, and
      // silently no-op. Reading once and delivering here is the fix. On a
      // fresh start nothing is pending → `flow.output` is null → nothing is
      // printed; on a compact-resume the unread events are recapped.
      //
      // This is a RESERVE → RENDER → WRITE → COMMIT sequence, never a direct
      // claim-then-render (issue #442, PR #442 round-16 review): the prior
      // code called `claimDeliveryClient` — the durable `first_notified_at`
      // mutation — BEFORE rendering or writing anything, then wrote via a bare,
      // un-awaited `process.stdout.write`. `process.stdout.write`'s synchronous
      // return value is only a backpressure signal; an async `EPIPE` arriving
      // after that call would durably claim the recap rows while emitting
      // nothing — the exact at-most-once loss window `hook deliver` closed for
      // its own transport (`reserveRenderAndCommitHookDelivery` /
      // `writeAndCommitHookDelivery`, `hook.ts`). Reusing that same shared flow
      // here (its `post-compact` branch needs no per-event cap sizing, so it
      // reserves the full unread set directly) closes the identical window for
      // the SessionStart recap: a write failure releases the reservation
      // (rows stay pending, nothing durably claimed) instead of committing.
      const flow = await reserveRenderAndCommitHookDelivery(
        opened.id,
        'post-compact',
        socket,
        'SessionStart',
      );
      if (flow) {
        // stdout is the SessionStart hook's wire channel: it MUST contain only
        // this JSON. Do NOT add `console.log`/diagnostics to stdout in this
        // command — anything else here corrupts the hook output Claude reads.
        await writeAndCommitHookDelivery(flow, (toWrite) =>
          writeStreamChunk(process.stdout, JSON.stringify(toWrite)),
        );
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
      if (match) {
        await closeSessionClient(match.id, socket);
        // One-line success ack on STDERR (issue #420 P3). This command has no
        // stdout wire output, but stderr keeps the symmetry with `session
        // start` and gives a hand-wiring user a durable signal that the session
        // deregistered. The Claude Code host never reads hook stderr.
        console.error(`AgentMon: session ${match.id} ended`);
      }
    } catch {
      // daemon went away mid-deregister — the idle reaper is the backstop; no-op.
    }
  });
