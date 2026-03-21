import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AgentMonitorRuntime } from '@agentmonitors/core';

interface ServerOptions {
  socketPath: string;
  monitorsDir: string;
  workspacePath: string;
  intervalMs: number;
}

function ok(result: unknown) {
  return JSON.stringify({ ok: true, result });
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ ok: false, error: message });
}

export async function runRuntimeServer(
  runtime: AgentMonitorRuntime,
  options: ServerOptions,
): Promise<void> {
  mkdirSync(path.dirname(options.socketPath), { recursive: true });
  if (existsSync(options.socketPath)) {
    unlinkSync(options.socketPath);
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const requestJson = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      try {
        const request = JSON.parse(requestJson) as {
          method: string;
          payload?: Record<string, unknown>;
        };
        let result: unknown;
        switch (request.method) {
          case 'status':
            result = runtime.status();
            break;
          case 'tick':
            result = await runtime.tick(
              options.monitorsDir,
              options.workspacePath,
            );
            break;
          case 'session.open':
            result = runtime.openSession(request.payload as never);
            break;
          case 'session.close':
            result = runtime.closeSession(String(request.payload?.['sessionId']));
            break;
          case 'session.list':
            result = runtime.listSessions();
            break;
          case 'events.list':
            result = runtime.listEvents(request.payload as never);
            break;
          case 'events.ack':
            runtime.acknowledgeSession(
              String(request.payload?.['sessionId']),
              Array.isArray(request.payload?.['eventIds'])
                ? (request.payload?.['eventIds'] as string[])
                : undefined,
            );
            result = { ok: true };
            break;
          case 'hook.claim':
            result = runtime.claimDelivery(
              String(request.payload?.['sessionId']),
              request.payload?.['lifecycle'] as
                | 'turn-interruptible'
                | 'turn-idle'
                | 'post-compact',
            );
            break;
          default:
            throw new Error(`Unknown method: ${request.method}`);
        }
        socket.write(`${ok(result)}\n`);
      } catch (error) {
        socket.write(`${fail(error)}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => resolve());
  });

  const timer = setInterval(() => {
    runtime.tick(options.monitorsDir, options.workspacePath).catch(() => {
      // keep the daemon alive; RPC callers can inspect status and events
    });
  }, options.intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      if (existsSync(options.socketPath)) {
        unlinkSync(options.socketPath);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runtime.tick(options.monitorsDir, options.workspacePath);
}
