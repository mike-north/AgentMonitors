import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanMonitors } from '../parser/scan-monitors.js';
import type { MonitorDefinition } from '../schema/types.js';
import { parseDuration } from '../notify/notifier.js';
import type { Observation, ObservationResult } from '../observation/types.js';
import type { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { AgentRuntimeAdapter } from '../adapter/types.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import type {
  AgentSessionRecord,
  DeliveryClaim,
  EventQuery,
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
      const source = this.registry.get(monitor.frontmatter.source);
      if (!source) {
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${monitor.frontmatter.source}".`,
        );
      }

      // A monitor with an active continuous watcher is driven by that watcher;
      // skip its one-shot observe() so it is not processed twice (G5).
      if (this.activeWatchers.has(monitor.id)) continue;

      const schedule = this.scheduleForMonitor(monitor, now);
      if (!schedule.due) continue;

      evaluated.push(monitor.id);

      // Contain per-monitor *source* failures (G6 hardening): only `observe()`
      // is inside this boundary. A source's operational error (e.g. the
      // `incoming-changes` source shelling out to git and hitting a transient
      // failure) must not abort the whole tick and starve every other due
      // monitor. On such a failure we record an `error` outcome and continue,
      // without persisting anything for this monitor — so its `lastObservationAt`
      // stays put and it is still due, and retries cleanly, on the next tick.
      //
      // `ingest()` is deliberately OUTSIDE the boundary: it is runtime-owned
      // (notify dispatch, persistence, event materialization) and advances
      // persisted state as it goes, so a throw there is a runtime/persistence
      // bug, not a source error. Containing it would both violate the
      // "leave state untouched on failure" invariant (state may already have
      // advanced) and mislabel the failure as an `observe()` error — so we let
      // it surface as a tick failure instead of masking it.
      let observationResult: ObservationResult;
      try {
        const monitorState = this.store.getMonitorState(monitor.id);
        observationResult = await source.observe(monitor.frontmatter.scope, {
          previousState: monitorState.sourceState,
          now,
        });
      } catch (error) {
        this.recordMonitorFailure(monitor, error);
        continue;
      }

      emittedEventIds.push(
        ...this.ingest(monitor, observationResult.observations, now, {
          workspacePath,
          ...(observationResult.nextState !== undefined
            ? { nextSourceState: { value: observationResult.nextState } }
            : {}),
        }),
      );
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
      sourceName: monitor.frontmatter.source,
      result:
        emittedCount > 0
          ? 'triggered'
          : observed > 0
            ? 'suppressed'
            : 'no-change',
      observationData: { observed, emitted: emittedCount },
    });

    const emittedEventIds: string[] = [];
    for (const emitted of dispatch.emitted) {
      const event = this.processObservation({
        monitor: emitted.monitor,
        sourceName: emitted.monitor.frontmatter.source,
        observation: emitted.observation,
        observedAt: emitted.observedAt,
        workspacePath: options.workspacePath,
      });
      emittedEventIds.push(event.id);
    }
    return emittedEventIds;
  }

  /**
   * Record a contained per-monitor source failure (G6) — a throw from
   * `source.observe()`. Writes a single `error` row to the `observation_history`
   * audit trail (surfaced by `agentmonitors monitor history`) and logs it, but
   * deliberately does **not** touch this monitor's persisted
   * source/notify/`lastObservationAt` state: leaving it untouched means the
   * monitor stays due and retries cleanly on the next tick rather than losing a
   * polling window to a transient source error. Only the tick loop's
   * `observe()` boundary calls this; `ingest()` failures are not routed here
   * (they surface as tick failures — see `tick()`).
   */
  private recordMonitorFailure(
    monitor: MonitorDefinition,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.recordObservationHistory({
      monitorId: monitor.id,
      sourceName: monitor.frontmatter.source,
      result: 'error',
      observationData: { error: message },
    });
    console.error(
      `[agentmonitors] monitor "${monitor.id}" (source "${monitor.frontmatter.source}") observe() failed; ` +
        `skipping it this tick and retrying next tick: ${message}`,
    );
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
      const source = this.registry.get(monitor.frontmatter.source);
      if (!source) {
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${monitor.frontmatter.source}".`,
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
    const iterable = watch(monitor.frontmatter.scope, {
      previousState: monitorState.sourceState,
      now: new Date(),
      signal,
    });
    try {
      for await (const observation of iterable) {
        if (signal.aborted) break;
        this.ingest(monitor, [observation], new Date(), { workspacePath });
        this.refreshWorkspaceSessions(workspacePath);
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
    if (monitor.frontmatter.source === 'schedule') {
      const cron = monitor.frontmatter.scope['cron'];
      const timezone = monitor.frontmatter.scope['timezone'];
      if (typeof cron !== 'string') return { due: false, nextPollMs: 60_000 };
      const due =
        cronMatchesDate(
          cron,
          now,
          typeof timezone === 'string' ? timezone : 'UTC',
        ) && elapsed >= 60_000;
      return { due, nextPollMs: 60_000 };
    }

    if (monitor.frontmatter.source === 'api-poll') {
      const interval = monitor.frontmatter.scope['interval'];
      const ms =
        typeof interval === 'string'
          ? parseDuration(interval)
          : DEFAULT_API_POLL_MS;
      return { due: elapsed >= ms, nextPollMs: ms };
    }

    const genericInterval = monitor.frontmatter.scope['interval'];
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
