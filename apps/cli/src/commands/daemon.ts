import { Command, Option } from 'commander';
import { createRuntime } from '../runtime.js';
import { reportError } from '../output.js';
import {
  callDaemon,
  createDaemonServer,
  daemonAvailable,
  resolveSocketPath,
} from '../daemon-ipc.js';
import { daemonStatusClient, daemonTickClient } from '../runtime-client.js';

async function runLoop(
  monitorsDir: string,
  workspacePath: string,
  pollMs: number,
  socketPath: string,
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

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await server.listen();
  console.log(`AgentMon daemon listening on ${socketPath}`);

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
  .action(
    async (
      monitorsDir: string,
      options: { workspace: string; pollMs: string; socket?: string },
    ) => {
      const pollMs = Number(options.pollMs);
      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        reportError('--poll-ms must be a positive number.', false);
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
      await runLoop(monitorsDir, options.workspace, pollMs, socketPath);
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
