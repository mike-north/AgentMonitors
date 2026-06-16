import type {
  MonitorDefinition,
  NotifyConfig,
  Urgency,
} from '../schema/types.js';
import type { Observation } from '../observation/types.js';

export type AgentLifecycleEvent =
  | 'session-opened'
  | 'session-dormant'
  | 'turn-interruptible'
  | 'turn-ended'
  | 'turn-idle'
  | 'pre-compact'
  | 'post-compact';

export type DeliveryLifecycle =
  | 'turn-interruptible'
  | 'turn-idle'
  | 'post-compact';

export type AgentSessionRole = 'lead' | 'subagent';
export type AgentSessionStatus = 'active' | 'dormant';
export type DeliveryMode = 'delivery' | 'recap';
export type UrgencyCounts = Record<Urgency, number>;

export interface OpenSessionInput {
  adapter: string;
  hostSessionId: string;
  workspacePath?: string;
  role?: AgentSessionRole;
  agentIdentity: string;
  hookStatePath: string;
}

export interface AgentSessionRecord {
  id: string;
  adapter: string;
  hostSessionId: string;
  agentIdentity: string;
  role: AgentSessionRole;
  workspacePath?: string;
  hookStatePath: string;
  status: AgentSessionStatus;
  baselineAt: Date;
  lastActiveAt: Date;
  lastRecapAt?: Date;
  dormantAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitorEventRecord {
  id: string;
  workspacePath: string | null;
  monitorId: string;
  sourceName: string;
  urgency: Urgency;
  title: string;
  body: string;
  summary: string;
  payload: unknown;
  snapshotMetadata: unknown;
  snapshotText: string | null;
  diffText: string | null;
  objectKey: string | null;
  queryScope: Record<string, string | string[]>;
  tags: string[];
  createdAt: Date;
}

export interface DeliveryEventSummary {
  eventId: string;
  monitorId: string;
  title: string;
  summary: string;
  urgency: Urgency;
  createdAt: string;
  /**
   * The monitor's body-instructions for this event (from `MonitorEventRecord.body`,
   * which is the monitor's markdown body / `observation.body`). Carries what the
   * agent should DO when the monitor fires, so a delivery transport can surface the
   * instructions, not just the title/summary.
   */
  body: string;
}

export interface DeliveryClaim {
  sessionId: string;
  mode: DeliveryMode;
  urgency?: Urgency;
  lifecycle: DeliveryLifecycle;
  message: string;
  unreadCounts: SessionUnreadCounts;
  events: DeliveryEventSummary[];
}

export interface SessionEventFilter {
  sessionId: string;
  monitorId?: string;
  urgency?: Urgency;
  tags?: string[];
  scope?: Record<string, string>;
  unreadOnly?: boolean;
  sinceBaseline?: boolean;
  sinceLastRecap?: boolean;
  limit?: number;
}

export interface EventQuery {
  sessionId?: string;
  monitorId?: string;
  urgency?: Urgency;
  tags?: string[];
  scope?: Record<string, string>;
  objectKey?: string;
  unreadOnly?: boolean;
  sinceBaseline?: boolean;
  since?: Date;
  /**
   * Restrict results to events materialized for this workspace, plus
   * workspace-agnostic (`workspacePath === null`) events. The inbox DB is global
   * and the same `monitorId` may exist in multiple workspaces, so callers that
   * reason about a single workspace (e.g. `monitor explain`) MUST scope by this
   * to avoid leaking other workspaces' events (issue #94 review).
   */
  workspacePath?: string;
}

export type MonitorExplainStageId =
  | 'definition'
  | 'scheduling'
  | 'observation'
  | 'notify'
  | 'materialization'
  | 'delivery';

/**
 * The status of a single monitor-explain pipeline stage.
 *
 * - `ok` — the stage completed and produced the signal the next stage needs.
 * - `pending` — the stage is intentionally holding (e.g. debounce/throttle), or
 *   has not run yet because an upstream stage has not produced its input.
 * - `healthy` — the stage ran successfully and the *correct* outcome was "no
 *   work to do" (the watched target genuinely did not change). This is an
 *   affirmative, not-a-bug outcome (issue #94) and is rendered distinctly from
 *   both `ok` (signal delivered) and `failure` (a real fault).
 * - `failure` — a real fault: the source errored, the definition is invalid, the
 *   daemon is down, or an expected projection is missing.
 */
export type MonitorExplainStageStatus =
  | 'ok'
  | 'pending'
  | 'healthy'
  | 'failure';

export interface MonitorExplainStage {
  id: MonitorExplainStageId;
  label: string;
  status: MonitorExplainStageStatus;
  reason: string;
  details?: Record<string, unknown>;
}

export type MonitorDeliveryState = 'unread' | 'claimed' | 'acknowledged';

/**
 * The per-recipient Interpret verdict recorded on a projection (G14, 002 §1.1.8):
 * `deliver` — the agentic gate passed (or no gate) and a digest was produced;
 * `suppress` — the agentic gate judged the delta not substantive, so no delivery;
 * `failed` — the AI tool errored and the runtime fell back to the deterministic
 * `rendered` artifact (best-effort).
 */
export type InterpretDecision = 'deliver' | 'suppress' | 'failed';

/**
 * A per-recipient baseline cursor (G10, 002 §1.1.2): the last shaped artifact a
 * given session was caught up to for one `(monitorId, objectKey, workspacePath)`
 * object. The recipient's Diff stage spans FROM `baselineContent`.
 * `baselineContent` is denormalized (prune-immune); `baselineSnapshotId` records
 * which event/snapshot the baseline came from, for diagnosis.
 */
export interface SessionObjectCursorRecord {
  sessionId: string;
  monitorId: string;
  objectKey: string;
  workspacePath: string | null;
  baselineSnapshotId: string | null;
  baselineContent: string;
  updatedAt: Date;
}

export interface MonitorDeliveryProjection {
  eventId: string;
  sessionId: string;
  sessionRole: AgentSessionRole;
  sessionStatus: AgentSessionStatus;
  deliveryState: MonitorDeliveryState;
  workspacePath: string | null;
  createdAt: Date;
  firstNotifiedAt?: Date;
  lastClaimAt?: Date;
  lastClaimLifecycle?: string;
  acknowledgedAt?: Date;
  /**
   * The PER-RECIPIENT delta for this projection (G10, 002 §1.1.2): the diff of
   * the shared event's artifact against THIS session's own baseline cursor.
   * Absent for a baseline event (nothing to diff) and for legacy rows
   * materialized before G10 — consumers fall back to the shared
   * `MonitorEventRecord.diffText` in that case.
   */
  diffText?: string;
  /** The per-recipient Interpret verdict (G14), absent for non-`prose` deliveries. */
  interpretDecision?: InterpretDecision;
  /** The agentic-gate suppression reason or the fallback-failure detail. */
  interpretReason?: string;
  /** The delivered cheap digest when `interpretDecision` is `deliver`. */
  interpretDigest?: string;
}

export interface MonitorExplainInput {
  monitorId: string;
  monitorsDir: string;
  workspacePath?: string;
  historyLimit?: number;
  eventLimit?: number;
  now?: Date;
}

export interface MonitorExplainReport {
  monitorId: string;
  generatedAt: Date;
  monitor?: {
    id: string;
    displayName: string;
    filePath: string;
    sourceName: string;
    urgency: Urgency;
  };
  stages: MonitorExplainStage[];
  verdict: {
    status: MonitorExplainStageStatus;
    stage: MonitorExplainStageId;
    reason: string;
  };
  observations: ObservationHistoryRecord[];
  events: MonitorEventRecord[];
  projections: MonitorDeliveryProjection[];
  leadSessions: AgentSessionRecord[];
}

export type SessionUnreadCounts = UrgencyCounts & { total: number };

export interface SessionHookState {
  updatedAt: string;
  sessionId: string;
  unread: SessionUnreadCounts;
  hasPendingHigh: boolean;
  hasPendingNormal: boolean;
  hasPendingLow: boolean;
  latestHighTitles: string[];
}

export interface MonitorRuntimeState {
  lastObservationAt?: Date;
  sourceState?: unknown;
  notifyState: NotifyRuntimeState;
}

export interface PendingDebounceState {
  observations: StoredObservationEnvelope[];
  dueAt: string;
}

/**
 * Durable accumulation state for the scheduled-rollup Pace mode
 * (`notify.strategy: rollup`, 001 §3.6 / 002 §4.4). Every observation produced
 * since the last window flush is appended to `observations`; unlike
 * `PendingDebounceState` there is **no** `dueAt` reset on each new observation —
 * the flush time is schedule-driven (the author's `window` cron), not
 * settle-driven. The batch is persisted in `monitor_state.notify_state` and
 * **MUST** survive a daemon restart (002 §4.4 step 1, BP1); it is hydrated and
 * flushed on the first tick where the window cron fires with a non-empty batch.
 *
 * @see docs/specs/002-runtime-delivery.md §4.4
 */
export interface PendingRollupState {
  observations: StoredObservationEnvelope[];
}

export interface NotifyRuntimeState {
  suppressedUntil?: string;
  pendingDebounce?: PendingDebounceState;
  pendingRollup?: PendingRollupState;
  /**
   * The epoch-minute (Math.floor(ms / 60_000)) of the most recent rollup window
   * flush. Guards against duplicate flushes within the same calendar minute when
   * the tick interval is shorter than 60 s (002 §4.4 step 2 "at most once per
   * minute"). Persisted independently of `pendingRollup` so the guard survives
   * the flush that deletes `pendingRollup`.
   */
  rollupLastFiredMinute?: number;
}

export interface StoredObservationEnvelope {
  monitor: MonitorDefinition;
  observation: Observation;
  observedAt: Date;
  /**
   * The urgency the runtime resolved for this observation —
   * `clamp(observation.salience ?? band.lo, band.lo, band.hi)` over the
   * monitor's authored `urgency` band. Drives both notify timing (the
   * high-urgency debounce default) and the materialized `monitor_events.urgency`
   * row, so a held batch and its event rows agree on the effective urgency.
   *
   * @see docs/specs/002-runtime-delivery.md §4.1, §5.1
   */
  effectiveUrgency: Urgency;
}

export interface ProcessObservationInput {
  monitor: MonitorDefinition;
  sourceName: string;
  observation: Observation;
  observedAt: Date;
  workspacePath?: string;
  /**
   * The effective urgency resolved at notify time
   * (`clamp(salience ?? band.lo, band.lo, band.hi)`). The materialized
   * `monitor_events.urgency` row MUST use this value so the persisted event and
   * the notify-timing decision agree (002 §5.1).
   */
  effectiveUrgency: Urgency;
}

export interface PollingDecision {
  due: boolean;
  nextPollMs: number;
}

/**
 * A monitor whose observation failed on a tick, surfaced so callers can
 * distinguish a genuine no-change from a broken source without re-querying
 * `observation_history`.
 */
export interface ErroredObservation {
  monitorId: string;
  message: string;
}

/**
 * A monitor that was found but skipped on a tick because its interval has not
 * yet elapsed since the last observation. Surfaced so callers (e.g. daemon
 * once) can distinguish "skipped, not yet due" from "no monitors found".
 *
 * @see docs/specs/002-runtime-delivery.md §2.4
 */
export interface SkippedMonitor {
  monitorId: string;
  /** The earliest time at which this monitor will be due for its next tick. */
  nextDueAt: Date;
}

/**
 * Summary returned by a single `AgentMonitorRuntime.tick()` call.
 *
 * Note: errored monitors (whose `observe()` threw, or whose `ingest()` failed)
 * are still included in `evaluatedMonitors` — they were attempted even though
 * their outcome is `errored` rather than `triggered`/`suppressed`/`no-change`.
 * They are additionally listed in `erroredObservations`, populated from the
 * same path that writes an `errored` row to `observation_history`, so the tick
 * itself can report the failure rather than silently print `emitted 0`.
 *
 * Monitors found in the directory but skipped because their interval has not
 * elapsed are listed in `skippedMonitors` so callers can distinguish
 * "skipped, not yet due" from "no monitors found" (issue #152).
 */
export interface RuntimeTickResult {
  evaluatedMonitors: string[];
  emittedEventIds: string[];
  erroredObservations: ErroredObservation[];
  skippedMonitors: SkippedMonitor[];
}

/**
 * A live handle over the continuous watchers started by
 * `AgentMonitorRuntime.watchMonitors()`. While a monitor is being watched, the
 * tick loop skips its one-shot `observe()` so it is not driven twice.
 */
export interface WatchHandle {
  /** The ids of the monitors with an active watcher under this handle. */
  readonly monitorIds: string[];
  /** Abort every watcher this handle started and wait for them to settle. */
  stop(): Promise<void>;
}

export interface NotifyDispatchResult {
  emitted: StoredObservationEnvelope[];
  nextState: NotifyRuntimeState;
}

export interface RuntimeStatus {
  sessions: number;
  activeSessions: number;
  dormantSessions: number;
  events: number;
}

/**
 * The outcome of evaluating a due monitor on a tick:
 * - `triggered`: ≥1 observation became an event (including a tick that flushes a
 *   previously-held debounce batch even when no new observations were returned).
 * - `suppressed`: observations were returned but none emitted this tick —
 *   throttled or held in a debounce batch.
 * - `no-change`: the source returned no observations.
 * - `errored`: a failure occurred and was isolated so the tick (or watcher)
 *   continued. Two cases produce this outcome:
 *   (1) The monitor's `observe()` threw or rejected in the tick loop. In this
 *       case `ingest()` was never called, so the monitor's persisted
 *       `sourceState` is left exactly as it was — no subsequent delta is
 *       dropped.
 *   (2) A single dispatched observation failed to materialize inside `ingest()`
 *       (tick or watch path), e.g. a DB insert error. The batch's other
 *       observations are unaffected; `emittedEventIds` reflects only the
 *       observations that were durably written.
 *   In both cases the audit write itself is best-effort: a `recordObservationHistory`
 *   failure is swallowed so a failing audit row can never re-abort the tick.
 * - `rebaselined`: the source advanced its baseline without computing a delta
 *   (a graceful re-baseline after it could not diff against the prior point,
 *   e.g. a force-pushed/gc'd ref); distinct from `no-change` (genuinely nothing
 *   changed) and from `errored` (the source threw).
 */
export type ObservationOutcome =
  | 'triggered'
  | 'suppressed'
  | 'no-change'
  | 'errored'
  | 'rebaselined';

export interface ObservationHistoryRecord {
  id: string;
  monitorId: string;
  sourceName: string;
  observationData: Record<string, unknown>;
  result: ObservationOutcome;
  createdAt: Date;
}

export interface ObservationHistoryQuery {
  monitorId?: string;
  limit?: number;
}

export interface ObservationCycleResult {
  observations: Observation[];
  nextState?: unknown;
}

export interface MonitorObservationResult {
  monitor: MonitorDefinition;
  sourceName: string;
  observations: Observation[];
  nextState?: unknown;
  observedAt: Date;
}

export interface MonitorSchedulingMetadata {
  monitor: MonitorDefinition;
  nextPollMs: number;
}

export function defaultNotifyConfigForUrgency(
  urgency: Urgency,
  notify?: NotifyConfig,
): NotifyConfig | undefined {
  if (notify) return notify;
  if (urgency === 'high') {
    return { strategy: 'debounce', 'settle-for': '15s' };
  }
  return undefined;
}
