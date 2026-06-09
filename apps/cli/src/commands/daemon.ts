import { Command, Option } from 'commander';
import type { WatchHandle } from '@mike-north/core';
import { createRuntime } from '../runtime.js';
import { reportError } from '../output.js';
import {
  callDaemon,
  createDaemonServer,
  daemonAvailable,
  resolveSocketPath,
} from '../daemon-ipc.js';
import { daemonStatusClient, daemonTickClient } from '../runtime-client.js';
import { shouldReap, BOOT_GRACE_MS } from '../reap-decision.js';

const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1000;

async function runLoop(
  monitorsDir: string,
  workspacePath: string,
  pollMs: number,
  socketPath: string,
  reapAfterMs: number,
): Promise<void> {
  const runtime = createRuntime();
  let stopping = false;
  let wakeLoop: (() => void) | undefined;
  const server = createDaemonServer({
    runtime,
    socketPath,
    onStop: () => {
      stopping = true;
      wakeLoop?.();
    },
  });
  const stop = () => {
    stopping = true;
    wakeLoop?.();
  };
  const isStoppingRequested = () => stopping;

  let idleSince: number | null = null;
  let hasSeenSession = false;

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await server.listen();
  console.log(`AgentMon daemon listening on ${socketPath}`);

  // Start continuous watchers for any watch-capable sources (G5). Watched
  // monitors are driven by their watcher; the tick loop below skips them. New
  // monitors added after startup are picked up on the next daemon restart.
  let watchHandle: WatchHandle | undefined;
  try {
    watchHandle = await runtime.watchMonitors(monitorsDir, workspacePath, {
      onError: (monitorId, error) => {
        console.error(
          `AgentMon watcher for "${monitorId}" failed: ${error.message}`,
        );
      },
    });
    if (watchHandle.monitorIds.length > 0) {
      console.log(
        `Watching ${String(watchHandle.monitorIds.length)} monitor(s) continuously: ${watchHandle.monitorIds.join(', ')}.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`AgentMon watch setup failed: ${message}`);
  }

  try {
    while (!isStoppingRequested()) {
      try {
        const result = await runtime.tick(monitorsDir, workspacePath);
        if (result.emittedEventIds.length > 0) {
          console.log(
            `Emitted ${String(result.emittedEventIds.length)} event(s) from ${String(result.evaluatedMonitors.length)} monitor(s).`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`AgentMon runtime tick failed: ${message}`);
      }

      // Idle reaping: stop the daemon when no active sessions have been open
      // for this workspace continuously for the required idle window.
      // Uses shouldReap() which applies a boot-grace period to prevent the
      // reaper from firing before `session start` finishes registration.
      //
      // hasSeenSession is also set if any dormant session exists — this handles
      // the case where a session is registered and closed between tick intervals
      // (tick only observes the closed/dormant state but must not apply the
      // boot-grace period as if no session was ever registered).
      {
        const workspaceSessions = runtime
          .listSessions()
          .filter((s) => s.workspacePath === workspacePath);
        const openCount = workspaceSessions.filter(
          (s) => s.status === 'active',
        ).length;
        const anySession = workspaceSessions.length > 0;
        const decision = shouldReap({
          openCount,
          hasSeenSession: hasSeenSession || anySession,
          idleSince,
          now: Date.now(),
          reapAfterMs,
          bootGraceMs: BOOT_GRACE_MS,
        });
        idleSince = decision.nextIdleSince;
        hasSeenSession = decision.nextHasSeenSession;
        if (decision.reap) {
          stop();
        }
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          wakeLoop = undefined;
          resolve();
        }, pollMs);
        wakeLoop = () => {
          clearTimeout(timeout);
          wakeLoop = undefined;
          resolve();
        };
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (watchHandle) await watchHandle.stop();
    await server.close();
  }
}

export const daemonCommand = new Command('daemon').description(
  'Run or inspect the AgentMon runtime loop',
);

daemonCommand
  .command('once')
  .description('Run one runtime observation cycle')
  .argument(
    '[monitorsDir]',
    'Directory containing MONITOR.md files',
    '.claude/monitors',
  )
  .option(
    '--workspace <path>',
    'Workspace path for session projection',
    process.cwd(),
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      monitorsDir: string,
      options: { workspace: string; format: string },
    ) => {
      try {
        const result = await daemonTickClient(monitorsDir, options.workspace);
        if (options.format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Evaluated ${String(result.evaluatedMonitors.length)} monitor(s), emitted ${String(result.emittedEventIds.length)} event(s).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

daemonCommand
  .command('run')
  .description('Run the runtime loop continuously')
  .argument(
    '[monitorsDir]',
    'Directory containing MONITOR.md files',
    '.claude/monitors',
  )
  .option(
    '--workspace <path>',
    'Workspace path for session projection',
    process.cwd(),
  )
  .option('--poll-ms <ms>', 'Polling interval in milliseconds', '30000')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--reap-after-ms <ms>',
    'Stop the daemon after this many ms of idle (no active sessions). Set 0 to disable.',
    String(DEFAULT_REAP_AFTER_MS),
  )
  .action(
    async (
      monitorsDir: string,
      options: {
        workspace: string;
        pollMs: string;
        socket?: string;
        reapAfterMs: string;
      },
    ) => {
      const pollMs = Number(options.pollMs);
      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        reportError('--poll-ms must be a positive number.', false);
        return;
      }
      const reapAfterMs = Number(options.reapAfterMs);
      if (!Number.isFinite(reapAfterMs) || reapAfterMs < 0) {
        reportError(
          '--reap-after-ms must be a non-negative number (0 disables).',
          false,
        );
        return;
      }
      const socketPath = resolveSocketPath(options.socket);
      if (await daemonAvailable(socketPath)) {
        reportError(
          `AgentMon daemon is already running at ${socketPath}.`,
          false,
        );
        return;
      }
      await runLoop(
        monitorsDir,
        options.workspace,
        pollMs,
        socketPath,
        reapAfterMs,
      );
    },
  );

daemonCommand
  .command('status')
  .description('Show runtime status from the local database')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (options: { socket?: string; format: string }) => {
    try {
      const running = await daemonAvailable(options.socket);
      const status = running
        ? await daemonStatusClient(options.socket)
        : createRuntime().status();
      const payload = {
        running,
        socketPath: resolveSocketPath(options.socket),
        ...status,
      };
      if (options.format === 'json') {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Daemon running: ${running ? 'yes' : 'no'}`);
      console.log(`Socket: ${payload.socketPath}`);
      console.log(`Sessions: ${String(status.sessions)}`);
      console.log(`Active sessions: ${String(status.activeSessions)}`);
      console.log(`Dormant sessions: ${String(status.dormantSessions)}`);
      console.log(`Events: ${String(status.events)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, options.format === 'json');
    }
  });

daemonCommand
  .command('stop')
  .description('Ask the local AgentMon daemon to stop')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .action(async (options: { socket?: string }) => {
    try {
      await callDaemon(
        'stop',
        {},
        options.socket ? { socketPath: options.socket } : {},
      );
      console.log('AgentMon daemon stopping.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, false);
    }
  });
