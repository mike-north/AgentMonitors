import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { scanMonitors } from '../parser/scan-monitors.js';
import type { MonitorDefinition, Urgency } from '../schema/types.js';
import { validateScope } from '../schema/validate-scope.js';
import { parseDuration } from '../notify/notifier.js';
import type { Observation, ObservationContext } from '../observation/types.js';
import type { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { AgentRuntimeAdapter } from '../adapter/types.js';
import type { InterpretAdapter } from '../adapter/interpret.js';
import { buildTextDiff } from './diff.js';
import { shapeObservation } from './shape-stage.js';
import {
  RuntimeStore,
  computeNetCollapseView,
  netCollapseGroupKey,
} from './store.js';
import type {
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryEventSummary,
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
  type NotifyDispatchResult,
  type NotifyRuntimeState,
  type DeliveryLifecycle,
  type SessionHookState,
} from './types.js';

const DEFAULT_FILE_FINGERPRINT_POLL_MS = 30_000;
const DEFAULT_API_POLL_MS = 300_000;
const DEFAULT_HIGH_URGENCY_SETTLE_MS = 15_000;
const MAX_RECAP_EVENTS = 10;
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
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

export class AgentMonitorRuntime {
  /** Monitor ids currently driven by a continuous `watch()` (see `watchMonitors`). */
  private readonly activeWatchers = new Set<string>();

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
  ) {}

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
    this.refreshHookState(session.id);
    return session;
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

    const runtimeState = this.store.getMonitorState(input.monitorId);
    const schedule = this.scheduleForMonitor(monitor, now);
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
        ...(input.workspacePath !== undefined
          ? { workspacePath: input.workspacePath }
          : {}),
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
      input.workspacePath,
    );
    const leadSessions = this.store
      .sessionsForWorkspace(input.workspacePath)
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
      stages.push(
        explainStage(
          'delivery',
          'ok',
          `Events are projected to lead sessions (${Object.entries(counts)
            .map(([state, count]) => `${state}: ${String(count)}`)
            .join(', ')}).${interpretSuffix}`,
          interpretVerdicts.length > 0
            ? { ...counts, interpret: interpretVerdicts }
            : counts,
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
      const valid = scopeErrors.length === 0;
      if (!valid) invalidCount += 1;

      const runtimeState = this.store.getMonitorState(monitor.id);
      const schedule = this.scheduleForMonitor(monitor, now);
      const history = this.store.listObservationHistory({
        monitorId: monitor.id,
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
        ...(valid ? {} : { validationError: scopeErrors.join('; ') }),
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
   * Claim the pending delivery for a session at a lifecycle point (002 §9).
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
    const now = new Date();
    this.store.touchSession(sessionId);
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
      const highUnread = this.store.pendingEventsForSession(sessionId, 'high');
      const settledHigh = highUnread.filter(
        (event) =>
          now.getTime() - event.createdAt.getTime() >=
          DEFAULT_HIGH_URGENCY_SETTLE_MS,
      );
      if (settledHigh.length > 0) {
        // Per-recipient `net` collapse (G10 PR-B, 002 §1.1.7): deliver only the
        // newest event per object for a `net` monitor; record the older
        // intermediates claimed-but-suppressed.
        //
        // DECIDE first, WITHOUT mutating: compute the per-object representatives
        // a full claim would surface (the pure {@link computeNetCollapseView}),
        // then apply the #299 cap to those representatives. The MUTATING collapse
        // (delta re-anchoring + net-suppression) runs ONLY on the surfaced groups
        // below. A DEFERRED group must stay byte-untouched — its intermediates
        // UNSUPPRESSED and still pending — until the context event that actually
        // surfaces it; otherwise those intermediates would be net-suppressed while
        // never claimed (orphaned: excluded from pending/unread yet lacking a
        // `first_notified_at`), breaking the claimed-but-suppressed-AT-CLAIM-TIME
        // contract (002 §1.1.7). Running the mutation on the full set before the
        // cap is exactly that bug.
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

        // Restrict the mutating collapse + claim to ONLY the surfaced groups —
        // each surfaced representative's full set of settled events (the
        // representative plus that object's older intermediates). Deferred groups
        // are excluded entirely, so nothing about them is re-anchored,
        // suppressed, or claimed; they re-deliver intact next context event.
        const surfacedKeys = new Set(surfacedReps.map(netCollapseGroupKey));
        const surfacedCandidates = settledHigh.filter((event) =>
          surfacedKeys.has(netCollapseGroupKey(event)),
        );

        // The delivered subset for the surfaced groups (equals `surfacedReps`,
        // now with each surviving delta re-anchored to this recipient's cursor →
        // endpoint and the surfaced groups' intermediates net-suppressed). Diffs
        // are recomputed inside collapse, so this must run BEFORE the digest
        // lookup reads the (re-anchored) deltas.
        const surfacedHigh = this.store.collapseNetForClaim(
          sessionId,
          surfacedCandidates,
        );

        const digests = this.store.interpretDigestsForSession(
          sessionId,
          surfacedHigh.map((event) => event.id),
        );
        // Claim the FULL surfaced-group candidate set (representatives + their
        // now-suppressed intermediates) so the cursor advances to each surfaced
        // object's endpoint and the suppressed rows are consumed.
        this.store.markClaimed(
          sessionId,
          surfacedCandidates.map((event) => event.id),
          lifecycle,
        );
        this.refreshHookState(sessionId);
        return {
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
        };
      }

      const normalPending = this.store.pendingEventsForSession(
        sessionId,
        'normal',
      );
      if (
        normalPending.length > 0 &&
        normalPending.length === unreadNormal.length
      ) {
        // Record per-recipient `net` suppression for the intermediates of this
        // claimed batch (G10 PR-B, 002 §1.1.7). This branch surfaces only the
        // generic inbox prompt (no event payloads), but the collapse must still
        // run so suppressed intermediates are recorded/explainable and the
        // cursor advances correctly via the full-set markClaimed below.
        this.store.collapseNetForClaim(sessionId, normalPending);
        this.store.markClaimed(
          sessionId,
          normalPending.map((event) => event.id),
          lifecycle,
        );
        this.refreshHookState(sessionId);
        return {
          sessionId,
          lifecycle,
          mode: 'delivery',
          urgency: 'normal',
          unreadCounts: sessionUnreadCounts,
          message: NORMAL_INBOX_PROMPT,
          events: [],
        };
      }

      return null;
    }

    const unreadLow = this.store.unreadEventsForSession(sessionId, 'low');
    const lowUnread = this.store.pendingEventsForSession(sessionId, 'low');
    const shouldSendLow =
      lowUnread.length > 0 && lowUnread.length === unreadLow.length;

    if (lifecycle === 'turn-idle' && shouldSendLow) {
      // Record per-recipient `net` suppression for this claimed batch's
      // intermediates (G10 PR-B, 002 §1.1.7); see the normal branch above.
      this.store.collapseNetForClaim(sessionId, lowUnread);
      this.store.markClaimed(
        sessionId,
        lowUnread.map((event) => event.id),
        lifecycle,
      );
      this.refreshHookState(sessionId);
      return {
        sessionId,
        lifecycle,
        mode: 'delivery',
        urgency: 'low',
        unreadCounts: sessionUnreadCounts,
        message: IDLE_INBOX_PROMPT,
        events: [],
      };
    }

    const unread = this.store.unreadEventsForSession(sessionId);
    if (lifecycle === 'post-compact' && unread.length > 0) {
      // Per-recipient `net` collapse (G10 PR-B, 002 §1.1.7) over the FULL unread
      // set, then recap only the delivered (post-collapse) tail. The full set is
      // still claimed below so the cursor advances and suppressed intermediates
      // are consumed. Collapse re-anchors the surviving delta, so it must run
      // before the digest lookup.
      const deliveredUnread = this.store.collapseNetForClaim(sessionId, unread);
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
      this.store.markClaimed(
        sessionId,
        unread.map((event) => event.id),
        lifecycle,
      );
      this.store.updateSessionRecap(sessionId);
      this.refreshHookState(sessionId);
      return {
        sessionId,
        lifecycle,
        mode: 'recap',
        unreadCounts: sessionUnreadCounts,
        message,
        events: recapSlice.map((event) =>
          toDeliveryEventSummary(event, digests),
        ),
      };
    }

    return null;
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
    const highUnread = this.store.pendingEventsForSession(sessionId, 'high');
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

  async tick(
    monitorsDir: string,
    workspacePath = monitorsDir,
  ): Promise<RuntimeTickResult> {
    const result = await scanMonitors(monitorsDir);
    this.assertNoDuplicateIds(result, monitorsDir);

    const now = new Date();
    const emittedEventIds: string[] = [];
    const evaluated: string[] = [];
    const erroredObservations: ErroredObservation[] = [];
    const skippedMonitors: { monitorId: string; nextDueAt: Date }[] = [];

    for (const parsed of result.monitors) {
      const monitor = parsed.monitor;
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      if (!source) {
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${sourceName}".`,
        );
      }

      // A monitor with an active continuous watcher is driven by that watcher;
      // skip its one-shot observe() so it is not processed twice (G5).
      if (this.activeWatchers.has(monitor.id)) continue;

      const schedule = this.scheduleForMonitor(monitor, now);
      if (!schedule.due) {
        // Record skipped monitors so callers can distinguish "not yet due" from
        // "no monitors found" (issue #152). nextDueAt is computed from the same
        // scheduling decision — single source of truth, never recomputed.
        // Fall back to `now` (not epoch 0) when lastObservationAt is absent so
        // the computed nextDueAt stays meaningful even under partial/missing state.
        const monitorStateForSkip = this.store.getMonitorState(monitor.id);
        const lastObservationAt =
          monitorStateForSkip.lastObservationAt?.getTime() ?? now.getTime();
        const nextDueAt = new Date(lastObservationAt + schedule.nextPollMs);
        skippedMonitors.push({ monitorId: monitor.id, nextDueAt });

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
          const rollupDispatch = this.dispatchRollup(
            monitor,
            [],
            now,
            rollupNotifyState,
          );
          this.store.setMonitorState(monitor.id, {
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
              emittedEventIds.push(
                ...(await this.materializeSpan(
                  monitor,
                  rollupDispatch.emitted,
                  { observed: 0, workspacePath },
                )),
              );
            } catch {
              // best-effort: materialization failure must not abort the tick
            }
          }
        }

        continue;
      }

      evaluated.push(monitor.id);

      // Two separate try/catch blocks so observe() failures and ingest()
      // failures are handled independently (issue #46):
      //
      // Block 1 — observe(): if observe() throws, we skip ingest() entirely.
      // Skipping ingest() means setMonitorState() is never called, which is
      // what preserves the previously-persisted sourceState so the next tick's
      // diff spans from the last good baseline rather than an empty state.
      let observationResult;
      try {
        const monitorState = this.store.getMonitorState(monitor.id);
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
        erroredObservations.push({ monitorId: monitor.id, message });
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
            sourceName,
            result: 'errored',
            observationData: {
              error: message,
            },
          });
        } catch {
          // best-effort audit — ignore write failures
        }
        continue;
      }

      // Block 2 — ingest(): ingest() now isolates per-observation materialization
      // failures internally (see ingest()), so it should not normally throw.
      // This outer catch is a defence-in-depth safety net: if ingest() itself
      // throws (e.g. setMonitorState fails), record errored best-effort and
      // continue so the tick is not aborted.
      try {
        emittedEventIds.push(
          ...(await this.ingest(monitor, observationResult.observations, now, {
            workspacePath,
            ...(observationResult.nextState !== undefined
              ? { nextSourceState: { value: observationResult.nextState } }
              : {}),
            ...(observationResult.outcome
              ? { sourceOutcome: observationResult.outcome }
              : {}),
          })),
        );
      } catch (ingestError) {
        const message =
          ingestError instanceof Error
            ? ingestError.message
            : String(ingestError);
        erroredObservations.push({ monitorId: monitor.id, message });
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
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

    this.refreshWorkspaceSessions(workspacePath);

    return {
      evaluatedMonitors: evaluated,
      emittedEventIds,
      erroredObservations,
      skippedMonitors,
    };
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
   * own in-memory state and the runtime leaves the persisted `sourceState`
   * untouched.
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

    const monitorState = this.store.getMonitorState(monitor.id);
    const dispatch = this.dispatchNotify(
      monitor,
      passedObservations,
      now,
      monitorState.notifyState,
    );

    this.store.setMonitorState(monitor.id, {
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
   * so a non-empty flush there correctly classifies as `triggered` (emitted > 0).
   */
  private async materializeSpan(
    monitor: MonitorDefinition,
    emitted: StoredObservationEnvelope[],
    options: {
      observed: number;
      workspacePath: string;
      sourceOutcome?: 'rebaselined' | 'no-files-matched';
    },
  ): Promise<string[]> {
    const observed = options.observed;
    const emittedCount = emitted.length;
    this.store.recordObservationHistory({
      monitorId: monitor.id,
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
        });
        if (event) emittedEventIds.push(event.id);
      } catch (materializeError) {
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
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
      this.activeWatchers.add(monitor.id);

      const watch = source.watch.bind(source);
      tasks.push(
        this.consumeWatch(
          monitor,
          watch,
          workspacePath,
          controller.signal,
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
        await Promise.allSettled(tasks);
        for (const id of monitorIds) this.activeWatchers.delete(id);
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
    onError?: (monitorId: string, error: Error) => void,
  ): Promise<void> {
    const monitorState = this.store.getMonitorState(monitor.id);
    const iterable = watch(watchConfig(monitor.frontmatter.watch), {
      previousState: monitorState.sourceState,
      now: new Date(),
      workspacePath,
      signal,
    });
    try {
      for await (const observation of iterable) {
        if (signal.aborted) break;
        // Per-observation isolation (issue #46): an ingest() failure on one
        // yielded observation must not kill the entire watcher. Record an
        // 'errored' history row and continue consuming subsequent observations.
        // The outer try/catch (below) still handles errors from the async
        // iterator itself (the watch() generator rejecting).
        // The audit write is best-effort — if recordObservationHistory itself
        // throws we swallow it so a failed audit row never kills the watcher.
        try {
          await this.ingest(monitor, [observation], new Date(), {
            workspacePath,
          });
          this.refreshWorkspaceSessions(workspacePath);
        } catch (ingestError) {
          try {
            this.store.recordObservationHistory({
              monitorId: monitor.id,
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
      if (signal.aborted) return;
      this.activeWatchers.delete(monitor.id);
      onError?.(
        monitor.id,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  status() {
    return this.store.status();
  }

  refreshHookState(sessionId: string): SessionHookState {
    const highUnread = this.store.pendingEventsForSession(sessionId, 'high');
    const pendingHigh = highUnread.some(
      (event) =>
        Date.now() - event.createdAt.getTime() >=
        DEFAULT_HIGH_URGENCY_SETTLE_MS,
    );
    const pendingNormal =
      this.store.pendingEventsForSession(sessionId, 'normal').length > 0;
    const pendingLow =
      this.store.pendingEventsForSession(sessionId, 'low').length > 0;
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
  ): PollingDecision {
    const state = this.store.getMonitorState(monitor.id);
    const lastObservationAt = state.lastObservationAt?.getTime() ?? 0;
    const elapsed = now.getTime() - lastObservationAt;
    const config = watchConfig(monitor.frontmatter.watch);
    if (monitor.frontmatter.watch.type === 'schedule') {
      const cron = config['cron'];
      const timezone = config['timezone'];
      if (typeof cron !== 'string') return { due: false, nextPollMs: 60_000 };
      const due =
        cronMatchesDate(
          cron,
          now,
          typeof timezone === 'string' ? timezone : 'UTC',
        ) && elapsed >= 60_000;
      return { due, nextPollMs: 60_000 };
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

    const diffText =
      effectiveSnapshotText && previousSnapshot
        ? buildTextDiff(previousSnapshot.content, effectiveSnapshotText)
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
