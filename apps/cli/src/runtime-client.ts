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
import { callDaemon, daemonAvailable } from './daemon-ipc.js';
import { createRuntime } from './runtime.js';

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function normalizeSession(session: AgentSessionRecord): AgentSessionRecord {
  return {
    ...session,
    baselineAt: asDate(session.baselineAt),
    lastActiveAt: asDate(session.lastActiveAt),
    ...(session.lastRecapAt
      ? { lastRecapAt: asDate(session.lastRecapAt) }
      : {}),
    ...(session.dormantAt ? { dormantAt: asDate(session.dormantAt) } : {}),
    createdAt: asDate(session.createdAt),
    updatedAt: asDate(session.updatedAt),
  };
}

function normalizeEvent(event: MonitorEventRecord): MonitorEventRecord {
  return {
    ...event,
    createdAt: asDate(event.createdAt),
  };
}

async function withFallback<T>(
  remote: () => Promise<T>,
  local: () => T | Promise<T>,
  socketPath?: string,
): Promise<T> {
  if (await daemonAvailable(socketPath)) {
    return await remote();
  }
  return await local();
}

export async function openSessionClient(
  input: OpenSessionInput,
  socketPath?: string,
): Promise<AgentSessionRecord> {
  return withFallback(
    () =>
      callDaemon<AgentSessionRecord>(
        'session.open',
        input as unknown as Record<string, unknown>,
        socketPath ? { socketPath } : {},
      ).then(normalizeSession),
    () => normalizeSession(createRuntime().openSession(input)),
    socketPath,
  );
}

export async function closeSessionClient(
  sessionId: string,
  socketPath?: string,
): Promise<AgentSessionRecord> {
  return withFallback(
    () =>
      callDaemon<AgentSessionRecord>(
        'session.close',
        { sessionId },
        socketPath ? { socketPath } : {},
      ).then(normalizeSession),
    () => normalizeSession(createRuntime().closeSession(sessionId)),
    socketPath,
  );
}

export async function listSessionsClient(
  socketPath?: string,
): Promise<AgentSessionRecord[]> {
  return withFallback(
    () =>
      callDaemon<AgentSessionRecord[]>(
        'session.list',
        {},
        socketPath ? { socketPath } : {},
      ).then((sessions) => sessions.map(normalizeSession)),
    () => createRuntime().listSessions().map(normalizeSession),
    socketPath,
  );
}

export async function listEventsClient(
  query: EventQuery,
  socketPath?: string,
): Promise<MonitorEventRecord[]> {
  return withFallback(
    () =>
      callDaemon<MonitorEventRecord[]>(
        'events.list',
        query as Record<string, unknown>,
        socketPath ? { socketPath } : {},
      ).then((events) => events.map(normalizeEvent)),
    () => createRuntime().listEvents(query).map(normalizeEvent),
    socketPath,
  );
}

export async function acknowledgeEventsClient(
  sessionId: string,
  eventIds?: string[],
  socketPath?: string,
): Promise<void> {
  await withFallback(
    () =>
      callDaemon(
        'events.ack',
        {
          sessionId,
          ...(eventIds ? { eventIds } : {}),
        },
        socketPath ? { socketPath } : {},
      ).then(() => undefined),
    () => {
      createRuntime().acknowledgeSession(sessionId, eventIds);
    },
    socketPath,
  );
}

export async function claimDeliveryClient(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath?: string,
): Promise<DeliveryClaim | null> {
  return withFallback(
    () =>
      callDaemon<DeliveryClaim | null>(
        'hook.claim',
        {
          sessionId,
          lifecycle,
        },
        socketPath ? { socketPath } : {},
      ),
    () => createRuntime().claimDelivery(sessionId, lifecycle),
    socketPath,
  );
}

export async function daemonStatusClient(
  socketPath?: string,
): Promise<RuntimeStatus> {
  return withFallback(
    () =>
      callDaemon<RuntimeStatus>('status', {}, socketPath ? { socketPath } : {}),
    () => createRuntime().status(),
    socketPath,
  );
}

export async function daemonTickClient(
  monitorsDir: string,
  workspacePath: string,
  socketPath?: string,
): Promise<RuntimeTickResult> {
  return withFallback(
    () =>
      callDaemon<RuntimeTickResult>(
        'daemon.tick',
        {
          monitorsDir,
          workspacePath,
        },
        socketPath ? { socketPath } : {},
      ),
    () => createRuntime().tick(monitorsDir, workspacePath),
    socketPath,
  );
}
