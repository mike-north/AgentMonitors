import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { writePrivateFileAtomic } from '../security/local-permissions.js';
import { scanMonitors } from '../parser/scan-monitors.js';
import type { MonitorDefinition, Urgency } from '../schema/types.js';
import { monitorFrontmatterSchema } from '../schema/monitor-schema.js';
import { validateScope, validateWatchScope } from '../schema/validate-scope.js';
import { parseDuration } from '../notify/notifier.js';
import type {
  Observation,
  ObservationContext,
  ObservationSource,
} from '../observation/types.js';
import type { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { AgentRuntimeAdapter } from '../adapter/types.js';
import type { InterpretAdapter } from '../adapter/interpret.js';
import { buildDiff, changeDetectionStrategyOf } from './diff.js';
import {
  diagnoseReminderSuppression,
  type ReminderSessionCounts,
  type ReminderUrgency,
} from './reminder-diagnosis.js';
import { shapeObservation } from './shape-stage.js';
import {
  classifyReminderHold,
  classifySettleWindowHold,
  type HookDeliveryDiagnosis,
  type HookDeliveryHold,
} from './hook-delivery-diagnosis.js';
import {
  RuntimeStore,
  computeNetCollapseView,
  netCollapseGroupKey,
} from './store.js';
import { DeliveryReservationRegistry } from './delivery-reservations.js';
import type {
  AgentSessionRecord,
  DeclareEphemeralMonitorInput,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryReservation,
  EphemeralMonitorRecord,
  DoctorDeliveryCounts,
  DoctorMonitorRollup,
  DoctorParseError,
  DoctorReportInput,
  EventQuery,
  MonitorDoctorReport,
  MonitorEventRecord,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorExplainStage,
  ErroredObservation,
  MonitorExplainStageId,
  MonitorExplainStageStatus,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
  OpenSessionInput,
  PollingDecision,
  ProcessObservationInput,
  RuntimeTickResult,
  StoredObservationEnvelope,
  WatchHandle,
} from './types.js';
import {
  defaultNotifyConfigForUrgency,
  EPHEMERAL_MONITOR_ID_PREFIX,
  type NotifyDispatchResult,
  type NotifyRuntimeState,
  type DeliveryLifecycle,
  type SessionHookState,
} from './types.js';
import { schedulingDefaults } from './scheduling-defaults.js';

const DEFAULT_FILE_FINGERPRINT_POLL_MS =
  schedulingDefaults.fileFingerprintPollMs;
const DEFAULT_API_POLL_MS = schedulingDefaults.apiPollMs;
const DEFAULT_HIGH_URGENCY_SETTLE_MS =
  schedulingDefaults.highUrgencyClaimSettleMs;
const MAX_RECAP_EVENTS = 10;

/**
 * Per-session dormancy threshold (002 §6.2 / 007 §4.4). A session that has not
 * advanced its `lastActiveAt` for at least this long is treated as **dormant by
 * inactivity** — a backstop for a session that vanished without an explicit
 * close ([002 §6.1](../../../docs/specs/002-runtime-delivery.md)) — so its
 * ephemeral monitors are reaped even though it never called `session close`.
 * This is a per-session transition, distinct from the daemon-wide idle
 * self-termination (002 §10.2). Overridable via the runtime constructor for
 * deterministic tests.
 */
const DEFAULT_SESSION_DORMANCY_MS = 30 * 60 * 1_000;

/**
 * The `hostSessionId` prefix `verify` gives its throwaway lead session
 * (`agentmonitors-verify-<token>`). The reap backstop (issue #414) uses it to
 * recognize an orphaned verify session left by an uncatchably-killed
 * `--use-workspace-daemon` run and clean up its scratch events.
 */
const VERIFY_SESSION_ID_PREFIX = 'agentmonitors-verify-';

/**
 * TTL (issue #414) for the tombstone the reap backstop installs over an orphaned
 * verify run's scratch object — long enough for a not-yet-materialized deletion
 * to appear and be swept, short enough to leave nothing lingering.
 */
const ORPHANED_VERIFY_SUPPRESSION_TTL_MS = 5 * 60 * 1_000;

/**
 * Slack added on top of a monitor's derived poll-interval + settle when the reap
 * backstop sizes an orphan tombstone (issue #418), so a deletion materializing a
 * tick or two late still lands inside the window before it expires.
 */
const ORPHANED_VERIFY_SUPPRESSION_MARGIN_MS = 60 * 1_000;

/**
 * True when `objectKey`'s basename is a `verify` scratch file
 * (`agentmonitors-verify-<token>[.ext]`) — a synthetic path verify created and
 * deleted, which no real monitored object ever carries (issue #414). It is the
 * canonical predicate gating every by-KEY object-event sweep (the reap backstop
 * AND {@link AgentMonitorRuntime.suppressObjectEvents}) so a by-key deletion can
 * only ever erase verify's own artifacts, never a real event at a genuine
 * watched path. Exported so the daemon-socket boundary can reject a non-scratch
 * key before it ever reaches the runtime.
 *
 * Splits on BOTH `/` and `\` so a Windows-style absolute `objectKey` (which
 * `verify` builds with `path.join`) still resolves to its basename — otherwise
 * the guard would fail to recognize a scratch key on Windows and leave stray
 * sessions/events behind (issue #418 review).
 */
export function isVerifyScratchObjectKey(objectKey: string): boolean {
  const basename = objectKey.split(/[\\/]/).pop() ?? objectKey;
  return /^agentmonitors-verify-[0-9a-f]{12}(\..*)?$/.test(basename);
}
const EXPLAIN_STAGE_LABELS: Record<MonitorExplainStageId, string> = {
  definition: 'Definition',
  scheduling: 'Scheduling',
  observation: 'Observation',
  notify: 'Notify state',
  materialization: 'Materialization',
  delivery: 'Projection and delivery',
};

/**
 * Extract the per-source configuration from a monitor's `watch` block. This is
 * the `watch` object minus the `type` key, which is passed to source plugins as
 * their config (matching the old `scope` contract).
 */
function watchConfig(watch: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, ...config } = watch;
  return config;
}

/**
 * Describe a monitor's observation cadence in author-facing terms for the doctor
 * rollup (issue #267): the cron expression for `schedule` sources, the authored
 * `watch.interval` for interval sources, or the resolved default poll interval
 * (`nextPollMs`) when none is authored. Intentionally generic wording so it reads
 * correctly for every bundled source.
 */
function describeCadence(
  watch: Record<string, unknown>,
  nextPollMs: number,
): string {
  if (watch['type'] === 'schedule') {
    const cron = watch['cron'];
    return typeof cron === 'string' ? `cron '${cron}'` : 'schedule';
  }
  const interval = watch['interval'];
  if (typeof interval === 'string') return `every ${interval}`;
  return `every ${String(Math.round(nextPollMs / 1000))}s`;
}
const NORMAL_INBOX_PROMPT = 'AgentMon messages are available. Read the inbox.';
const IDLE_INBOX_PROMPT = 'AgentMon has inbox updates ready for review.';

function unreadDetailsCommand(sessionId: string): string {
  return `agentmonitors events list --session ${sessionId} --unread --format json`;
}

function fullHistoryCommand(sessionId: string): string {
  return `agentmonitors events list --session ${sessionId} --format json`;
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  // Hook-state files may reveal pending-work titles, so they are written
  // owner-only inside an owner-only session directory (issue #292).
  writePrivateFileAtomic(filePath, JSON.stringify(payload, null, 2));
}

function monitorIdFromFilePath(filePath: string): string {
  const base = path.basename(filePath);
  return base === 'MONITOR.md'
    ? path.basename(path.dirname(filePath))
    : path.parse(filePath).name;
}

function explainStage(
  id: MonitorExplainStageId,
  status: MonitorExplainStageStatus,
  reason: string,
  details?: Record<string, unknown>,
): MonitorExplainStage {
  return {
    id,
    label: EXPLAIN_STAGE_LABELS[id],
    status,
    reason,
    ...(details ? { details } : {}),
  };
}

/**
 * Severity rank for explain stage statuses. Higher = more severe.
 * A healthy/ok stage must NEVER mask a downstream failure or pending.
 * Ranking: failure(3) > pending(2) > healthy(1) > ok(0).
 */
const STAGE_STATUS_SEVERITY: Record<MonitorExplainStageStatus, number> = {
  ok: 0,
  healthy: 1,
  pending: 2,
  failure: 3,
};

function explainVerdict(stages: MonitorExplainStage[]): {
  status: MonitorExplainStageStatus;
  stage: MonitorExplainStageId;
  reason: string;
} {
  // Select the highest-severity stage. failure > pending > healthy > ok.
  // Using `find(status !== 'ok')` was the regression introduced in #98: a
  // healthy Observation stage (status='healthy', not 'ok') would short-circuit
  // and mask a downstream failure or pending (#149).
  let worst: MonitorExplainStage | undefined;
  for (const stage of stages) {
    if (
      worst === undefined ||
      STAGE_STATUS_SEVERITY[stage.status] > STAGE_STATUS_SEVERITY[worst.status]
    ) {
      worst = stage;
    }
  }
  const stage = worst ?? stages[stages.length - 1];
  return {
    status: stage?.status ?? 'ok',
    stage: stage?.id ?? 'delivery',
    reason: stage?.reason ?? 'Monitor delivered successfully.',
  };
}

const URGENCY_BY_RANK = ['low', 'normal', 'high'] as const satisfies Urgency[];
const URGENCY_RANK: Record<Urgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

/**
 * Resolve the effective urgency for a single observation: clamp the source's
 * per-observation `salience` (defaulting to the band's low bound when absent)
 * into the monitor's authored `urgency` band `[lo, hi]`.
 *
 * - No `salience` → the band's low bound (the authored base urgency).
 * - `salience` within the band → the salience escalates (or de-escalates)
 *   within it.
 * - `salience` above the band → clamped to `hi`; below the band → clamped to
 *   `lo`.
 *
 * A degenerate band (a bare scalar `urgency`, so `lo === hi`) can never be
 * escalated — every salience clamps back to the single authored level,
 * preserving PP5 and full backward compatibility.
 *
 * @see docs/specs/002-runtime-delivery.md §4.1
 */
function effectiveObservationUrgency(
  monitor: MonitorDefinition,
  observation: Observation,
): Urgency {
  const lo = monitor.frontmatter.urgency;
  // `urgencyMax` may be absent on a monitor snapshot hydrated from pre-upgrade
  // persisted state (before the range-urgency change was deployed). Treat a
  // missing value as a degenerate band (`hi === lo`) — the observation can never
  // escalate, and we return the base urgency. This is the same semantics as a
  // bare scalar urgency (full backward compat). See 002 §3 restart-safety note.
  // The cast to `Urgency | undefined` is intentional: at compile time
  // `MonitorFrontmatter.urgencyMax` is always `Urgency`, but pre-upgrade
  // deserialized JSON may lack the field entirely.
  const hi = (monitor.frontmatter.urgencyMax as Urgency | undefined) ?? lo;
  const desired = observation.salience ?? lo;
  const rank = Math.min(
    Math.max(URGENCY_RANK[desired], URGENCY_RANK[lo]),
    URGENCY_RANK[hi],
  );
  // rank is clamped into [lo, hi] ⊆ [0, 2], so this lookup is always defined.
  return URGENCY_BY_RANK[rank] ?? lo;
}

function serializeObservation(
  monitor: MonitorDefinition,
  observation: Observation,
  observedAt: Date,
): StoredObservationEnvelope {
  return {
    monitor,
    observation,
    observedAt,
    effectiveUrgency: effectiveObservationUrgency(monitor, observation),
  };
}

function hydrateStoredObservationEnvelope(
  envelope: StoredObservationEnvelope,
): StoredObservationEnvelope {
  return {
    monitor: envelope.monitor,
    observation: envelope.observation,
    observedAt:
      envelope.observedAt instanceof Date
        ? envelope.observedAt
        : new Date(envelope.observedAt),
    // Restart-safety / upgrade backfill (002 §3, issue #109): a debounce batch
    // persisted BEFORE the range-urgency upgrade will have no `effectiveUrgency`
    // field on its envelopes. Recompute it from the envelope's `monitor` +
    // `observation` so the materialized event row is never written with
    // `undefined` urgency. `effectiveObservationUrgency` degrades cleanly when
    // the hydrated monitor snapshot itself lacks `urgencyMax` (old monitor).
    // The cast to `Urgency | undefined` is intentional: at compile time
    // `StoredObservationEnvelope.effectiveUrgency` is always `Urgency`, but
    // pre-upgrade deserialized JSON may lack the field entirely.
    effectiveUrgency:
      (envelope.effectiveUrgency as Urgency | undefined) ??
      effectiveObservationUrgency(envelope.monitor, envelope.observation),
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function cronFieldValuesForDate(
  now: Date,
  timeZone = 'UTC',
): [minute: number, hour: number, day: number, month: number, weekday: number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);

  const partMap = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayText = partMap.get('weekday')?.toLowerCase();
  const weekday = weekdayText ? WEEKDAY_INDEX[weekdayText] : undefined;
  const minute = Number(partMap.get('minute'));
  const hour = Number(partMap.get('hour'));
  const day = Number(partMap.get('day'));
  const month = Number(partMap.get('month'));

  if (
    !Number.isFinite(minute) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    weekday === undefined
  ) {
    throw new Error(`Could not derive cron values for timezone "${timeZone}".`);
  }

  return [minute, hour, day, month, weekday];
}

export function cronMatchesDate(
  cron: string,
  now: Date,
  timeZone = 'UTC',
): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const values = cronFieldValuesForDate(now, timeZone);

  return parts.every((part, index) => {
    const currentValue = values[index];
    return currentValue !== undefined && matchCronField(part, currentValue);
  });
}

function matchCronField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.includes(',')) {
    return field.split(',').some((segment) => matchCronField(segment, value));
  }
  if (field.includes('/')) {
    const [base, stepString] = field.split('/');
    const step = Number(stepString);
    if (!Number.isFinite(step) || step <= 0) return false;
    if (base === '*') return value % step === 0;
    if (!base) return false;
    return matchCronField(base, value) && value % step === 0;
  }
  if (field.includes('-')) {
    const parts = field.split('-').map(Number);
    const start = parts[0];
    const end = parts[1];
    if (start === undefined || end === undefined) return false;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return value >= start && value <= end;
  }
  const parsed = Number(field);
  return Number.isFinite(parsed) && parsed === value;
}

function summarizeEvents(events: { title: string; summary: string }[]): string {
  return events
    .map((event, index) => {
      const detail = event.summary || event.title;
      return `${String(index + 1)}. ${detail}`;
    })
    .join('\n');
}

/**
 * Build the recipient-visible summary for one event (G14, 002 §1.1.8): prefer
 * the per-session Interpret digest when present (the agentic gate produced a
 * cheap digest for this recipient), otherwise fall back to the deterministic
 * `summary` → `body` → `title` chain. Shared by the claim and preview paths so
 * a previewed event and its eventual claim render identically.
 */
function recipientSummary(
  event: MonitorEventRecord,
  digests: Map<string, string>,
): string {
  return digests.get(event.id) ?? (event.summary || event.body || event.title);
}

/**
 * Map a delivered {@link MonitorEventRecord} into the {@link DeliveryEventSummary}
 * a transport receives. Kept in one place so the claim path and the delivery
 * preview (issue #299) emit byte-identical event summaries.
 */
function toDeliveryEventSummary(
  event: MonitorEventRecord,
  digests: Map<string, string>,
): DeliveryEventSummary {
  return {
    eventId: event.id,
    monitorId: event.monitorId,
    title: event.title,
    summary: recipientSummary(event, digests),
    urgency: event.urgency,
    createdAt: event.createdAt.toISOString(),
    body: event.body,
  };
}

/**
 * Mutable per-tick accumulator shared by {@link AgentMonitorRuntime.tick} and its
 * per-monitor helper `evaluateMonitorOnTick`, mirroring the four arrays a
 * {@link RuntimeTickResult} is built from.
 */
interface TickAccumulator {
  evaluated: string[];
  emittedEventIds: string[];
  erroredObservations: ErroredObservation[];
  skippedMonitors: { monitorId: string; nextDueAt: Date }[];
}

/**
 * The pure decision a delivery makes (issue #300): the rendered {@link
 * DeliveryClaim} plus the candidate rows a commit must mark claimed. Produced by
 * `decideDelivery` WITHOUT touching the store, so it can back either an
 * immediate `claimDelivery` (decide → apply) or a deferred `reserveDelivery`
 * (decide → lease → …push… → commit applies). The rendered claim reads only
 * event fields + interpret digests, never the re-anchored per-recipient delta
 * the commit persists, so a reserved claim renders identically to a directly
 * claimed one.
 */
interface DeliveryDecision {
  sessionId: string;
  /** Representatives plus the older `net` intermediates of each surfaced group. */
  candidates: MonitorEventRecord[];
  /** True for the post-compact recap branch (commit also advances the recap cursor). */
  isRecap: boolean;
  claim: DeliveryClaim;
}

export class AgentMonitorRuntime {
  /**
   * Monitor ids currently driven by a continuous `watch()` (see `watchMonitors`),
   * mapped to a per-watcher identity token. The token distinguishes the *current*
   * watcher for an id from an earlier, torn-down one: a straggling checkpoint
   * from a superseded watcher is rejected when its token no longer matches the
   * live entry, and each watcher only releases its own slot on exit. The tick
   * loop still uses membership (`has`) to skip `observe()` for actively-watched
   * monitors.
   */
  private readonly activeWatchers = new Map<string, symbol>();

  /**
   * The per-session dormancy threshold in ms (002 §6.2 / 007 §4.4). Defaults to
   * {@link DEFAULT_SESSION_DORMANCY_MS}; overridable for deterministic tests.
   */
  private readonly sessionDormancyMs: number;

  /**
   * In-memory reservations for the reserve → commit/release surfacing protocol
   * (006 §4, issue #300). Daemon-local by design — both transports drive the one
   * runtime, and a lost lease safely returns its rows to the hook path.
   */
  private readonly reservations: DeliveryReservationRegistry;

  constructor(
    private readonly store: RuntimeStore,
    private readonly registry: SourceRegistry,
    private readonly adapters: AgentRuntimeAdapter[] = [claudeCodeAdapter],
    /**
     * The optional **Interpret adapter** (G14, 002 §1.1.8). When present, a
     * `payload.form: prose` monitor's per-recipient delta is read by the user's
     * own AI tool to produce a cheap digest + agentic significance gate. When
     * absent, Interpret never runs (fully backward compatible) and `prose`
     * deliveries carry the deterministic `rendered` artifact. The runtime core
     * never embeds the tool's command string — the host-specific invocation lives
     * behind this adapter (002 §11.1, 006 §2.1, AP3).
     */
    private readonly interpretAdapter?: InterpretAdapter,
    /**
     * Optional runtime tuning. `sessionDormancyMs` overrides the per-session
     * dormancy threshold (002 §6.2 / 007 §4.4) — used by tests to exercise
     * inactivity-triggered ephemeral-monitor reaping deterministically.
     * `deliveryReservationTtlMs` overrides the uncommitted-reservation lifetime
     * (006 §4, issue #300) — used by tests to exercise lease expiry
     * deterministically.
     */
    options: {
      sessionDormancyMs?: number;
      deliveryReservationTtlMs?: number;
    } = {},
  ) {
    this.sessionDormancyMs =
      options.sessionDormancyMs ?? DEFAULT_SESSION_DORMANCY_MS;
    this.reservations = new DeliveryReservationRegistry(
      options.deliveryReservationTtlMs,
    );
  }

  adapter(name: string): AgentRuntimeAdapter {
    const adapter = this.adapters.find((candidate) => candidate.name === name);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${name}`);
    }
    return adapter;
  }

  openSession(input: OpenSessionInput): AgentSessionRecord {
    const session = this.store.openSession(input);
    this.refreshHookState(session.id);
    return session;
  }

  closeSession(sessionId: string): AgentSessionRecord {
    const session = this.store.closeSession(sessionId);
    // Reap the session's ephemeral monitors (007 §4.4): a session that ends or
    // goes dormant MUST release its session-scoped watches immediately — they
    // must not outlive the session, leak into another session, or resurrect
    // after a daemon restart. Reaping retains their already-materialized events
    // (the session record goes dormant, not deleted) so a late delivery is never
    // silently dropped (007 §4.4 default retention, PP1).
    this.store.reapEphemeralMonitorsForSession(sessionId);
    this.refreshHookState(session.id);
    return session;
  }

  /**
   * Declare an ephemeral (agent-declared, session-scoped) monitor (007 §4.2):
   * "tell me when _X_, and remind me of _this instruction_ when it does." The
   * declaration binds to the resolved AgentMon session, is validated by the
   * **same** {@link validateScope} path as `agentmonitors validate` (so an
   * ephemeral monitor cannot express a config a persistent one could not), is
   * assigned a namespaced runtime identity (007 §4.3), and is persisted durably
   * so it survives a daemon restart while the session lives (007 §4.4). The
   * declaration performs **no** watching: it registers intent and returns; the
   * daemon does all subsequent observation on the normal tick (PP9, 007 §4.5).
   *
   * @throws if the bound session is unknown or not active (an unbindable
   *   declaration is rejected, never silently made global — 007 §4.2), the source
   *   is unknown, or the scope/urgency is invalid.
   */
  declareEphemeralMonitor(
    input: DeclareEphemeralMonitorInput,
  ): EphemeralMonitorRecord {
    // 1. Resolve + validate the binding session (007 §4.2).
    const session = this.store.findSessionById(input.sessionId);
    if (!session) {
      throw new Error(
        `Cannot declare an ephemeral monitor: session "${input.sessionId}" was not found. ` +
          'A declaration must bind to a live AgentMon session (007 §4.2).',
      );
    }
    if (session.status !== 'active') {
      throw new Error(
        `Cannot declare an ephemeral monitor: session "${input.sessionId}" is ${session.status}. ` +
          'A declaration must bind to an active session (007 §4.2).',
      );
    }
    // An ephemeral monitor's events project into the declaring session ONLY, and
    // projection is filtered to LEAD sessions (007 §4.6 / 002 §6). A monitor bound
    // to a subagent session would therefore observe forever but never deliver a
    // single event — a silently-dead watch. Reject it at declaration time rather
    // than register something that can never fire.
    if (session.role !== 'lead') {
      throw new Error(
        `Cannot declare an ephemeral monitor: session "${input.sessionId}" is a ${session.role} session. ` +
          'Ephemeral-monitor events project into lead sessions only (007 §4.6), so a ' +
          'non-lead binding would never deliver — declare from the lead session.',
      );
    }

    // 2. Validate the source name + scope via the SAME `validateScope` path as
    //    `agentmonitors validate` (007 §4.2, AP4/BP3). `validateWatchScope`
    //    (schema check + the shared BP3 change-detection.collection friendly
    //    error) is the exact path `agentmonitors validate` uses, so an invalid
    //    scope is rejected with the IDENTICAL diagnosis (005 §14.4).
    const source = this.registry.get(input.source);
    if (!source) {
      throw new Error(
        `Unknown source "${input.source}". Available sources: ${this.registry
          .names()
          .join(', ')}`,
      );
    }
    const scopeErrors = validateWatchScope(input.scope, source.scopeSchema);
    if (scopeErrors.length > 0) {
      throw new Error(
        `Invalid scope for source "${input.source}": ${scopeErrors.join('; ')}`,
      );
    }

    // 3. Parse the urgency band + confirm the whole declaration through the SAME
    //    frontmatter schema a persistent monitor uses, so an ephemeral monitor's
    //    frontmatter is byte-identical in shape to a file-authored one (AP7).
    //    Spread the scope FIRST so the real source name always wins `type` — a
    //    scope key literally named `type` must never override the resolved source
    //    (no bundled scopeSchema sets additionalProperties:false, so such a key
    //    parses), which would desync the monitor from its source and starve it.
    const parsed = monitorFrontmatterSchema.safeParse({
      watch: { ...input.scope, type: input.source },
      urgency: input.urgency ?? 'normal',
    });
    if (!parsed.success) {
      throw new Error(
        `Invalid ephemeral monitor declaration: ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      );
    }

    // 4. Assign the namespaced runtime identity (007 §4.3) and persist.
    const id = `${EPHEMERAL_MONITOR_ID_PREFIX}${session.id}/${ulid()}`;
    const record = this.store.insertEphemeralMonitor({
      id,
      sessionId: session.id,
      workspacePath: session.workspacePath ?? null,
      sourceName: input.source,
      scope: input.scope,
      urgency: parsed.data.urgency,
      urgencyMax: parsed.data.urgencyMax,
      instruction: input.instruction ?? '',
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    // Declaring a watch IS session activity: bump the session's `lastActiveAt`
    // so a declaration on its own resets the per-session dormancy clock (002
    // §6.2 / 007 §4.4). Without this, only `claimDelivery`/recap advance it, so a
    // session that declares a watch and then blocks on one long tool call (no
    // hooks) would be reaped mid-wait and lose its watches — exactly the case a
    // watch exists for. See also the declaredAt guard in `staleActiveSessions`.
    this.store.touchSession(session.id);
    return record;
  }

  /** List the active ephemeral monitors declared by a session (007 §4, `watch list`). */
  listEphemeralMonitors(sessionId: string): EphemeralMonitorRecord[] {
    return this.store.listEphemeralMonitorsForSession(sessionId);
  }

  /**
   * Cancel an ephemeral monitor (007 §4.4, `watch cancel`), reaping it
   * immediately. The `sessionId` MUST own the monitor — a session can only
   * cancel its own watches (session isolation) — so a cancel targeting another
   * session's id, or an unknown id, is rejected.
   *
   * @returns the reaped record.
   */
  cancelEphemeralMonitor(
    sessionId: string,
    ephemeralId: string,
  ): EphemeralMonitorRecord {
    const record = this.store.findEphemeralMonitorById(ephemeralId);
    if (record?.sessionId !== sessionId) {
      throw new Error(
        `Ephemeral monitor "${ephemeralId}" was not found for session "${sessionId}".`,
      );
    }
    this.store.reapEphemeralMonitor(ephemeralId);
    return this.store.getEphemeralMonitorById(ephemeralId);
  }

  /**
   * Rebuild the pipeline-facing {@link MonitorDefinition} from a durable
   * ephemeral declaration (007 §4.6). Reconstructed on every tick (and after a
   * daemon restart) so an ephemeral monitor flows the identical pipeline as a
   * persistent one (AP7). The urgency band is restored to its `lo..hi` string
   * form so the frontmatter schema reproduces the same flattened
   * `{ urgency, urgencyMax }`. `filePath` is empty — an ephemeral monitor has no
   * file — which is never used on the tick path (the id is its identity).
   */
  private ephemeralRecordToMonitor(
    record: EphemeralMonitorRecord,
  ): MonitorDefinition {
    const urgencyBand =
      record.urgency === record.urgencyMax
        ? record.urgency
        : `${record.urgency}..${record.urgencyMax}`;
    // Spread the persisted scope FIRST so `record.sourceName` always wins `type`:
    // a persisted scope key named `type` must never override the source name the
    // monitor is keyed and scheduled by (identity/scheduling stay consistent with
    // `record.sourceName`). Mirrors the same guard at declaration time.
    const frontmatter = monitorFrontmatterSchema.parse({
      watch: { ...record.scope, type: record.sourceName },
      urgency: urgencyBand,
    });
    return {
      id: record.id,
      displayName: record.displayName ?? record.id,
      frontmatter,
      instructions: record.instruction,
      filePath: '',
    };
  }

  /**
   * Per-session dormancy transition (002 §6.2 / 007 §4.4). Before evaluating
   * monitors on a tick, move any `active` session in `workspacePath` that has
   * been inactive for at least {@link sessionDormancyMs} to `dormant` and reap
   * its ephemeral monitors — a backstop for a session that vanished without an
   * explicit `session close`. Distinct from the daemon-wide idle self-termination
   * (002 §10.2), which stops the whole daemon once ALL a workspace's sessions are
   * inactive.
   */
  private reapDormantSessions(
    now: Date,
    workspacePath: string,
    monitorsById: Map<string, MonitorDefinition>,
  ): void {
    const staleBefore = new Date(now.getTime() - this.sessionDormancyMs);
    for (const session of this.store.staleActiveSessions(
      workspacePath,
      staleBefore,
    )) {
      // #414 backstop: a `verify --use-workspace-daemon` run killed uncatchably
      // (SIGKILL/crash) before it could clean up leaves an `active` verify
      // session AND its scratch file's create/delete events — the exact stray
      // state issue #414 forbids. When we reap such a session, tombstone + retract
      // its synthetic scratch objects too, so nothing it left reaches a later
      // session. Captured BEFORE the close (projections persist, but read first).
      const scratchObjects = session.hostSessionId.startsWith(
        VERIFY_SESSION_ID_PREFIX,
      )
        ? this.verifyScratchObjectsForSession(session.id)
        : [];
      // Reuse closeSession so the dormancy transition and an explicit close
      // share ONE path (status → dormant, ephemeral monitors reaped, hook state
      // refreshed).
      this.closeSession(session.id);
      for (const object of scratchObjects) {
        this.suppressObjectEvents({
          monitorId: object.monitorId,
          objectKey: object.objectKey,
          workspacePath: object.workspacePath,
          // Derive the tombstone's life from the object's OWN monitor cadence when
          // it is still authored (issue #418): a long-interval/long-settle monitor
          // needs a window that outlasts its next poll + settle, or the scratch
          // deletion re-materializes AFTER the tombstone has expired and lingers.
          // Falls back to the fixed floor when the monitor is gone from the scan.
          ttlMs: this.orphanSuppressionTtlMs(
            monitorsById.get(object.monitorId),
            now,
            object.workspacePath,
          ),
          now,
        });
      }
    }
  }

  /**
   * The distinct synthetic scratch objects (`agentmonitors-verify-<token>…`) an
   * orphaned verify session projected events for (issue #414). Used by the reap
   * backstop above to tombstone+retract them. Matching is by the well-known
   * scratch-file basename, which no real monitored object ever carries, so the
   * subsequent by-key retraction can never touch real events.
   */
  private verifyScratchObjectsForSession(sessionId: string): {
    monitorId: string;
    objectKey: string;
    workspacePath: string | null;
  }[] {
    const seen = new Set<string>();
    const objects: {
      monitorId: string;
      objectKey: string;
      workspacePath: string | null;
    }[] = [];
    for (const event of this.store.listEvents({ sessionId })) {
      if (
        event.objectKey === null ||
        !isVerifyScratchObjectKey(event.objectKey)
      )
        continue;
      const key = `${event.monitorId}::${event.objectKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push({
        monitorId: event.monitorId,
        objectKey: event.objectKey,
        workspacePath: event.workspacePath ?? null,
      });
    }
    return objects;
  }

  /**
   * TTL for the tombstone the reap backstop installs over an orphaned verify run's
   * scratch object (issue #418). The fixed {@link ORPHANED_VERIFY_SUPPRESSION_TTL_MS}
   * floor can undershoot a monitor whose poll interval + notify settle exceeds it —
   * the scratch deletion would then re-materialize AFTER the tombstone expired and
   * linger for a later session. When the object's monitor is still authored (its
   * definition is in this tick's scan) we derive the max of the floor and
   * (interval + settle + margin) so the window always outlasts one full
   * observe-and-settle cycle; when it is gone we fall back to the floor.
   */
  private orphanSuppressionTtlMs(
    monitor: MonitorDefinition | undefined,
    now: Date,
    workspacePath: string | null,
  ): number {
    if (!monitor) return ORPHANED_VERIFY_SUPPRESSION_TTL_MS;
    const { nextPollMs } = this.scheduleForMonitor(monitor, now, workspacePath);
    const notify = monitor.frontmatter.notify;
    // The settle window that can delay the deletion's materialization: a debounce
    // holds the batch for `settle-for`; a throttle can defer up to `suppress-for`.
    const settleRaw =
      notify?.strategy === 'debounce'
        ? notify['settle-for']
        : notify?.strategy === 'throttle'
          ? notify['suppress-for']
          : undefined;
    let settleMs = 0;
    if (typeof settleRaw === 'string') {
      try {
        settleMs = parseDuration(settleRaw);
      } catch {
        settleMs = 0;
      }
    }
    return Math.max(
      ORPHANED_VERIFY_SUPPRESSION_TTL_MS,
      nextPollMs + settleMs + ORPHANED_VERIFY_SUPPRESSION_MARGIN_MS,
    );
  }

  listSessions(): AgentSessionRecord[] {
    return this.store.listSessions();
  }

  listEvents(query: EventQuery = {}) {
    return this.store.listEvents(query);
  }

  listObservationHistory(
    query: ObservationHistoryQuery = {},
  ): ObservationHistoryRecord[] {
    return this.store.listObservationHistory(query);
  }

  async explainMonitor(
    input: MonitorExplainInput,
  ): Promise<MonitorExplainReport> {
    const now = input.now ?? new Date();
    const historyLimit = input.historyLimit ?? 10;
    const eventLimit = input.eventLimit ?? 10;
    const stages: MonitorExplainStage[] = [];
    const scan = await scanMonitors(input.monitorsDir);
    const parseError = scan.errors.find(
      (error) => monitorIdFromFilePath(error.filePath) === input.monitorId,
    );
    const monitor = scan.monitors.find(
      (candidate) => candidate.monitor.id === input.monitorId,
    )?.monitor;
    const duplicate = scan.duplicateIds.find(
      (candidate) => candidate.id === input.monitorId,
    );

    if (parseError) {
      stages.push(
        explainStage(
          'definition',
          'failure',
          `MONITOR.md failed to parse or validate: ${parseError.error}`,
          { filePath: parseError.filePath },
        ),
      );
      return {
        monitorId: input.monitorId,
        generatedAt: now,
        stages,
        verdict: explainVerdict(stages),
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
      };
    }

    if (!monitor) {
      stages.push(
        explainStage(
          'definition',
          'failure',
          `Monitor "${input.monitorId}" was not found in ${input.monitorsDir}.`,
        ),
      );
      return {
        monitorId: input.monitorId,
        generatedAt: now,
        stages,
        verdict: explainVerdict(stages),
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
      };
    }

    if (duplicate) {
      stages.push(
        explainStage(
          'definition',
          'failure',
          `Monitor id "${input.monitorId}" is duplicated across ${String(duplicate.filePaths.length)} files.`,
          { filePaths: duplicate.filePaths },
        ),
      );
      return {
        monitorId: input.monitorId,
        generatedAt: now,
        monitor: {
          id: monitor.id,
          displayName: monitor.displayName,
          filePath: monitor.filePath,
          sourceName: monitor.frontmatter.watch.type,
          urgency: monitor.frontmatter.urgency,
        },
        stages,
        verdict: explainVerdict(stages),
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
      };
    }

    const sourceName = monitor.frontmatter.watch.type;
    const source = this.registry.get(sourceName);
    const scopeErrors = source
      ? validateScope(
          watchConfig(monitor.frontmatter.watch),
          source.scopeSchema,
        )
      : [`Unknown source "${sourceName}".`];
    if (scopeErrors.length > 0) {
      stages.push(
        explainStage(
          'definition',
          'failure',
          `Monitor definition is invalid: ${scopeErrors.join('; ')}`,
          { filePath: monitor.filePath, sourceName },
        ),
      );
      return {
        monitorId: input.monitorId,
        generatedAt: now,
        monitor: {
          id: monitor.id,
          displayName: monitor.displayName,
          filePath: monitor.filePath,
          sourceName,
          urgency: monitor.frontmatter.urgency,
        },
        stages,
        verdict: explainVerdict(stages),
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
      };
    }

    stages.push(
      explainStage('definition', 'ok', 'Monitor definition is valid.', {
        filePath: monitor.filePath,
        sourceName,
      }),
    );

    // Workspace-scope consistency (issue #345 / #307 review). Every stage of one
    // report MUST read a single scope. `workspacePath` is optional on the
    // `monitor.explain` wire; when omitted, default it to the SAME workspace the
    // tick loop uses when it is called without one (`tick(monitorsDir)` defaults
    // `workspacePath` to `monitorsDir`). Otherwise the scheduling/monitor-state
    // stages would read a NULL scope no write path populates ("never ticked, due
    // now") while the observation/event/history stages read unscoped across ALL
    // workspaces — a self-contradictory report and a cross-workspace history leak.
    const workspacePath = input.workspacePath ?? input.monitorsDir;

    const runtimeState = this.store.getMonitorState(
      input.monitorId,
      workspacePath,
    );
    const schedule = this.scheduleForMonitor(monitor, now, workspacePath);
    if (schedule.error) {
      // Defensive isolation (issue #297): scheduleForMonitor() never throws —
      // an invalid IANA timezone surfaces here as `schedule.error` instead.
      // explainMonitor() MUST NOT mutate runtime state (002 §10.7), so — unlike
      // the tick path — this does NOT write an observation_history row.
      //
      // Stage placement: the failure is in cron/timezone evaluation (002 §10.7
      // stage 2, "Scheduling"), not observe() (stage 3, "Observation") — the
      // source was never even called. It is nonetheless rendered as an
      // 'observation'-stage failure, DELIBERATELY, for consistency with the
      // tick loop: a live daemon isolates this exact failure into an 'errored'
      // observation_history row (evaluateMonitorOnTick()'s schedule.error
      // branch), which the normal history-based rendering below always surfaces
      // as an 'observation' failure. Placing it in 'scheduling' here would make
      // the SAME root cause render in different stages depending on whether a
      // tick had already run — confusing. The MESSAGE states the true cause
      // (scheduling/timezone, not "the source") so the stage location doesn't
      // read as a misdiagnosis (PR #433 review, discussion_r3608549689).
      stages.push(
        explainStage(
          'observation',
          'failure',
          `This monitor's schedule could not be evaluated, so its source was never observed: ${schedule.error}`,
          { error: schedule.error },
        ),
      );
      return {
        monitorId: input.monitorId,
        generatedAt: now,
        monitor: {
          id: monitor.id,
          displayName: monitor.displayName,
          filePath: monitor.filePath,
          sourceName,
          urgency: monitor.frontmatter.urgency,
        },
        stages,
        verdict: explainVerdict(stages),
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
      };
    }
    const lastObservationAt = runtimeState.lastObservationAt;
    const nextDueAt = schedule.due
      ? now
      : new Date(
          (lastObservationAt?.getTime() ?? now.getTime()) + schedule.nextPollMs,
        );
    stages.push(
      explainStage(
        'scheduling',
        'ok',
        lastObservationAt
          ? `Last tick completed at ${lastObservationAt.toISOString()}; next due ${schedule.due ? 'now' : nextDueAt.toISOString()}.`
          : 'No completed tick is recorded yet; the monitor is due on the next daemon tick.',
        {
          due: schedule.due,
          nextPollMs: schedule.nextPollMs,
          nextDueAt: nextDueAt.toISOString(),
          ...(lastObservationAt
            ? { lastObservationAt: lastObservationAt.toISOString() }
            : {}),
        },
      ),
    );

    const observations = this.store.listObservationHistory({
      monitorId: input.monitorId,
      // Scope to the explained workspace so a same-id monitor in another
      // workspace cannot leak its observation history into this report
      // (issue #345 / #307; mirrors the event/monitor-state scoping above).
      workspacePath,
      limit: historyLimit,
    });
    const latestObservation = observations[0];
    if (!latestObservation) {
      stages.push(
        explainStage(
          'observation',
          'failure',
          'No observation history has been recorded for this monitor.',
        ),
      );
    } else if (latestObservation.result === 'errored') {
      stages.push(
        explainStage(
          'observation',
          'failure',
          'The most recent source observation errored.',
          latestObservation.observationData,
        ),
      );
    } else if (latestObservation.result === 'no-change') {
      // A genuinely quiet tick is healthy, not a fault (issue #94): the watched
      // target simply hasn't changed. Render distinctly from a real failure.
      stages.push(
        explainStage(
          'observation',
          'healthy',
          'Source ran, observed 0 changes — your watched target genuinely hasn’t changed (not a bug).',
          latestObservation.observationData,
        ),
      );
    } else if (latestObservation.result === 'no-files-matched') {
      stages.push(
        explainStage(
          'observation',
          'failure',
          'The source ran but matched zero files; check the monitor globs and cwd.',
          latestObservation.observationData,
        ),
      );
    } else if (latestObservation.result === 'rebaselined') {
      // The source advanced its baseline without computing a delta (e.g. a
      // force-pushed/gc'd ref). No change was emitted, which is healthy — not a
      // fault (issue #94).
      stages.push(
        explainStage(
          'observation',
          'healthy',
          'Source rebaselined and emitted no change — your watched target is being tracked, nothing to report (not a bug).',
          latestObservation.observationData,
        ),
      );
    } else {
      stages.push(
        explainStage(
          'observation',
          'ok',
          `The latest observation outcome was ${latestObservation.result}.`,
          latestObservation.observationData,
        ),
      );
    }

    // A healthy/idle observation means the watched target genuinely hasn't
    // changed (issue #94): the absence of downstream events/projections is the
    // *expected* outcome, not a fault, so the later stages must not render ✗.
    const observationHealthy =
      latestObservation?.result === 'no-change' ||
      latestObservation?.result === 'rebaselined';

    const notifyState = runtimeState.notifyState;
    const pendingDebounce = notifyState.pendingDebounce;
    const suppressedUntil = notifyState.suppressedUntil
      ? new Date(notifyState.suppressedUntil)
      : null;
    // Track whether the notify layer has a queued batch (holding or overdue) so
    // the materialization stage can reflect 'pending' rather than 'failure'
    // (#149, Copilot review #155).
    //
    // IMPORTANT: pendingDebounce can be present even when dueAt <= now. That
    // happens when the settle window has expired but the daemon tick has not
    // yet run to flush and clear the batch. In that window the batch is still
    // queued — it will materialize on the next tick — so materialization is
    // still pending, not a failure. The notify stage distinguishes "actively
    // settling" (dueAt > now) from "ready to flush on next tick" (dueAt <= now)
    // with distinct text, but both are semantically pending.
    let notifyPending = false;
    // A debounce-held materialization message that describes the current hold
    // state for the materialization stage reason (set when notifyPending is true
    // due to a debounce batch, null when pending is due to throttle).
    let debounceMaterializationReason: string | null = null;
    if (pendingDebounce) {
      notifyPending = true;
      const dueAt = new Date(pendingDebounce.dueAt);
      const isOverdue = dueAt <= now;
      if (isOverdue) {
        stages.push(
          explainStage(
            'notify',
            'pending',
            `debounce settle window has elapsed; ${String(pendingDebounce.observations.length)} observation(s) will be flushed on the next daemon tick.`,
            {
              dueAt: pendingDebounce.dueAt,
              observations: pendingDebounce.observations.length,
              overdue: true,
            },
          ),
        );
        debounceMaterializationReason =
          'No monitor_events rows yet — the debounce settle window has elapsed and the batch will flush on the next daemon tick.';
      } else {
        stages.push(
          explainStage(
            'notify',
            'pending',
            `debounce is holding ${String(pendingDebounce.observations.length)} observation(s) until ${pendingDebounce.dueAt}.`,
            {
              dueAt: pendingDebounce.dueAt,
              observations: pendingDebounce.observations.length,
              overdue: false,
            },
          ),
        );
        debounceMaterializationReason =
          'No monitor_events rows yet — the notify layer is holding the batch until the debounce settle window elapses.';
      }
    } else if (
      notifyState.pendingRollup &&
      notifyState.pendingRollup.observations.length > 0
    ) {
      // Rollup is accumulating: the notify layer is intentionally holding
      // observations until the next delivery window fires (002 §4.4). This is
      // expected `pending` — not a bug — consistent with the debounce branch.
      notifyPending = true;
      const count = notifyState.pendingRollup.observations.length;
      const window =
        monitor.frontmatter.notify?.strategy === 'rollup'
          ? monitor.frontmatter.notify.window
          : 'unknown';
      stages.push(
        explainStage(
          'notify',
          'pending',
          `rollup is holding ${String(count)} observation(s) until the next window (${window}).`,
          { window, observations: count },
        ),
      );
      debounceMaterializationReason =
        'No monitor_events rows yet — the rollup notify layer is accumulating observations until the next window.';
    } else if (suppressedUntil && suppressedUntil > now) {
      notifyPending = true;
      stages.push(
        explainStage(
          'notify',
          'pending',
          `throttle is suppressing new notifications until ${suppressedUntil.toISOString()}.`,
          { suppressedUntil: suppressedUntil.toISOString() },
        ),
      );
    } else {
      stages.push(
        explainStage(
          'notify',
          'ok',
          'No debounce, rollup, or throttle hold is currently active.',
        ),
      );
    }

    const events = this.store
      .listEvents({
        monitorId: input.monitorId,
        // Scope to the explained workspace so a same-id monitor in another
        // workspace cannot leak its events into this report (issue #94 review).
        workspacePath,
      })
      .slice(0, eventLimit);
    if (events.length === 0) {
      // When no event has materialized yet because the notify layer has a queued
      // batch (actively settling or overdue-but-unflushed), materialization is
      // pending — not a failure. The observation was observed but the runtime
      // hasn't flushed it yet. Only treat it as failure when the notify layer is
      // clear and there is still nothing materialized (unexpected absence).
      stages.push(
        observationHealthy
          ? explainStage(
              'materialization',
              'healthy',
              'No events materialized — expected, because the source observed no changes (not a bug).',
            )
          : notifyPending
            ? explainStage(
                'materialization',
                'pending',
                debounceMaterializationReason ??
                  'No monitor_events rows yet — the notify layer is holding the batch until the throttle window elapses.',
              )
            : explainStage(
                'materialization',
                'failure',
                'No monitor_events rows exist for this monitor.',
              ),
      );
    } else {
      stages.push(
        explainStage(
          'materialization',
          'ok',
          `${String(events.length)} recent monitor_events row(s) found.`,
          { eventIds: events.map((event) => event.id) },
        ),
      );
    }

    const projections = this.store.listDeliveryProjectionsForMonitor(
      input.monitorId,
      // Scope to the explained workspace's sessions (plus global sessions) so
      // projections from other workspaces are not overcounted (issue #94 review).
      workspacePath,
    );
    const leadSessions = this.store
      .sessionsForWorkspace(workspacePath)
      .filter((session) => session.role === 'lead');
    if (events.length > 0 && projections.length === 0) {
      stages.push(
        explainStage(
          'delivery',
          'failure',
          leadSessions.length === 0
            ? 'No lead session is registered for this workspace, so events were not projected.'
            : 'No session_event_state projections exist for the materialized events.',
          { leadSessions: leadSessions.map((session) => session.id) },
        ),
      );
    } else if (events.length > 0) {
      const counts = projections.reduce<Record<string, number>>(
        (acc, projection) => {
          acc[projection.deliveryState] =
            (acc[projection.deliveryState] ?? 0) + 1;
          return acc;
        },
        {},
      );
      // Per-recipient Interpret verdicts (G14, 002 §1.1.8): surface why a `prose`
      // delta was suppressed-as-not-substantive or fell back after a tool failure,
      // so "why nothing fired" is inspectable (capability C12). The verdict is
      // recorded right of the seam, on each projection.
      const interpretVerdicts = projections
        .filter((projection) => projection.interpretDecision)
        .map((projection) => ({
          sessionId: projection.sessionId,
          decision: projection.interpretDecision,
          ...(projection.interpretReason
            ? { reason: projection.interpretReason }
            : {}),
          ...(projection.interpretDigest
            ? { digest: projection.interpretDigest }
            : {}),
        }));
      const suppressedCount = interpretVerdicts.filter(
        (v) => v.decision === 'suppress',
      ).length;
      const interpretSuffix =
        suppressedCount > 0
          ? ` Interpret suppressed ${String(suppressedCount)} as not substantive (recorded per-recipient).`
          : '';
      // Coalesced-reminder suppression (issue #333, 002 §9.2–§9.3): when a
      // session's unread normal/low events are already CLAIMED (but not yet
      // acknowledged), the generic inbox reminder is suppressed — the exact trap
      // where a second `hook claim --lifecycle turn-interruptible` returns null
      // with no explanation. Name that reason here so the silence is inspectable
      // (capability C12) rather than a dead end. The guard is SESSION-level and
      // cross-monitor (it counts every unread event of the band for the session),
      // so we read session-scoped store counts, restricted to the sessions this
      // monitor actually projects a still-unread (unacknowledged, unsuppressed)
      // event to.
      const reminderSessionIds = new Set(
        projections
          .filter(
            (projection) =>
              projection.deliveryState !== 'acknowledged' &&
              !projection.netSuppressed &&
              projection.interpretDecision !== 'suppress',
          )
          .map((projection) => projection.sessionId),
      );
      const reminderCounts: ReminderSessionCounts[] = [];
      const reminderBands: ReminderUrgency[] = ['normal', 'low'];
      for (const sessionId of reminderSessionIds) {
        for (const urgency of reminderBands) {
          reminderCounts.push({
            sessionId,
            urgency,
            unreadCount: this.store.unreadEventsForSession(sessionId, urgency)
              .length,
            // Lease-aware (issue #300): a row reserved by an in-flight channel
            // push is not independently claimable, so it must not count as
            // pending here or the reminder-suppression diagnosis would disagree
            // with what a real claim would decide.
            pendingCount: this.pendingForClaim(sessionId, urgency).length,
          });
        }
      }
      const reminderSuppression = diagnoseReminderSuppression(reminderCounts);
      const reminderSuffix =
        reminderSuppression.length > 0
          ? ` ${reminderSuppression.map((finding) => finding.message).join(' ')}`
          : '';
      const deliveryDetails: Record<string, unknown> = { ...counts };
      if (interpretVerdicts.length > 0) {
        deliveryDetails['interpret'] = interpretVerdicts;
      }
      if (reminderSuppression.length > 0) {
        deliveryDetails['reminderSuppression'] = reminderSuppression;
      }
      stages.push(
        explainStage(
          'delivery',
          'ok',
          `Events are projected to lead sessions (${Object.entries(counts)
            .map(([state, count]) => `${state}: ${String(count)}`)
            .join(', ')}).${interpretSuffix}${reminderSuffix}`,
          deliveryDetails,
        ),
      );
    } else {
      stages.push(
        observationHealthy
          ? explainStage(
              'delivery',
              'healthy',
              'Nothing to deliver — the source observed no changes, so there is no signal to project (not a bug).',
            )
          : explainStage(
              'delivery',
              'pending',
              'Delivery has not started because no event has materialized yet.',
            ),
      );
    }

    return {
      monitorId: input.monitorId,
      generatedAt: now,
      monitor: {
        id: monitor.id,
        displayName: monitor.displayName,
        filePath: monitor.filePath,
        sourceName,
        urgency: monitor.frontmatter.urgency,
      },
      stages,
      verdict: explainVerdict(stages),
      observations,
      events,
      projections,
      leadSessions,
    };
  }

  /**
   * Produce a workspace-wide, durable-state health report — the read-only
   * diagnosis behind `agentmonitors doctor` (005 §"doctor", issue #267). Unlike
   * {@link explainMonitor} (single-monitor, staged) this rolls up every monitor
   * in the tree plus the workspace's lead-session state, so an author can answer
   * "is my monitoring working, and if not, where is it broken?" from one call.
   *
   * All reads are in-process against the persisted store, so the report is valid
   * whether or not a daemon is running (the daemon writes the same SQLite file).
   * The CLI adds the project-enabled and daemon-reachable checks, which are
   * CLI-only concerns core does not model.
   */
  async doctorReport(input: DoctorReportInput): Promise<MonitorDoctorReport> {
    const now = input.now ?? new Date();
    const historyLimit = input.historyLimit ?? 1;
    const { monitorsDir, workspacePath } = input;

    // Doctor is a diagnostic surface: a stat failure (permissions, transient
    // FS race after existsSync) is reported as "no monitors directory", never
    // thrown — a crashing doctor cannot diagnose anything.
    const monitorsDirExists = (() => {
      try {
        return existsSync(monitorsDir) && statSync(monitorsDir).isDirectory();
      } catch {
        return false;
      }
    })();

    const scan = await scanMonitors(monitorsDir);
    const parseErrors: DoctorParseError[] = scan.errors.map((error) => ({
      id: monitorIdFromFilePath(error.filePath) || error.filePath,
      error: error.error,
    }));

    const leadSessions = this.store
      .sessionsForWorkspace(workspacePath)
      .filter((session) => session.role === 'lead');

    const monitors: DoctorMonitorRollup[] = [];
    let invalidCount = 0;
    for (const { monitor } of scan.monitors) {
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      const scopeErrors = source
        ? validateScope(
            watchConfig(monitor.frontmatter.watch),
            source.scopeSchema,
          )
        : [`Unknown source "${sourceName}".`];

      const runtimeState = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      const schedule = this.scheduleForMonitor(monitor, now, workspacePath);
      // Defensive isolation (issue #297): scheduleForMonitor() never throws — an
      // invalid IANA timezone surfaces here as `schedule.error` instead. Doctor
      // is a diagnostic surface (like explain) and must never crash on a single
      // bad monitor's config; fold the scheduling failure into the same
      // valid/validationError reporting as a scope error so it's visible in the
      // rollup rather than silently producing a bogus `due`/`nextDueAt`.
      const validationErrors = schedule.error
        ? [...scopeErrors, schedule.error]
        : scopeErrors;
      const valid = validationErrors.length === 0;
      if (!valid) invalidCount += 1;

      const history = this.store.listObservationHistory({
        monitorId: monitor.id,
        // Scope to this workspace (issue #345 / #307) so a same-id monitor in
        // another workspace cannot leak its observation history here — mirrors
        // the `monitor_events` scoping below and in explainMonitor.
        workspacePath,
        limit: historyLimit,
      });
      // "Never observed" means no completed observation tick AND no recorded
      // observation-history row (issue #267). An errored-only monitor DID run, so
      // it is not "never observed" even though `lastObservationAt` is unset —
      // and its `lastObservedAt` falls back to the newest history row's
      // timestamp so the rollup never prints "never" for a monitor that ran.
      const lastObservedAt =
        runtimeState.lastObservationAt ?? history[0]?.createdAt;
      const neverObserved =
        runtimeState.lastObservationAt === undefined && history.length === 0;

      const nextDueAt = schedule.due
        ? now
        : new Date(
            (lastObservedAt?.getTime() ?? now.getTime()) + schedule.nextPollMs,
          );

      const events = this.store.listEvents({
        monitorId: monitor.id,
        // Scope to this workspace (plus workspace-agnostic events) so a same-id
        // monitor in another workspace cannot leak (mirrors explainMonitor).
        workspacePath,
      });
      const lastEventAt = events.reduce<Date | undefined>(
        (latest, event) =>
          latest === undefined || event.createdAt > latest
            ? event.createdAt
            : latest,
        undefined,
      );

      const delivery: DoctorDeliveryCounts = {
        unread: 0,
        claimed: 0,
        acknowledged: 0,
      };
      for (const projection of this.store
        .listDeliveryProjectionsForMonitor(monitor.id, workspacePath)
        .filter((projection) => projection.sessionRole === 'lead')) {
        if (projection.deliveryState === 'unread') delivery.unread += 1;
        else if (projection.deliveryState === 'claimed') delivery.claimed += 1;
        // Exhaustive over MonitorDeliveryState: the remaining case is
        // 'acknowledged' (an explicit === check trips no-unnecessary-condition).
        else delivery.acknowledged += 1;
      }

      monitors.push({
        id: monitor.id,
        displayName: monitor.displayName,
        sourceName,
        urgency: monitor.frontmatter.urgency,
        valid,
        ...(valid ? {} : { validationError: validationErrors.join('; ') }),
        ...(lastObservedAt ? { lastObservedAt } : {}),
        neverObserved,
        due: schedule.due,
        nextDueAt,
        cadence: describeCadence(
          monitor.frontmatter.watch,
          schedule.nextPollMs,
        ),
        ...(lastEventAt ? { lastEventAt } : {}),
        delivery,
      });
    }

    return {
      generatedAt: now,
      monitorsDir,
      workspacePath,
      monitorsDirExists,
      monitors,
      invalidCount,
      duplicateIds: scan.duplicateIds,
      parseErrors,
      leadSessions,
      hasLeadSession: leadSessions.length > 0,
    };
  }

  acknowledgeSession(sessionId: string, eventIds?: string[]): void {
    const ids =
      eventIds ?? this.store.unreadEventsForSession(sessionId).map((e) => e.id);
    this.store.acknowledgeEvents(sessionId, ids);
    this.refreshHookState(sessionId);
  }

  /**
   * Retract a caller-supplied SET of a synthetic object's events by id, across
   * every session they projected into (issue #407): removes the shared
   * `monitor_events` rows, their per-recipient projections, snapshots, and the
   * affected sessions' seeded cursors, then refreshes each affected session's
   * hook-state so its cached unread counts drop the retracted events.
   *
   * Used by `verify --use-workspace-daemon` to erase the create/delete events its
   * own throwaway scratch file generated against the live workspace daemon, so a
   * later session never sees a spurious `File deleted: agentmonitors-verify-…`.
   * The caller passes the exact event ids it observed for that file (it created
   * and deleted it), so a real event sharing the same watched path is never
   * swept. Never point this at real monitored events.
   *
   * @returns the number of `monitor_events` rows removed.
   */
  retractObjectEvents(input: {
    workspacePath?: string | null;
    monitorId: string;
    objectKey: string;
    eventIds: string[];
  }): number {
    const { removedEventIds, affectedSessionIds } =
      this.store.retractObjectEvents(input);
    for (const sessionId of affectedSessionIds) {
      this.refreshHookState(sessionId);
    }
    return removedEventIds.length;
  }

  /**
   * Install a durable, self-expiring tombstone for a synthetic object key and
   * retract any events it already has, so a `verify --use-workspace-daemon` run
   * can prove delivery and then clean up its OWN scratch file WITHOUT blocking a
   * full poll interval for the file's deletion to re-materialize (issue #414 —
   * the #407 wait doubled verify's runtime). verify calls this the instant it has
   * proven delivery: the create event is retracted now, and the tombstone makes
   * the daemon auto-retract the pending `File deleted: agentmonitors-verify-…` on
   * the very tick it appears (see {@link applyObjectSuppressions}), before any
   * later session can observe it — preserving #407's no-leak guarantee.
   *
   * MUST only target a synthetic object key no real monitored file shares
   * (verify's `…/agentmonitors-verify-<token><ext>` scratch path): the retraction
   * and the daemon-side sweep both delete BY KEY, so a real event at a genuine
   * watched path must never be passed here.
   *
   * @returns the number of already-materialized events retracted immediately.
   */
  suppressObjectEvents(input: {
    workspacePath?: string | null;
    monitorId: string;
    objectKey: string;
    /** How long the tombstone stays active (ms) before the daemon purges it. */
    ttlMs: number;
    now?: Date;
  }): number {
    // Trust-boundary guard (issue #418): the durable tombstone + by-KEY sweep this
    // installs is safe ONLY for a synthetic verify scratch key that no real
    // monitored file ever shares. Reject anything else so a real event at a genuine
    // watched path can never be tombstoned and swept by key — which would eat a
    // later, genuine event at that very path. A literal watched file verify created
    // must be cleaned up via the id-scoped {@link retractObjectEvents} instead.
    if (!isVerifyScratchObjectKey(input.objectKey)) {
      throw new Error(
        `suppressObjectEvents refuses a non-synthetic object key "${input.objectKey}": the durable tombstone + by-key sweep is only safe for a verify scratch path (agentmonitors-verify-<token>). Retract a real object's events by id (retractObjectEvents) instead.`,
      );
    }
    const now = input.now ?? new Date();
    // Normalize the workspace scope ONCE and apply the SAME value to both the
    // durable tombstone and the immediate retraction (issue #418 review). An
    // omitted `workspacePath` means the workspace-agnostic (NULL) scope, NOT "every
    // workspace": passing `null` (never `undefined`) to `retractObjectEventsByKey`
    // keeps this initial deletion scoped to exactly the rows the tombstone will
    // later match, so it can never sweep another workspace's events. The unscoped
    // (all-workspace) by-key sweep remains an explicit opt-in only a direct
    // `retractObjectEventsByKey` caller can request.
    const workspacePath = input.workspacePath ?? null;
    this.store.upsertObjectSuppression({
      monitorId: input.monitorId,
      objectKey: input.objectKey,
      workspacePath,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
    });
    const { removedEventIds, affectedSessionIds } =
      this.store.retractObjectEventsByKey({
        monitorId: input.monitorId,
        objectKey: input.objectKey,
        workspacePath,
      });
    for (const sessionId of affectedSessionIds) {
      this.refreshHookState(sessionId);
    }
    return removedEventIds.length;
  }

  /**
   * Runtime-tick sweep (issue #414): retract any events whose object key is under
   * an active {@link objectEventSuppressions} tombstone, then purge expired
   * tombstones. Runs at the END of every {@link tick}, so a scratch file's
   * deletion event — materialized earlier in the SAME tick — is erased before the
   * tick returns and thus before any later session can claim it. Purging on the
   * same pass means an interrupted verify run (or a delete that never came)
   * leaves nothing permanent once its short TTL lapses.
   */
  private applyObjectSuppressions(now: Date, workspacePath: string): void {
    for (const suppression of this.store.activeObjectSuppressions(
      workspacePath,
      now,
    )) {
      const { affectedSessionIds } = this.store.retractObjectEventsByKey({
        monitorId: suppression.monitorId,
        objectKey: suppression.objectKey,
        workspacePath: suppression.workspacePath,
      });
      for (const sessionId of affectedSessionIds) {
        this.refreshHookState(sessionId);
      }
    }
    this.store.purgeExpiredObjectSuppressions(now);
  }

  /**
   * Claim the pending delivery for a session at a lifecycle point (002 §9) —
   * decide the delivery and apply it (mark claimed) in one atomic step. This is
   * the immediate, single-call path the hook transport uses.
   *
   * The reserve → commit path ({@link reserveDelivery}/{@link commitDelivery})
   * splits the same decision from its persistence, so a transport that must
   * surface the claim over a fallible channel can defer the claim until the push
   * succeeds (006 §4, issue #300); this method is exactly `decide → apply`.
   *
   * `maxEvents` bounds how many delivered events a **`turn-interruptible`
   * high-urgency** claim actually surfaces AND claims (issue #299). A transport
   * whose surface is length-bounded — the hook-deliver transport renders into a
   * 4000-char `additionalContext` (006 §5.1) — first sizes how many whole event
   * blocks fit (via {@link previewSettledHighDelivery}) and passes that count, so
   * we claim ONLY the events it renders and leave the truncated-away remainder
   * pending (`first_notified_at` NULL) to re-deliver at the next context event.
   * `undefined` (the default, and every non-capped caller such as the channel
   * transport) claims the full delivered set exactly as before. It has no effect
   * on the reminder / low / recap branches, which inject no per-event bodies
   * (reminders) or already self-heal by re-showing all unread (recap, 006 §5.5).
   */
  claimDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
    maxEvents?: number,
  ): DeliveryClaim | null {
    this.store.touchSession(sessionId);
    const decision = this.decideDelivery(sessionId, lifecycle, maxEvents);
    if (!decision) return null;
    this.applyDelivery(decision);
    return decision.claim;
  }

  /**
   * Reserve — but do NOT yet claim — the pending delivery for a session at a
   * lifecycle point (006 §4, issue #300). Returns the SAME {@link DeliveryClaim}
   * a {@link claimDelivery} would (rendered from the identical decision) plus an
   * opaque `reservationId`, and LEASES the underlying rows so the hook transport
   * will not double-surface them (the cross-transport dedup boundary of 006 §4.5,
   * now enforced from reserve time). Crucially it performs **no** store mutation:
   * `first_notified_at` ("was surfaced") is stamped only when the caller
   * {@link commitDelivery} after a successful surface. On a failed/disconnected
   * push the caller {@link releaseDelivery}, returning the rows to the hook path.
   * If the caller does neither, the lease self-expires and the rows re-deliver.
   *
   * This is what lets the channel transport avoid consuming a delivery on a
   * transient MCP disconnect: it reserves, pushes, and only then commits.
   */
  reserveDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
    maxEvents?: number,
  ): DeliveryReservation | null {
    this.store.touchSession(sessionId);
    const decision = this.decideDelivery(sessionId, lifecycle, maxEvents);
    if (!decision) return null;
    const reservationId = this.reservations.add({
      sessionId: decision.sessionId,
      candidates: decision.candidates,
      isRecap: decision.isRecap,
      claim: decision.claim,
    });
    // Refresh the hook-state projection so it reflects the lease immediately: the
    // reserved rows are now hidden from `pendingForClaim`, so the file stops
    // advertising them as claimable while the push is in flight (issue #300).
    // This writes only the derived hook-state cache — it does NOT claim the rows.
    this.refreshHookState(decision.sessionId);
    return { reservationId, claim: decision.claim };
  }

  /**
   * Commit a reservation from {@link reserveDelivery} after its claim was
   * surfaced (006 §4, issue #300): apply the deferred claim (mark the reserved
   * rows claimed, "was surfaced" — BP2, not acknowledged), returning the claim.
   * Returns `null` if the reservation is unknown or already expired — the rows
   * were never permanently consumed, so a stale commit is a safe no-op (they may
   * have already re-delivered via the hook path).
   */
  commitDelivery(reservationId: string): DeliveryClaim | null {
    const plan = this.reservations.take(reservationId);
    if (!plan) return null;
    this.applyDelivery(plan);
    return plan.claim;
  }

  /**
   * Release a reservation from {@link reserveDelivery} WITHOUT claiming (006 §4,
   * issue #300): the push failed or disconnected, so drop the lease and return
   * the rows to `pending`, where the hook transport (or the next channel poll)
   * re-delivers them. A no-op for an unknown/expired reservation.
   */
  releaseDelivery(reservationId: string): void {
    const plan = this.reservations.remove(reservationId);
    // Refresh the hook-state projection so the released rows are advertised as
    // pending again immediately (they returned to the hook path) — the mirror of
    // the refresh `reserveDelivery` does when the lease is taken (issue #300).
    if (plan) this.refreshHookState(plan.sessionId);
  }

  /**
   * Pending (not-yet-claimed) events for a session's claim decision, MINUS any
   * currently leased by an outstanding reservation (006 §4, issue #300). Leased
   * rows are hidden from the claim decision so a concurrent hook claim does not
   * surface an event the channel is mid-surfacing (cross-transport dedup, 006
   * §4.5). A released/expired lease restores them on the next call.
   */
  private pendingForClaim(
    sessionId: string,
    urgency?: Urgency,
  ): MonitorEventRecord[] {
    const pending = this.store.pendingEventsForSession(sessionId, urgency);
    const reserved = this.reservations.reservedEventIds(sessionId);
    if (reserved.size === 0) return pending;
    return pending.filter((event) => !reserved.has(event.id));
  }

  /**
   * Decide the pending delivery for a session at a lifecycle point WITHOUT
   * mutating the store (issue #300). Mirrors the prior `claimDelivery` branch
   * logic exactly, but (a) reads pending sets through {@link pendingForClaim} so
   * leased rows are excluded, and (b) renders the claim from the PURE
   * {@link computeNetCollapseView} decision — never the mutating collapse. The
   * rendered `message`/`events` read only event fields + interpret digests, which
   * the collapse mutation does not touch (it re-anchors `diff_text` for later
   * `events list`/`monitor explain` only), so this renders byte-identically to
   * the previous in-place claim. {@link applyDelivery} performs the deferred
   * mutation.
   */
  private decideDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
    maxEvents?: number,
  ): DeliveryDecision | null {
    const now = new Date();
    const unreadCounts = {
      low: this.store.unreadEventsForSession(sessionId, 'low').length,
      normal: this.store.unreadEventsForSession(sessionId, 'normal').length,
      high: this.store.unreadEventsForSession(sessionId, 'high').length,
    };
    const sessionUnreadCounts = {
      ...unreadCounts,
      total: unreadCounts.low + unreadCounts.normal + unreadCounts.high,
    };

    if (lifecycle === 'turn-interruptible') {
      const unreadNormal = this.store.unreadEventsForSession(
        sessionId,
        'normal',
      );
      const highUnread = this.pendingForClaim(sessionId, 'high');
      const settledHigh = highUnread.filter(
        (event) =>
          now.getTime() - event.createdAt.getTime() >=
          DEFAULT_HIGH_URGENCY_SETTLE_MS,
      );
      if (settledHigh.length > 0) {
        // Per-recipient `net` collapse (G10 PR-B, 002 §1.1.7): deliver only the
        // newest event per object for a `net` monitor; the older intermediates
        // are folded away and (at apply time) recorded claimed-but-suppressed.
        // The decision is the pure {@link computeNetCollapseView}; the mutating
        // collapse runs only in {@link applyDelivery} over the surfaced groups.
        const representatives = computeNetCollapseView(settledHigh).delivered;

        // Cap the surfaced set to what a length-bounded transport asked for
        // (issue #299). We CLAIM only the events actually rendered, never the
        // truncated-away remainder — so a session with more pending high-urgency
        // work than fits in one context injection keeps re-delivering the rest
        // at each subsequent context event instead of silently losing it.
        const limit =
          maxEvents === undefined
            ? representatives.length
            : Math.min(representatives.length, Math.max(1, maxEvents));
        const surfacedReps = representatives.slice(0, limit);

        // Restrict the surfaced set to ONLY the surfaced groups — each surfaced
        // representative's full set of settled events (the representative plus
        // that object's older intermediates). Deferred groups are excluded
        // entirely, so nothing about them is re-anchored, suppressed, or claimed
        // at apply time; they re-deliver intact next context event.
        const surfacedKeys = new Set(surfacedReps.map(netCollapseGroupKey));
        const surfacedCandidates = settledHigh.filter((event) =>
          surfacedKeys.has(netCollapseGroupKey(event)),
        );

        // The delivered subset — identical to what the mutating collapse would
        // return (its return value IS `computeNetCollapseView(...).delivered`).
        // Rendering from this pure view keeps decide side-effect-free while
        // producing the same content the eventual claim surfaces.
        const surfacedHigh =
          computeNetCollapseView(surfacedCandidates).delivered;

        const digests = this.store.interpretDigestsForSession(
          sessionId,
          surfacedHigh.map((event) => event.id),
        );
        return {
          sessionId,
          candidates: surfacedCandidates,
          isRecap: false,
          claim: {
            sessionId,
            lifecycle,
            mode: 'delivery',
            urgency: 'high',
            unreadCounts: sessionUnreadCounts,
            message: summarizeEvents(
              surfacedHigh.map((event) => ({
                title: event.title,
                summary: recipientSummary(event, digests),
              })),
            ),
            events: surfacedHigh.map((event) =>
              toDeliveryEventSummary(event, digests),
            ),
          },
        };
      }

      const normalPending = this.pendingForClaim(sessionId, 'normal');
      if (
        normalPending.length > 0 &&
        normalPending.length === unreadNormal.length
      ) {
        return {
          sessionId,
          candidates: normalPending,
          isRecap: false,
          claim: {
            sessionId,
            lifecycle,
            mode: 'delivery',
            urgency: 'normal',
            unreadCounts: sessionUnreadCounts,
            message: NORMAL_INBOX_PROMPT,
            events: [],
          },
        };
      }

      return null;
    }

    const unreadLow = this.store.unreadEventsForSession(sessionId, 'low');
    const lowUnread = this.pendingForClaim(sessionId, 'low');
    const shouldSendLow =
      lowUnread.length > 0 && lowUnread.length === unreadLow.length;

    if (lifecycle === 'turn-idle' && shouldSendLow) {
      return {
        sessionId,
        candidates: lowUnread,
        isRecap: false,
        claim: {
          sessionId,
          lifecycle,
          mode: 'delivery',
          urgency: 'low',
          unreadCounts: sessionUnreadCounts,
          message: IDLE_INBOX_PROMPT,
          events: [],
        },
      };
    }

    const unread = this.store.unreadEventsForSession(sessionId);
    if (lifecycle === 'post-compact' && unread.length > 0) {
      // Per-recipient `net` collapse (G10 PR-B, 002 §1.1.7) over the FULL unread
      // set, then recap only the delivered (post-collapse) tail. The full set is
      // claimed at apply time so the cursor advances and suppressed intermediates
      // are consumed. Recap reads all UNREAD (not pending), so a leased row is
      // still recapped — a lease is not acknowledgement, and recap re-shows unread
      // until acked (006 §5.5).
      const deliveredUnread = computeNetCollapseView(unread).delivered;
      const recapSlice = deliveredUnread.slice(-MAX_RECAP_EVENTS);
      const digests = this.store.interpretDigestsForSession(
        sessionId,
        recapSlice.map((event) => event.id),
      );
      const message = [
        'Recap of recent AgentMon activity since your last recap:',
        summarizeEvents(
          recapSlice.map((event) => ({
            title: event.title,
            summary: recipientSummary(event, digests),
          })),
        ),
        `Run \`${fullHistoryCommand(sessionId)}\` for recent history.`,
        `Run \`${unreadDetailsCommand(sessionId)}\` for unread details.`,
      ].join('\n');
      return {
        sessionId,
        candidates: unread,
        isRecap: true,
        claim: {
          sessionId,
          lifecycle,
          mode: 'recap',
          unreadCounts: sessionUnreadCounts,
          message,
          events: recapSlice.map((event) =>
            toDeliveryEventSummary(event, digests),
          ),
        },
      };
    }

    return null;
  }

  /**
   * Persist the mutation a {@link DeliveryDecision} deferred (issue #300): the
   * per-recipient `net` collapse (re-anchor the surviving delta + record
   * net-suppression for the intermediates) over the full candidate set, then mark
   * that set claimed (`first_notified_at` = "was surfaced", BP2 — NOT
   * acknowledged), advance the recap cursor for a recap, and refresh hook state.
   * Called by {@link claimDelivery} immediately and by {@link commitDelivery}
   * after a successful surface. The decision already rendered from the pure
   * collapse view, so this ignores `collapseNetForClaim`'s return.
   */
  private applyDelivery(decision: {
    sessionId: string;
    candidates: MonitorEventRecord[];
    isRecap: boolean;
    claim: DeliveryClaim;
  }): void {
    const { sessionId, candidates, claim } = decision;
    this.store.collapseNetForClaim(sessionId, candidates);
    this.store.markClaimed(
      sessionId,
      candidates.map((event) => event.id),
      claim.lifecycle,
    );
    if (decision.isRecap) this.store.updateSessionRecap(sessionId);
    this.refreshHookState(sessionId);
  }

  /**
   * Non-mutating preview of the settled high-urgency events a
   * `turn-interruptible` {@link claimDelivery} WOULD surface right now, in
   * delivery order (issue #299). A length-bounded transport (the hook-deliver
   * transport, 006 §5.1) calls this FIRST to size how many whole event blocks
   * fit under its context cap, then passes that count back as `claimDelivery`'s
   * `maxEvents` so it claims exactly the events it renders. Returns `[]` when no
   * settled high delivery is pending (the caller then falls through to an
   * ordinary claim for the reminder / low path). Reads only — it never claims,
   * suppresses, re-anchors a delta, or refreshes hook state (contrast
   * {@link claimDelivery}), so previewing does not consume a delivery.
   */
  previewSettledHighDelivery(sessionId: string): DeliveryEventSummary[] {
    const now = new Date();
    // Exclude rows leased by an outstanding reservation (issue #300) so the
    // hook transport sizes and claims exactly what a real claim would decide —
    // never an event the channel is mid-surfacing.
    const highUnread = this.pendingForClaim(sessionId, 'high');
    const settledHigh = highUnread.filter(
      (event) =>
        now.getTime() - event.createdAt.getTime() >=
        DEFAULT_HIGH_URGENCY_SETTLE_MS,
    );
    if (settledHigh.length === 0) return [];
    // Same pure collapse DECISION the claim uses, so the previewed set is exactly
    // what a full claim would surface — only without persisting the collapse.
    const { delivered } = computeNetCollapseView(settledHigh);
    const digests = this.store.interpretDigestsForSession(
      sessionId,
      delivered.map((event) => event.id),
    );
    return delivered.map((event) => toDeliveryEventSummary(event, digests));
  }

  /**
   * Non-mutating diagnosis of why a `claimDelivery(sessionId, lifecycle)` call
   * would (or would not) surface anything right now (issue #334). Reads only —
   * it never claims, suppresses, re-anchors a delta, or refreshes hook state
   * (contrast {@link claimDelivery}) — so diagnosing never consumes a delivery.
   *
   * Mirrors {@link claimDelivery}'s precedence exactly so the reported holds
   * match what a real claim would decide: at `turn-interruptible`, the
   * high-urgency settle-window hold is reported whenever pending high work is
   * entirely unsettled; the normal-reminder hold is evaluated only when high
   * would not already preempt this turn's delivery (i.e. NO settled high
   * work exists — settled high work would deliver instead and the normal
   * reminder would not be consulted). At `turn-idle`, only the low-reminder hold is
   * evaluated. `post-compact` (the recap lifecycle) has no coalescing/settle
   * guard to explain — recap fires whenever `unreadCounts.total > 0` — so no
   * band-specific holds are computed for it.
   */
  diagnoseHookDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
  ): HookDeliveryDiagnosis {
    const now = new Date();
    const unreadCounts = {
      low: this.store.unreadEventsForSession(sessionId, 'low').length,
      normal: this.store.unreadEventsForSession(sessionId, 'normal').length,
      high: this.store.unreadEventsForSession(sessionId, 'high').length,
    };
    const sessionUnreadCounts = {
      ...unreadCounts,
      total: unreadCounts.low + unreadCounts.normal + unreadCounts.high,
    };

    const holds: HookDeliveryHold[] = [];
    if (lifecycle === 'turn-interruptible') {
      // Lease-aware (issue #300): exclude rows reserved by an in-flight channel
      // push so this diagnosis matches what a real claim would surface.
      const pendingHigh = this.pendingForClaim(sessionId, 'high');
      const settleHold = classifySettleWindowHold(
        pendingHigh.map((event) => event.createdAt),
        unreadCounts.high,
        now,
        DEFAULT_HIGH_URGENCY_SETTLE_MS,
      );
      if (settleHold) holds.push(settleHold);

      // Same precedence claimDelivery uses: normal is only relevant when no
      // settled high work exists to preempt it this turn.
      const settledHighCount = pendingHigh.filter(
        (event) =>
          now.getTime() - event.createdAt.getTime() >=
          DEFAULT_HIGH_URGENCY_SETTLE_MS,
      ).length;
      if (settledHighCount === 0) {
        const pendingNormal = this.pendingForClaim(sessionId, 'normal').length;
        const normalHold = classifyReminderHold(
          'normal',
          unreadCounts.normal,
          pendingNormal,
        );
        if (normalHold) holds.push(normalHold);
      }
    } else if (lifecycle === 'turn-idle') {
      const pendingLow = this.pendingForClaim(sessionId, 'low').length;
      const lowHold = classifyReminderHold('low', unreadCounts.low, pendingLow);
      if (lowHold) holds.push(lowHold);
    }

    return {
      sessionId,
      lifecycle,
      unreadCounts: sessionUnreadCounts,
      holds,
    };
  }

  async tick(
    monitorsDir: string,
    workspacePath = monitorsDir,
  ): Promise<RuntimeTickResult> {
    const result = await scanMonitors(monitorsDir);
    this.assertNoDuplicateIds(result, monitorsDir);

    const now = new Date();
    const acc: TickAccumulator = {
      evaluated: [],
      emittedEventIds: [],
      erroredObservations: [],
      skippedMonitors: [],
    };

    // Per-session dormancy (002 §6.2 / 007 §4.4): before evaluating anything,
    // transition stale active sessions to dormant and reap their ephemeral
    // monitors, so a session that vanished without an explicit close still
    // releases its session-scoped watches this tick (and they never fire below).
    // The scanned monitors are threaded in so the reap can size an orphan verify
    // tombstone from the object's own monitor cadence (issue #418).
    const monitorsById = new Map<string, MonitorDefinition>(
      result.monitors.map((parsed) => [parsed.monitor.id, parsed.monitor]),
    );
    this.reapDormantSessions(now, workspacePath, monitorsById);

    // Persistent monitors (directory-authored). An unknown source is a hard tick
    // failure — the author can fix the file.
    for (const parsed of result.monitors) {
      const monitor = parsed.monitor;
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      if (!source) {
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${sourceName}".`,
        );
      }
      await this.evaluateMonitorOnTick(
        monitor,
        source,
        now,
        workspacePath,
        acc,
      );
    }

    // Ephemeral monitors (agent-declared, session-scoped) flow the IDENTICAL
    // pipeline (007 §4.6, AP7): each is rebuilt into a MonitorDefinition and run
    // through the SAME `evaluateMonitorOnTick`, threading its declaring session
    // id so materialized events project ONLY to that session (007 §4.6 isolation).
    // Only monitors whose declaring session is still active are returned.
    for (const record of this.store.listActiveEphemeralMonitors(
      workspacePath,
    )) {
      // A single bad ephemeral record must never abort the tick for every other
      // session's monitors. Unlike a scanned monitor (whose unknown source /
      // parse failure is an author-fixable, tick-aborting error), an ephemeral
      // monitor cannot be edited — so any failure resolving its source or
      // rebuilding its definition is recorded as errored and skipped.
      try {
        const source = this.registry.get(record.sourceName);
        if (!source) {
          acc.erroredObservations.push({
            monitorId: record.id,
            message: `references unknown source "${record.sourceName}".`,
          });
          continue;
        }
        const monitor = this.ephemeralRecordToMonitor(record);
        await this.evaluateMonitorOnTick(
          monitor,
          source,
          now,
          workspacePath,
          acc,
          record.sessionId,
        );
      } catch (error) {
        acc.erroredObservations.push({
          monitorId: record.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Object-event suppression sweep (issue #414): retract any events whose key
    // is under an active tombstone — crucially a scratch file's deletion event,
    // materialized above in THIS tick, is erased before the tick returns (so no
    // later session ever claims it) — then purge expired tombstones. Runs after
    // evaluation but before session refresh so the refresh reflects the removals.
    this.applyObjectSuppressions(now, workspacePath);

    this.refreshWorkspaceSessions(workspacePath);

    return {
      evaluatedMonitors: acc.evaluated,
      emittedEventIds: acc.emittedEventIds,
      erroredObservations: acc.erroredObservations,
      skippedMonitors: acc.skippedMonitors,
    };
  }

  /**
   * Evaluate ONE monitor on a tick — shared by the persistent (directory) and
   * ephemeral (007 §4) paths so both flow the IDENTICAL scheduling → observe →
   * notify → materialize logic (AP7). Mutates the passed {@link TickAccumulator}
   * exactly as the old inlined loop did. `ephemeralSessionId`, when present,
   * restricts materialized events to that declaring session (007 §4.6 isolation);
   * it is `undefined` for persistent monitors (project into all lead sessions).
   */
  private async evaluateMonitorOnTick(
    monitor: MonitorDefinition,
    source: ObservationSource,
    now: Date,
    workspacePath: string,
    acc: TickAccumulator,
    ephemeralSessionId?: string,
  ): Promise<void> {
    const sourceName = monitor.frontmatter.watch.type;

    // A monitor with an active continuous watcher is driven by that watcher;
    // skip its one-shot observe() so it is not processed twice (G5).
    if (this.activeWatchers.has(monitor.id)) return;

    const schedule = this.scheduleForMonitor(monitor, now, workspacePath);
    if (schedule.error) {
      // Isolate a scheduling failure (issue #297) — e.g. an invalid IANA
      // timezone — exactly like an observe() failure below: record it on the
      // tick result and as an 'errored' observation-history row, then skip this
      // monitor for the tick. A single bad monitor must never abort evaluation
      // of the rest (AP-per-monitor isolation).
      acc.erroredObservations.push({
        monitorId: monitor.id,
        message: schedule.error,
      });
      try {
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath,
          sourceName,
          result: 'errored',
          observationData: { error: schedule.error },
        });
      } catch {
        // best-effort audit — ignore write failures
      }
      return;
    }
    if (!schedule.due) {
      // Record skipped monitors so callers can distinguish "not yet due" from
      // "no monitors found" (issue #152). nextDueAt is computed from the same
      // scheduling decision — single source of truth, never recomputed.
      // Fall back to `now` (not epoch 0) when lastObservationAt is absent so
      // the computed nextDueAt stays meaningful even under partial/missing state.
      const monitorStateForSkip = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      const lastObservationAt =
        monitorStateForSkip.lastObservationAt?.getTime() ?? now.getTime();
      const nextDueAt = new Date(lastObservationAt + schedule.nextPollMs);
      acc.skippedMonitors.push({ monitorId: monitor.id, nextDueAt });

      // Special case for scheduled-rollup (002 §4.4): the rollup window must
      // be evaluated on every tick regardless of the source polling interval.
      // A monitor whose interval has not yet elapsed must still flush its
      // accumulated batch when the delivery window opens, so we dispatch
      // `dispatchRollup` with zero new observations to trigger a window check.
      if (monitor.frontmatter.notify?.strategy === 'rollup') {
        // dispatchRollup mutates nextState in-place, so we pass the spread
        // state and always persist the result — `rollupLastFiredMinute` may
        // have been updated even when no observations were flushed.
        const rollupNotifyState = { ...monitorStateForSkip.notifyState };
        // dispatchRollup() evaluates `notify.timezone` via cronMatchesDate,
        // which can throw for an invalid IANA zone exactly like the schedule
        // watch case above (issue #297). This call sits outside the
        // observe()/ingest() try/catches (this whole branch runs on the
        // NOT-due path), so it needs its own isolation: a bad rollup timezone
        // must not abort the tick for every other monitor either.
        let rollupDispatch: NotifyDispatchResult;
        try {
          rollupDispatch = this.dispatchRollup(
            monitor,
            [],
            now,
            rollupNotifyState,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          acc.erroredObservations.push({ monitorId: monitor.id, message });
          try {
            this.store.recordObservationHistory({
              monitorId: monitor.id,
              workspacePath,
              sourceName,
              result: 'errored',
              observationData: { error: message },
            });
          } catch {
            // best-effort audit — ignore write failures
          }
          return;
        }
        this.store.setMonitorState(monitor.id, workspacePath, {
          sourceState: monitorStateForSkip.sourceState,
          notifyState: rollupDispatch.nextState,
          lastObservationAt: monitorStateForSkip.lastObservationAt ?? null,
        });
        // Route the flushed batch through the SAME span materialization as
        // `ingest()` (issue #180) so the not-due path records the `triggered`
        // observation_history row (002 §10.7) and writes every emitted
        // observation onto the shared chain — the due path already does both.
        // (The `net` collapse is per-recipient at claim time; G10 PR-B.)
        // Only invoke it when the window actually flushed something: an empty
        // window check runs every not-due tick and must NOT flood the audit
        // trail with `no-change` rows. `observed: 0` because this path
        // dispatches no NEW observations — only the already-accumulated batch.
        if (rollupDispatch.emitted.length > 0) {
          try {
            acc.emittedEventIds.push(
              ...(await this.materializeSpan(monitor, rollupDispatch.emitted, {
                observed: 0,
                workspacePath,
                ...(ephemeralSessionId !== undefined
                  ? { ephemeralSessionId }
                  : {}),
              })),
            );
          } catch {
            // best-effort: materialization failure must not abort the tick
          }
        }
      }

      return;
    }

    acc.evaluated.push(monitor.id);

    // Two separate try/catch blocks so observe() failures and ingest()
    // failures are handled independently (issue #46):
    //
    // Block 1 — observe(): if observe() throws, we skip ingest() entirely.
    // Skipping ingest() means setMonitorState() is never called, which is
    // what preserves the previously-persisted sourceState so the next tick's
    // diff spans from the last good baseline rather than an empty state.
    let observationResult;
    try {
      const monitorState = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      observationResult = await source.observe(
        watchConfig(monitor.frontmatter.watch),
        {
          previousState: monitorState.sourceState,
          now,
          workspacePath,
        },
      );
    } catch (observeError) {
      // observe() failed: record errored outcome (best-effort) and skip
      // this monitor entirely for this tick. ingest() is NOT called, which
      // preserves sourceState as described above.
      const message =
        observeError instanceof Error
          ? observeError.message
          : String(observeError);
      // Same source as the audit row below: surface it on the tick result so
      // `daemon once`/`daemon run` can report the failure instead of a bare
      // `emitted 0`.
      acc.erroredObservations.push({ monitorId: monitor.id, message });
      try {
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath,
          sourceName,
          result: 'errored',
          observationData: {
            error: message,
          },
        });
      } catch {
        // best-effort audit — ignore write failures
      }
      return;
    }

    // Block 2 — ingest(): ingest() now isolates per-observation materialization
    // failures internally (see ingest()), so it should not normally throw.
    // This outer catch is a defence-in-depth safety net: if ingest() itself
    // throws (e.g. setMonitorState fails), record errored best-effort and
    // continue so the tick is not aborted.
    try {
      acc.emittedEventIds.push(
        ...(await this.ingest(monitor, observationResult.observations, now, {
          workspacePath,
          ...(observationResult.nextState !== undefined
            ? { nextSourceState: { value: observationResult.nextState } }
            : {}),
          ...(observationResult.outcome
            ? { sourceOutcome: observationResult.outcome }
            : {}),
          ...(ephemeralSessionId !== undefined ? { ephemeralSessionId } : {}),
        })),
      );
    } catch (ingestError) {
      const message =
        ingestError instanceof Error
          ? ingestError.message
          : String(ingestError);
      acc.erroredObservations.push({ monitorId: monitor.id, message });
      try {
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath,
          sourceName,
          result: 'errored',
          observationData: {
            error: message,
          },
        });
      } catch {
        // best-effort audit — ignore write failures
      }
    }
  }

  /**
   * Funnel a batch of observations through notify dispatch, persist the updated
   * monitor state, and materialize the emitted observations into durable events.
   * Shared by the tick loop (one-shot `observe()`) and the continuous watcher
   * (`watch()`), so both paths apply identical notify/throttle/debounce semantics
   * and event materialization.
   *
   * `nextSourceState` is provided only by `observe()` (which returns the next
   * source state); the watcher omits it, since a long-lived `watch()` owns its
   * own in-memory state. The watcher advances the persisted `sourceState` out of
   * band via the `context.checkpoint` callback (002 §2.4, `writeCheckpoint`),
   * serialized with this `ingest()` on the per-watcher chain — not through this
   * path.
   *
   * **Ordering guarantee (G14, 002 §1.1.8):** all durable monitor-state mutation
   * (notify state via `setMonitorState`, per-recipient event rows via
   * `insertEvent`, and snapshot rows via `saveSnapshot`) completes synchronously
   * before the first `await` — the Interpret shell-out. If the process dies mid-
   * Interpret, the projected rows survive and are deliverable without a digest
   * (best-effort fallback, PP4). Concurrent watchers on the single-threaded event
   * loop therefore never interleave a monitor's durable-state mutations with
   * another monitor's, even though `ingest()` is now `async`.
   */
  private async ingest(
    monitor: MonitorDefinition,
    observations: Observation[],
    now: Date,
    options: {
      workspacePath: string;
      nextSourceState?: { value: unknown };
      sourceOutcome?: 'rebaselined' | 'no-files-matched';
      /**
       * Present only for an ephemeral monitor (007 §4): materialized events
       * project into ONLY this declaring session, never a sibling lead session
       * in the same workspace (007 §4.6 isolation).
       */
      ephemeralSessionId?: string;
    },
  ): Promise<string[]> {
    // Pre-filter: a `payload.form: structured` CEL gate that evaluates `false`
    // suppresses delivery entirely (002 §1.1.6). This check MUST run BEFORE
    // dispatchNotify so that suppressed observations never advance notify state
    // and are never counted as emitted in the audit history row.  Running it
    // inside processObservation (after dispatch) was incorrect: the history row
    // would say `triggered` even though no event was ever materialized.
    const passedObservations = observations.filter((obs) => {
      const shaped = shapeObservation(obs, now, {
        shape: monitor.frontmatter.shape,
        payload: monitor.frontmatter.payload,
      });
      return !shaped.suppressed;
    });

    const monitorState = this.store.getMonitorState(
      monitor.id,
      options.workspacePath,
    );
    const dispatch = this.dispatchNotify(
      monitor,
      passedObservations,
      now,
      monitorState.notifyState,
    );

    this.store.setMonitorState(monitor.id, options.workspacePath, {
      sourceState: options.nextSourceState
        ? options.nextSourceState.value
        : monitorState.sourceState,
      notifyState: dispatch.nextState,
      lastObservationAt: now,
    });

    // Audit-history recording and per-observation materialization are shared
    // with the not-due rollup flush in tick() via materializeSpan() (issue
    // #180): both the source-interval-elapsed (`ingest`) path and the
    // window-fires-on-a-not-due-tick path write the `triggered` history row
    // (002 §10.7) and record every emitted observation on the shared chain.
    // The `net` collapse (002 §1.1.7) is NO LONGER applied here — it is a
    // per-recipient claim-time decision (G10 PR-B); see materializeSpan().
    return await this.materializeSpan(monitor, dispatch.emitted, {
      observed: observations.length,
      workspacePath: options.workspacePath,
      ...(options.sourceOutcome
        ? { sourceOutcome: options.sourceOutcome }
        : {}),
      ...(options.ephemeralSessionId !== undefined
        ? { ephemeralSessionId: options.ephemeralSessionId }
        : {}),
    });
  }

  /**
   * Materialize a dispatched catch-up span into durable events, shared by BOTH
   * flush paths so they can never drift (issue #180):
   *
   *  - `ingest()` — the source-interval-elapsed ("due") path, and
   *  - the not-due rollup branch in `tick()` — where the source poll interval
   *    has NOT elapsed but the rollup delivery window opens. Per 002 §4.4 this
   *    is the *normal* operating mode for a rollup monitor whose `watch.interval`
   *    is relaxed to match the delivery window.
   *
   * The helper performs, in order:
   *
   *  1. **Audit trail (G6, 002 §10.7 / §1.1.6).** Records the monitor's outcome
   *     row, classified by what was *emitted*, not by new observations — a batch
   *     can emit a previously-held observation with zero new observations (e.g. a
   *     debounce flush, or a rollup window firing on a not-due tick), which is
   *     still a `triggered` outcome. Only `suppressed` (observations seen but
   *     held/throttled) and `no-change` (nothing seen) depend on the observation
   *     count.
   *  2. **Per-observation materialization with isolation (issue #46).** A single
   *     failing observation must not drop the already-durably-written ids of its
   *     batch-mates; on failure a best-effort `errored` history row is written
   *     for the individual observation and the loop continues. The batch-level
   *     row from step 1 is unaffected — it reflects what was *dispatched*, not
   *     what materialized.
   *
   * `observed` is the raw count of observations the source reported this tick
   * (i.e. `observations.length` from the `observe()` result, **before** notify
   * dispatch and the Shape pre-filter). It is used only for the history-row
   * classification: when `emitted > 0` the row is always `triggered` regardless
   * of `observed`; `observed` only distinguishes `suppressed` (source returned
   * something but dispatch held it) from `no-change` (source returned nothing).
   * The not-due rollup flush passes `observed: 0` because no source `observe()`
   * call was made on that tick — only the already-accumulated batch is emitted —
   * so a non-empty flush there correctly classifies as `triggered` (emitted \> 0).
   */
  private async materializeSpan(
    monitor: MonitorDefinition,
    emitted: StoredObservationEnvelope[],
    options: {
      observed: number;
      workspacePath: string;
      sourceOutcome?: 'rebaselined' | 'no-files-matched';
      /** Ephemeral-monitor declaring session (007 §4.6) — see {@link ingest}. */
      ephemeralSessionId?: string;
    },
  ): Promise<string[]> {
    const observed = options.observed;
    const emittedCount = emitted.length;
    this.store.recordObservationHistory({
      monitorId: monitor.id,
      workspacePath: options.workspacePath,
      sourceName: monitor.frontmatter.watch.type,
      result:
        emittedCount > 0
          ? 'triggered'
          : // `rebaselined` is, by contract (002 §observation_history), a tick
            // that returned ZERO observations and advanced its baseline. Guard
            // on observed === 0 so a source that mistakenly sets the diagnostic
            // while also returning (suppressed) observations can't mask a
            // genuine `suppressed` tick — the invariant is enforced here at the
            // runtime boundary, not left to source authors.
            observed === 0 && options.sourceOutcome !== undefined
            ? options.sourceOutcome
            : observed > 0
              ? 'suppressed'
              : 'no-change',
      observationData: { observed, emitted: emittedCount },
    });

    // G10 PR-B (002 §1.1.7, Decision Q3): the shared `monitor_events` chain
    // records EVERY emitted observation in order, regardless of
    // `baseline-strategy`. The `net` collapse is no longer applied here — it is
    // a PER-RECIPIENT decision deferred to claim time (`collapseNetForClaim`),
    // because an away recipient's net delta must be diffed against ITS OWN
    // cursor, not the shared snapshot baseline. Keeping every intermediate on
    // the shared chain is the incremental substrate every recipient diffs over
    // (precise over cheap). A single tick that emits multiple observations to
    // one object therefore now materializes one shared event each; the
    // claim-time per-recipient collapse delivers only the newest of them to a
    // `net` recipient (the same-tick span `collapseToNetSpan` used to fold,
    // semantics preserved on the per-recipient side).
    const emittedEventIds: string[] = [];
    for (const envelope of emitted) {
      try {
        const event = await this.processObservation({
          monitor: envelope.monitor,
          sourceName: envelope.monitor.frontmatter.watch.type,
          observation: envelope.observation,
          observedAt: envelope.observedAt,
          workspacePath: options.workspacePath,
          effectiveUrgency: envelope.effectiveUrgency,
          ...(options.ephemeralSessionId !== undefined
            ? { restrictToSessionId: options.ephemeralSessionId }
            : {}),
        });
        if (event) emittedEventIds.push(event.id);
      } catch (materializeError) {
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
            workspacePath: options.workspacePath,
            sourceName: monitor.frontmatter.watch.type,
            result: 'errored',
            observationData: {
              error:
                materializeError instanceof Error
                  ? materializeError.message
                  : String(materializeError),
            },
          });
        } catch {
          // best-effort audit — ignore write failures
        }
      }
    }
    return emittedEventIds;
  }

  private refreshWorkspaceSessions(workspacePath: string): void {
    for (const session of this.store.sessionsForWorkspace(workspacePath)) {
      this.refreshHookState(session.id);
    }
  }

  /**
   * Refuse to run on duplicate monitor ids: state is keyed by monitorId, so
   * processing aliased monitors would corrupt persisted source/notify state (SP2).
   */
  private assertNoDuplicateIds(
    result: Awaited<ReturnType<typeof scanMonitors>>,
    monitorsDir: string,
  ): void {
    if (result.duplicateIds.length === 0) return;
    const details = result.duplicateIds
      .map((dup) => `"${dup.id}" (${dup.filePaths.join(', ')})`)
      .join('; ');
    throw new Error(
      `Duplicate monitor ids in ${monitorsDir}: ${details}. ` +
        'Monitor ids are derived from folder names and must be unique within a tree.',
    );
  }

  /**
   * Start continuous watchers for every scanned monitor whose source implements
   * `watch()` (G5). Each yielded observation is funnelled through the same
   * pipeline as a ticked `observe()` (notify dispatch → materialization →
   * projection). Returns a handle whose `stop()` aborts and awaits every watcher.
   * While a watcher is active, the tick loop skips that monitor's `observe()`, so
   * it is never driven twice. Sources without `watch()` are untouched and keep
   * running on the tick loop.
   *
   * Restart-safety: watchers are re-established on restart; a `watch()` source's
   * own change-detection state is in-memory (the runtime does not persist it).
   */
  async watchMonitors(
    monitorsDir: string,
    workspacePath = monitorsDir,
    options: { onError?: (monitorId: string, error: Error) => void } = {},
  ): Promise<WatchHandle> {
    const result = await scanMonitors(monitorsDir);
    this.assertNoDuplicateIds(result, monitorsDir);

    const controllers = new Map<string, AbortController>();
    const tasks: Promise<void>[] = [];

    for (const parsed of result.monitors) {
      const monitor = parsed.monitor;
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      if (!source) {
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${sourceName}".`,
        );
      }
      if (!source.watch) continue;
      if (this.activeWatchers.has(monitor.id)) continue;

      const controller = new AbortController();
      controllers.set(monitor.id, controller);
      // Identity token for THIS watcher: `consumeWatch` releases the slot only
      // while its own token is still current, and a superseded watcher's
      // straggling checkpoint is rejected on token mismatch (002 §2.4).
      const watcherToken = Symbol(monitor.id);
      this.activeWatchers.set(monitor.id, watcherToken);

      const watch = source.watch.bind(source);
      tasks.push(
        this.consumeWatch(
          monitor,
          watch,
          workspacePath,
          controller.signal,
          watcherToken,
          options.onError,
        ),
      );
    }

    const monitorIds = [...controllers.keys()];
    let stopped = false;
    return {
      monitorIds,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        for (const controller of controllers.values()) controller.abort();
        // Each watcher task releases its OWN active-watcher slot in its `finally`
        // (token-guarded), so by the time every task settles the slots are freed
        // without an unconditional delete here that could evict a newer watcher
        // that re-established the id after this one exited.
        await Promise.allSettled(tasks);
      },
    };
  }

  /**
   * Drive a single monitor's `watch()` iterable to completion (or abort),
   * ingesting each yielded observation. Never rejects: an error that is not the
   * result of our own abort is reported via `onError` and the monitor is released
   * from the active-watcher set so the tick loop resumes driving it via
   * `observe()`.
   */
  private async consumeWatch(
    monitor: MonitorDefinition,
    watch: (
      config: Record<string, unknown>,
      context: ObservationContext & { signal: AbortSignal },
    ) => AsyncIterable<Observation>,
    workspacePath: string,
    signal: AbortSignal,
    watcherToken: symbol,
    onError?: (monitorId: string, error: Error) => void,
  ): Promise<void> {
    // Per-watcher serialization chain (G14, 002 §2.4). Both watch-checkpoint
    // writes and observation ingests append to this single chain, so:
    //  - a checkpoint whose durable write is in flight when an observation
    //    arrives ALWAYS completes before that observation is ingested (the G14
    //    durable-write-before-ingest ordering), and
    //  - an ingest's read-modify-write of `monitorState.sourceState` is never
    //    interleaved with a checkpoint write of the same row (which would let a
    //    stale-baseline ingest clobber a newer checkpoint, or vice versa).
    // A task's rejection is isolated so it never poisons the chain for the next
    // task (each caller handles its own failure).
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const result = chain.then(task);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    // A checkpoint delivered after this watcher is torn down — its AbortSignal
    // aborted (stop()), or it is no longer the current active watcher for this
    // monitor id (it exited and was superseded) — is REJECTED rather than
    // enqueued (002 §2.4): a straggling `checkpoint(staleState)` must never
    // clobber a newer baseline written by observe() or a re-established watcher.
    // Rejecting at call time (not enqueuing) is also what keeps the shutdown
    // flush below terminating — no new chain links appear once the watcher is
    // torn down. The checkpoint is scoped to this watcher's own
    // `(monitorId, workspacePath)` state row (002 §3, #345/#307).
    const checkpoint = (nextState: unknown): Promise<void> => {
      if (
        signal.aborted ||
        this.activeWatchers.get(monitor.id) !== watcherToken
      ) {
        process.stderr.write(
          `Warning: watch checkpoint for monitor "${monitor.id}" ignored after ` +
            `the watcher stopped; state not persisted.\n`,
        );
        return Promise.resolve();
      }
      return enqueue(() =>
        this.writeCheckpoint(monitor.id, workspacePath, nextState),
      );
    };

    try {
      // Hoisted INSIDE the try (not above it): `getMonitorState` can throw
      // (e.g. SQLITE_BUSY) and `watch()` is a plain function that may validate
      // its config and throw synchronously before ever returning an iterable —
      // legal per the `ObservationSource.watch` type, which only constrains the
      // RETURNED value to `AsyncIterable<Observation>`. Either throw must still
      // hit the `finally` below so the active-watcher slot is released instead
      // of leaking forever (the id would otherwise stay pinned, permanently
      // skipped by the tick loop and unreachable by a future `watchMonitors()`).
      const monitorState = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      const iterable = watch(watchConfig(monitor.frontmatter.watch), {
        previousState: monitorState.sourceState,
        now: new Date(),
        workspacePath,
        signal,
        checkpoint,
      });
      for await (const observation of iterable) {
        if (signal.aborted) break;
        // Per-observation isolation (issue #46): an ingest() failure on one
        // yielded observation must not kill the entire watcher. Record an
        // 'errored' history row and continue consuming subsequent observations.
        // The outer try/catch (below) still handles errors from the async
        // iterator itself (the watch() generator rejecting).
        // The audit write is best-effort — if recordObservationHistory itself
        // throws we swallow it so a failed audit row never kills the watcher.
        // Ingest runs through the same serialization chain as checkpoint so the
        // G14 ordering (002 §2.4) holds against out-of-band checkpoint calls.
        try {
          await enqueue(() =>
            this.ingest(monitor, [observation], new Date(), {
              workspacePath,
            }),
          );
          this.refreshWorkspaceSessions(workspacePath);
        } catch (ingestError) {
          try {
            this.store.recordObservationHistory({
              monitorId: monitor.id,
              workspacePath,
              sourceName: monitor.frontmatter.watch.type,
              result: 'errored',
              observationData: {
                error:
                  ingestError instanceof Error
                    ? ingestError.message
                    : String(ingestError),
              },
            });
          } catch {
            // best-effort audit — ignore write failures
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        onError?.(
          monitor.id,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      // This watcher is done (normal completion, iterator error, or abort):
      // release its active-watcher slot IF it is still the current watcher for
      // this monitor id, so the tick loop resumes driving observe() (a watch()
      // that completes normally must not permanently pin the id and starve
      // observe()) and a future watchMonitors() can re-establish it. A watcher
      // already superseded by a newer one leaves that newer entry untouched.
      if (this.activeWatchers.get(monitor.id) === watcherToken) {
        this.activeWatchers.delete(monitor.id);
      }
      // Flush every still-pending checkpoint/ingest before the watcher task
      // resolves, so `stop()` (which awaits every watcher task) truly waits for
      // in-flight durable writes rather than racing shutdown against them.
      //
      // Under the CURRENT invariants — the slot delete above always precedes
      // this flush, `checkpoint()`'s post-teardown guard rejects (rather than
      // enqueuing) once the slot is deleted/superseded, and `writeCheckpoint`'s
      // persistence is synchronous better-sqlite3 work — no NEW link can be
      // appended to `chain` once we start reading it here, so a single
      // `await chain` would already be sufficient. The re-read loop below is
      // deliberately kept anyway as a defensive guard against a future change
      // to any of those three invariants (e.g. an async checkpoint backend, or
      // a reordering of the delete relative to this flush) reintroducing a
      // window where a link is enqueued between the read and its settle; it is
      // not compensating for a race that exists today. Do not reorder the slot
      // delete relative to this flush — that ordering is what the guarantee
      // depends on.
      let settled = chain;
      await settled;
      while (settled !== chain) {
        settled = chain;
        await settled;
      }
    }
  }

  /**
   * Durably persist a watch-mode checkpoint (002 §2.4): write the watcher's
   * updated source state into its own `(monitorId, workspacePath)` state row's
   * `sourceState` (002 §3, #345/#307), leaving notify state and
   * `lastObservationAt` untouched. A checkpoint is a **state write only** — it
   * never materializes or delivers an observation, and it must land in the
   * watcher's OWN workspace scope so a same-id monitor in another workspace is
   * never clobbered.
   *
   * A checkpoint write failure MUST NOT abort the watcher: it is a transient
   * durability gap, not a protocol violation (002 §2.4). We log a warning and
   * resolve so even a source that does not guard `checkpoint()` keeps watching.
   * The caller enqueues this on the per-watcher serialization chain, which is
   * what gives it the G14 durable-write-before-ingest ordering.
   */
  private writeCheckpoint(
    monitorId: string,
    workspacePath: string,
    nextState: unknown,
  ): Promise<void> {
    try {
      const current = this.store.getMonitorState(monitorId, workspacePath);
      this.store.setMonitorState(monitorId, workspacePath, {
        sourceState: nextState,
        notifyState: current.notifyState,
        ...(current.lastObservationAt
          ? { lastObservationAt: current.lastObservationAt }
          : {}),
      });
    } catch (error) {
      process.stderr.write(
        `Warning: watch checkpoint for monitor "${monitorId}" failed to persist ` +
          `(${error instanceof Error ? error.message : String(error)}); continuing to watch.\n`,
      );
    }
    return Promise.resolve();
  }

  status() {
    return this.store.status();
  }

  refreshHookState(sessionId: string): SessionHookState {
    // Lease-aware pending (issue #300): a row reserved by an in-flight channel
    // push is not independently claimable, so it must not be advertised as
    // pending work in the hook-state projection — otherwise the file would
    // disagree with the (lease-aware) claim decision during a reservation.
    // `reserveDelivery`/`releaseDelivery` re-run this so the file tracks the
    // lease as it is taken and dropped.
    const highUnread = this.pendingForClaim(sessionId, 'high');
    const pendingHigh = highUnread.some(
      (event) =>
        Date.now() - event.createdAt.getTime() >=
        DEFAULT_HIGH_URGENCY_SETTLE_MS,
    );
    const pendingNormal = this.pendingForClaim(sessionId, 'normal').length > 0;
    const pendingLow = this.pendingForClaim(sessionId, 'low').length > 0;
    const state = this.store.sessionHookState(sessionId, {
      high: pendingHigh,
      normal: pendingNormal,
      low: pendingLow,
      titles: highUnread.slice(-5).map((event) => event.title),
    });
    const session = this.store.getSessionById(sessionId);
    const adapter = this.adapter(session.adapter);
    writeJsonAtomic(session.hookStatePath, adapter.materializeHookState(state));
    return state;
  }

  private scheduleForMonitor(
    monitor: MonitorDefinition,
    now: Date,
    workspacePath: string | null,
  ): PollingDecision {
    const state = this.store.getMonitorState(monitor.id, workspacePath);
    const lastObservationAt = state.lastObservationAt?.getTime() ?? 0;
    const elapsed = now.getTime() - lastObservationAt;
    const config = watchConfig(monitor.frontmatter.watch);
    if (monitor.frontmatter.watch.type === 'schedule') {
      const cron = config['cron'];
      const timezone = config['timezone'];
      if (typeof cron !== 'string')
        return { due: false, nextPollMs: schedulingDefaults.scheduleTickMs };
      // Defensive isolation (issue #297): an invalid IANA `timezone` makes
      // Intl.DateTimeFormat throw inside cronFieldValuesForDate(). Authoring-time
      // validation (the schedule source's scopeSchema, checked by `validate` and
      // `watch declare`) should reject this before a monitor is ever persisted —
      // this catch is the last line of defense for a bypassed/legacy value, so a
      // single bad timezone can never escape as an uncaught throw and abort a
      // whole tick or crash a read-only diagnostic (explain/doctor).
      try {
        const due =
          cronMatchesDate(
            cron,
            now,
            typeof timezone === 'string' ? timezone : 'UTC',
          ) && elapsed >= schedulingDefaults.scheduleTickMs;
        return { due, nextPollMs: schedulingDefaults.scheduleTickMs };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          due: false,
          nextPollMs: schedulingDefaults.scheduleTickMs,
          error: message,
        };
      }
    }

    if (monitor.frontmatter.watch.type === 'api-poll') {
      const interval = config['interval'];
      const ms =
        typeof interval === 'string'
          ? parseDuration(interval)
          : DEFAULT_API_POLL_MS;
      return { due: elapsed >= ms, nextPollMs: ms };
    }

    const genericInterval = config['interval'];
    if (typeof genericInterval === 'string') {
      const ms = parseDuration(genericInterval);
      return { due: elapsed >= ms, nextPollMs: ms };
    }

    return {
      due: elapsed >= DEFAULT_FILE_FINGERPRINT_POLL_MS,
      nextPollMs: DEFAULT_FILE_FINGERPRINT_POLL_MS,
    };
  }

  private dispatchNotify(
    monitor: MonitorDefinition,
    observations: Observation[],
    observedAt: Date,
    state: NotifyRuntimeState,
  ): NotifyDispatchResult {
    const emitted: StoredObservationEnvelope[] = [];
    const nextState: NotifyRuntimeState = { ...state };

    // Scheduled-rollup Pace mode (002 §4.4). A `rollup` monitor accumulates
    // every observation in durable `notifyState.pendingRollup` and delivers
    // nothing until the author's `window` cron fires (no per-change interrupts,
    // §4.4 step 6). It never uses the debounce/throttle/immediate paths below,
    // so it short-circuits the rest of dispatchNotify.
    //
    // Clear any stale `pendingDebounce` state first: if the monitor's strategy
    // was previously `debounce` and was changed to `rollup`, the held batch
    // must not linger in notifyState indefinitely (it can never be flushed by
    // the rollup path). Drop it here so the strategy-change is clean.
    if (monitor.frontmatter.notify?.strategy === 'rollup') {
      delete nextState.pendingDebounce;
      return this.dispatchRollup(monitor, observations, observedAt, nextState);
    }

    if (nextState.pendingDebounce) {
      const dueAt = new Date(nextState.pendingDebounce.dueAt);
      if (dueAt.getTime() <= observedAt.getTime()) {
        emitted.push(
          ...nextState.pendingDebounce.observations.map(
            hydrateStoredObservationEnvelope,
          ),
        );
        delete nextState.pendingDebounce;
      }
    }

    for (const observation of observations) {
      const envelope = serializeObservation(monitor, observation, observedAt);
      // Notify timing is evaluated against the observation's *effective*
      // urgency (salience clamped into the monitor's band), not the monitor's
      // base urgency — so a source can escalate a single observation onto the
      // high-urgency debounce path (within the authored band) without changing
      // the monitor's default.
      const notify = defaultNotifyConfigForUrgency(
        envelope.effectiveUrgency,
        monitor.frontmatter.notify,
      );
      // An observation is "escalated" when source salience pushed its effective
      // urgency above the monitor's authored base (band low bound). A degenerate
      // band (bare scalar urgency) can never be escalated.
      const isEscalated =
        URGENCY_RANK[envelope.effectiveUrgency] >
        URGENCY_RANK[monitor.frontmatter.urgency];

      // Whole-batch early flush (002 §4.1): an escalated observation landing in
      // a held debounce batch flushes the ENTIRE batch — the already-held
      // observations plus this one — immediately, rather than splitting the
      // batch (splitting risks ordering confusion). This is the only path that
      // can short-circuit a settling debounce window before its `dueAt`.
      if (isEscalated && nextState.pendingDebounce) {
        emitted.push(
          ...nextState.pendingDebounce.observations.map(
            hydrateStoredObservationEnvelope,
          ),
          envelope,
        );
        delete nextState.pendingDebounce;
        continue;
      }

      if (!notify) {
        emitted.push(envelope);
        continue;
      }

      if (notify.strategy === 'throttle') {
        const suppressedUntil = nextState.suppressedUntil
          ? new Date(nextState.suppressedUntil)
          : null;
        if (
          suppressedUntil &&
          suppressedUntil.getTime() > observedAt.getTime()
        ) {
          continue;
        }
        emitted.push(envelope);
        nextState.suppressedUntil = new Date(
          observedAt.getTime() + parseDuration(notify['suppress-for']),
        ).toISOString();
        continue;
      }

      // `rollup` monitors are dispatched entirely by `dispatchRollup` and never
      // reach this loop, so the only remaining strategy here is `debounce`.
      // This narrows the union (excluding `rollup`) so `settle-for` is typed.
      if (notify.strategy !== 'debounce') {
        continue;
      }

      if (nextState.pendingDebounce) {
        nextState.pendingDebounce = {
          observations: [
            ...nextState.pendingDebounce.observations.map(
              hydrateStoredObservationEnvelope,
            ),
            envelope,
          ],
          dueAt: new Date(
            observedAt.getTime() + parseDuration(notify['settle-for']),
          ).toISOString(),
        };
        continue;
      }

      nextState.pendingDebounce = {
        observations: [envelope],
        dueAt: new Date(
          observedAt.getTime() + parseDuration(notify['settle-for']),
        ).toISOString(),
      };
    }

    return { emitted, nextState };
  }

  /**
   * Scheduled-rollup Pace mode dispatch (002 §4.4). On each tick:
   *
   * 1. **Accumulate** every new observation into the durable
   *    `notifyState.pendingRollup` batch (no `dueAt` reset — the flush time is
   *    schedule-driven, not settle-driven). Persisted across restarts (§4.4
   *    step 1, BP1) because `notifyState` is serialized into
   *    `monitor_state.notify_state`.
   * 2. **Evaluate** the author's `window` cron against `observedAt` in the
   *    configured `timezone` (default UTC). The window fires at most once per
   *    minute (002 §4.4 step 2), guarded by `rollupLastFiredMinute` — an
   *    epoch-minute integer persisted independently of `pendingRollup` so the
   *    guard survives a flush.
   * 3. **Flush** the whole batch as the emitted set and clear accumulation iff
   *    the window matches AND the batch is non-empty. An empty window produces
   *    no delivery (§4.4 step 3 — no empty pings).
   *
   * Observations that arrive on the same tick the window fires are included in
   * that window's delivery (they were produced at-or-before this opening).
   * Each accumulated observation becomes its own `monitor_events` row downstream
   * (§4.4 step 4), so the full event history is queryable.
   */
  private dispatchRollup(
    monitor: MonitorDefinition,
    observations: Observation[],
    observedAt: Date,
    nextState: NotifyRuntimeState,
  ): NotifyDispatchResult {
    const notify = monitor.frontmatter.notify;
    // Defensive: this method is only reached for rollup monitors, but narrow
    // the discriminated union so `window`/`timezone` are accessible.
    if (notify?.strategy !== 'rollup') {
      return { emitted: [], nextState };
    }

    // 1. Accumulate. Hydrate any restart-persisted envelopes (backfilling
    // `effectiveUrgency` per 002 §3 / issue #109) so a batch that survived a
    // daemon restart materializes with a valid urgency, then append this tick's
    // new observations.
    const accumulated: StoredObservationEnvelope[] = [
      ...(nextState.pendingRollup?.observations ?? []).map(
        hydrateStoredObservationEnvelope,
      ),
      ...observations.map((observation) =>
        serializeObservation(monitor, observation, observedAt),
      ),
    ];

    // 2. Evaluate the delivery window with a once-per-minute deduplication
    // guard (002 §4.4 step 2): `cronMatchesDate` returns true for every
    // timestamp within the matching minute, so we compare the current
    // epoch-minute to `rollupLastFiredMinute` to prevent a second flush
    // within the same minute when ticks are sub-minute.
    const currentMinute = Math.floor(observedAt.getTime() / 60_000);
    const windowFires =
      cronMatchesDate(notify.window, observedAt, notify.timezone ?? 'UTC') &&
      nextState.rollupLastFiredMinute !== currentMinute;

    if (windowFires) {
      // Record the minute we fired so a same-minute tick does not re-flush.
      nextState.rollupLastFiredMinute = currentMinute;
    }

    // 3. Flush iff the window fires AND the batch is non-empty; an empty window
    // produces no delivery (§4.4 step 3).
    if (windowFires && accumulated.length > 0) {
      delete nextState.pendingRollup;
      return { emitted: accumulated, nextState };
    }

    // Otherwise keep accumulating silently — no per-change interrupts (§4.4
    // step 6). Persist the batch (durable accumulation, §4.4 step 1) only when
    // there is something to hold; an empty window with nothing accumulated
    // leaves `pendingRollup` absent.
    if (accumulated.length > 0) {
      nextState.pendingRollup = { observations: accumulated };
    } else {
      delete nextState.pendingRollup;
    }
    return { emitted: [], nextState };
  }

  private async processObservation(input: ProcessObservationInput) {
    const objectKey = input.observation.objectKey ?? input.monitor.id;

    // ── Shape stage (G15, 002 §1.1.4–§1.1.6) ──────────────────────────────
    // Runs on the shared side of the seam, BEFORE Diff. When the monitor
    // declares `shape`, render the shaped snapshot (the source's raw facts +
    // the derived facts computed at the injected `now`) into a stable, diffable
    // artifact, and diff THAT artifact — never the raw source. The injected
    // `now` is the tick clock (`observedAt`); no ambient `Date.now()` is read.
    const shaped = shapeObservation(input.observation, input.observedAt, {
      shape: input.monitor.frontmatter.shape,
      payload: input.monitor.frontmatter.payload,
    });
    // Defensive guard: suppressed observations are pre-filtered in ingest()
    // BEFORE dispatchNotify, so this branch should not be reached in normal
    // operation. Retained as a safety net for any future call sites.
    if (shaped.suppressed) return null;

    const effectiveSnapshotText = shaped.snapshotText;

    const previousSnapshot = effectiveSnapshotText
      ? this.store.latestSnapshot(
          input.monitor.id,
          objectKey,
          input.workspacePath ?? null,
        )
      : null;

    // The object's declared change-detection strategy (issue #437), read from
    // the raw observation's `snapshot` metadata so `strategy: json-diff`
    // renders a structural diffText instead of a compact-JSON line diff.
    const strategy = changeDetectionStrategyOf(input.observation.snapshot);
    const diffText =
      effectiveSnapshotText && previousSnapshot
        ? buildDiff(previousSnapshot.content, effectiveSnapshotText, strategy)
        : null;

    const event = this.store.insertEvent(
      {
        workspacePath: input.workspacePath ?? null,
        monitorId: input.monitor.id,
        sourceName: input.sourceName,
        urgency: input.effectiveUrgency,
        title: input.observation.title,
        body: input.observation.body ?? input.monitor.instructions,
        summary:
          input.observation.summary ??
          input.observation.body ??
          input.observation.title,
        payload: shaped.payload ?? input.observation.payload ?? {},
        snapshotMetadata: input.observation.snapshot ?? {},
        snapshotText: effectiveSnapshotText ?? null,
        // The SHARED object-level diff (against the latest stored snapshot) for
        // `events list`/history display (002 §5.2). The PER-RECIPIENT delta is
        // computed inside insertEvent's projection loop and recorded on each
        // session's session_event_state.diff_text (G10, 002 §1.1.2).
        diffText,
        objectKey,
        // Persist the author-declared baseline strategy on the shared event so
        // the per-recipient `net` collapse can run at claim time without
        // re-scanning monitor definitions (G10 PR-B, 002 §1.1.7). Defaults to
        // `incremental` when the monitor omits the field.
        baselineStrategy: input.monitor.frontmatter.baselineStrategy,
        // Make the source-agnostic changeKind queryable without each source having
        // to duplicate it into its own queryScope.
        queryScope: {
          ...(input.observation.queryScope ?? {}),
          ...(input.observation.changeKind
            ? { changeKind: input.observation.changeKind }
            : {}),
        },
        tags: input.monitor.frontmatter.tags ?? [],
        createdAt: input.observedAt,
      },
      // The object's snapshot state immediately BEFORE this event — used to seed
      // a first-time recipient's cursor so it hears only changes AFTER it
      // registered (decided semantics Q1; backward-compat with the single-baseline
      // diff above when there is one recipient at the shared baseline).
      { previousContent: previousSnapshot?.content ?? null },
      // Ephemeral-monitor projection isolation (007 §4.6): restrict projection to
      // the declaring session so its events never reach a sibling lead session.
      input.restrictToSessionId !== undefined
        ? { restrictToSessionId: input.restrictToSessionId }
        : undefined,
    );

    // TODO(#46 follow-up): make insertEvent+saveSnapshot atomic via a
    // transaction. Currently a saveSnapshot failure after a successful insertEvent
    // leaves an event row without its snapshot — best-effort: the ingest() caller
    // catches this and records an errored history row for the observation.
    if (effectiveSnapshotText) {
      this.store.saveSnapshot({
        workspacePath: input.workspacePath ?? null,
        monitorId: input.monitor.id,
        objectKey,
        eventId: event.id,
        content: effectiveSnapshotText,
      });
    }

    // ── Interpret stage (G14, 002 §1.1.8) ─────────────────────────────────
    // Runs AFTER the per-recipient Diff/projection, on the per-recipient delta,
    // and ONLY for `payload.form: prose`. Best-effort and off the critical path:
    // a tool failure falls back to the deterministic `rendered` artifact
    // (already projected above) and is recorded as explainable. The host-specific
    // tool invocation lives behind `this.interpretAdapter` — never here.
    if (
      input.monitor.frontmatter.payload?.form === 'prose' &&
      this.interpretAdapter
    ) {
      await this.runInterpret(input.monitor, event, diffText);
    }

    return event;
  }

  /**
   * Drive the per-recipient Interpret stage (G14, 002 §1.1.8) over every lead
   * session the just-materialized `event` projected into. For each recipient the
   * adapter reads the per-recipient delta and either delivers a cheap digest or
   * suppresses the projection as not-substantive; every verdict is recorded on
   * `session_event_state` so "why nothing fired" is inspectable via
   * `monitor explain` (002 §10.7, capability C12).
   *
   * Best-effort: an adapter rejection (tool missing / errors / times out) MUST
   * NOT drop the underlying delta — the projection stays deliverable as the
   * deterministic `rendered` artifact and the failure is recorded (`failed`).
   */
  private async runInterpret(
    monitor: MonitorDefinition,
    event: { id: string; diffText: string | null; snapshotText: string | null },
    diffText: string | null,
  ): Promise<void> {
    const adapter = this.interpretAdapter;
    if (!adapter) return;
    const sessionIds = this.store.projectedSessionIdsForLastEvent();
    if (sessionIds.length === 0) return;

    // The per-recipient delta (G10, 002 §1.1.2): each recipient is judged on the
    // diff it actually computed against ITS OWN baseline cursor (recorded on
    // session_event_state.diff_text), falling back to the shared event diff, then
    // the full artifact at a baseline. Recipients sharing the same delta get ONE
    // adapter call (same input → same verdict, no redundant tool round-trips).
    // When recipients are co-registered at the same baseline their deltas are
    // identical, so this collapses to exactly today's single shared call (the
    // G14 behavior PR-A must not change).
    const sharedFallback = diffText ?? event.snapshotText ?? '';
    // Fetch all per-recipient diffs for every projected session in ONE query
    // (avoids the N+1 pattern of calling perRecipientDiffsForSession once per
    // recipient in the loop below). (G10, 002 §1.1.2; Copilot review: comment 3.)
    const allRecipientDiffs = this.store.perRecipientDiffsForAllSessions(
      sessionIds,
      event.id,
    );
    const criteria = monitor.instructions;

    // Group recipients by their distinct delta so the adapter runs once per
    // distinct input, not once per recipient.
    const sessionsByDelta = new Map<string, string[]>();
    for (const sessionId of sessionIds) {
      const delta = allRecipientDiffs.get(sessionId) ?? sharedFallback;
      const bucket = sessionsByDelta.get(delta);
      if (bucket) bucket.push(sessionId);
      else sessionsByDelta.set(delta, [sessionId]);
    }

    for (const [delta, deltaSessionIds] of sessionsByDelta) {
      let result: Awaited<ReturnType<typeof adapter.interpret>> | undefined;
      let errorMessage: string | undefined;
      try {
        result = await adapter.interpret({
          delta,
          criteria,
          monitorId: monitor.id,
        });
      } catch (interpretError) {
        // Best-effort fallback (PP4, AP3): record the failure and leave every
        // projection deliverable as the deterministic `rendered` artifact.
        errorMessage =
          interpretError instanceof Error
            ? interpretError.message
            : String(interpretError);
      }

      for (const sessionId of deltaSessionIds) {
        if (errorMessage !== undefined) {
          this.store.recordInterpretDecision(sessionId, event.id, {
            decision: 'failed',
            reason: errorMessage,
          });
        } else if (result?.decision === 'suppress') {
          this.store.recordInterpretDecision(sessionId, event.id, {
            decision: 'suppress',
            reason: result.reason,
          });
        } else if (result?.decision === 'deliver') {
          this.store.recordInterpretDecision(sessionId, event.id, {
            decision: 'deliver',
            digest: result.digest,
          });
        }
      }
    }
  }
}
