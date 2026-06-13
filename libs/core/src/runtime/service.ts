import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanMonitors } from '../parser/scan-monitors.js';
import type { MonitorDefinition } from '../schema/types.js';
import { validateScope } from '../schema/validate-scope.js';
import { parseDuration } from '../notify/notifier.js';
import type { Observation } from '../observation/types.js';
import type { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { AgentRuntimeAdapter } from '../adapter/types.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import type {
  AgentSessionRecord,
  DeliveryClaim,
  EventQuery,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorExplainStage,
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

function explainVerdict(stages: MonitorExplainStage[]): {
  status: MonitorExplainStageStatus;
  stage: MonitorExplainStageId;
  reason: string;
} {
  const stopped = stages.find((stage) => stage.status !== 'ok');
  const stage = stopped ?? stages[stages.length - 1];
  return {
    status: stage?.status ?? 'ok',
    stage: stage?.id ?? 'delivery',
    reason: stage?.reason ?? 'Monitor delivered successfully.',
  };
}

function serializeObservation(
  monitor: MonitorDefinition,
  observation: Observation,
  observedAt: Date,
): StoredObservationEnvelope {
  return { monitor, observation, observedAt };
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

export class AgentMonitorRuntime {
  /** Monitor ids currently driven by a continuous `watch()` (see `watchMonitors`). */
  private readonly activeWatchers = new Set<string>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly registry: SourceRegistry,
    private readonly adapters: AgentRuntimeAdapter[] = [claudeCodeAdapter],
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
    if (pendingDebounce && new Date(pendingDebounce.dueAt) > now) {
      stages.push(
        explainStage(
          'notify',
          'pending',
          `debounce is holding ${String(pendingDebounce.observations.length)} observation(s) until ${pendingDebounce.dueAt}.`,
          {
            dueAt: pendingDebounce.dueAt,
            observations: pendingDebounce.observations.length,
          },
        ),
      );
    } else if (suppressedUntil && suppressedUntil > now) {
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
          'No debounce or throttle hold is currently active.',
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
      stages.push(
        observationHealthy
          ? explainStage(
              'materialization',
              'healthy',
              'No events materialized — expected, because the source observed no changes (not a bug).',
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
      stages.push(
        explainStage(
          'delivery',
          'ok',
          `Events are projected to lead sessions (${Object.entries(counts)
            .map(([state, count]) => `${state}: ${String(count)}`)
            .join(', ')}).`,
          counts,
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

  acknowledgeSession(sessionId: string, eventIds?: string[]): void {
    const ids =
      eventIds ?? this.store.unreadEventsForSession(sessionId).map((e) => e.id);
    this.store.acknowledgeEvents(sessionId, ids);
    this.refreshHookState(sessionId);
  }

  claimDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
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
        this.store.markClaimed(
          sessionId,
          settledHigh.map((event) => event.id),
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
            settledHigh.map((event) => ({
              title: event.title,
              summary: event.summary || event.body || event.title,
            })),
          ),
          events: settledHigh.map((event) => ({
            eventId: event.id,
            monitorId: event.monitorId,
            title: event.title,
            summary: event.summary || event.body || event.title,
            urgency: event.urgency,
            createdAt: event.createdAt.toISOString(),
            body: event.body,
          })),
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
      const message = [
        'Recap of recent AgentMon activity since your last recap:',
        summarizeEvents(
          unread.slice(-MAX_RECAP_EVENTS).map((event) => ({
            title: event.title,
            summary: event.summary || event.body || event.title,
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
        events: unread.slice(-MAX_RECAP_EVENTS).map((event) => ({
          eventId: event.id,
          monitorId: event.monitorId,
          title: event.title,
          summary: event.summary || event.body || event.title,
          urgency: event.urgency,
          createdAt: event.createdAt.toISOString(),
          body: event.body,
        })),
      };
    }

    return null;
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
      if (!schedule.due) continue;

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
          },
        );
      } catch (observeError) {
        // observe() failed: record errored outcome (best-effort) and skip
        // this monitor entirely for this tick. ingest() is NOT called, which
        // preserves sourceState as described above.
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
            sourceName,
            result: 'errored',
            observationData: {
              error:
                observeError instanceof Error
                  ? observeError.message
                  : String(observeError),
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
          ...this.ingest(monitor, observationResult.observations, now, {
            workspacePath,
            ...(observationResult.nextState !== undefined
              ? { nextSourceState: { value: observationResult.nextState } }
              : {}),
            ...(observationResult.outcome
              ? { sourceOutcome: observationResult.outcome }
              : {}),
          }),
        );
      } catch (ingestError) {
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
            sourceName,
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

    this.refreshWorkspaceSessions(workspacePath);

    return { evaluatedMonitors: evaluated, emittedEventIds };
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
   * untouched. Synchronous start-to-finish, so concurrent watchers on the
   * single-threaded event loop never interleave a monitor's state mutation.
   */
  private ingest(
    monitor: MonitorDefinition,
    observations: Observation[],
    now: Date,
    options: {
      workspacePath: string;
      nextSourceState?: { value: unknown };
      sourceOutcome?: 'rebaselined';
    },
  ): string[] {
    const monitorState = this.store.getMonitorState(monitor.id);
    const dispatch = this.dispatchNotify(
      monitor,
      observations,
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

    // Audit trail: record this monitor's outcome (G6). Shared by the tick loop
    // and the watcher, so watch-mode observations are audited identically.
    // Classify by what was *emitted*, not by new observations: a batch can emit
    // a previously-debounced observation with zero new observations (e.g. the
    // default high-urgency settle flushing), which is still a `triggered`
    // outcome. Only `suppressed` (observations seen but held/throttled) and
    // `no-change` (nothing seen) depend on the observation count.
    const observed = observations.length;
    const emittedCount = dispatch.emitted.length;
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
            observed === 0 && options.sourceOutcome === 'rebaselined'
            ? 'rebaselined'
            : observed > 0
              ? 'suppressed'
              : 'no-change',
      observationData: { observed, emitted: emittedCount },
    });

    // Per-observation materialization isolation (issue #46): a single failing
    // observation must not drop the already-durably-written ids of its
    // batch-mates, and must not cause emittedEventIds to disagree with what is
    // actually in the DB. On failure we record a best-effort errored history row
    // for the individual observation and continue to the next in the batch.
    // The batch-level triggered/suppressed/no-change row recorded above is
    // unaffected — it reflects what was *dispatched*, not what materialized.
    const emittedEventIds: string[] = [];
    for (const emitted of dispatch.emitted) {
      try {
        const event = this.processObservation({
          monitor: emitted.monitor,
          sourceName: emitted.monitor.frontmatter.watch.type,
          observation: emitted.observation,
          observedAt: emitted.observedAt,
          workspacePath: options.workspacePath,
        });
        emittedEventIds.push(event.id);
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
      context: {
        previousState?: unknown;
        now: Date;
        signal: AbortSignal;
      },
    ) => AsyncIterable<Observation>,
    workspacePath: string,
    signal: AbortSignal,
    onError?: (monitorId: string, error: Error) => void,
  ): Promise<void> {
    const monitorState = this.store.getMonitorState(monitor.id);
    const iterable = watch(watchConfig(monitor.frontmatter.watch), {
      previousState: monitorState.sourceState,
      now: new Date(),
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
          this.ingest(monitor, [observation], new Date(), { workspacePath });
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
      const notify = defaultNotifyConfigForUrgency(
        monitor.frontmatter.urgency,
        monitor.frontmatter.notify,
      );
      const envelope = serializeObservation(monitor, observation, observedAt);

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

  private processObservation(input: ProcessObservationInput) {
    const objectKey = input.observation.objectKey ?? input.monitor.id;
    const previousSnapshot = input.observation.snapshotText
      ? this.store.latestSnapshot(
          input.monitor.id,
          objectKey,
          input.workspacePath ?? null,
        )
      : null;

    const diffText =
      input.observation.snapshotText && previousSnapshot
        ? buildTextDiff(
            previousSnapshot.content,
            input.observation.snapshotText,
          )
        : null;

    const event = this.store.insertEvent({
      workspacePath: input.workspacePath ?? null,
      monitorId: input.monitor.id,
      sourceName: input.sourceName,
      urgency: input.monitor.frontmatter.urgency,
      title: input.observation.title,
      body: input.observation.body ?? input.monitor.instructions,
      summary:
        input.observation.summary ??
        input.observation.body ??
        input.observation.title,
      payload: input.observation.payload ?? {},
      snapshotMetadata: input.observation.snapshot ?? {},
      snapshotText: input.observation.snapshotText ?? null,
      diffText,
      objectKey,
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
    });

    // TODO(#46 follow-up): make insertEvent+saveSnapshot atomic via a
    // transaction. Currently a saveSnapshot failure after a successful insertEvent
    // leaves an event row without its snapshot — best-effort: the ingest() caller
    // catches this and records an errored history row for the observation.
    if (input.observation.snapshotText) {
      this.store.saveSnapshot({
        workspacePath: input.workspacePath ?? null,
        monitorId: input.monitor.id,
        objectKey,
        eventId: event.id,
        content: input.observation.snapshotText,
      });
    }

    return event;
  }
}
