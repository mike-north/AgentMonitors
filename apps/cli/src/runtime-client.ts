import type {
  AgentSessionRecord,
  DeclareEphemeralMonitorInput,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DeliveryReservation,
  DoctorMonitorRollup,
  DoctorReportInput,
  EphemeralMonitorRecord,
  EventQuery,
  HookDeliveryDiagnosis,
  MaterializationRetryRepairInput,
  MaterializationRetryRepairResult,
  MaterializationRetrySkipInput,
  MaterializationRetrySummary,
  MonitorDoctorReport,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorEventRecord,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
  OpenSessionInput,
  RuntimeTickResult,
  UnretainedObservationLoss,
} from '@agentmonitors/core';
import {
  isMaterializationRetrySummary,
  normalizeRetryRecord,
  normalizeRetrySummary,
  normalizeUnretainedObservationLoss,
} from './retry-diagnostics.js';
import { createRuntime } from './runtime.js';
import { callDaemon, type DaemonStatusResult } from './daemon-ipc.js';

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

/**
 * Install a durable, self-expiring suppression over a synthetic object key on the
 * LIVE daemon and retract what that key already has (issue #414). `verify
 * --use-workspace-daemon` calls this the instant it has proven delivery: it
 * erases the create event now and leaves the daemon to auto-retract the scratch
 * file's pending deletion on the tick it materializes — so verify need not block
 * a full poll interval for that deletion (the #407 wait that doubled its
 * runtime), while a later session still never sees the scratch event. MUST only
 * target verify's own `…/agentmonitors-verify-<token>` scratch path. Returns the
 * number of already-materialized events retracted immediately.
 *
 * Current verify uses this finite tombstone only against a daemon that predates
 * verify artifact ownership ({@link registerVerifyArtifactClient}, issue #562).
 */
export async function suppressObjectEventsClient(
  input: {
    monitorId: string;
    objectKey: string;
    ttlMs: number;
    workspacePath?: string;
  },
  socketPath?: string,
): Promise<number> {
  const result = await callDaemon<{ removed: number }>(
    'events.suppressObject',
    input,
    socketPath ? { socketPath } : {},
  );
  return result.removed;
}

/**
 * Register exact ownership of verify's synthetic scratch artifact on the LIVE
 * daemon, before the file is created (issue #562). From then on the daemon can
 * keep that exact key out of later sessions once cleanup takes effect, even if
 * this run is killed before any event projects. An older daemon answers with
 * `DaemonUnsupportedRequestError`; the caller then uses its legacy cleanup.
 */
export async function registerVerifyArtifactClient(
  input: {
    runId: string;
    ownerSessionId: string;
    workspacePath: string;
    monitorId: string;
    objectKey: string;
  },
  socketPath?: string,
): Promise<void> {
  await callDaemon(
    'verifyArtifacts.register',
    input,
    socketPath ? { socketPath } : {},
  );
}

/**
 * Ask the LIVE daemon to put this run's registered artifact under permanent
 * cleanup authority and retract its existing events (issue #562). Idempotent.
 * Returns the number of events retracted by this request.
 */
export async function requestVerifyArtifactCleanupClient(
  runId: string,
  socketPath?: string,
): Promise<number> {
  const result = await callDaemon<{ retractedEventCount: number }>(
    'verifyArtifacts.requestCleanup',
    { runId },
    socketPath ? { socketPath } : {},
  );
  return result.retractedEventCount;
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
 * Reserve — but do not yet claim — the pending `turn-interruptible` delivery for
 * a session (006 §4, issue #300). Returns the {@link DeliveryReservation}
 * (claim + opaque `reservationId`) a transport surfaces then {@link
 * commitDeliveryClient commits} (on success) or {@link releaseDeliveryClient
 * releases} (on a failed push), or `null` when nothing is pending. Reserving
 * leases the rows so the hook transport will not double-surface them (006 §4.5),
 * WITHOUT marking them claimed — the claim is deferred to commit so a transient
 * push failure never consumes the delivery.
 */
export async function reserveDeliveryClient(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath?: string,
  maxEvents?: number,
): Promise<DeliveryReservation | null> {
  return await callDaemon<DeliveryReservation | null>(
    'hook.reserve',
    {
      sessionId,
      lifecycle,
      ...(maxEvents !== undefined ? { maxEvents } : {}),
    },
    socketPath ? { socketPath } : {},
  );
}

/**
 * Commit a reservation from {@link reserveDeliveryClient} after its claim was
 * surfaced (006 §4, issue #300): the reserved rows become claimed ("was
 * surfaced", BP2 — not acknowledged). Returns the committed {@link
 * DeliveryClaim}, or `null` if the reservation was unknown/expired (a safe
 * no-op — the rows were never permanently consumed).
 */
export async function commitDeliveryClient(
  reservationId: string,
  socketPath?: string,
): Promise<DeliveryClaim | null> {
  return await callDaemon<DeliveryClaim | null>(
    'hook.commit',
    { reservationId },
    socketPath ? { socketPath } : {},
  );
}

/**
 * Release a reservation from {@link reserveDeliveryClient} WITHOUT claiming (006
 * §4, issue #300): the push failed/disconnected, so the leased rows return to
 * `pending` for the hook transport (or the next poll) to re-deliver.
 */
export async function releaseDeliveryClient(
  reservationId: string,
  socketPath?: string,
): Promise<void> {
  await callDaemon(
    'hook.release',
    { reservationId },
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
 * Preview the coalesced normal-urgency reminder text a `turn-interruptible`
 * claim would append to a settled-high delivery for this session RIGHT NOW,
 * WITHOUT claiming anything (issue #441 cross-monitor coalescing; PR #456
 * review finding 4). A length-bounded transport MUST call this alongside
 * {@link previewSettledHighDeliveryClient} and reserve room for the returned
 * text (when non-`undefined`) BEFORE sizing how many whole high-urgency event
 * blocks fit — the reminder is appended AFTER the packed blocks, so sizing
 * against the blocks alone risks a claim that overflows the cap once the
 * reminder is appended, or truncates it away (006 §5.5).
 */
export async function previewCoalescedReminderClient(
  sessionId: string,
  socketPath?: string,
): Promise<string | undefined> {
  const result = await callDaemon<{ reminder: string | null }>(
    'hook.previewReminder',
    { sessionId },
    socketPath ? { socketPath } : {},
  );
  return result.reminder ?? undefined;
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
  const report = await callDaemon<MonitorExplainReport>(
    'monitor.explain',
    input as unknown as Record<string, unknown>,
    socketPath ? { socketPath } : {},
  );
  return {
    ...report,
    // Project the service's second public retry copy without rewriting other
    // stage details, diagnosis order, or the primary verdict.
    stages: report.stages.map((stage) =>
      stage.id === 'materialization' &&
      isMaterializationRetrySummary(stage.details)
        ? { ...stage, details: { ...normalizeRetrySummary(stage.details) } }
        : stage,
    ),
    ...(report.materializationRetries
      ? {
          materializationRetries: normalizeRetrySummary(
            report.materializationRetries,
          ),
        }
      : {}),
  };
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

/**
 * Client timeout for the two retry repairs. The daemon runs each repair as one
 * immediate SQLite transaction, which waits up to the store's 5-second busy
 * timeout for another writer's lock before it fails. That wait can come twice:
 * the store's busy wait is synchronous, so while another process holds the
 * lock the daemon's own tick can block its event loop for up to 5 seconds
 * before it even reads the request, and the repair's transaction may then wait
 * up to 5 seconds more. This covers both waits with a margin, where the
 * default 2-second client timeout would give up on a daemon about to apply the
 * repair.
 *
 * It is not a bound on the daemon: a daemon blocked on a lock for longer still
 * answers too late, the CLI reports the outcome as unknown, and the daemon may
 * apply the repair after the CLI has given up.
 */
export const RETRY_REPAIR_TIMEOUT_MS = 15_000;

/**
 * A repair result with its retry's Dates revived and its last error
 * normalized for display, whether it came over the socket or in-process.
 */
function normalizeRepairResult(
  result: MaterializationRetryRepairResult,
): MaterializationRetryRepairResult {
  return { outcome: result.outcome, retry: normalizeRetryRecord(result.retry) };
}

/**
 * Re-arm one terminal retry on the live daemon (005 `monitor retry rearm`),
 * so a watcher paused on it in that process wakes at once. The returned
 * record is safe metadata with its Dates revived.
 */
export async function rearmRetryClient(
  input: MaterializationRetryRepairInput,
  socketPath?: string,
): Promise<MaterializationRetryRepairResult> {
  return normalizeRepairResult(
    await callDaemon<MaterializationRetryRepairResult>(
      'retry.rearm',
      { ...input },
      {
        timeoutMs: RETRY_REPAIR_TIMEOUT_MS,
        ...(socketPath ? { socketPath } : {}),
      },
    ),
  );
}

/** Skip one terminal retry on the live daemon (005 `monitor retry skip`). */
export async function skipRetryClient(
  input: MaterializationRetrySkipInput,
  socketPath?: string,
): Promise<MaterializationRetryRepairResult> {
  return normalizeRepairResult(
    await callDaemon<MaterializationRetryRepairResult>(
      'retry.skip',
      { ...input },
      {
        timeoutMs: RETRY_REPAIR_TIMEOUT_MS,
        ...(socketPath ? { socketPath } : {}),
      },
    ),
  );
}

/**
 * Re-arm one terminal retry directly in the workspace's persisted store, for
 * when no daemon is reachable. The store transaction is the same one the
 * daemon would run; a daemon started later finds the retry pending.
 */
export function rearmRetryInProcess(
  input: MaterializationRetryRepairInput,
  dbPath: string,
): MaterializationRetryRepairResult {
  return normalizeRepairResult(
    createRuntime(dbPath).rearmMaterializationRetry(input),
  );
}

/** Skip one terminal retry directly in the persisted store (no daemon reachable). */
export function skipRetryInProcess(
  input: MaterializationRetrySkipInput,
  dbPath: string,
): MaterializationRetryRepairResult {
  return normalizeRepairResult(
    createRuntime(dbPath).skipMaterializationRetry(input),
  );
}

export async function daemonStatusClient(
  socketPath?: string,
): Promise<DaemonStatusResult> {
  return await callDaemon<DaemonStatusResult>(
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
 * The safe projection of one id's recovery obligations off the wire: the retry
 * summary only when present and well-formed, the loss only when valid, or
 * `undefined` when nothing reportable is left.
 */
function reviveMonitorWork(group: {
  materializationRetries?: MaterializationRetrySummary;
  unretainedObservationLoss?: UnretainedObservationLoss;
}):
  | {
      materializationRetries?: MaterializationRetrySummary;
      unretainedObservationLoss?: UnretainedObservationLoss;
    }
  | undefined {
  // Same projection as an attached rollup summary.
  const retries = group.materializationRetries
    ? normalizeRetrySummary(group.materializationRetries)
    : undefined;
  const loss = normalizeUnretainedObservationLoss(
    group.unretainedObservationLoss,
  );
  if (!retries && !loss) return undefined;
  return {
    ...(retries ? { materializationRetries: retries } : {}),
    ...(loss ? { unretainedObservationLoss: loss } : {}),
  };
}

/**
 * Reconstruct the `Date` fields {@link MonitorDoctorReport} promises, lost to
 * plain ISO strings by the JSON round trip over the daemon socket (issue
 * #373). `doctorReportInProcess` returns real `Date` objects straight from
 * the store; `doctor.ts` calls `.toISOString()` on report dates unconditionally
 * (unlike sibling commands, which only re-serialize their reports), so
 * `doctorReportClient` must uphold the same contract or that call throws.
 * Attached and orphan retry summaries share the safe metadata projection, so
 * version-skewed daemon errors and unexpected private fields cannot bypass it.
 */
function reviveDoctorReportDates(
  report: MonitorDoctorReport,
): MonitorDoctorReport {
  return {
    ...report,
    generatedAt: new Date(report.generatedAt),
    ...(report.orphanedMonitorWork
      ? {
          orphanedMonitorWork: report.orphanedMonitorWork.flatMap((group) => {
            const work = reviveMonitorWork(group);
            if (!work) return [];
            return [
              {
                monitorId: group.monitorId,
                // Closed vocabulary on the wire: anything but `ephemeral`
                // renders as a definition-backed id.
                monitorKind:
                  group.monitorKind === 'ephemeral'
                    ? ('ephemeral' as const)
                    : ('persistent' as const),
                ...work,
              },
            ];
          }),
        }
      : {}),
    ...(report.ephemeralMonitorWork
      ? {
          ephemeralMonitorWork: report.ephemeralMonitorWork.flatMap((group) => {
            const work = reviveMonitorWork(group);
            return work
              ? [
                  {
                    monitorId: group.monitorId,
                    sessionId: group.sessionId,
                    ...work,
                    ...(group.validationError !== undefined
                      ? { validationError: group.validationError }
                      : {}),
                  },
                ]
              : [];
          }),
        }
      : {}),
    monitors: report.monitors.map((monitor) => {
      const revived = { ...monitor };
      for (const field of MONITOR_ROLLUP_DATE_FIELDS) {
        const value = revived[field];
        if (value !== undefined) revived[field] = new Date(value);
      }
      if (revived.materializationRetries) {
        revived.materializationRetries = normalizeRetrySummary(
          revived.materializationRetries,
        );
      }
      const loss = normalizeUnretainedObservationLoss(
        revived.unretainedObservationLoss,
      );
      if (loss) revived.unretainedObservationLoss = loss;
      else delete revived.unretainedObservationLoss;
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
