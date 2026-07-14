import type {
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DoctorReportInput,
  EventQuery,
  MonitorDoctorReport,
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
  maxEvents?: number,
): Promise<DeliveryClaim | null> {
  return await callDaemon<DeliveryClaim | null>(
    'hook.claim',
    {
      sessionId,
      lifecycle,
      ...(maxEvents !== undefined ? { maxEvents } : {}),
    },
    socketPath ? { socketPath } : {},
  );
}

/**
 * Preview the settled high-urgency events a `turn-interruptible` claim would
 * surface for a session, WITHOUT claiming them (issue #299). The hook-deliver
 * transport uses this to size how many whole event blocks fit under its
 * 4000-char `additionalContext` cap before claiming exactly that many.
 */
export async function previewSettledHighDeliveryClient(
  sessionId: string,
  socketPath?: string,
): Promise<DeliveryEventSummary[]> {
  return await callDaemon<DeliveryEventSummary[]>(
    'hook.preview',
    { sessionId },
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
  dbPath?: string,
): Promise<RuntimeTickResult> {
  const runtime = createRuntime(dbPath);
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

/**
 * Build the `agentmonitors doctor` health report *in-process* against the
 * persisted SQLite store (issue #267). Doctor is a read-only diagnosis, so it
 * always reads the store directly rather than round-tripping the daemon socket —
 * the daemon writes the same DB, so the report is accurate whether or not a
 * daemon is running (mirrors `daemon status`'s in-process read). `dbPath` is the
 * workspace-resolved database path.
 */
export async function doctorReportInProcess(
  input: DoctorReportInput,
  dbPath: string,
): Promise<MonitorDoctorReport> {
  const runtime = createRuntime(dbPath);
  return await runtime.doctorReport(input);
}
