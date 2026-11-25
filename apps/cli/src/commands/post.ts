import { Command } from 'commander';
import { callDaemon } from '../daemon-ipc.js';
import { MAX_TIMER_DELAY_MS, parseIntegerOption } from '../integer-option.js';
import {
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';
import { reportError } from '../output.js';

export const postCommand = new Command('post')
  .description('Post a message to a session')
  .argument('<body>', 'Message text')
  .requiredOption('--session <id>', 'Recipient session id (see session list)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--require-ack',
    'Resurface the message until acknowledged or its budget is spent',
  )
  .option(
    '--resurface-after-ms <ms>',
    'Time between delivery and the next offer (default 300000)',
  )
  .option(
    '--max-resurfaces <count>',
    'Resurfaces before needs-attention (default 2)',
  )
  .action(
    async (
      body: string,
      options: {
        session: string;
        socket?: string;
        requireAck?: boolean;
        resurfaceAfterMs?: string;
        maxResurfaces?: string;
      },
    ) => {
      try {
        const resurfaceAfterMs =
          options.resurfaceAfterMs === undefined
            ? undefined
            : parseIntegerOption(
                '--resurface-after-ms',
                options.resurfaceAfterMs,
                { min: 1, max: MAX_TIMER_DELAY_MS },
              );
        if (resurfaceAfterMs?.ok === false)
          throw new Error(resurfaceAfterMs.message);
        const maxResurfaces =
          options.maxResurfaces === undefined
            ? undefined
            : parseIntegerOption('--max-resurfaces', options.maxResurfaces, {
                min: 0,
                max: 100,
              });
        if (maxResurfaces?.ok === false) throw new Error(maxResurfaces.message);
        const socketPath = resolveManualDaemonSocketPath(options.socket);
        const result = await callDaemon<{ eventId: string }>(
          'messages.post',
          {
            sessionId: options.session,
            body,
            requireAck: options.requireAck,
            resurfaceAfterMs: resurfaceAfterMs?.value,
            maxResurfaces: maxResurfaces?.value,
          },
          socketPath ? { socketPath } : {},
        );
        console.log(result.eventId);
      } catch (error) {
        reportError(manualDaemonErrorMessage(error), false);
      }
    },
  );
