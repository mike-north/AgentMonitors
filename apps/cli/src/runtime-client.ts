import type {
  AgentSessionRecord,
  DeclareEphemeralMonitorInput,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DoctorMonitorRollup,
  DoctorReportInput,
  EphemeralMonitorRecord,
  EventQuery,
  HookDeliveryDiagnosis,
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

/**
 * Retract (delete) a specific SET of a synthetic object's events by id — across
 * all sessions — from the LIVE daemon over its socket. `verify
 * --use-workspace-daemon` calls this to erase the create/delete events its own
 * throwaway scratch file generated against the workspace daemon, so a later
 * session never sees a spurious `File deleted: agentmonitors-verify-…` (issue
 * #407). The caller passes the exact ids it observed for that file, so a real
 * event sharing the same watched path is never swept; `monitorId` scopes the
 * deletion as defense in depth. Returns the number of events removed.
 */
export async function retractObjectEventsClient(
  input: {
    monitorId: string;
    objectKey: string;
    eventIds: string[];
    workspacePath?: string;
  },
  socketPath?: string,
): Promise<number> {
  const result = await callDaemon<{ removed: number }>(
    'events.retractObject',
    input,
    socketPath ? { socketPath } : {},
  );
  return result.removed;
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

/**
 * Diagnose (read-only) why a `claimDelivery(sessionId, lifecycle)` call would
 * or would not surface anything right now (issue #334). Used exclusively by
 * `hook deliver --debug` to write a stderr diagnosis alongside the unchanged
 * stdout contract — never called on the non-debug path.
 */
export async function diagnoseHookDeliveryClient(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath?: string,
): Promise<HookDeliveryDiagnosis> {
  return await callDaemon<HookDeliveryDiagnosis>(
    'hook.diagnose',
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

/**
 * Declare an ephemeral (agent-declared, session-scoped) monitor through the
 * daemon (007 §4.2 / 005 §14.4). Thin over the socket IPC (AP6); the runtime
 * validates the scope with the same `validateScope` path as `agentmonitors
 * validate`.
 */
export async function declareWatchClient(
  input: DeclareEphemeralMonitorInput,
  socketPath?: string,
): Promise<EphemeralMonitorRecord> {
  return await callDaemon<EphemeralMonitorRecord>(
    'watch.declare',
    input as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
}

/** List a session's active ephemeral monitors (007 §4, `watch list`). */
export async function listWatchClient(
  sessionId: string,
  socketPath?: string,
): Promise<EphemeralMonitorRecord[]> {
  return await callDaemon<EphemeralMonitorRecord[]>(
    'watch.list',
    { sessionId },
    socketPath ? { socketPath } : {},
  );
}

/** Cancel (immediately reap) one of a session's ephemeral monitors (007 §4.4). */
export async function cancelWatchClient(
  sessionId: string,
  ephemeralId: string,
  socketPath?: string,
): Promise<EphemeralMonitorRecord> {
  return await callDaemon<EphemeralMonitorRecord>(
    'watch.cancel',
    { sessionId, ephemeralId },
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
 *
 * `dbPath` is the workspace-resolved database path ({@link
 * resolveWorkspaceDbPath} in `workspace-db-path.ts`) — the SAME db `doctor`
 * reads (issue #374). Required (not optional, matching {@link
 * doctorReportInProcess}): every caller already has a workspace to resolve
 * against, so an optional default here would only invite a caller to skip
 * that resolution and silently fall back to the bare global default,
 * disagreeing with `doctor`'s diagnosis of the same workspace.
 */
export async function explainMonitorInProcess(
  input: MonitorExplainInput,
  dbPath: string,
): Promise<MonitorExplainReport> {
  const runtime = createRuntime(dbPath);
  return await runtime.explainMonitor(input);
}

/**
 * Read observation history *in-process* from the persisted SQLite store,
 * bypassing the daemon socket. Fallback for {@link listObservationHistoryClient}
 * when the daemon is unreachable. Issue #150.
 *
 * `dbPath` is the workspace-resolved database path ({@link
 * resolveWorkspaceDbPath} in `workspace-db-path.ts`) — the SAME db `doctor`
 * reads (issue #374). Required (not optional, matching {@link
 * doctorReportInProcess}): every caller already has a workspace to resolve
 * against, so an optional default here would only invite a caller to skip
 * that resolution and silently fall back to the bare global default,
 * disagreeing with `doctor`'s diagnosis of the same workspace.
 */
export function listObservationHistoryInProcess(
  query: ObservationHistoryQuery,
  dbPath: string,
): ObservationHistoryRecord[] {
  const runtime = createRuntime(dbPath);
  return runtime.listObservationHistory(query);
}

/**
 * Build the `agentmonitors doctor` health report *in-process* against the
 * persisted SQLite store (issue #267).
 *
 * Fallback for {@link doctorReportClient} when the daemon is unreachable
 * (issue #373 — a genuinely live daemon holds its own connection open on the
 * SAME SQLite file, and a separate reader connection opened here can observe
 * that connection's commits with a lag: WAL visibility across processes is
 * NOT instantaneous the way same-connection reads are. Preferring the live
 * daemon's own connection when one is reachable is what makes the rollup
 * match `events list`/`monitor history`'s ground truth; this in-process path
 * is only correct as a last resort when there is no live connection to ask).
 * `dbPath` is the workspace-resolved database path.
 */
export async function doctorReportInProcess(
  input: DoctorReportInput,
  dbPath: string,
): Promise<MonitorDoctorReport> {
  const runtime = createRuntime(dbPath);
  return await runtime.doctorReport(input);
}

/** `AgentSessionRecord` fields serialized as ISO strings over the wire. */
const SESSION_DATE_FIELDS = [
  'baselineAt',
  'lastActiveAt',
  'lastRecapAt',
  'dormantAt',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof AgentSessionRecord)[];

/** `DoctorMonitorRollup` fields serialized as ISO strings over the wire. */
const MONITOR_ROLLUP_DATE_FIELDS = [
  'lastObservedAt',
  'nextDueAt',
  'lastEventAt',
] as const satisfies readonly (keyof DoctorMonitorRollup)[];

/**
 * Reconstruct the `Date` fields {@link MonitorDoctorReport} promises, lost to
 * plain ISO strings by the JSON round trip over the daemon socket (issue
 * #373). `doctorReportInProcess` returns real `Date` objects straight from
 * the store; `doctor.ts` calls `.toISOString()` on report dates unconditionally
 * (unlike sibling commands, which only re-serialize their reports), so
 * `doctorReportClient` must uphold the same contract or that call throws.
 */
function reviveDoctorReportDates(
  report: MonitorDoctorReport,
): MonitorDoctorReport {
  return {
    ...report,
    generatedAt: new Date(report.generatedAt),
    monitors: report.monitors.map((monitor) => {
      const revived = { ...monitor };
      for (const field of MONITOR_ROLLUP_DATE_FIELDS) {
        const value = revived[field];
        if (value !== undefined) revived[field] = new Date(value);
      }
      return revived;
    }),
    leadSessions: report.leadSessions.map((session) => {
      const revived = { ...session };
      for (const field of SESSION_DATE_FIELDS) {
        const value = revived[field];
        if (value !== undefined) revived[field] = new Date(value);
      }
      return revived;
    }),
  };
}

/**
 * Build the `agentmonitors doctor` health report from the LIVE daemon over
 * its socket (issue #373). Preferred over {@link doctorReportInProcess}
 * whenever a daemon is reachable: reading through the daemon's own
 * connection is what guarantees the rollup reflects the same ground truth
 * `events list`/`monitor history` (also daemon-served) report, rather than a
 * separate reader connection's lagged view of the same SQLite file.
 */
export async function doctorReportClient(
  input: DoctorReportInput,
  socketPath?: string,
): Promise<MonitorDoctorReport> {
  const report = await callDaemon<MonitorDoctorReport>(
    'doctor.report',
    input as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
  return reviveDoctorReportDates(report);
}
