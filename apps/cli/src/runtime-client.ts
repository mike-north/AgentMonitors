import type {
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryLifecycle,
  EventQuery,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorEventRecord,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
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

export async function listObservationHistoryClient(
  query: ObservationHistoryQuery,
  socketPath?: string,
): Promise<ObservationHistoryRecord[]> {
  return await callDaemon<ObservationHistoryRecord[]>(
    'history.list',
    query as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
}

export async function explainMonitorClient(
  input: MonitorExplainInput,
  socketPath?: string,
): Promise<MonitorExplainReport> {
  return await callDaemon<MonitorExplainReport>(
    'monitor.explain',
    input as unknown as Record<string, unknown>,
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

/**
 * Run `monitor explain` *in-process* against the persisted SQLite store,
 * bypassing the daemon socket entirely.
 *
 * Used as the fallback for {@link explainMonitorClient} when the daemon is
 * unreachable ({@link DaemonConnectionError}). A read-only diagnosis tool must
 * not require a live daemon to read persisted state from the last tick — the
 * data is already in the DB (e.g. right after `daemon once`). This is the same
 * in-process pattern `daemon once` uses (see {@link daemonTickClient}): build a
 * runtime over the real store and call the core method directly. Issue #150.
 */
export async function explainMonitorInProcess(
  input: MonitorExplainInput,
): Promise<MonitorExplainReport> {
  const runtime = createRuntime();
  return await runtime.explainMonitor(input);
}

/**
 * Read observation history *in-process* from the persisted SQLite store,
 * bypassing the daemon socket. Fallback for {@link listObservationHistoryClient}
 * when the daemon is unreachable. Issue #150.
 */
export function listObservationHistoryInProcess(
  query: ObservationHistoryQuery,
): ObservationHistoryRecord[] {
  const runtime = createRuntime();
  return runtime.listObservationHistory(query);
}
