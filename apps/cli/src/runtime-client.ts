import type {
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryLifecycle,
  EventQuery,
  MonitorEventRecord,
  OpenSessionInput,
  RuntimeStatus,
  RuntimeTickResult,
} from '@agentmonitors/core';
import { createRuntime } from './runtime.js';
import { callDaemon } from './daemon-ipc.js';

export async function openSessionClient(
  input: OpenSessionInput,
  socketPath?: string,
): Promise<AgentSessionRecord> {
  return await callDaemon<AgentSessionRecord>(
    'session.open',
    input as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
}

export async function closeSessionClient(
  sessionId: string,
  socketPath?: string,
): Promise<AgentSessionRecord> {
  return await callDaemon<AgentSessionRecord>(
    'session.close',
    { sessionId },
    socketPath ? { socketPath } : {},
  );
}

export async function listSessionsClient(
  socketPath?: string,
): Promise<AgentSessionRecord[]> {
  return await callDaemon<AgentSessionRecord[]>(
    'session.list',
    {},
    socketPath ? { socketPath } : {},
  );
}

export async function listEventsClient(
  query: EventQuery,
  socketPath?: string,
): Promise<MonitorEventRecord[]> {
  return await callDaemon<MonitorEventRecord[]>(
    'events.list',
    query as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
}

export async function acknowledgeEventsClient(
  sessionId: string,
  eventIds?: string[],
  socketPath?: string,
): Promise<void> {
  await callDaemon(
    'events.ack',
    {
      sessionId,
      ...(eventIds ? { eventIds } : {}),
    },
    socketPath ? { socketPath } : {},
  );
}

export async function claimDeliveryClient(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath?: string,
): Promise<DeliveryClaim | null> {
  return await callDaemon<DeliveryClaim | null>(
    'hook.claim',
    { sessionId, lifecycle },
    socketPath ? { socketPath } : {},
  );
}

export async function daemonStatusClient(
  socketPath?: string,
): Promise<RuntimeStatus> {
  return await callDaemon<RuntimeStatus>(
    'status',
    {},
    socketPath ? { socketPath } : {},
  );
}

export async function daemonTickClient(
  monitorsDir: string,
  workspacePath?: string,
): Promise<RuntimeTickResult> {
  const runtime = createRuntime();
  return await runtime.tick(monitorsDir, workspacePath);
}
