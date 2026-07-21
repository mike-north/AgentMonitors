import type {
  MonitorDefinition,
  NotifyConfig,
  Urgency,
} from '../schema/types.js';
import type { ephemeralMonitorStatus } from '../inbox/schema.js';
import type { Observation } from '../observation/types.js';
import type { DuplicateMonitorId } from '../parser/scan-monitors.js';
import { schedulingDefaults } from './scheduling-defaults.js';

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

/**
 * The lifecycle status of an ephemeral monitor (007 §4.4), derived from the
 * single source of truth — the drizzle column enum {@link ephemeralMonitorStatus}
 * — so the persisted values and this public type cannot drift.
 */
export type EphemeralMonitorStatus = (typeof ephemeralMonitorStatus)[number];

/**
 * Reserved id prefix for ephemeral (agent-declared) monitors (007 §4.3). Every
 * ephemeral id is `ephemeral:<sessionId>/<ulid>` — it always contains a `/`,
 * which a directory-derived persistent monitor id (a single path segment) never
 * can, so an ephemeral id is structurally incapable of colliding with a
 * persistent one (SP2). The prefix keeps `monitor_events.monitor_id`,
 * `monitor explain`, and `queryScope` filtering unambiguously namespaced, and
 * lets a store-level query recognise an ephemeral event by its `monitor_id`
 * alone (e.g. to keep an ephemeral event out of an unscoped read, 007 §4.6).
 */
export const EPHEMERAL_MONITOR_ID_PREFIX = 'ephemeral:';

/**
 * A durable ephemeral-monitor record (007 §4): an agent-declared, session-scoped
 * monitor stored in the daemon's durable store so it survives a restart while the
 * declaring session lives (007 §4.4). `id` is the namespaced runtime identity
 * `ephemeral:<sessionId>/<ulid>` (007 §4.3).
 */
export interface EphemeralMonitorRecord {
  id: string;
  sessionId: string;
  workspacePath: string | null;
  sourceName: string;
  /** The source-`scopeSchema`-valid scope config (007 §4.2). */
  scope: Record<string, unknown>;
  /** The authored urgency band's low bound (base effective urgency). */
  urgency: Urgency;
  /** The authored urgency band's high bound (equals `urgency` for a scalar). */
  urgencyMax: Urgency;
  /**
   * Free-text handling guidance — the monitor's body-instructions (007 §4.2),
   * mirroring a persistent monitor's markdown body. It is used as the delivered
   * event body (`DeliveryEventSummary.body`, 002 §9.1) only as a **fallback**:
   * an observation that carries its own `body` overrides it
   * (`observation.body ?? monitor.instructions`), so it is not always what is
   * surfaced on delivery.
   */
  instruction: string;
  displayName?: string;
  status: EphemeralMonitorStatus;
  createdAt: Date;
  updatedAt: Date;
  reapedAt?: Date;
}

/**
 * Input to {@link AgentMonitorRuntime.declareEphemeralMonitor} (007 §4.2). The
 * declaration binds to the resolved AgentMon session `sessionId`; its scope is
 * validated by the same `validateScope` path as `agentmonitors validate`.
 */
export interface DeclareEphemeralMonitorInput {
  /** The declaring (bound) AgentMon session id (007 §4.2). */
  sessionId: string;
  /** A registered source name (003). */
  source: string;
  /** The source-specific scope config (validated against the source schema). */
  scope: Record<string, unknown>;
  /**
   * Authored urgency — a scalar (`normal`) or a band (`normal..high`). Defaults
   * to `normal`, matching persistent monitors (007 §4.2).
   */
  urgency?: string;
  /** Free-text handling guidance that becomes the monitor's body (007 §4.2). */
  instruction?: string;
  /** Optional human-readable display name. */
  displayName?: string;
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
  /**
   * The monitor's author-declared baseline strategy at materialization time
   * (G13/G10 PR-B, 002 §1.1.7), persisted on the shared event so the
   * per-recipient `net` collapse runs at claim without re-scanning monitors.
   * `null` on legacy rows materialized before PR-B — treated as `incremental`.
   */
  baselineStrategy: 'incremental' | 'net' | null;
  queryScope: Record<string, string | string[]>;
  tags: string[];
  createdAt: Date;
  /**
   * The requesting session's delivery state for this event (002 §7):
   * `unread` (not acknowledged), `claimed` (surfaced at least once at a
   * delivery lifecycle, but not acknowledged), or `acknowledged`. Only present
   * when the query was session-scoped (`EventQuery.sessionId` set) — a
   * global/unscoped `listEvents()` call has no single session's state to
   * report, so this is `undefined` in that case. The CLI's unread filter
   * matches an unacknowledged event and therefore includes
   * claimed-but-unacknowledged events (002 §7); this field lets a caller tell
   * an unread-and-unclaimed event apart from one that was already surfaced
   * once (issue #338).
   */
  deliveryState?: MonitorDeliveryState;
}

export interface DeliveryEventSummary {
  eventId: string;
  monitorId: string;
  title: string;
  /**
   * The recipient-visible summary (G14, 002 §1.1.8): the Interpret digest when
   * one was produced for this recipient's delta, otherwise the deterministic
   * `MonitorEventRecord.summary` → `body` → `title` fallback chain
   * (`recipientSummary` in `service.ts`). A digest is a **prose reading of the
   * change**, not necessarily the object's identity — for a `prose`-form
   * monitor watching many objects, two distinct objects can legitimately
   * produce indistinguishable or identity-free digest text. Transports that
   * need to name WHICH object an event is about (e.g. a multi-object source
   * delivering under one shared authored title, 002 §5.4) MUST use {@link
   * objectDetail}, not this field.
   */
  summary: string;
  /**
   * The deterministic per-object source detail (`MonitorEventRecord.summary`,
   * never replaced by an Interpret digest): what names the specific object
   * this event is about, independent of any agentic summarization. Always
   * populated by the runtime (`toDeliveryEventSummary`) for a real delivery;
   * optional here only so a hand-constructed `DeliveryEventSummary` (e.g. in a
   * test) may omit it. A transport rendering per-object identity — such as
   * `buildEventBlock`'s detail line — MUST prefer this over {@link summary},
   * since `summary` can be an Interpret digest that carries no object
   * identity at all (issue #449 review).
   */
  objectDetail?: string;
  urgency: Urgency;
  createdAt: string;
  /**
   * The monitor's body-instructions for this event (from `MonitorEventRecord.body`,
   * which is the monitor's markdown body / `observation.body`). Carries what the
   * agent should DO when the monitor fires, so a delivery transport can surface the
   * instructions, not just the title/summary.
   */
  body: string;
  /**
   * The change summary for this event — what actually changed at the observed
   * source (a file diff, an API-body diff, a command-output diff). Carries the
   * concrete evidence the monitor fired on, so a delivery transport can surface
   * *what changed*, not just the title and the author's instructions.
   *
   * This is the **recipient-specific** delta (`session_event_state.diff_text`,
   * G10 / 002 §1.1.2): the diff THIS recipient's own baseline cursor produces
   * against the shared observation, not necessarily the shared latest-snapshot
   * delta on `MonitorEventRecord.diffText`. Two sessions at divergent cursors
   * receive different (correct) spans from the same shared event — a session
   * last seen two observations ago receives the full multi-observation span,
   * while a caught-up session receives only the latest delta (session
   * isolation, issue #436). The shared `MonitorEventRecord.diffText` is used
   * only as a **legacy fallback** for a pre-G10 row whose per-recipient column
   * is `null` (mirrors `perRecipientDiffsForSession`'s own contract).
   *
   * Optional: absent when the event carried no diff at all (neither the
   * per-recipient nor the shared value is present). Transports that surface it
   * MUST bound it — a raw diff can be arbitrarily large and the render lands in
   * the agent's context window.
   */
  diffText?: string;
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

/**
 * An uncommitted delivery reservation (006 §4, issue #300): the {@link
 * DeliveryClaim} a transport should surface, plus an opaque `reservationId` it
 * commits (after a successful surface) or releases (on a failed/disconnected
 * push). Reserving leases the underlying rows — hiding them from the hook
 * transport's claim so the two do not double-surface (006 §4.5) — WITHOUT
 * marking them claimed. The claim (`firstNotifiedAt`, "was surfaced") is written
 * only at commit; a release returns the rows to the hook path. The rows stay
 * unacknowledged throughout (BP2).
 */
export interface DeliveryReservation {
  reservationId: string;
  claim: DeliveryClaim;
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
  /**
   * Set when this projection was CLAIMED-BUT-SUPPRESSED by the per-recipient
   * `net` collapse (G10 PR-B, 002 §1.1.7): an older intermediate of a `net`
   * monitor's catch-up span whose newest sibling was delivered instead. The row
   * is retained so the collapse stays explainable, but it was never surfaced to
   * a transport.
   */
  netSuppressed?: boolean;
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

/**
 * Delivery-state tallies for one monitor's projections into the lead session(s)
 * of a single workspace. The three states are distinct (000 AP: _unread_,
 * _claimed_, and _acknowledged_ are not the same — claiming a delivery never
 * acknowledges it), so they are counted independently rather than collapsed.
 */
export interface DoctorDeliveryCounts {
  unread: number;
  claimed: number;
  acknowledged: number;
}

/**
 * A per-monitor health rollup produced by
 * {@link AgentMonitorRuntime.doctorReport}. Every field is derived from durable
 * state (persisted observation history, `monitor_events`, and session
 * projections), so it is accurate whether or not a daemon is currently running —
 * the daemon writes the same SQLite store the report reads (mirrors
 * `daemon status` and `monitor explain`'s in-process reads).
 */
export interface DoctorMonitorRollup {
  id: string;
  displayName: string;
  sourceName: string;
  urgency: Urgency;
  /** `false` when the monitor's `watch` config fails source/schema validation. */
  valid: boolean;
  /** The joined validation error(s); present only when `valid` is `false`. */
  validationError?: string;
  /**
   * Timestamp of the most recent completed observation tick for this monitor;
   * `undefined` when the monitor has never been observed.
   */
  lastObservedAt?: Date;
  /**
   * `true` when no observation has ever completed for this monitor (the daemon
   * has never run it) — the explicit "never observed" marker (issue #267).
   */
  neverObserved: boolean;
  /** Whether the monitor is due to observe now. */
  due: boolean;
  /** The next time the monitor is due to observe; `undefined` when unknown. */
  nextDueAt?: Date;
  /**
   * A human-readable cadence descriptor, e.g. `every 30s` (interval sources) or
   * `cron '0 9 * * 1-5'` (schedule sources).
   */
  cadence: string;
  /**
   * Timestamp of the most recent materialized event for this monitor in the
   * report's workspace; `undefined` when nothing has materialized.
   */
  lastEventAt?: Date;
  /** Delivery-state tallies across this workspace's lead-session projections. */
  delivery: DoctorDeliveryCounts;
}

/** A parse-level failure attributed to a monitor id (or file path fallback). */
export interface DoctorParseError {
  /** The monitor id (folder/stem), or the file path when the id can't be derived. */
  id: string;
  error: string;
}

/** Input for {@link AgentMonitorRuntime.doctorReport}. */
export interface DoctorReportInput {
  /** Directory containing `MONITOR.md` definitions (e.g. `.claude/monitors`). */
  monitorsDir: string;
  /**
   * Workspace path for session projection and event scoping. Required: an
   * unscoped report would mix workspace-agnostic sessions with unscoped
   * events/projections and become internally inconsistent.
   */
  workspacePath: string;
  /** Clock override (tests). Defaults to `new Date()`. */
  now?: Date;
  /** Observation-history rows to inspect per monitor when detecting activity. Default `1`. */
  historyLimit?: number;
}

/**
 * The workspace-wide, durable-state health report behind the
 * `agentmonitors doctor` command (005 §"doctor", issue #267). It is a
 * read-only diagnosis of the core/daemon side; the CLI layers the
 * project-enabled and daemon-reachable checks (both CLI-only concerns) on
 * top of it.
 */
export interface MonitorDoctorReport {
  generatedAt: Date;
  monitorsDir: string;
  /**
   * Always set: mirrors {@link DoctorReportInput.workspacePath}, which is
   * required (a report can never be workspace-unscoped). Callers can rely on
   * this to name the exact workspace a `lead-session` failure searched
   * (issue #335) rather than treating it as possibly absent.
   */
  workspacePath: string;
  /** Whether the monitors directory exists on disk. */
  monitorsDirExists: boolean;
  /** Every discovered monitor's rollup (both valid and invalid definitions). */
  monitors: DoctorMonitorRollup[];
  /** Count of discovered monitors that failed validation. */
  invalidCount: number;
  /** Monitor-id collisions across the tree (001 §4). */
  duplicateIds: DuplicateMonitorId[];
  /** Parse-level failures (a `MONITOR.md` that could not be parsed at all). */
  parseErrors: DoctorParseError[];
  /** Lead sessions registered for this workspace. */
  leadSessions: AgentSessionRecord[];
  /** `true` when at least one lead session exists for the workspace. */
  hasLeadSession: boolean;
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
  /**
   * Present only for an ephemeral monitor (007 §4): the declaring session id.
   * When set, the materialized event projects into ONLY this session, never a
   * sibling lead session in the same workspace (007 §4.6 isolation).
   */
  restrictToSessionId?: string;
}

export interface PollingDecision {
  due: boolean;
  nextPollMs: number;
  /**
   * Present when the scheduling decision itself could not be computed — e.g. an
   * invalid IANA `timezone` on a `schedule` monitor makes `Intl.DateTimeFormat`
   * throw inside cron matching (issue #297). `due` is `false` and `nextPollMs`
   * falls back to the source's default poll interval so callers still have a
   * usable decision; every caller MUST treat a present `error` as "this monitor
   * cannot be scheduled right now" and isolate the failure to that monitor
   * rather than let it abort a whole tick or diagnostic report. Authoring-time
   * validation (the `schedule` source's `scopeSchema` and the `rollup` notify
   * schema) should reject an invalid timezone before it ever reaches here — this
   * is the defensive last line for a bypassed/legacy value.
   */
  error?: string;
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
 * - `no-files-matched`: the source returned no observations because its
 *   file-system scope matched zero files; distinct from a quiet matched set.
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
  | 'no-files-matched'
  | 'errored'
  | 'rebaselined';

export interface ObservationHistoryRecord {
  id: string;
  monitorId: string;
  /** Observing daemon's workspace; `null` for global/legacy rows (issue #345). */
  workspacePath: string | null;
  sourceName: string;
  observationData: Record<string, unknown>;
  result: ObservationOutcome;
  createdAt: Date;
}

export interface ObservationHistoryQuery {
  monitorId?: string;
  /**
   * Scope to one workspace (issue #345 / #307). When set, only rows written by a
   * tick for this exact workspace are returned; omit to list across workspaces.
   */
  workspacePath?: string;
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

/**
 * Resolve the effective notify config for an observation: an authored
 * `notify` block always wins; otherwise `high`-urgency gets a default
 * debounce settle (`schedulingDefaults.highUrgencyDefaultDebounceSettleMs`)
 * so it isn't materialized instantly, and `normal`/`low` get none. This is
 * the single source of truth the runtime tick uses (`service.ts`) — anything
 * that needs to *reason about* notify timing (e.g. the CLI `verify` budget)
 * should call this rather than re-deriving the default.
 */
export function defaultNotifyConfigForUrgency(
  urgency: Urgency,
  notify?: NotifyConfig,
): NotifyConfig | undefined {
  if (notify) return notify;
  if (urgency === 'high') {
    return {
      strategy: 'debounce',
      'settle-for': `${String(schedulingDefaults.highUrgencyDefaultDebounceSettleMs / 1000)}s`,
    };
  }
  return undefined;
}
