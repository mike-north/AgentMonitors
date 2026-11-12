/**
 * Coordinate host-neutral observation, pacing, durable admission and session delivery.
 * Deterministic persistence completes before optional interpretation; source plugins
 * own acquisition while adapters own host-specific interaction. Source config must
 * pass the authoring contract before execution; rejected config pauses work without
 * consuming its durable baseline.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { ulid } from 'ulid';
import { writePrivateFileAtomic } from '../security/local-permissions.js';
import { scanMonitors } from '../parser/scan-monitors.js';
import {
  parseMonitorFile,
  type ParseOutcome,
} from '../parser/parse-monitor.js';
import type { MonitorDefinition, Urgency } from '../schema/types.js';
import { monitorFrontmatterSchema } from '../schema/monitor-schema.js';
import { validateWatchScope } from '../schema/validate-scope.js';
import { parseDuration } from '../notify/notifier.js';
import type {
  Observation,
  ObservationSource,
  ObservationResult,
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
  classifyCoalescingWithheldHold,
  classifyReminderHold,
  classifySettleWindowHold,
  type HookDeliveryDiagnosis,
  type HookDeliveryHold,
} from './hook-delivery-diagnosis.js';
import {
  MaterializationRetryNotFoundError,
  MaterializationRetryTransitionError,
  RuntimeStore,
  computeNetCollapseView,
  netCollapseGroupKey,
} from './store.js';
import {
  heldMonitorIds,
  withStoreWriter,
  learnNotifyPolicyIdentity,
  commitNotifyPolicyEdit,
} from './store-writer.js';
import {
  notifyPolicyKey,
  storedNotifyPolicyMatches,
  validateCapturedNotifyEnvelope,
  capturedNotifyRoute,
  type PolicyNotifyState,
} from './notify-policy.js';
import { DeliveryReservationRegistry } from './delivery-reservations.js';
import { serializeRetryEnvelope } from './retry-envelope.js';
import {
  SAFE_DIAGNOSTIC_TEXT_MAX,
  safeDiagnosticText,
} from './diagnostic-text.js';
import {
  rethrowIfRuntimeTransactionAborted,
  runRuntimeTransaction,
} from './runtime-transaction.js';
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
  MaterializationRetryDiagnostic,
  MaterializationRetryRecord,
  MaterializationRetryRepairInput,
  MaterializationRetrySkipInput,
  MaterializationRetrySummary,
  MonitorDoctorReport,
  MonitorEventRecord,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorExplainStage,
  ErroredObservation,
  MonitorExplainStageId,
  MonitorExplainStageStatus,
  ObservationHistoryQuery,
  EphemeralMonitorWork,
  OrphanedMonitorWork,
  ObservationHistoryRecord,
  OpenSessionInput,
  PollingDecision,
  ProcessObservationInput,
  UnretainedObservationLoss,
  RuntimeTickResult,
  StoredObservationEnvelope,
  WatchHandle,
} from './types.js';
import {
  defaultNotifyConfigForUrgency,
  EPHEMERAL_MONITOR_ID_PREFIX,
  MATERIALIZATION_RETRY_DELAYS_MS,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  type NotifyDispatchResult,
  type NotHeldObservation,
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
 * (`nextPollMs`) when none is authored. Authored cadence remains descriptive
 * even for invalid config; without safe scheduling or an authored cadence the
 * descriptor is unknown rather than inventing a default.
 */
function describeCadence(
  watch: Record<string, unknown>,
  nextPollMs: number | undefined,
): string {
  if (watch['type'] === 'schedule') {
    const cron = watch['cron'];
    return typeof cron === 'string' ? `cron '${cron}'` : 'schedule';
  }
  const interval = watch['interval'];
  if (typeof interval === 'string') return `every ${interval}`;
  return nextPollMs === undefined
    ? 'unknown'
    : `every ${String(Math.round(nextPollMs / 1000))}s`;
}
/**
 * Semantic, transport-neutral body for a coalesced normal/low-urgency reminder
 * (002 §9.2/§9.3). This is the message a `DeliveryClaim` with no event bodies
 * carries.
 *
 * Two properties, each fixing a defect of the former `NORMAL_INBOX_PROMPT`
 * (`'AgentMon messages are available. Read the inbox.'`, issue #438):
 *
 * 1. **No product-name attribution.** Attribution is a property of the delivery
 *    SURFACE, owned by each transport — the hook adapter prefixes its own label
 *    (its `additionalContext` arrives unlabeled), while the channel adds none
 *    (its `<channel source="agentmonitors">` tag already names the source).
 *    Emitting "AgentMon" here double-attributed the channel. So the runtime,
 *    per the host-agnostic-core rule, emits only the semantic message.
 * 2. **No reference to the legacy `inbox` model.** `inbox_items` is
 *    non-authoritative (002 §12); the authoritative path is
 *    events/session-projection. "Read the inbox" pointed at a deprecated
 *    concept with no runnable referent.
 *
 * **No CLI verb, either (PR #445 review, finding 2).** A prior revision of
 * this function also embedded the concrete `agentmonitors events list`/`ack`
 * commands — but the CHANNEL transport pushes this string verbatim into its
 * `<channel>` tag body, and a channel-connected agent acknowledges through the
 * `agentmon_ack` MCP tool (`channel.ts`), not the CLI. Baking one transport's
 * verb into the shared, transport-neutral message put conflicting
 * instructions on the channel surface. Each transport now supplies its OWN
 * concrete action step, with its OWN sessionId/socket already available on the
 * `DeliveryClaim`/render options: the hook transport appends
 * `agentmonitors events list`/`ack` commands (`hook-deliver-render.ts`'s
 * `buildHookReminderActionStep`); the channel transport points at its
 * `agentmon_ack` tool (`channel-render.ts`). This keeps the runtime
 * host-agnostic (AP6) while still leaving each delivered payload
 * self-sufficient and actionable (issue #438) — the acknowledge step just
 * moves from this shared sentence to each transport's own phrasing (issue
 * #434 is unaffected: every transport's phrasing still names it).
 */
function reminderMessage(): string {
  return 'Monitored changes are pending.';
}

/**
 * Appended to a `turn-interruptible` high-urgency delivery's message when a
 * normal-urgency reminder is ALSO due in the same call (issue #441 —
 * cross-monitor coalescing). Reuses the exact transport-neutral
 * {@link reminderMessage} body so the coalesced reminder reads identically to a
 * standalone normal reminder — just one more line of the same message rather
 * than a separate delivery. Per #445's wording contract (002 §9.2 / 006
 * §5.1.1) this shared suffix carries ONLY the semantic body — no product
 * prefix, no CLI/tool verb. Each transport appends its own acknowledge action
 * step (hook: `agentmonitors events ack`; channel: `agentmon_ack`) from the
 * claim's `coalescedReminder` field when it renders the footer.
 */
const COALESCED_NORMAL_SUFFIX = `\n\n${reminderMessage()}`;

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

/**
 * Explain reasons are display text, not a replacement for source audit bytes.
 * Keep legacy errors to one terminal-safe line and 512 Unicode code points,
 * including the truncation marker. CLI history mirrors this private policy
 * without expanding the core plugin API with a presentation-only helper.
 */
function displayObservationError(
  value: unknown,
  limit = 512,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = stripVTControlCharacters(value)
    // eslint-disable-next-line no-control-regex -- Remove literal terminal control bytes from legacy diagnostics.
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const points = Array.from(line);
  return points.length > limit
    ? `${points.slice(0, limit - 3).join('')}...`
    : line || undefined;
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

/**
 * Sorts object keys recursively so equal values serialize identically whatever
 * order, or whitespace, the author wrote them in.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * `watch` keys the scheduling engine reads to decide WHEN to observe, which no
 * source reads to decide WHAT it observes. Each bundled poll source declares
 * `interval` as "used by the scheduling engine, not by this plugin directly"
 * (`source-api-poll`, `source-command-poll`, `source-incoming-changes`;
 * `source-file-fingerprint` documents it as the observe interval), and
 * `scheduleForMonitor` is the only reader. The `schedule` source's `cron` and
 * `timezone` are NOT listed: the scheduler reads them too, but that source also
 * writes them into its observation's payload and `objectKey`, so they shape what
 * an event is.
 */
const SCHEDULING_ONLY_WATCH_KEYS: readonly string[] = ['interval'];

/**
 * A short content fingerprint of the parts of a monitor's definition that decide
 * what an event IS: how it was observed, what it carries, and how it is
 * presented (issue #451).
 *
 * Included, with the reason each can change a stored or delivered event:
 * - `urgency`, `urgencyMax`: the event's delivery urgency.
 * - the body (`instructions`): the delivered body when the source supplies none.
 * - `name`: the delivered title (`name` wins over the source's title, 002 §5.4).
 * - `watch` minus {@link SCHEDULING_ONLY_WATCH_KEYS}: the source and its
 *   configuration (command, query, globs, ...) decide the payload and `objectKey`.
 * - `shape` and `payload`: derive facts, render the snapshot, and transform the
 *   delivered payload before diffing, so they change the stored snapshot, diff
 *   and payload.
 * - `baselineStrategy`: stored on the event and decides how each recipient's
 *   catch-up span is collapsed at delivery.
 *
 * Excluded because they change neither the observation nor the delivered text:
 * `notify` (when events materialize, not what they contain), `tags` (a label
 * used only to filter `events list`), and the scheduling keys above.
 *
 * Objects are hashed in canonical key order, so key order and whitespace in the
 * source file do not matter; array order does.
 *
 * Persisted on each materialized event and recomputed from the CURRENT monitor in
 * `explainMonitor`, so the two can be compared without touching the event's own
 * stored fields. A read-only diagnostic aid, never a second source of truth for
 * delivery content.
 *
 * @see docs/specs/002-runtime-delivery.md §5.3
 */
function definitionFingerprint(monitor: MonitorDefinition): string {
  const frontmatter = monitor.frontmatter;
  const watch = Object.fromEntries(
    Object.entries(frontmatter.watch).filter(
      ([key]) => !SCHEDULING_ONLY_WATCH_KEYS.includes(key),
    ),
  );
  const material = JSON.stringify(
    canonicalize({
      urgency: frontmatter.urgency,
      urgencyMax: frontmatter.urgencyMax,
      instructions: monitor.instructions,
      name: frontmatter.name,
      watch,
      shape: frontmatter.shape,
      payload: frontmatter.payload,
      baselineStrategy: frontmatter.baselineStrategy,
    }),
  );
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
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

/**
 * Longest observation title, in code points, a not-held outcome message
 * carries. It is well below the 512-code-point display cap that history and
 * explain apply to the whole message, so a long title can never push the
 * start of the serializer's reason out of the human views; a long reason can
 * still be cut there, while the stored row keeps it whole (002 §4.7).
 */
const NOT_HELD_TITLE_LIMIT = 200;

/**
 * Admission check for held notify work (002 §4.7). Debounce and rollup holds
 * persist their envelopes as JSON in `monitor_state.notify_state`, so an
 * envelope `JSON.stringify` cannot encode (a BigInt, a cyclic reference, a
 * throwing `toJSON` or getter) would make every later state write for the
 * monitor fail. The check runs the same serializer the hold write uses, once,
 * where an envelope would join a hold; an envelope that passes stays
 * serializable inside every later hold write.
 *
 * Limit: the hold write serializes the envelope again, so the check proves
 * serializability only for values that serialize the same way twice. A
 * non-deterministic accessor (one that returns a BigInt only on a later read)
 * can still pass this check and fail the later write; that is not defended.
 *
 * Total by construction: building the outcome text never throws, even when
 * the serializer threw a value whose own `toString` throws. Such a reason
 * falls back to a fixed string.
 *
 * Returns `undefined` when the envelope can be held, otherwise the complete
 * single-line `errored` outcome text naming the observation, the strategy and
 * the serializer's reason.
 */
function notHeldReason(
  envelope: StoredObservationEnvelope,
  strategy: 'debounce' | 'rollup',
): string | undefined {
  try {
    JSON.stringify(envelope);
    return undefined;
  } catch (error) {
    let reason: string | undefined;
    try {
      reason = displayObservationError(
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // A hostile thrown value whose conversion to text throws: use the fixed
      // reason rather than let the refusal itself escape and wedge the monitor.
    }
    let title: string | undefined;
    try {
      title = displayObservationError(
        envelope.observation.title,
        NOT_HELD_TITLE_LIMIT,
      );
    } catch {
      // Same guard for a title that is not a plain string.
    }
    return `Observation "${title ?? '(untitled)'}" was not held for ${strategy}: it cannot be serialized (${reason ?? 'unknown serialization error'}).`;
  }
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
 *
 * `perRecipientDiffs` maps each surfaced event id → the delta THIS recipient
 * computed against its OWN baseline cursor (`session_event_state.diff_text`,
 * G10 / 002 §1.1.2). Surfacing the per-recipient delta — not the shared
 * latest-snapshot delta on `MonitorEventRecord.diffText` — is what keeps the
 * change summary correct under divergent recipient cursors: a session last seen
 * at `a1` receives the full `a1→a3` span, while a session already caught up to
 * `a2` receives only `a2→a3` from the same shared observation (session isolation,
 * issue #436). The shared `MonitorEventRecord.diffText` is used only as the
 * legacy fallback for pre-G10 rows whose per-recipient column is NULL (mirroring
 * `perRecipientDiffsForSession`'s own contract and the explain projection).
 */
function toDeliveryEventSummary(
  event: MonitorEventRecord,
  digests: Map<string, string>,
  perRecipientDiffs: Map<string, string>,
): DeliveryEventSummary {
  // Per-recipient delta (this session's own baseline span) when present; the
  // shared latest-snapshot delta only for legacy NULL rows (issue #436).
  const diffText = perRecipientDiffs.get(event.id) ?? event.diffText;
  return {
    eventId: event.id,
    monitorId: event.monitorId,
    title: event.title,
    summary: recipientSummary(event, digests),
    // The deterministic per-object detail, deliberately NOT digest-preferring
    // (unlike `summary` above): a transport naming which object this event is
    // about must not lose identity to a digest that carries none (issue #449
    // review).
    objectDetail: event.summary,
    urgency: event.urgency,
    createdAt: event.createdAt.toISOString(),
    body: event.body,
    // Surface the change summary when the recipient has one; a transport bounds
    // it before rendering (issue #436). Prefer `undefined` over `null` on the
    // delivery summary (optional-field convention), so omit it for a null diff.
    ...(diffText ? { diffText } : {}),
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
  skippedMonitors: RuntimeTickResult['skippedMonitors'];
}

/** Committed event plus its exact recipient set for post-commit interpretation. */
interface MaterializedObservation {
  monitor: MonitorDefinition;
  event: MonitorEventRecord;
  diffText: string | null;
  projectedSessionIds: string[];
}

/**
 * A dispatched observation that did not become an event in its span. Each one
 * has exactly one durable outcome, committed with the span's source/notify
 * state (002 §2): either a retained outbox row (the failed envelope and every
 * later sibling, in order), or, when the outbox cannot take that whole suffix,
 * a terminal `errored` observation-history row naming why it was not retained.
 */
interface MaterializationFailure {
  envelope: StoredObservationEnvelope;
  message: string;
  /** True when the retry outbox holds this envelope for a later attempt. */
  retained: boolean;
  /**
   * True only for the first failed write of a retained suffix, which gets a
   * best-effort post-commit `errored` audit row. Deferred siblings get none,
   * and an unretained failure's `errored` row was already committed in-span.
   */
  auditError: boolean;
}

/** Admission outcome distinguishes committed event ids from durable retry obligations. */
interface MaterializationSpanResult {
  emittedEventIds: string[];
  failures: MaterializationFailure[];
}

/** Inputs shared by durable admission and its best-effort post-commit reporting. */
interface MaterializationSpanOptions {
  /** Raw source count before shaping/pacing, used only for audit classification. */
  observed: number;
  /**
   * How many of the `observed` observations a hold refused (002 §4.7). Each
   * has its own `errored` loss row from the admission transaction, so they do
   * not count toward `suppressed`, and a span made only of them writes no
   * batch row. Kept apart from `notRetainedCount` because the cause differs,
   * but both are loss: a batch row with either count supersedes no drop.
   */
  notHeld?: number;
  workspacePath: string;
  nextMonitorState: {
    sourceState?: unknown;
    notifyState: PolicyNotifyState;
    lastObservationAt?: Date | null;
  };
  sourceOutcome?: 'rebaselined' | 'no-files-matched';
  /** Restricts ephemeral monitor projections to their declaring session. */
  ephemeralSessionId?: string;
}

/** Deterministic span result; interpretation may use it only after outer commit. */
interface DurableMaterializationSpan {
  materialized: MaterializedObservation[];
  failures: MaterializationFailure[];
}

/** The baseline a retained poll result was observed from; both are set together. */
function retainedBaseline(admission: PollAdmission): string {
  if (admission.expectedSourceState === undefined) {
    throw new Error('Retained poll result has no captured source baseline.');
  }
  return admission.expectedSourceState;
}

/** Match the persisted source baseline representation without retaining source-mutable objects. */
function sourceStateToken(state: unknown): string {
  return JSON.stringify(state ?? {});
}

/** Require an explicit finite source batch at the untyped plugin boundary. */
function isObservationBatch(value: unknown): value is ObservationResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    'observations' in value &&
    Array.isArray(value.observations) &&
    value.observations.every(
      (observation: unknown) =>
        observation !== null &&
        typeof observation === 'object' &&
        'title' in observation &&
        typeof observation.title === 'string',
    )
  );
}

/** Preserve a useful failure description without assuming the thrown value is an Error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Which observation a loss names, for one-line display: `observation 300 of 600 (object-299, "Title")`. */
function describeUnretainedObservation(
  loss: UnretainedObservationLoss,
): string {
  const position =
    loss.position !== undefined
      ? `observation ${String(loss.position)}${loss.spanSize !== undefined ? ` of ${String(loss.spanSize)}` : ''}`
      : 'an observation';
  const identity = [
    ...(loss.objectKey !== undefined ? [loss.objectKey] : []),
    ...(loss.title !== undefined ? [`"${loss.title}"`] : []),
  ];
  return identity.length > 0
    ? `${position} (${identity.join(', ')})`
    : position;
}

/**
 * Explain's materialization-stage reason for outstanding loss (002 §10.7).
 * One wording covers every kind of loss; the newest loss's own error says why
 * it was lost (an outbox drop or a hold refusal).
 */
function unretainedLossReason(loss: UnretainedObservationLoss): string {
  const error = displayObservationError(loss.error);
  return `${String(loss.count)} observation(s) were dropped because the runtime could not keep them; the newest, ${describeUnretainedObservation(loss)}, failed: ${error ?? 'no error was recorded'}`;
}

/** Wire-stable details: ISO timestamps, so socket and in-process reports agree. */
function unretainedLossDetails(
  loss: UnretainedObservationLoss,
): Record<string, unknown> {
  return {
    unretainedObservationLoss: {
      ...loss,
      recordedAt: loss.recordedAt.toISOString(),
    },
  };
}

/**
 * The durable outcome of an observation admission dropped because the retry
 * outbox could not retain its ordered suffix (002 §2 and `observation_history`).
 * It names which observation was lost (its position in the span, and its
 * `objectKey`/`title` when they are strings) so separate drops stay
 * distinguishable, and marks the row `notRetained` for diagnostics. Every text
 * field is control-normalized and capped like retry errors; the payload is
 * never copied. The materialization error is shortened, if needed, so the
 * `Not retained for retry:` reason always fits the cap.
 */
function unretainedObservationData(
  observation: Observation,
  materializationError: string,
  refusal: string,
  index: number,
  spanSize: number,
): {
  error: string;
  notRetained: true;
  position: number;
  spanSize: number;
  objectKey?: string;
  title?: string;
} {
  const reason = safeDiagnosticText(` Not retained for retry: ${refusal}.`);
  const error = safeDiagnosticText(
    safeDiagnosticText(materializationError).slice(
      0,
      Math.max(0, SAFE_DIAGNOSTIC_TEXT_MAX - reason.length),
    ) + reason,
  );
  return {
    error,
    notRetained: true,
    position: index + 1,
    spanSize,
    ...lostObservationIdentity(observation),
  };
}

/**
 * The display-safe identity a loss row stores for the observation it lost
 * (002 `observation_history`): its `objectKey` and `title`, each only when it
 * is a string, control-normalized and capped. Source contracts type these as
 * strings, but a failing observation is the one most likely to break its
 * contract. The payload is never copied.
 */
function lostObservationIdentity(observation: Observation): {
  objectKey?: string;
  title?: string;
} {
  const { objectKey, title } = observation as {
    objectKey?: unknown;
    title?: unknown;
  };
  return {
    ...(typeof objectKey === 'string'
      ? { objectKey: safeDiagnosticText(objectKey) }
      : {}),
    ...(typeof title === 'string' ? { title: safeDiagnosticText(title) } : {}),
  };
}

/**
 * The durable outcome of an observation a debounce or rollup hold refused
 * (002 §4.7), recorded as loss (002 §2). `error` is the refusal's complete
 * outcome text, unchanged; `holdRefused` marks the row for diagnostics, and
 * the identity names which observation was lost. A refusal has no position in
 * a dispatched span, so none is recorded.
 */
function heldRefusalData(refusal: NotHeldObservation): {
  error: string;
  holdRefused: true;
  objectKey?: string;
  title?: string;
} {
  return {
    error: refusal.message,
    holdRefused: true,
    ...lostObservationIdentity(refusal.observation),
  };
}

/**
 * The durable outcome of a terminal retry an operator skipped (002 §2.7),
 * recorded as loss (002 §2). `error` is the retry's last error followed by
 * `Retry skipped after <n> failed attempts.`, with the operator's reason when
 * one was given; `skipped` marks the row for diagnostics, `retryId` names the
 * removed retry, and the identity names which observation was lost. It has no
 * span position, since the retry outlived the span that admitted it. The
 * last error is shortened, if needed, so the skip note always fits the cap.
 */
function skippedRetryObservationData(
  retry: MaterializationRetryRecord,
  reason: string | undefined,
): {
  error: string;
  skipped: true;
  retryId: string;
  objectKey?: string;
  title?: string;
} {
  const note = reason?.trim() ? `: ${reason.trim()}` : '';
  const suffix = safeDiagnosticText(
    ` Retry skipped after ${String(retry.attemptCount)} failed attempts${note}.`,
  );
  const error = safeDiagnosticText(
    safeDiagnosticText(retry.lastError ?? 'Materialization failed.').slice(
      0,
      Math.max(0, SAFE_DIAGNOSTIC_TEXT_MAX - suffix.length),
    ) + suffix,
  );
  return {
    error,
    skipped: true,
    retryId: retry.id,
    ...lostObservationIdentity(retry.envelope.observation),
  };
}

/**
 * What the store keeps for one lost observation (002 §2), whatever the kind of
 * loss: the observation's raw `objectKey`, which is what supersedes the loss
 * (a later event for exactly this key), and the display-safe outcome row.
 * Only a string key counts; the display-safe copy in `observationData` is
 * never used for matching.
 */
function observationLossRecord(
  observation: Observation,
  observationData: Record<string, unknown> & { error: string },
): {
  objectKey: string | undefined;
  observationData: Record<string, unknown> & { error: string };
} {
  const { objectKey } = observation as { objectKey?: unknown };
  return {
    objectKey: typeof objectKey === 'string' ? objectKey : undefined,
    observationData,
  };
}

/** One shell word: plain ids stay bare, anything else is single-quoted. */
function shellWord(value: string): string {
  return /^[\w.:/@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The CLI repairs for one terminal retry, as named in reports (005 `monitor retry`). */
function retryRepairCommands(
  monitorId: string,
  retryId: string,
): { rearm: string; skip: string } {
  const target = `${shellWord(monitorId)} ${shellWord(retryId)}`;
  return {
    rearm: `agentmonitors monitor retry rearm ${target}`,
    skip: `agentmonitors monitor retry skip ${target}`,
  };
}

/**
 * The report for a terminal retry that keeps its monitor paused (002 §2.7):
 * which retry, why, and the two ways out.
 */
function terminalRetryMessage(
  monitorId: string,
  retry: MaterializationRetryRecord,
): string {
  const { rearm, skip } = retryRepairCommands(monitorId, retry.id);
  return `Materialization retry ${retry.id} stopped after ${String(retry.attemptCount)} failed attempts; newer input waits until it is re-armed or skipped. Retry it with \`${rearm}\`, or give it up as a recorded loss with \`${skip}\`. Last error: ${retry.lastError ?? 'unknown'}`;
}

/**
 * Explain's reason for an outbox holding terminal work: how many retries
 * stopped, and the repairs for the oldest one, which pauses the monitor.
 */
function terminalRetriesReason(
  monitorId: string,
  summary: MaterializationRetrySummary,
): string {
  const head = `${String(summary.terminal)} observation(s) exhausted automatic materialization retries and require operator repair.`;
  const oldest = summary.records.find(({ status }) => status === 'terminal');
  if (!oldest) return head;
  const { rearm, skip } = retryRepairCommands(monitorId, oldest.id);
  return `${head} Retry ${oldest.id} with \`${rearm}\`, or give it up as a recorded loss with \`${skip}\`.`;
}

/** A retry's operator-safe metadata: never its envelope or payload. */
function retryDiagnostic(
  retry: MaterializationRetryRecord,
): MaterializationRetryDiagnostic {
  return {
    id: retry.id,
    status: retry.status,
    attemptCount: retry.attemptCount,
    nextAttemptAt: retry.nextAttemptAt,
    lastError:
      retry.lastError === null ? null : safeDiagnosticText(retry.lastError),
    createdAt: retry.createdAt,
    updatedAt: retry.updatedAt,
  };
}

/** Report how many failures were queued or recorded errored, preserving the first error. */
function summarizeMaterializationFailures(
  failures: MaterializationFailure[],
): string {
  const first = failures[0]?.message ?? 'Unknown materialization failure.';
  if (failures.length === 1) return first;
  const retained = failures.filter((failure) => failure.retained).length;
  const unretained = failures.length - retained;
  const outcomes = [
    ...(retained > 0
      ? [
          `${String(retained)} observations were queued for materialization retry`,
        ]
      : []),
    ...(unretained > 0
      ? [
          `${String(unretained)} observations could not be retained and were recorded errored`,
        ]
      : []),
  ];
  return `${outcomes.join('; ')}. First error: ${first}`;
}

/**
 * How often a watcher held behind a terminal retry rechecks its outbox. A
 * terminal retry is never attempted automatically; the recheck only notices
 * that it was re-armed (or otherwise cleared) from another connection.
 */
const TERMINAL_RETRY_RECHECK_MS = 60_000;

/**
 * Why retained work still blocks newer source input after a drain attempt
 * (002 §2.7): an attempt failed this time, the oldest retry is terminal and
 * waits for an operator re-arm, or it is backing off until `nextAttemptAt`.
 */
type RetryDrainBlock =
  | { kind: 'failed'; message: string }
  | { kind: 'terminal'; message: string }
  | { kind: 'backoff'; nextAttemptAt: Date };

/** The outcome of draining one monitor's retry outbox oldest-first. */
interface RetryDrainResult {
  /** At least one retry was attempted, successfully or not. */
  attempted: boolean;
  /** Events completed from the outbox, in admission order. */
  emittedEventIds: string[];
  /** Present while retained work remains; the source must not be asked for more. */
  blocked?: RetryDrainBlock;
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Decides, inside one admission transaction, whether a failed observation can
 * be retained together with its whole ordered suffix (002 §2). A suffix is
 * retainable only when every envelope in it is inside the retry outbox's
 * plain-data domain and all of it fits the monitor's remaining outbox room.
 * Retaining part of a suffix is never an option: a later sibling would then
 * materialize ahead of an older queued observation of the same span.
 *
 * Each envelope is validated at most once and the outbox room is read once
 * per span, so a span with many failures stays linear. Nothing is enqueued
 * between decisions, because admission enqueues the one retained suffix only
 * after its loop ends.
 */
class SuffixRetention {
  /** First index whose suffix data has been computed; later indices reuse it. */
  private start: number | undefined;
  /** Serialized byte count of envelope `i`, or why it is outside the retry domain. */
  private readonly sizes: (number | string)[] = [];
  /** Total bytes of envelopes `i..end`, valid for `i >= start`. */
  private readonly suffixBytes: number[] = [];
  /** Nearest index `>= i` whose envelope is outside the retry domain. */
  private readonly firstInvalid: (number | undefined)[] = [];
  private remaining: { records: number; bytes: number } | undefined;

  constructor(
    private readonly store: RuntimeStore,
    private readonly monitorId: string,
    private readonly workspacePath: string,
    private readonly emitted: StoredObservationEnvelope[],
  ) {}

  /** `undefined` when `emitted[index..]` can be retained; otherwise why it cannot. */
  refusal(index: number): string | undefined {
    this.prepare(index);
    const invalid = this.firstInvalid[index];
    if (invalid !== undefined) {
      const reason = String(this.sizes[invalid]);
      return invalid === index
        ? `its envelope is not serializable for the retry outbox (${reason})`
        : `a later observation in its ordered suffix is not serializable for the retry outbox (${reason})`;
    }
    const remaining = this.remaining ?? { records: 0, bytes: 0 };
    const records = this.emitted.length - index;
    const bytes = this.suffixBytes[index] ?? 0;
    if (records > remaining.records || bytes > remaining.bytes) {
      return (
        `the retry outbox capacity is exhausted: its ordered suffix needs ${String(records)} records ` +
        `(${String(bytes)} bytes) but ${String(remaining.records)} records ` +
        `(${String(remaining.bytes)} bytes) remain for this monitor`
      );
    }
    return undefined;
  }

  private prepare(index: number): void {
    if (this.start !== undefined && index >= this.start) return;
    const end = this.emitted.length;
    const from = this.start ?? end;
    for (let i = index; i < from; i += 1) {
      const envelope = this.emitted[i];
      if (envelope === undefined) continue;
      try {
        this.sizes[i] = Buffer.byteLength(
          serializeRetryEnvelope(envelope),
          'utf8',
        );
      } catch (error) {
        this.sizes[i] = errorMessage(error);
      }
    }
    for (let i = from - 1; i >= index; i -= 1) {
      const size = this.sizes[i];
      const next = i + 1 < end ? (this.suffixBytes[i + 1] ?? 0) : 0;
      this.suffixBytes[i] = (typeof size === 'number' ? size : 0) + next;
      this.firstInvalid[i] =
        typeof size === 'string'
          ? i
          : i + 1 < end
            ? this.firstInvalid[i + 1]
            : undefined;
    }
    this.start = index;
    this.remaining ??= this.store.materializationRetryCapacity(
      this.monitorId,
      this.workspacePath,
    );
  }
}

/** One live poll's captured execution, returned-but-unadmitted work, and declaration lifetime. */
interface PollAdmission {
  readonly monitor: MonitorDefinition;
  readonly now: Date;
  readonly workspacePath: string;
  readonly ephemeralSessionId?: string;
  result?: ObservationResult;
  /**
   * The persisted source baseline `result` was observed from. Its later
   * admission is refused if that baseline has changed in the meantime.
   */
  expectedSourceState?: string;
  retired?: boolean;
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
   * watcher for an id from an earlier, torn-down one: a straggling batch
   * from a superseded watcher is rejected when its token no longer matches the
   * live entry, and each watcher only releases its own slot on exit. The tick
   * loop still uses membership (`has`) to skip `observe()` for actively-watched
   * monitors.
   */
  /** Identity belongs to one workspace/monitor, including a blocked startup. */
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
    const ephemerals = this.store.listEphemeralMonitorsForSession(sessionId);
    const session = this.store.closeSession(sessionId);
    // Reap the session's ephemeral monitors (007 §4.4): a session that ends or
    // goes dormant MUST release its session-scoped watches immediately — they
    // must not outlive the session, leak into another session, or resurrect
    // after a daemon restart. Reaping retains their already-materialized events
    // (the session record goes dormant, not deleted) so a late delivery is never
    // silently dropped (007 §4.4 default retention, PP1).
    this.store.reapEphemeralMonitorsForSession(sessionId);
    for (const record of ephemerals) this.retirePollAdmission(record.id);
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

    // 3b. Reject a whitespace-only `displayName` (issue #449 review): it is an
    //     ephemeral monitor's ONLY naming affordance (no frontmatter file), and it
    //     flows into `frontmatter.name` on every tick reconstruction
    //     (`ephemeralRecordToMonitor` below). A present-but-blank name would
    //     silently win over the source title there (002 §5.4's precedence) and
    //     durably headline every delivered event with whitespace. Mirrors the
    //     same rejection `monitorFrontmatterSchema`'s `name` field applies to a
    //     persistent monitor's frontmatter.
    if (input.displayName?.trim() === '') {
      throw new Error(
        'Invalid ephemeral monitor declaration: --display-name must contain ' +
          'non-whitespace characters when present.',
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
    this.retirePollAdmission(ephemeralId);
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
      // An explicit `--display-name` IS the authored name for an ephemeral
      // monitor — its only naming affordance, since it has no frontmatter file.
      // It must reach `frontmatter.name` (not just `displayName`) so the event
      // title rule (002 §5.4) treats ephemeral and persistent monitors
      // identically (007 §4.6). Absent, `name` stays unset and the source title
      // remains the fallback, exactly as for a nameless persistent monitor.
      ...(record.displayName ? { name: record.displayName } : {}),
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
          // Source preflight is separate: unrelated invalid config must not
          // shorten safely derivable cadence protection during cleanup.
          ttlMs: this.orphanSuppressionTtlMs(
            monitorsById.get(object.monitorId),
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
   * observe-and-settle cycle. Only unavailable or unparseable runtime cadence
   * uses the floor; unrelated source-schema errors do not erase authored timing
   * or known defaults. This is a bounded window, not proof that source/held work
   * has drained after an arbitrary pause. Source preflight still gates execution.
   */
  private orphanSuppressionTtlMs(
    monitor: MonitorDefinition | undefined,
  ): number {
    if (!monitor) return ORPHANED_VERIFY_SUPPRESSION_TTL_MS;
    const watch = monitor.frontmatter.watch;
    let nextPollMs: number;
    if (watch.type === 'schedule') {
      // Schedule observation cadence is fixed independently of cron validity.
      nextPollMs = schedulingDefaults.scheduleTickMs;
    } else if (watch['interval'] === undefined) {
      nextPollMs =
        watch.type === 'api-poll'
          ? DEFAULT_API_POLL_MS
          : DEFAULT_FILE_FINGERPRINT_POLL_MS;
    } else {
      const interval = watch['interval'];
      if (typeof interval !== 'string') {
        return ORPHANED_VERIFY_SUPPRESSION_TTL_MS;
      }
      // Catch only the pure duration parser. Cleanup must not turn storage or
      // unrelated scheduler failures into a silently shortened lifetime.
      try {
        nextPollMs = parseDuration(interval);
      } catch {
        return ORPHANED_VERIFY_SUPPRESSION_TTL_MS;
      }
    }
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

  /**
   * Return a terminal materialization retry to automatic retry (002 §2.7):
   * its attempts and last error reset and its first retry delay starts again,
   * with its identity, envelope and admission position unchanged. The monitor
   * stays paused until the retry completes; once it does, the monitor takes
   * newer input in order. A watcher paused on the retry is woken at once.
   *
   * @throws {@link MaterializationRetryNotFoundError} when no retry of this
   *   monitor in this workspace has the id.
   * @throws {@link MaterializationRetryTransitionError} when the retry is not
   *   terminal; a pending retry is still attempted automatically.
   */
  rearmMaterializationRetry(
    input: MaterializationRetryRepairInput,
  ): MaterializationRetryDiagnostic {
    this.terminalRetryFor(input, 're-armed');
    const rearmed = this.store.rearmMaterializationRetry(input.retryId);
    this.wakeRetryRepairWaiters(input.workspacePath, input.monitorId);
    return retryDiagnostic(rearmed);
  }

  /**
   * Give up a terminal materialization retry (002 §2.7): its observation is
   * recorded as an outstanding loss, with the retry's last error and the
   * optional reason, through the same loss record admission drops use (002
   * §2), and the retry is removed in the same transaction. The loss stays
   * reported by `doctorReport` and `explainMonitor` until a later event for
   * the observation's object key supersedes it. The monitor takes newer input
   * on its next tick once no other retained work remains ahead of it.
   *
   * Returns the retry as it was when it was skipped.
   *
   * @throws {@link MaterializationRetryNotFoundError} when no retry of this
   *   monitor in this workspace has the id.
   * @throws {@link MaterializationRetryTransitionError} when the retry is not
   *   terminal; a pending retry is still attempted automatically.
   */
  skipMaterializationRetry(
    input: MaterializationRetrySkipInput,
  ): MaterializationRetryDiagnostic {
    const current = this.terminalRetryFor(input, 'skipped');
    // The same loss record every other drop gets (002 §2); the store writes it
    // inside the skip's own transaction, at the retry's admission position.
    const skipped = this.store.skipMaterializationRetry(
      input.retryId,
      { monitorId: input.monitorId, workspacePath: input.workspacePath },
      observationLossRecord(
        current.envelope.observation,
        skippedRetryObservationData(current, input.reason),
      ),
    );
    this.wakeRetryRepairWaiters(input.workspacePath, input.monitorId);
    return retryDiagnostic(skipped);
  }

  /**
   * The retry an operator repair names, refused unless it belongs to the
   * given workspace/monitor and is terminal. The store re-checks both inside
   * its own transaction; this read exists to give a refusal its explanation.
   */
  private terminalRetryFor(
    input: MaterializationRetryRepairInput,
    verb: string,
  ): MaterializationRetryRecord {
    const current = this.store.getMaterializationRetry(input.retryId);
    if (
      current.monitorId !== input.monitorId ||
      current.workspacePath !== input.workspacePath
    ) {
      throw new MaterializationRetryNotFoundError(input.retryId);
    }
    if (current.status !== 'terminal') {
      const next = current.nextAttemptAt?.toISOString() ?? 'not scheduled';
      throw new MaterializationRetryTransitionError(
        input.retryId,
        `is ${current.status}, not terminal, so it cannot be ${verb}. It is still retried automatically (${String(current.attemptCount)} of ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} attempts failed; next attempt at ${next})`,
      );
    }
    return current;
  }

  async explainMonitor(
    input: MonitorExplainInput,
  ): Promise<MonitorExplainReport> {
    const now = input.now ?? new Date();
    const historyLimit = input.historyLimit ?? 10;
    const eventLimit = input.eventLimit ?? 10;
    // Retained work belongs to the workspace/monitor route, independently of
    // whether its current definition still exists or can be scheduled. Resolve
    // the same default scope as tick before any definition-error return.
    const workspacePath = input.workspacePath ?? input.monitorsDir;
    const stages: MonitorExplainStage[] = [];
    const scan = await scanMonitors(input.monitorsDir);
    // Read retry metadata after asynchronous discovery so work admitted while
    // it waits is not omitted beside the later event and history reads. Keep
    // this before definition refusals, which still need retained-work metadata.
    const materializationRetries = this.store.materializationRetrySummary(
      input.monitorId,
      workspacePath,
    );
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
        materializationRetries,
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
        materializationRetries,
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
        materializationRetries,
      };
    }

    const sourceName = monitor.frontmatter.watch.type;
    const source = this.registry.get(sourceName);
    const scopeErrors = source
      ? validateWatchScope(
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
      // The preflight stops a rejected config before admission, so it adds no
      // drop, but a drop admitted under the earlier config stays outstanding
      // until a later observation supersedes it (002 §2). Report it beside the
      // definition failure, which stays the verdict: the drop cannot vanish
      // while the config is rejected, as doctor keeps it on the invalid rollup.
      const unretainedLoss = this.store.outstandingUnretainedObservationLoss(
        input.monitorId,
        workspacePath,
      );
      if (unretainedLoss) {
        stages.push(
          explainStage(
            'materialization',
            'failure',
            unretainedLossReason(unretainedLoss),
            unretainedLossDetails(unretainedLoss),
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
        observations: [],
        events: [],
        projections: [],
        leadSessions: [],
        materializationRetries,
      };
    }

    stages.push(
      explainStage('definition', 'ok', 'Monitor definition is valid.', {
        filePath: monitor.filePath,
        sourceName,
      }),
    );

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
        materializationRetries,
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
      const error = displayObservationError(
        latestObservation.observationData['error'],
      );
      stages.push(
        explainStage(
          'observation',
          'failure',
          error
            ? `Source observation failed: ${error}`
            : 'The most recent source observation errored.',
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
    // A dropped observation was never retained, so no retry summary reflects
    // it; the durable drop rows are its only trace (002 §2, §10.7). It outranks
    // the retry branches: retained work can still be recovered, a drop cannot.
    const unretainedLoss = this.store.outstandingUnretainedObservationLoss(
      input.monitorId,
      workspacePath,
    );
    if (unretainedLoss) {
      stages.push(
        explainStage(
          'materialization',
          'failure',
          unretainedLossReason(unretainedLoss),
          unretainedLossDetails(unretainedLoss),
        ),
      );
    } else if (materializationRetries.terminal > 0) {
      stages.push(
        explainStage(
          'materialization',
          'failure',
          terminalRetriesReason(input.monitorId, materializationRetries),
          { ...materializationRetries },
        ),
      );
    } else if (materializationRetries.pending > 0) {
      stages.push(
        explainStage(
          'materialization',
          'pending',
          `${String(materializationRetries.pending)} observation(s) are durably queued for materialization retry.`,
          { ...materializationRetries },
        ),
      );
    } else if (events.length === 0) {
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
      // Explain absent reminders without changing state. Old claims explain
      // silence only when no fresh work remains; a reservation explains a
      // temporary same-band hold. Counts are session-scoped across monitors,
      // restricted to sessions this monitor still projects unread work into.
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
            // Split out from claimedCount (round 10): a leased row is NOT a
            // durable claim and must never be reported as one an ack can clear.
            leasedCount: this.leasedPendingCount(sessionId, urgency),
          });
        }
      }
      const reminderSuppression = diagnoseReminderSuppression(reminderCounts);
      const reminderSuffix =
        reminderSuppression.length > 0
          ? ` ${reminderSuppression.map((finding) => finding.message).join(' ')}`
          : '';

      // Definition-drift diagnostic (issue #451): a pending event whose OWN
      // stored `definitionFingerprint` differs from the monitor's CURRENT
      // fingerprint was observed under a since-edited definition (anything
      // `definitionFingerprint` covers: urgency, body, name, source and its
      // configuration, shape, payload, baseline strategy). "Pending" means
      // unacknowledged AND still deliverable: a projection already
      // net-collapsed or Interpret-suppressed never delivers and is excluded.
      // Not itself a bug — the event still delivers with what was in force when
      // it was observed — but an author debugging an unexpected delivery needs
      // to see that the definition has changed. A `null` fingerprint (a row from
      // before the field existed) is "unknown", never flagged. Counted over ALL
      // pending events for the monitor, not the `eventLimit`-bounded list above,
      // with a single synchronous query.
      const staleEventIds = this.store.pendingEventIdsOutsideDefinition(
        input.monitorId,
        workspacePath,
        definitionFingerprint(monitor),
      );
      const staleSuffix =
        staleEventIds.length > 0
          ? ` ${String(staleEventIds.length)} pending event(s) in total predate the monitor's current definition (its urgency, body, name, source configuration, shape, payload or baseline strategy changed since they were observed) — they will still deliver with the urgency/body in force when THEY were observed, not the current one, unless a newer change to the same object supersedes them.`
          : '';

      const deliveryDetails: Record<string, unknown> = { ...counts };
      if (interpretVerdicts.length > 0) {
        deliveryDetails['interpret'] = interpretVerdicts;
      }
      if (reminderSuppression.length > 0) {
        deliveryDetails['reminderSuppression'] = reminderSuppression;
      }
      if (staleEventIds.length > 0) {
        deliveryDetails['staleDefinitionEventIds'] = staleEventIds;
      }
      stages.push(
        explainStage(
          'delivery',
          'ok',
          `Events are projected to lead sessions (${Object.entries(counts)
            .map(([state, count]) => `${state}: ${String(count)}`)
            .join(', ')}).${interpretSuffix}${reminderSuffix}${staleSuffix}`,
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
      materializationRetries,
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

    // A duplicate id has no unambiguous current definition. Keep its retained
    // work in the orphaned group exactly once, rather than attributing it to
    // each conflicting definition and multiplying the reported obligations.
    const duplicateMonitorIds = new Set(scan.duplicateIds.map(({ id }) => id));
    const monitors: DoctorMonitorRollup[] = [];
    let invalidCount = 0;
    for (const { monitor } of scan.monitors) {
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      const scopeErrors = source
        ? validateWatchScope(
            watchConfig(monitor.frontmatter.watch),
            source.scopeSchema,
          )
        : [`Unknown source "${sourceName}".`];

      const runtimeState = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      // A rejected scope is not safe input to scheduling (for example, an
      // invalid interval would throw from parseDuration). Preserve the shared
      // validation diagnostic and leave its due time unknown until correction.
      // Valid scopes retain the existing scheduler and its timezone diagnostic;
      // unrelated scheduling failures are not swallowed by this boundary.
      const schedule =
        scopeErrors.length === 0
          ? this.scheduleForMonitor(monitor, now, workspacePath)
          : undefined;
      const validationErrors = schedule?.error ? [schedule.error] : scopeErrors;
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

      const nextDueAt =
        !valid || schedule === undefined
          ? undefined
          : schedule.due
            ? now
            : new Date(
                (lastObservedAt?.getTime() ?? now.getTime()) +
                  schedule.nextPollMs,
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
      const materializationRetries = duplicateMonitorIds.has(monitor.id)
        ? undefined
        : this.store.materializationRetrySummary(monitor.id, workspacePath);
      // Like retained work, a duplicated id's drops belong to its orphan group
      // once, not to each conflicting definition.
      const unretainedObservationLoss = duplicateMonitorIds.has(monitor.id)
        ? undefined
        : this.store.outstandingUnretainedObservationLoss(
            monitor.id,
            workspacePath,
          );

      monitors.push({
        id: monitor.id,
        displayName: monitor.displayName,
        sourceName,
        urgency: monitor.frontmatter.urgency,
        valid,
        ...(valid ? {} : { validationError: validationErrors.join('; ') }),
        ...(lastObservedAt ? { lastObservedAt } : {}),
        neverObserved,
        due: valid && (schedule?.due ?? false),
        ...(nextDueAt ? { nextDueAt } : {}),
        cadence: describeCadence(
          monitor.frontmatter.watch,
          schedule?.nextPollMs,
        ),
        ...(lastEventAt ? { lastEventAt } : {}),
        delivery,
        ...(materializationRetries ? { materializationRetries } : {}),
        ...(unretainedObservationLoss ? { unretainedObservationLoss } : {}),
      });
    }

    // Discover routes from metadata, not captured envelopes or a capped row
    // listing. Capacity is per monitor, so a full outbox cannot hide another.
    // A rollup row represents its id's recovery obligations exactly when it
    // carries the retry summary (one parsed, non-duplicated definition). Every
    // other id with retained work or an outstanding drop is attributed once:
    // to its live ephemeral monitor, or else to an orphan group, so neither
    // can disappear with its definition or its declaration (002 §2).
    const representedMonitorIds = new Set(
      monitors
        .filter(
          ({ materializationRetries }) => materializationRetries !== undefined,
        )
        .map(({ id }) => id),
    );
    const retainedMonitorIds = new Set(
      this.store.materializationRetryMonitorIds(workspacePath),
    );
    const orphanedMonitorWork: OrphanedMonitorWork[] = [];
    const ephemeralMonitorWork: EphemeralMonitorWork[] = [];
    for (const monitorId of [
      ...new Set([
        ...retainedMonitorIds,
        ...this.store.unretainedObservationMonitorIds(workspacePath),
      ]),
    ]
      .filter((id) => !representedMonitorIds.has(id))
      .sort()) {
      const unretainedObservationLoss =
        this.store.outstandingUnretainedObservationLoss(
          monitorId,
          workspacePath,
        );
      const materializationRetries = retainedMonitorIds.has(monitorId)
        ? this.store.materializationRetrySummary(monitorId, workspacePath)
        : undefined;
      if (!materializationRetries && !unretainedObservationLoss) continue;
      const work = {
        ...(materializationRetries ? { materializationRetries } : {}),
        ...(unretainedObservationLoss ? { unretainedObservationLoss } : {}),
      };
      const ephemeral = monitorId.startsWith(EPHEMERAL_MONITOR_ID_PREFIX);
      // A live ephemeral monitor never has a definition file; its work is its
      // own, not orphaned. Once cancelled or reaped it is retired, and its
      // obligations stay visible as an orphan like a removed definition's.
      const declaration = ephemeral
        ? this.store.findEphemeralMonitorById(monitorId)
        : null;
      if (declaration?.status === 'active') {
        // The tick's own preflight (`evaluateMonitorOnTick`): a persisted scope
        // the source now rejects is skipped on every tick and cannot be edited.
        // An unknown source or an unrebuildable record is an errored
        // observation on the tick, not a scope rejection, so it is not
        // reported here; doctor must not throw while diagnosing it.
        const liveSource = this.registry.get(declaration.sourceName);
        let scopeErrors: string[] = [];
        if (liveSource) {
          try {
            scopeErrors = validateWatchScope(
              watchConfig(
                this.ephemeralRecordToMonitor(declaration).frontmatter.watch,
              ),
              liveSource.scopeSchema,
            );
          } catch {
            scopeErrors = [];
          }
        }
        ephemeralMonitorWork.push({
          monitorId,
          sessionId: declaration.sessionId,
          ...work,
          ...(scopeErrors.length > 0
            ? { validationError: scopeErrors.join('; ') }
            : {}),
        });
      } else {
        orphanedMonitorWork.push({
          monitorId,
          monitorKind: ephemeral ? 'ephemeral' : 'persistent',
          ...work,
        });
      }
    }

    return {
      generatedAt: now,
      monitorsDir,
      workspacePath,
      monitorsDirExists,
      monitors,
      orphanedMonitorWork,
      ephemeralMonitorWork,
      invalidCount,
      duplicateIds: scan.duplicateIds,
      parseErrors,
      leadSessions,
      hasLeadSession: leadSessions.length > 0,
    };
  }

  /**
   * Acknowledge events for a session. Omitting `eventIds` acknowledges every
   * unread event for the session **except all rows** currently leased by an
   * outstanding delivery reservation (issue #300) — `reservedEventIds`
   * returns every candidate held by every live reservation for this session,
   * so more than one row can be excluded at once. Those rows are left unread
   * so they can still be redelivered if a reservation is released rather
   * than committed.
   */
  acknowledgeSession(sessionId: string, eventIds?: string[]): void {
    let ids = eventIds;
    if (!ids) {
      // Exclude rows currently LEASED by an in-flight channel-push reservation
      // (issue #300, PR #445 review round 10): acknowledging a leased-but-
      // unclaimed row before the push resolves can permanently lose it — if
      // the push later rejects/disconnects, `releaseDelivery` returns the row
      // to `pending`, but it would already be (wrongly) acknowledged and would
      // never redeliver. A scoped ack (explicit `eventIds`, e.g. from a hook
      // body-injection instruction) is a deliberate caller choice naming rows
      // it actually saw and is NOT filtered here.
      const reserved = this.reservations.reservedEventIds(sessionId);
      ids = this.store
        .unreadEventsForSession(sessionId)
        .filter((event) => !reserved.has(event.id))
        .map((event) => event.id);
    }
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
   * The count of a band's pending (unclaimed) events that are currently held
   * out of {@link pendingForClaim} because they are LEASED by an outstanding
   * reservation (006 §4, issue #300; PR #445 review round 10) — i.e. an
   * in-flight channel push is mid-surfacing them, not a durable claim. Callers
   * that explain WHY a coalesced reminder is held (`monitor explain`,
   * {@link diagnoseHookDelivery}) need this split out from truly-claimed rows:
   * a lease resolves itself (commit → claimed, or release/expiry → pending
   * again) and must never be presented as something an `events ack` can or
   * should clear.
   */
  private leasedPendingCount(sessionId: string, urgency?: Urgency): number {
    const reserved = this.reservations.reservedEventIds(sessionId);
    if (reserved.size === 0) return 0;
    return this.store
      .pendingEventsForSession(sessionId, urgency)
      .filter((event) => reserved.has(event.id)).length;
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
      const highUnread = this.pendingForClaim(sessionId, 'high');
      const settledHigh = highUnread.filter(
        (event) =>
          now.getTime() - event.createdAt.getTime() >=
          DEFAULT_HIGH_URGENCY_SETTLE_MS,
      );

      // Cross-monitor coalescing window (issue #441): computed up front so a
      // normal-urgency reminder that is ALSO due this call can be folded into
      // a settled-high delivery below, instead of preempted to a SEPARATE,
      // later turn-interruptible call. Two monitors watching overlapping
      // state (e.g. a high-urgency label monitor and a normal-urgency
      // review-queue monitor both firing off the same underlying change)
      // previously interrupted the session twice for one action; this makes
      // it one batch when both land in the same settle window. Previously
      // surfaced rows remain unread but never block fresh pending work.
      const normalPending = this.pendingForClaim(sessionId, 'normal');
      const normalReminderDue =
        normalPending.length > 0 &&
        this.leasedPendingCount(sessionId, 'normal') === 0;

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

        const surfacedIds = surfacedHigh.map((event) => event.id);
        const digests = this.store.interpretDigestsForSession(
          sessionId,
          surfacedIds,
        );
        const perRecipientDiffs = this.store.perRecipientDiffsForSession(
          sessionId,
          surfacedIds,
        );
        const highMessage = summarizeEvents(
          surfacedHigh.map((event) => ({
            title: event.title,
            summary: recipientSummary(event, digests),
          })),
        );
        // Coalesce a due normal reminder into THIS delivery (see the
        // `normalReminderDue` comment above). The `events` array still
        // carries only the high-urgency summaries — each retains its own
        // `urgency: 'high'` (never downgraded) and the normal events stay
        // undetailed exactly as a pure normal reminder would render them
        // (never escalated into full event summaries) — only the batch's
        // candidate set and message grow to include the coalesced reminder.
        return {
          sessionId,
          candidates: normalReminderDue
            ? [...surfacedCandidates, ...normalPending]
            : surfacedCandidates,
          isRecap: false,
          claim: {
            sessionId,
            lifecycle,
            mode: 'delivery',
            urgency: 'high',
            unreadCounts: sessionUnreadCounts,
            message: normalReminderDue
              ? `${highMessage}${COALESCED_NORMAL_SUFFIX}`
              : highMessage,
            events: surfacedHigh.map((event) =>
              toDeliveryEventSummary(event, digests, perRecipientDiffs),
            ),
            // Surfaced separately from `message` (PR #456 review finding 2):
            // `events` and `message` carry no representation of the coalesced
            // reminder that a bounded (events-rendering) transport would
            // notice on its own — see the field's own doc comment
            // (`types.ts`) for why this must be rendered explicitly.
            ...(normalReminderDue
              ? {
                  coalescedReminder: reminderMessage(),
                  coalescedNormalCount: normalPending.length,
                }
              : {}),
          },
        };
      }

      // A normal reminder must NOT fire standalone while high-urgency work is
      // still pending and unsettled (PR #456 review finding 1): with `settledHigh`
      // empty above but `highUnread` non-empty, firing the normal reminder here
      // preempts this turn, and the high batch only surfaces on a LATER
      // turn-interruptible call once it settles — the exact two-interrupt
      // failure #441 set out to fix, just shifted from (normal-then-high) to
      // (normal-now, high-later) instead of eliminated. Hold the reminder
      // until there is no genuinely pending high-urgency work at all; once the
      // pending high event settles, the branch above coalesces this SAME due
      // reminder into it in one call.
      if (normalReminderDue && highUnread.length === 0) {
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
            message: reminderMessage(),
            events: [],
          },
        };
      }

      return null;
    }

    const lowUnread = this.pendingForClaim(sessionId, 'low');
    const shouldSendLow =
      lowUnread.length > 0 && this.leasedPendingCount(sessionId, 'low') === 0;

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
          message: reminderMessage(),
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
      const recapIds = recapSlice.map((event) => event.id);
      const digests = this.store.interpretDigestsForSession(
        sessionId,
        recapIds,
      );
      const perRecipientDiffs = this.store.perRecipientDiffsForSession(
        sessionId,
        recapIds,
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
            toDeliveryEventSummary(event, digests, perRecipientDiffs),
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
    const deliveredIds = delivered.map((event) => event.id);
    const digests = this.store.interpretDigestsForSession(
      sessionId,
      deliveredIds,
    );
    const perRecipientDiffs = this.store.perRecipientDiffsForSession(
      sessionId,
      deliveredIds,
    );
    return delivered.map((event) =>
      toDeliveryEventSummary(event, digests, perRecipientDiffs),
    );
  }

  /**
   * Non-mutating preview of the coalesced normal-urgency reminder text a
   * `turn-interruptible` {@link claimDelivery} WOULD append to a settled-high
   * delivery right now (issue #441 cross-monitor coalescing; PR #456 review
   * finding 4). Mirrors the EXACT `normalReminderDue` check `decideDelivery`
   * uses in its settled-high branch, so this agrees byte-for-byte with what
   * the eventual claim's `coalescedReminder` field will carry.
   *
   * A length-bounded transport MUST call this alongside
   * {@link previewSettledHighDelivery} BEFORE sizing how many whole
   * high-urgency event blocks fit: the reminder text is appended AFTER the
   * packed blocks (see `renderHookDelivery`/`renderChannelEvent`), so sizing
   * against the event blocks alone — without reserving room for this text —
   * risks a claim that fits its events but overflows once the coalesced
   * reminder is appended, or truncates the reminder away (both a 006 §5.5
   * claimed-but-unrendered violation). Returns `undefined` when no reminder
   * would be coalesced right now (nothing pending/due, or no settled
   * high-urgency work to coalesce it into). Reads only — never claims,
   * suppresses, or refreshes hook state.
   */
  previewCoalescedReminder(sessionId: string): string | undefined {
    const now = new Date();
    const highUnread = this.pendingForClaim(sessionId, 'high');
    const settledHigh = highUnread.filter(
      (event) =>
        now.getTime() - event.createdAt.getTime() >=
        DEFAULT_HIGH_URGENCY_SETTLE_MS,
    );
    if (settledHigh.length === 0) return undefined;

    const normalPending = this.pendingForClaim(sessionId, 'normal');
    const normalReminderDue =
      normalPending.length > 0 &&
      this.leasedPendingCount(sessionId, 'normal') === 0;
    return normalReminderDue ? reminderMessage() : undefined;
  }

  /**
   * Non-mutating diagnosis of why a `claimDelivery(sessionId, lifecycle)` call
   * would (or would not) surface anything right now (issue #334). Reads only —
   * it never claims, suppresses, re-anchors a delta, or refreshes hook state
   * (contrast {@link claimDelivery}) — so diagnosing never consumes a delivery.
   *
   * Mirrors the delivery policy: high work can hold a fresh normal reminder
   * until its settle window ends; a live reservation temporarily holds the
   * same urgency band. Claimed rows are reported only when no fresh work is
   * pending. They remain unread, but do not hold newer observations hostage to
   * acknowledgment. The post-compact recap still re-shows unread work.
   */
  diagnoseHookDelivery(
    sessionId: string,
    lifecycle: DeliveryLifecycle,
  ): HookDeliveryDiagnosis {
    const now = new Date();
    const unreadLow = this.store.unreadEventsForSession(sessionId, 'low');
    const unreadNormal = this.store.unreadEventsForSession(sessionId, 'normal');
    const unreadCounts = {
      low: unreadLow.length,
      normal: unreadNormal.length,
      high: this.store.unreadEventsForSession(sessionId, 'high').length,
    };
    const sessionUnreadCounts = {
      ...unreadCounts,
      total: unreadCounts.low + unreadCounts.normal + unreadCounts.high,
    };

    // The ids actually holding a band's coalesced reminder back: unread MINUS
    // pending (unclaimed), i.e. the claimed ones. Computed here rather than in
    // the pure classifier so `doctor`'s remediation can acknowledge exactly
    // these rows instead of every unread event on the session (issue #425
    // review, round 6) — acknowledging unrelated, never-surfaced work would be
    // a different bug in the opposite direction.
    const claimedIds = (
      unread: readonly { id: string }[],
      pending: readonly { id: string }[],
    ): string[] => {
      const pendingIds = new Set(pending.map((event) => event.id));
      return unread
        .filter((event) => !pendingIds.has(event.id))
        .map((event) => event.id);
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

      const settledHighCount = pendingHigh.filter(
        (event) =>
          now.getTime() - event.createdAt.getTime() >=
          DEFAULT_HIGH_URGENCY_SETTLE_MS,
      ).length;
      const pendingNormal = this.pendingForClaim(sessionId, 'normal');
      const leasedNormal = this.leasedPendingCount(sessionId, 'normal');
      // Claimed-ids must be derived from the store's actually-claimed set
      // (`pendingEventsForSession`, unaffected by an in-flight channel lease),
      // not from `pendingForClaim` (lease-filtered): a reserved event is unread
      // and unclaimed — `claimDelivery` has not run for it — so treating it as
      // "claimed" here would let the scoped-ack remediation acknowledge a
      // never-surfaced event, making it permanently unclaimable once the
      // reservation later releases. The separate `leasedCount` lets the
      // classifier tell a pure in-flight lease (reserved-in-flight, never ack)
      // apart from a real claim.
      const unclaimedNormal = this.store.pendingEventsForSession(
        sessionId,
        'normal',
      );
      // A due normal reminder waits only for a concurrent high settle window.
      // A reservation instead explains its own temporary hold; claimed rows
      // cannot block fresh pending work, regardless of other urgency bands.
      const normalHold =
        classifyCoalescingWithheldHold(
          unreadCounts.normal,
          pendingNormal.length,
          pendingHigh.length,
          settledHighCount,
          leasedNormal,
        ) ??
        classifyReminderHold(
          'normal',
          unreadCounts.normal,
          pendingNormal.length,
          claimedIds(unreadNormal, unclaimedNormal),
          leasedNormal,
        );
      if (normalHold) holds.push(normalHold);
    } else if (lifecycle === 'turn-idle') {
      const pendingLow = this.pendingForClaim(sessionId, 'low');
      const leasedLow = this.leasedPendingCount(sessionId, 'low');
      // See the `normal` branch above: claimed-ids must come from the
      // lease-unaware store set, not the lease-filtered `pendingForClaim`,
      // and the lease count is threaded separately so a pure lease reads as
      // reserved-in-flight rather than a claim.
      const unclaimedLow = this.store.pendingEventsForSession(sessionId, 'low');
      const lowHold = classifyReminderHold(
        'low',
        unreadCounts.low,
        pendingLow.length,
        claimedIds(unreadLow, unclaimedLow),
        leasedLow,
      );
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

    this.reportMissingHeldDefinitions(result, workspacePath, acc);

    // Persistent monitors (directory-authored). An unknown source is a hard tick
    // failure — the author can fix the file.
    for (const parsed of result.monitors) {
      const monitor = this.revalidateDiscoveredMonitor(
        parsed.monitor,
        workspacePath,
        acc,
      );
      if (!monitor) continue;
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      if (!source) {
        // Source resolution is an admission boundary even without held work.
        // A live watcher can create its first hold while an earlier scope awaits.
        this.setWatchPolicy(monitor.id, workspacePath, null, monitor.filePath);
        if (this.hasCurrentNotifyHold(monitor.id, workspacePath)) {
          this.reportNotifyEditFailure(
            monitor.id,
            workspacePath,
            sourceName,
            `Notify edit blocked: unknown source "${sourceName}"; accepted holds retained.`,
            acc,
          );
          continue;
        }
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

  /** Hold membership can change across source/Interpret awaits; only this scope's live state counts. */
  private hasCurrentNotifyHold(id: string, workspacePath: string): boolean {
    const notify = this.store.getMonitorState(id, workspacePath).notifyState;
    return (
      (notify.pendingDebounce?.observations.length ?? 0) > 0 ||
      (notify.pendingRollup?.observations.length ?? 0) > 0
    );
  }

  /**
   * Held work that a rejected current scope must protect: durable notify holds,
   * or a returned poll result retained until reconciliation succeeds. Without
   * either, a running watcher keeps ingesting under its startup snapshot and
   * the admission gate stays as it was (002 §2.0, §4.6).
   */
  private hasHeldNotifyWork(id: string, workspacePath: string): boolean {
    const key = JSON.stringify([workspacePath, id]);
    return (
      this.hasCurrentNotifyHold(id, workspacePath) ||
      this.pollAdmissions.get(key)?.result !== undefined
    );
  }

  /**
   * Fallback is authorized only by positive evidence that the admitted location
   * is absent. A boolean existence probe also hides permission and I/O failures;
   * those cannot retire an unreadable current definition in favor of another.
   * Preserve the original read diagnostic when metadata cannot prove absence.
   */
  private isNotifyDefinitionPathAbsent(filePath: string): boolean {
    try {
      statSync(filePath);
      return false;
    } catch (error) {
      return (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      );
    }
  }

  /**
   * A path is a location, not monitor identity. A live scoped owner's latest
   * admitted path may supersede a discovered/captured path after relocation.
   * Reread both files: cached contents never authorize admission, and two valid
   * same-id definitions remain a duplicate error rather than a preference rule.
   * Only the existing owner's one path is consulted; no path history survives it.
   */
  private readCurrentNotifyDefinition(
    id: string,
    workspacePath: string,
    candidatePath?: string,
  ): ParseOutcome | undefined {
    const candidate = candidatePath
      ? parseMonitorFile(candidatePath)
      : undefined;
    if (candidate?.ok && candidate.monitor.id !== id) {
      return {
        ok: false,
        filePath: candidate.monitor.filePath,
        error: `Candidate definition does not identify monitor "${id}".`,
      };
    }
    const admittedPath = this.notifyPolicyUsers.get(
      JSON.stringify([workspacePath, id]),
    )?.currentPath;
    if (!admittedPath || admittedPath === candidatePath) return candidate;
    const current = parseMonitorFile(admittedPath);
    if (current.ok && current.monitor.id !== id) {
      return {
        ok: false,
        filePath: admittedPath,
        error: `Current definition does not identify monitor "${id}".`,
      };
    }
    if (candidate?.ok && current.ok) {
      throw new Error(
        `Duplicate monitor ids: "${id}" (${candidate.monitor.filePath}, ${current.monitor.filePath}).`,
      );
    }
    if (current.ok) return current;
    // Moving back is legitimate only when the admitted location is proven
    // absent. An unreadable location remains authoritative until validated;
    // permission/query failures must not turn another file into its replacement.
    if (candidate?.ok && this.isNotifyDefinitionPathAbsent(admittedPath)) {
      return candidate;
    }
    return current;
  }

  /**
   * Discovery supplies candidate paths, not continuing authority to edit policy.
   * Reread one authored definition immediately before its synchronous preparation:
   * an earlier scope may have awaited source/Interpret work since the directory
   * scan. This read linearizes admission with the following writer transaction
   * in the same JS turn; later file edits require subsequent discovery. It adds
   * no revision history and never reloads an established source/handling snapshot.
   */
  private revalidateDiscoveredMonitor(
    discovered: MonitorDefinition,
    workspacePath: string,
    acc: TickAccumulator,
  ): MonitorDefinition | undefined {
    const current = this.readCurrentNotifyDefinition(
      discovered.id,
      workspacePath,
      discovered.filePath,
    );
    if (current?.ok) return current.monitor;
    this.setWatchPolicy(
      discovered.id,
      workspacePath,
      null,
      current?.filePath ?? discovered.filePath,
    );
    this.reportNotifyEditFailure(
      discovered.id,
      workspacePath,
      discovered.frontmatter.watch.type,
      `Notify edit blocked: ${current?.error ?? 'monitor definition is missing or unreadable'}; accepted holds retained.`,
      acc,
    );
    return undefined;
  }

  /** Diagnose operational holds whose authored definition cannot be admitted. */
  private reportMissingHeldDefinitions(
    result: Awaited<ReturnType<typeof scanMonitors>>,
    workspacePath: string,
    acc: TickAccumulator,
  ): void {
    const knownIds = new Set(
      result.monitors.map((parsed) => parsed.monitor.id),
    );
    // Missing/invalid definitions cannot cancel operational holds. Diagnose only
    // held ids here; ordinary definition preflight remains a separate concern.
    const heldIds = new Set(heldMonitorIds(this.store, workspacePath));
    for (const id of heldIds) {
      // Ephemeral definitions live in SQLite, not in the scanned directory.
      // Their independent declaration/reap lifecycle does not imply a file edit.
      if (knownIds.has(id) || id.startsWith(EPHEMERAL_MONITOR_ID_PREFIX)) {
        continue;
      }
      const held = this.store.getMonitorState(id, workspacePath).notifyState;
      const captured = capturedNotifyRoute(
        held.pendingDebounce?.observations.at(0) ??
          held.pendingRollup?.observations.at(0),
      );
      // The scan itself can finish out of order with a newer discovery. A stale
      // missing/invalid result must not close that newer definition's live gate.
      const current = this.readCurrentNotifyDefinition(
        id,
        workspacePath,
        captured.filePath,
      );
      let reason = current?.ok ? undefined : current?.error;
      if (current?.ok) {
        const sourceName = current.monitor.frontmatter.watch.type;
        const source = this.registry.get(sourceName);
        if (!source) reason = `unknown source "${sourceName}"`;
        else {
          const errors = validateWatchScope(
            watchConfig(current.monitor.frontmatter.watch),
            source.scopeSchema,
          );
          if (!errors.length) continue;
          reason = `Invalid monitor definition: ${errors.join('; ')}`;
        }
      }
      const message = `Notify edit blocked: ${reason ?? 'monitor definition is missing or unreadable'}; accepted holds retained.`;
      this.setWatchPolicy(
        id,
        workspacePath,
        null,
        current?.ok
          ? current.monitor.filePath
          : (current?.filePath ?? captured.filePath),
      );
      this.reportNotifyEditFailure(
        id,
        workspacePath,
        captured.sourceName ?? 'unknown',
        message,
        acc,
      );
    }
  }

  /**
   * Scanned notify definitions gate watcher acceptance, without restarting or
   * reconfiguring the live source. A null definition means old held work or its
   * definition is blocked; the current yield remains on the consumer's stack.
   * Location provenance belongs to its counted owner and survives a closed gate.
   */
  private readonly watchPolicies = new Map<string, MonitorDefinition | null>();
  /**
   * Counted live ownership carries one current location separately from gate
   * permission. Blocking cannot erase that authority; the last user retires it.
   * This private record holds no instructions or path history. Durable holds
   * remain in SQLite and are not deleted with process-local ownership.
   */
  private readonly notifyPolicyUsers = new Map<
    string,
    {
      /** Watchers, evaluating polls and deferred results each retain their own lease. */
      users: number;
      /** Latest selected location, including a definition that has not reconciled successfully. */
      currentPath?: string;
    }
  >();
  /** In-flight or blocked poll results retain their execution snapshot until admitted or retired. */
  private readonly pollAdmissions = new Map<string, PollAdmission>();

  /** Cache ownership spans async work, never the lifetime of a retired declaration. */
  private retainNotifyPolicy(id: string, workspacePath: string): void {
    const key = JSON.stringify([workspacePath, id]);
    const owner = this.notifyPolicyUsers.get(key);
    if (owner) owner.users++;
    else this.notifyPolicyUsers.set(key, { users: 1 });
    if (!this.watchPolicies.has(key)) this.watchPolicies.set(key, null);
  }

  /** Release only process-local admission metadata; accepted durable work is never deleted here. */
  private releaseNotifyPolicy(id: string, workspacePath: string): void {
    const key = JSON.stringify([workspacePath, id]);
    const owner = this.notifyPolicyUsers.get(key);
    if (owner && owner.users > 1) owner.users--;
    else {
      // Permission, current location and cached instructions share this exact
      // lifetime; no retired owner can govern a future declaration or discovery.
      this.notifyPolicyUsers.delete(key);
      this.watchPolicies.delete(key);
    }
  }

  /** A reaped declaration cannot admit late source results or retain deferred instruction snapshots. */
  private retirePollAdmission(id: string): void {
    for (const [key, admission] of this.pollAdmissions) {
      if (admission.monitor.id !== id) continue;
      admission.retired = true;
      if (admission.result) {
        this.pollAdmissions.delete(key);
        this.releaseNotifyPolicy(id, admission.workspacePath);
        this.wakeNotifyPolicy(key);
      }
    }
  }

  /** Poll completion and reconciliation both unblock source admission without polling. */
  private wakeNotifyPolicy(key: string): void {
    for (const wake of this.watchPolicyWaiters.get(key) ?? []) wake();
  }

  /** Waiting source acceptance/checkpoints wake on reconciliation or teardown. */
  private readonly watchPolicyWaiters = new Map<string, Set<() => void>>();

  /**
   * Watchers paused on a terminal retry, by workspace/monitor key. A re-arm or
   * skip in this process wakes them so the watcher drains again at once
   * instead of at its next periodic recheck (002 §2.7).
   */
  private readonly retryRepairWaiters = new Map<string, Set<() => void>>();

  private wakeRetryRepairWaiters(workspacePath: string, monitorId: string) {
    const key = JSON.stringify([workspacePath, monitorId]);
    for (const wake of this.retryRepairWaiters.get(key) ?? []) wake();
  }

  /** Wait up to `ms` for an operator repair of this monitor's terminal retry. */
  private async waitForRetryRepair(
    workspacePath: string,
    monitorId: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const key = JSON.stringify([workspacePath, monitorId]);
    const woken = new AbortController();
    const wake = () => {
      woken.abort();
    };
    const waiters = this.retryRepairWaiters.get(key) ?? new Set();
    this.retryRepairWaiters.set(key, waiters);
    waiters.add(wake);
    signal.addEventListener('abort', wake, { once: true });
    try {
      await abortableDelay(ms, woken.signal);
    } finally {
      signal.removeEventListener('abort', wake);
      waiters.delete(wake);
      if (waiters.size === 0) this.retryRepairWaiters.delete(key);
    }
  }

  /**
   * Publish permission and current location within existing ownership. A blocked
   * definition may identify a new location before it ever reconciles successfully.
   * Closing without a new location preserves the latest authority, including
   * when an older asynchronous failure reports after a newer scan.
   */
  private setWatchPolicy(
    id: string,
    workspacePath: string,
    definition: MonitorDefinition | null,
    blockedPath?: string,
  ): void {
    const key = JSON.stringify([workspacePath, id]);
    const owner = this.notifyPolicyUsers.get(key);
    if (!owner) return;
    const currentPath = definition?.filePath ?? blockedPath;
    if (currentPath !== undefined) owner.currentPath = currentPath;
    this.watchPolicies.set(key, definition);
    this.wakeNotifyPolicy(key);
  }

  /**
   * Wait for explicit durable reconciliation before source creation, checkpoint,
   * or yield acceptance. Watch setup initializes this gate even without a tick;
   * an absent gate is an invariant error, not permission or an indefinite wait.
   */
  private async waitForWatchDefinition(
    id: string,
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<MonitorDefinition | undefined> {
    const key = JSON.stringify([workspacePath, id]);
    if (!this.watchPolicies.has(key)) {
      throw new Error('Watcher notify acceptance was not initialized.');
    }
    while (
      !signal.aborted &&
      (this.watchPolicies.get(key) === null || this.pollAdmissions.has(key))
    ) {
      await new Promise<void>((resolve) => {
        const waiters =
          this.watchPolicyWaiters.get(key) ?? new Set<() => void>();
        const wake = () => {
          signal.removeEventListener('abort', wake);
          waiters.delete(wake);
          if (!waiters.size) {
            this.watchPolicyWaiters.delete(key);
          }
          resolve();
        };
        waiters.add(wake);
        this.watchPolicyWaiters.set(key, waiters);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    if (signal.aborted) {
      return undefined;
    }
    return this.watchPolicies.get(key) ?? undefined;
  }

  /**
   * Admit a watcher operation against the current gate in the same synchronous
   * turn as its durable work. A definition returned through an await is only a
   * wake-up hint: reconciliation can close or replace the gate before resumption.
   * Blocked work sleeps on gate changes/abort, retaining its FIFO chain position.
   */
  private async acceptWatchWork<T>(
    monitor: MonitorDefinition,
    workspacePath: string,
    signal: AbortSignal,
    work: (accepted: MonitorDefinition) => T,
  ): Promise<T | undefined> {
    const key = JSON.stringify([workspacePath, monitor.id]);
    for (;;) {
      await this.waitForWatchPolicy(monitor, workspacePath, signal);
      const current = this.watchPolicies.get(key);
      if (signal.aborted) return undefined;
      if (!current || this.pollAdmissions.has(key)) continue;
      // Factory callers use this entire definition as their initial snapshot;
      // established sources merge only pacing into their pinned snapshot.
      return work(current);
    }
  }

  /** Apply reconciled pacing to an already established source/handling snapshot. */
  private async waitForWatchPolicy(
    monitor: MonitorDefinition,
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<MonitorDefinition | undefined> {
    const current = await this.waitForWatchDefinition(
      monitor.id,
      workspacePath,
      signal,
    );
    return current ? this.applyWatchPolicy(monitor, current) : undefined;
  }

  /** Live pacing changes cannot reload the established execution/handling snapshot. */
  private applyWatchPolicy(
    monitor: MonitorDefinition,
    current: MonitorDefinition,
  ): MonitorDefinition {
    // Only pacing/urgency follow reconciliation. Execution and handling remain
    // the established source's snapshot until it is explicitly restarted; this
    // boundary does not introduce unrelated live-definition reload behavior.
    const frontmatter = {
      ...monitor.frontmatter,
      urgency: current.frontmatter.urgency,
      urgencyMax: current.frontmatter.urgencyMax,
    };
    if (current.frontmatter.notify) {
      frontmatter.notify = current.frontmatter.notify;
    } else {
      delete frontmatter.notify;
    }
    return { ...monitor, frontmatter };
  }

  /** Report a blocked edit through existing error contracts without mutating holds. */
  private reportNotifyEditFailure(
    id: string,
    workspacePath: string,
    sourceName: string,
    message: string,
    acc: TickAccumulator,
  ): void {
    acc.erroredObservations.push({ monitorId: id, message });
    try {
      this.store.recordObservationHistory({
        monitorId: id,
        workspacePath,
        sourceName,
        result: 'errored',
        observationData: { error: message },
      });
    } catch {
      /* The retained holds remain authoritative even if diagnostics cannot persist. */
    }
  }

  /**
   * Own the edit's deterministic write unit. Re-read under the writer lock so
   * another runtime's committed drain cannot be duplicated or overwritten by a
   * decision made from an earlier read. Event units nest as SQLite savepoints;
   * every hold and materialization write commits together or all roll back.
   */
  private reconcileNotifyEdit(
    monitor: MonitorDefinition,
    workspacePath: string,
    restrictToSessionId?: string,
  ) {
    return withStoreWriter(this.store, () => {
      const state = this.store.getMonitorState(monitor.id, workspacePath);
      const notify: PolicyNotifyState = state.notifyState;
      const key = notifyPolicyKey(monitor);
      const held = [
        ...(notify.pendingDebounce?.observations ?? []),
        ...(notify.pendingRollup?.observations ?? []),
      ];
      for (const envelope of held) {
        // Persisted envelopes are older-version data. Missing captured semantics
        // must block recovery, never borrow instructions or urgency from an edit.
        validateCapturedNotifyEnvelope(envelope, monitor.id);
      }
      const changed =
        held.some((envelope) => notifyPolicyKey(envelope.monitor) !== key) ||
        (notify.policyKey !== undefined &&
          !storedNotifyPolicyMatches(notify.policyKey, key));
      if (!changed) {
        // A successful current scan establishes future comparison identity even
        // when legacy state has only guards. Missing metadata is not an edit:
        // preserve every clock/hold and never infer an unknowable earlier policy.
        if (notify.policyKey === undefined) {
          learnNotifyPolicyIdentity(this.store, monitor.id, workspacePath, key);
        }
        return [];
      }
      const drained = held
        .map(hydrateStoredObservationEnvelope)
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
        .map((envelope) => {
          const materialized = this.materializeObservation({
            monitor: envelope.monitor,
            sourceName: envelope.monitor.frontmatter.watch.type,
            observation: envelope.observation,
            observedAt: envelope.observedAt,
            workspacePath,
            effectiveUrgency: envelope.effectiveUrgency,
            ...(restrictToSessionId !== undefined
              ? { restrictToSessionId }
              : {}),
          });
          if (!materialized) {
            throw new Error('Captured held observation cannot materialize.');
          }
          return {
            ...materialized,
            monitor: envelope.monitor,
            sessions: [...this.store.projectedSessionIdsForLastEvent()],
          };
        });
      // Suppression/window guards belong to the retired policy. They cannot
      // suppress accepted old work or the new policy's first observation.
      const nextNotify: PolicyNotifyState = { ...notify, policyKey: key };
      delete nextNotify.pendingDebounce;
      delete nextNotify.pendingRollup;
      delete nextNotify.suppressedUntil;
      delete nextNotify.rollupLastFiredMinute;
      // Pacing adoption owns notify metadata and the materialized held batch,
      // never the source's opaque baseline or its observation clock.
      commitNotifyPolicyEdit(this.store, monitor.id, workspacePath, nextNotify);
      if (drained.length)
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath,
          sourceName: monitor.frontmatter.watch.type,
          result: 'triggered',
          observationData: {
            observed: 0,
            emitted: drained.length,
            reason: 'notify-policy-edit',
          },
        });
      return drained;
    });
  }

  /**
   * Publish acceptance only after the owned edit transaction succeeds. Startup
   * and tick use this same boundary; optional Interpret remains after commit.
   * A failed attempt retains durable work and leaves a cancellable blocked gate.
   * Callers run the source-config preflight (002 §2.0) on this same definition
   * in the same synchronous turn, so an invalid scope never reaches the drain.
   */
  private async prepareNotifyPolicy(
    monitor: MonitorDefinition,
    workspacePath: string,
    acc: TickAccumulator,
    ephemeralSessionId?: string,
  ): Promise<boolean> {
    this.setWatchPolicy(monitor.id, workspacePath, null, monitor.filePath);
    const sourceName = monitor.frontmatter.watch.type;

    try {
      const drained = this.reconcileNotifyEdit(
        monitor,
        workspacePath,
        ephemeralSessionId,
      );
      acc.emittedEventIds.push(...drained.map((item) => item.event.id));
      // Wake-ups resume only after this synchronous turn. Publish before
      // invoking ingestion so a reentrant Interpret edit cannot be overwritten
      // by this older preparation after the retained span's writes finish.
      this.setWatchPolicy(monitor.id, workspacePath, monitor);
      const key = JSON.stringify([workspacePath, monitor.id]);
      const pending = this.pollAdmissions.get(key);
      if (pending?.result) {
        this.pollAdmissions.delete(key);
        try {
          let resumed: Promise<MaterializationSpanResult>;
          try {
            // Argument getters and definition assembly can fail before ingest
            // starts. The removed result owns exactly one retained lease; release
            // it on every invocation exit without disturbing other live owners.
            // Ingest performs deterministic writes synchronously before yielding.
            resumed = this.ingest(
              this.applyWatchPolicy(pending.monitor, monitor),
              pending.result.observations,
              pending.now,
              {
                workspacePath,
                expectedSourceState: retainedBaseline(pending),
                ...(pending.result.nextState !== undefined
                  ? { nextSourceState: { value: pending.result.nextState } }
                  : {}),
                ...(pending.result.outcome
                  ? { sourceOutcome: pending.result.outcome }
                  : {}),
                ...(pending.ephemeralSessionId !== undefined
                  ? { ephemeralSessionId: pending.ephemeralSessionId }
                  : {}),
                onNotHeld: (message) =>
                  acc.erroredObservations.push({
                    monitorId: monitor.id,
                    message,
                  }),
              },
            );
          } finally {
            this.releaseNotifyPolicy(monitor.id, workspacePath);
          }
          const ingested = await resumed;
          acc.emittedEventIds.push(...ingested.emittedEventIds);
          if (ingested.failures.length > 0) {
            acc.erroredObservations.push({
              monitorId: monitor.id,
              message: summarizeMaterializationFailures(ingested.failures),
            });
          }
        } catch (error) {
          // The edit transaction already committed. A failed ordinary handoff
          // cannot restore those holds or truthfully report a blocked edit.
          this.reportNotifyEditFailure(
            monitor.id,
            workspacePath,
            sourceName,
            `Deferred observation failed after notify reconciliation committed: ${error instanceof Error ? error.message : String(error)}`,
            acc,
          );
        }
      }
      for (const item of drained) {
        if (
          item.monitor.frontmatter.payload?.form === 'prose' &&
          this.interpretAdapter
        ) {
          try {
            await this.runInterpret(
              item.monitor,
              item.event,
              item.diffText,
              item.sessions,
            );
          } catch (error) {
            this.reportNotifyEditFailure(
              monitor.id,
              workspacePath,
              sourceName,
              `Interpret failed after notify edit committed: ${error instanceof Error ? error.message : String(error)}`,
              acc,
            );
          }
        }
      }
    } catch (error) {
      this.setWatchPolicy(monitor.id, workspacePath, null);
      this.reportNotifyEditFailure(
        monitor.id,
        workspacePath,
        sourceName,
        `Notify edit blocked; accepted holds retained: ${error instanceof Error ? error.message : String(error)}`,
        acc,
      );
      return false;
    }
    return true;
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
    this.retainNotifyPolicy(monitor.id, workspacePath);
    try {
      await this.evaluateOwnedMonitorOnTick(
        monitor,
        source,
        now,
        workspacePath,
        acc,
        ephemeralSessionId,
      );
    } finally {
      this.releaseNotifyPolicy(monitor.id, workspacePath);
    }
  }

  /** Evaluate one leased scope; concurrent rescans may reconcile it while observe is in flight. */
  private async evaluateOwnedMonitorOnTick(
    monitor: MonitorDefinition,
    source: ObservationSource,
    now: Date,
    workspacePath: string,
    acc: TickAccumulator,
    ephemeralSessionId?: string,
  ): Promise<void> {
    const key = JSON.stringify([workspacePath, monitor.id]);
    const resuming = this.pollAdmissions.get(key)?.result !== undefined;
    const sourceName = monitor.frontmatter.watch.type;
    // Preflight the current author config before notify preparation, which can
    // hydrate or flush held work: invalid config must leave that work untouched.
    const preflightErrors = validateWatchScope(
      watchConfig(monitor.frontmatter.watch),
      source.scopeSchema,
    );
    if (preflightErrors.length > 0) {
      // Held work is protected: close the admission gate so a running watcher or
      // poll cannot commit beside it under the rejected definition. Without held
      // work, running watchers keep their startup config (002 §2.0, §4.6).
      if (this.hasHeldNotifyWork(monitor.id, workspacePath)) {
        this.setWatchPolicy(monitor.id, workspacePath, null, monitor.filePath);
      }
      acc.skippedMonitors.push({
        monitorId: monitor.id,
        validationError: preflightErrors.join('; '),
      });
      return;
    }
    // Work this monitor already accepted completes before anything newer
    // (002 §2.7): before held-work reconciliation, a retained poll result,
    // a rollup window flush or a source call. A watched monitor is drained
    // here too, so a notify edit cannot release newer held work ahead of it;
    // its watcher also drains before each pull. Each completion is one
    // synchronous transaction, so the two never complete the same retry.
    // An empty outbox costs one read and no await.
    if (this.hasRetainedWork(monitor.id, workspacePath)) {
      const drained = await this.drainMaterializationRetries(
        monitor.id,
        workspacePath,
        now,
        ephemeralSessionId,
      );
      acc.emittedEventIds.push(...drained.emittedEventIds);
      if (drained.attempted) acc.evaluated.push(monitor.id);
      if (drained.blocked) {
        this.reportBlockedDrain(monitor, workspacePath, drained.blocked, acc);
        return;
      }
    }
    if (
      !(await this.prepareNotifyPolicy(
        monitor,
        workspacePath,
        acc,
        ephemeralSessionId,
      ))
    ) {
      return;
    }

    // Preparation can await Interpret while another rescan closes/replaces the gate.
    const current = this.watchPolicies.get(key);
    if (!current || resuming || this.pollAdmissions.has(key)) return;
    // Only pacing/urgency follow the gate, so the preflighted scope still holds.
    monitor = this.applyWatchPolicy(monitor, current);

    // A monitor with an active continuous watcher is driven by that watcher;
    // skip its one-shot observe() so it is not processed twice (G5).
    if (this.activeWatchers.has(JSON.stringify([workspacePath, monitor.id])))
      return;

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
      // with zero new observations to trigger a window check.
      if (monitor.frontmatter.notify?.strategy === 'rollup') {
        await this.reportHeldNotifyFlush(
          this.flushHeldNotifyWork(
            monitor,
            now,
            workspacePath,
            ephemeralSessionId,
          ),
          monitor.id,
          workspacePath,
          sourceName,
          acc,
        );
      }

      return;
    }

    // A monitor that drained retained work and then observes counts once.
    if (!acc.evaluated.includes(monitor.id)) acc.evaluated.push(monitor.id);

    // Two separate try/catch blocks so observe() failures and ingest()
    // failures are handled independently (issue #46):
    //
    // Block 1 — observe(): if observe() throws, we skip ingest() entirely.
    // Skipping ingest() means setMonitorState() is never called, which is
    // what preserves the previously-persisted sourceState so the next tick's
    // diff spans from the last good baseline rather than an empty state.
    const admission: PollAdmission = {
      monitor,
      now,
      workspacePath,
      ...(ephemeralSessionId !== undefined ? { ephemeralSessionId } : {}),
    };
    this.pollAdmissions.set(key, admission);
    let observationResult;
    let expectedSourceState: string;
    try {
      const monitorState = this.store.getMonitorState(
        monitor.id,
        workspacePath,
      );
      expectedSourceState = sourceStateToken(monitorState.sourceState);
      observationResult = await source.observe(
        watchConfig(monitor.frontmatter.watch),
        {
          previousState: monitorState.sourceState,
          now,
          workspacePath,
        },
      );
    } catch (observeError) {
      // observe() failed: ingest() is NOT called, which preserves sourceState
      // as described above, and the scheduling timestamp stays where the last
      // successful observation left it.
      const message =
        observeError instanceof Error
          ? observeError.message
          : String(observeError);
      // Same source as the audit row below: surface it on the tick result so
      // `daemon once`/`daemon run` can report the failure instead of a bare
      // `emitted 0`.
      acc.erroredObservations.push({ monitorId: monitor.id, message });
      // Runtime-owned timing does not wait on the source (002 §2.6): work held
      // before the failure still flushes at its debounce deadline or rollup
      // window. Like a successful poll, the flush is admitted synchronously
      // while this poll still owns admission; only then is the slot released.
      const flush = this.flushHeldWorkDespiteSourceFailure(
        monitor,
        admission,
        now,
        workspacePath,
        ephemeralSessionId,
      );
      this.pollAdmissions.delete(key);
      this.wakeNotifyPolicy(key);
      await this.reportHeldNotifyFlush(
        flush,
        monitor.id,
        workspacePath,
        sourceName,
        acc,
      );
      // The source failure is recorded after any flush, so it stays the
      // newest outcome: progress on held work never reads as a healthy source.
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

    if (admission.retired) {
      this.pollAdmissions.delete(key);
      this.wakeNotifyPolicy(key);
      return;
    }

    // A returned result is retained in process memory until a later public
    // rescan admits it. Returning this tick keeps the daemon free to recover the
    // failed edit; no new source call or baseline can overtake the retained result.
    // A blocked span reaches no admission, so it records no drop and queues no
    // retry: the result and the durable holds stay as they are (002 §2, §4.6).
    const latest = this.watchPolicies.get(key);
    if (!latest) {
      admission.result = observationResult;
      admission.expectedSourceState = expectedSourceState;
      this.retainNotifyPolicy(monitor.id, workspacePath);
      this.reportNotifyEditFailure(
        monitor.id,
        workspacePath,
        sourceName,
        'Notify admission blocked; returned observation retained until reconciliation succeeds.',
        acc,
      );
      return;
    }
    monitor = this.applyWatchPolicy(monitor, latest);

    // Block 2 — ingest(): a materialization failure is returned once it has a
    // durable outcome (a queued retry, or an in-transaction `errored` row when
    // the outbox cannot retain its suffix). Only a transaction-wide ROLLBACK or
    // a storage failure (outbox, state or that `errored` write) still throws,
    // because no source advance can safely commit; this catch reports it while
    // leaving the prior source baseline available.
    try {
      const ingestion = this.ingest(
        monitor,
        observationResult.observations,
        now,
        {
          workspacePath,
          expectedSourceState,
          ...(observationResult.nextState !== undefined
            ? { nextSourceState: { value: observationResult.nextState } }
            : {}),
          ...(observationResult.outcome
            ? { sourceOutcome: observationResult.outcome }
            : {}),
          ...(ephemeralSessionId !== undefined ? { ephemeralSessionId } : {}),
          onNotHeld: (message) =>
            acc.erroredObservations.push({ monitorId: monitor.id, message }),
        },
      );
      // Deterministic admission ran synchronously in that call; relinquish the
      // poll slot before awaiting post-commit Interpret.
      this.pollAdmissions.delete(key);
      this.wakeNotifyPolicy(key);
      const ingested = await ingestion;
      acc.emittedEventIds.push(...ingested.emittedEventIds);
      if (ingested.failures.length > 0) {
        acc.erroredObservations.push({
          monitorId: monitor.id,
          message: summarizeMaterializationFailures(ingested.failures),
        });
      }
    } catch (ingestError) {
      // A synchronous failure may still own admission; an asynchronous
      // rejection may resume after this poll relinquished it to a successor.
      // Only the current owner can retire the slot and wake its waiters.
      if (this.pollAdmissions.get(key) === admission) {
        this.pollAdmissions.delete(key);
        this.wakeNotifyPolicy(key);
      }
      const message = errorMessage(ingestError);
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
   * Complete one monitor's retained materialization work, oldest admission
   * first, until its outbox is empty or a retry cannot complete now
   * (002 §2.7). Each retry renders the event its stored envelope describes and
   * commits it, its projections and the removal of the retry row together;
   * only sessions registered before the observation was admitted receive it.
   *
   * A failed attempt advances the retry's persisted backoff and records an
   * `errored` history row, and the drain stops there: a younger retry never
   * completes ahead of an older one. A terminal or backing-off retry is
   * reported to the caller without an attempt. The source is never invoked.
   */
  private async drainMaterializationRetries(
    monitorId: string,
    workspacePath: string,
    now: Date,
    restrictToSessionId?: string,
  ): Promise<RetryDrainResult> {
    const result: RetryDrainResult = { attempted: false, emittedEventIds: [] };
    for (;;) {
      const retry = this.store.oldestMaterializationRetry(
        monitorId,
        workspacePath,
      );
      if (!retry) return result;
      if (retry.status === 'terminal') {
        return {
          ...result,
          blocked: {
            kind: 'terminal',
            message: terminalRetryMessage(monitorId, retry),
          },
        };
      }
      if (
        retry.nextAttemptAt !== null &&
        retry.nextAttemptAt.getTime() > now.getTime()
      ) {
        return {
          ...result,
          blocked: { kind: 'backoff', nextAttemptAt: retry.nextAttemptAt },
        };
      }

      result.attempted = true;
      const { envelope } = retry;
      let materialized: MaterializedObservation;
      try {
        const rendered = this.renderObservationEvent({
          monitor: envelope.monitor,
          sourceName: envelope.monitor.frontmatter.watch.type,
          observation: envelope.observation,
          observedAt: envelope.observedAt,
          workspacePath,
          effectiveUrgency: envelope.effectiveUrgency,
        });
        if (!rendered) {
          throw new Error(
            'The retained observation is suppressed by its payload gate and cannot materialize.',
          );
        }
        const event = this.store.completeMaterializationRetry(
          retry.id,
          rendered.event,
          rendered.baseline,
          restrictToSessionId !== undefined
            ? { restrictToSessionId }
            : undefined,
        );
        materialized = {
          monitor: envelope.monitor,
          event,
          diffText: rendered.diffText,
          projectedSessionIds: this.store.projectedSessionIdsForLastEvent(),
        };
      } catch (retryError) {
        const cause = errorMessage(retryError);
        let message = `Materialization retry ${retry.id} failed: ${cause}`;
        try {
          // Backoff starts at this attempt, not at the tick's start.
          this.store.markMaterializationRetryFailed(retry.id, cause);
        } catch (stateError) {
          message += ` Recording the failed attempt also failed: ${errorMessage(stateError)}`;
        }
        this.recordErroredHistory(
          monitorId,
          workspacePath,
          retry.sourceName,
          message,
        );
        return { ...result, blocked: { kind: 'failed', message } };
      }
      result.emittedEventIds.push(materialized.event.id);
      // Interpret follows the committed completion, as it does for a span.
      await this.interpretMaterializedObservation(materialized, workspacePath);
    }
  }

  /** Whether this workspace/monitor's retry outbox holds any row, pending or terminal. */
  private hasRetainedWork(monitorId: string, workspacePath: string): boolean {
    return (
      this.store.oldestMaterializationRetry(monitorId, workspacePath) !==
      undefined
    );
  }

  /**
   * Report a tick that left retained work in place (002 §2.7). A failed
   * attempt already has its `errored` row; a terminal retry gets one on every
   * tick it keeps the monitor paused, alongside the tick-result entry. A retry
   * that is backing off is a schedule wait, reported with its next attempt
   * time like any monitor that is not yet due.
   */
  private reportBlockedDrain(
    monitor: MonitorDefinition,
    workspacePath: string,
    blocked: RetryDrainBlock,
    acc: TickAccumulator,
  ): void {
    if (blocked.kind === 'backoff') {
      acc.skippedMonitors.push({
        monitorId: monitor.id,
        nextDueAt: blocked.nextAttemptAt,
      });
      return;
    }
    if (blocked.kind === 'terminal') {
      this.recordErroredHistory(
        monitor.id,
        workspacePath,
        monitor.frontmatter.watch.type,
        blocked.message,
      );
    }
    acc.erroredObservations.push({
      monitorId: monitor.id,
      message: blocked.message,
    });
  }

  /**
   * Hold a watcher's next pull until its monitor's retained work has drained
   * (002 §2.7), retrying on the outbox's own backoff. Failed attempts are
   * reported each time; a terminal retry is reported once and then only
   * rechecked. Returns `false` once the watcher no longer owns its monitor.
   */
  private async drainBeforeWatchPull(
    monitorId: string,
    workspacePath: string,
    signal: AbortSignal,
    ownsWatch: () => boolean,
    onError?: (monitorId: string, error: Error) => void,
  ): Promise<boolean> {
    let reportedTerminal: string | undefined;
    for (;;) {
      if (!ownsWatch()) return false;
      const drained = await this.drainMaterializationRetries(
        monitorId,
        workspacePath,
        new Date(),
      );
      if (drained.emittedEventIds.length > 0) {
        this.refreshWorkspaceSessions(workspacePath);
      }
      const { blocked } = drained;
      if (!blocked) return ownsWatch();
      let waitMs: number;
      if (blocked.kind === 'backoff') {
        waitMs = blocked.nextAttemptAt.getTime() - Date.now();
      } else if (blocked.kind === 'failed') {
        onError?.(monitorId, new Error(blocked.message));
        waitMs = this.failedAttemptWaitMs(monitorId, workspacePath);
      } else {
        if (blocked.message !== reportedTerminal) {
          reportedTerminal = blocked.message;
          const sourceName =
            this.store.oldestMaterializationRetry(monitorId, workspacePath)
              ?.sourceName ?? 'unknown';
          this.recordErroredHistory(
            monitorId,
            workspacePath,
            sourceName,
            blocked.message,
          );
          onError?.(monitorId, new Error(blocked.message));
        }
        await this.waitForRetryRepair(
          workspacePath,
          monitorId,
          TERMINAL_RETRY_RECHECK_MS,
          signal,
        );
        continue;
      }
      await abortableDelay(waitMs, signal);
    }
  }

  /**
   * How long a watcher waits after a failed drain attempt: until the row's
   * persisted next attempt when that is still ahead, and otherwise the retry
   * policy's first delay. The fallback covers a failed attempt whose backoff
   * could not be recorded (or could not be read back), where the row is still
   * due and an immediate retry would spin (008 §8).
   */
  private failedAttemptWaitMs(
    monitorId: string,
    workspacePath: string,
  ): number {
    let nextAttemptAt: Date | null | undefined;
    try {
      nextAttemptAt = this.store.oldestMaterializationRetry(
        monitorId,
        workspacePath,
      )?.nextAttemptAt;
    } catch {
      // The outbox cannot be read; fall back to the floor.
    }
    const untilNext = nextAttemptAt ? nextAttemptAt.getTime() - Date.now() : 0;
    return untilNext > 0 ? untilNext : MATERIALIZATION_RETRY_DELAYS_MS[0];
  }

  /** Best-effort `errored` audit row; a failed write cannot change committed work. */
  private recordErroredHistory(
    monitorId: string,
    workspacePath: string,
    sourceName: string,
    message: string,
  ): void {
    try {
      this.store.recordObservationHistory({
        monitorId,
        workspacePath,
        sourceName,
        result: 'errored',
        observationData: { error: message },
      });
    } catch {
      // Audit is best-effort.
    }
  }

  /**
   * Funnel a batch of observations through notify dispatch, persist the updated
   * monitor state, and materialize the emitted observations into durable events.
   * Shared by the tick loop (one-shot `observe()`) and the continuous watcher
   * (`watch()`), so both paths apply identical notify/throttle/debounce semantics
   * and event materialization.
   *
   * `nextSourceState` is the restart baseline associated with this finite poll
   * or watch batch. An omitted checkpoint preserves the prior source state.
   * Source/notify state and every emitted event or retry obligation share the
   * same synchronous commit; no independent watch checkpoint path exists.
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
      /** Immutable baseline captured before source code acquires the batch. */
      expectedSourceState: string;
      nextSourceState?: { value: unknown };
      sourceOutcome?: 'rebaselined' | 'no-files-matched';
      /**
       * Present only for an ephemeral monitor (007 §4): materialized events
       * project into ONLY this declaring session, never a sibling lead session
       * in the same workspace (007 §4.6 isolation).
       */
      ephemeralSessionId?: string;
      /**
       * Reports each observation a debounce/rollup hold refused (002 §4.7):
       * the tick loop adds it to `erroredObservations`, a watcher to `onError`.
       * Its durable `errored` loss row (002 §2) is written inside the
       * admission transaction either way. Called only after that transaction commits
       * and the span has materialized; an exception it throws is ignored.
       */
      onNotHeld?: (message: string) => void;
    },
  ): Promise<MaterializationSpanResult> {
    // Pre-filter: a `payload.form: structured` CEL gate that evaluates `false`
    // suppresses delivery entirely (002 §1.1.6). This check MUST run BEFORE
    // dispatchNotify so that suppressed observations never advance notify state
    // and are never counted as emitted in the audit history row.  Running it
    // after dispatch (during materialization) was incorrect: the history row
    // would say `triggered` even though no event was ever materialized.
    const passedObservations = observations.filter((obs) => {
      const shaped = shapeObservation(obs, now, {
        shape: monitor.frontmatter.shape,
        payload: monitor.frontmatter.payload,
      });
      return !shaped.suppressed;
    });

    const admitted = runRuntimeTransaction(this.store, () => {
      // Read and decide under the same write lock as admission. Another writer's
      // held notify work must participate in dispatch rather than be overwritten
      // by a stale pre-transaction snapshot.
      const monitorState = this.store.getMonitorState(
        monitor.id,
        options.workspacePath,
      );
      if (
        sourceStateToken(monitorState.sourceState) !==
        options.expectedSourceState
      ) {
        throw new Error(
          'Monitor source baseline changed before admission; discard this stale batch and observe again from persisted state.',
        );
      }
      const dispatch = this.dispatchNotify(
        monitor,
        passedObservations,
        now,
        monitorState.notifyState,
      );
      const spanOptions: MaterializationSpanOptions = {
        observed: observations.length,
        notHeld: dispatch.notHeld.length,
        workspacePath: options.workspacePath,
        nextMonitorState: {
          sourceState: options.nextSourceState
            ? options.nextSourceState.value
            : monitorState.sourceState,
          // Private pacing identity lets a later effective edit retire this
          // policy's guards across restarts (002 §4.6).
          notifyState: {
            ...dispatch.nextState,
            policyKey: notifyPolicyKey(monitor),
          },
          lastObservationAt: now,
        },
        ...(options.sourceOutcome
          ? { sourceOutcome: options.sourceOutcome }
          : {}),
        ...(options.ephemeralSessionId !== undefined
          ? { ephemeralSessionId: options.ephemeralSessionId }
          : {}),
      };
      return {
        // An observation a hold refused (002 §4.7) is neither emitted nor
        // held. Admission records it as loss in this transaction, together
        // with the state that advances past it: a rollback undoes both, so
        // the refusal is decided again from the prior baseline.
        durable: this.admitSpan(
          monitor,
          dispatch.emitted,
          spanOptions,
          dispatch.notHeld,
        ),
        spanOptions,
        notHeld: dispatch.notHeld,
      };
    });
    // Refusals are reported only once the admission transaction has committed
    // and the span has materialized, so a throwing report callback can never
    // cut off committed work, and a rolled-back span reports none.
    try {
      return await this.finishMaterializationSpan(
        monitor,
        admitted.durable,
        admitted.spanOptions,
      );
    } finally {
      for (const { message } of admitted.notHeld) {
        try {
          options.onNotHeld?.(message);
        } catch {
          // Reporting is best-effort: the state, the `errored` row and any
          // materialized events are already committed.
        }
      }
    }
  }

  /**
   * Flush held notify work whose time has come without acquiring new source
   * observations: a rollup window check on a not-due tick (002 §4.4), or a
   * debounce deadline or rollup window reached while the source's observe()
   * fails (002 §2.6). Notify dispatch runs with an empty arrival set, so it
   * decides exactly as a successful tick with no new observations would.
   *
   * Read the authoritative batch, minute marker, source checkpoint and
   * observation time only after obtaining the writer lock; a schedule
   * snapshot cannot safely supply this decision after another runtime has
   * committed newer work. Only the notify state changes: the source baseline
   * and scheduling timestamp are committed back as they were read, so a flush
   * never stands in for a successful observation.
   */
  private async flushHeldNotifyWork(
    monitor: MonitorDefinition,
    now: Date,
    workspacePath: string,
    ephemeralSessionId?: string,
  ): Promise<MaterializationSpanResult> {
    const admitted = runRuntimeTransaction(this.store, () => {
      const current = this.store.getMonitorState(monitor.id, workspacePath);
      const dispatch = this.dispatchNotify(
        monitor,
        [],
        now,
        current.notifyState,
      );
      const options: MaterializationSpanOptions = {
        observed: 0,
        workspacePath,
        nextMonitorState: {
          sourceState: current.sourceState,
          notifyState: dispatch.nextState,
          lastObservationAt: current.lastObservationAt ?? null,
        },
        ...(ephemeralSessionId !== undefined ? { ephemeralSessionId } : {}),
      };
      return {
        durable: this.admitSpan(monitor, dispatch.emitted, options),
        options,
        emitted: dispatch.emitted.length,
      };
    });
    // Even an empty matching window commits its minute marker, but routine
    // window checks must not manufacture no-change history or empty deliveries.
    if (admitted.emitted === 0) return { emittedEventIds: [], failures: [] };
    return await this.finishMaterializationSpan(
      monitor,
      admitted.durable,
      admitted.options,
    );
  }

  /**
   * The held-work flush for a poll whose observe() failed (002 §2.6). Runs
   * under the admission gate current at this moment: a retired poll, or a
   * closed gate for a rejected or missing definition (002 §2.0, §4.6), leaves
   * held work untouched. Everything up to the flush's commit runs before this
   * returns, so the caller can release poll admission right after the call;
   * any failure, including a storage read, arrives as a rejection.
   */
  private async flushHeldWorkDespiteSourceFailure(
    monitor: MonitorDefinition,
    admission: PollAdmission,
    now: Date,
    workspacePath: string,
    ephemeralSessionId: string | undefined,
  ): Promise<MaterializationSpanResult> {
    const latest = admission.retired
      ? undefined
      : this.watchPolicies.get(JSON.stringify([workspacePath, monitor.id]));
    if (!latest || !this.hasCurrentNotifyHold(monitor.id, workspacePath)) {
      return { emittedEventIds: [], failures: [] };
    }
    return await this.flushHeldNotifyWork(
      this.applyWatchPolicy(monitor, latest),
      now,
      workspacePath,
      ephemeralSessionId,
    );
  }

  /**
   * Put a held-work flush's outcome on the tick result. A flush that rolled
   * back keeps its whole batch held for the next check; it is reported on the
   * tick result and as a best-effort `errored` row, and stays local to this
   * monitor so healthy siblings are still evaluated.
   */
  private async reportHeldNotifyFlush(
    flush: Promise<MaterializationSpanResult>,
    monitorId: string,
    workspacePath: string,
    sourceName: string,
    acc: TickAccumulator,
  ): Promise<void> {
    try {
      const flushed = await flush;
      acc.emittedEventIds.push(...flushed.emittedEventIds);
      if (flushed.failures.length > 0) {
        acc.erroredObservations.push({
          monitorId,
          message: summarizeMaterializationFailures(flushed.failures),
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      acc.erroredObservations.push({ monitorId, message });
      try {
        this.store.recordObservationHistory({
          monitorId,
          workspacePath,
          sourceName,
          result: 'errored',
          observationData: { error: message },
        });
      } catch {
        // Audit is best-effort after the failed admission rolled back.
      }
    }
  }

  /**
   * Record one observation admission could not keep as outstanding loss
   * (002 §2), whatever the reason: the retry outbox could not retain it, or a
   * hold refused it (002 §4.7). Every admission loss goes through here, and
   * this and a skipped retry's loss ({@link AgentMonitorRuntime.skipMaterializationRetry})
   * both build their record with `observationLossRecord`, so each gets the
   * same drop identity and the same supersession rule. Must run inside the
   * admitting span's transaction, at the lost observation's place in the
   * span's order (see {@link RuntimeStore.recordObservationLoss}).
   */
  private recordObservationLoss(
    monitorId: string,
    sourceName: string,
    workspacePath: string,
    observation: Observation,
    observationData: Record<string, unknown> & { error: string },
  ): void {
    this.store.recordObservationLoss({
      monitorId,
      workspacePath,
      sourceName,
      ...observationLossRecord(observation, observationData),
    });
  }

  /**
   * Synchronously persist the event prefix, ordered retry suffix, losses and
   * state. Caller holds the outer immediate transaction; individual events use
   * nested savepoints. No adapter or producer callback is allowed in this
   * boundary.
   *
   * `notHeld` are the dispatch's hold refusals (002 §4.7). Each is recorded as
   * loss at its place in observation order, after the `emittedBefore` events
   * that precede it, so the drop watermark (002 §2) orders it against its
   * siblings exactly as an unretained drop is ordered. Once a retained suffix
   * has started, later refusals are recorded after that suffix is queued: the
   * suffix's admission positions are reserved only then, and a retry of an
   * older observation must not supersede a newer loss.
   */
  private admitSpan(
    monitor: MonitorDefinition,
    emitted: StoredObservationEnvelope[],
    options: MaterializationSpanOptions,
    notHeld: readonly NotHeldObservation[] = [],
  ): DurableMaterializationSpan {
    const materialized: MaterializedObservation[] = [];
    const failures: MaterializationFailure[] = [];
    const retention = new SuffixRetention(
      this.store,
      monitor.id,
      options.workspacePath,
      emitted,
    );
    let deferRemaining = false;
    let refusalsRecorded = 0;
    const recordRefusalsBefore = (position: number) => {
      for (
        let refusal = notHeld[refusalsRecorded];
        refusal !== undefined && refusal.emittedBefore <= position;
        refusal = notHeld[++refusalsRecorded]
      ) {
        this.recordObservationLoss(
          monitor.id,
          monitor.frontmatter.watch.type,
          options.workspacePath,
          refusal.observation,
          heldRefusalData(refusal),
        );
      }
    };

    for (const [index, envelope] of emitted.entries()) {
      if (!deferRemaining) recordRefusalsBefore(index);
      if (deferRemaining) {
        failures.push({
          envelope,
          message:
            'Deferred behind an earlier observation that failed materialization.',
          retained: true,
          auditError: false,
        });
        continue;
      }
      try {
        const result = this.materializeObservation({
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
        if (result) {
          materialized.push({
            monitor: envelope.monitor,
            ...result,
            projectedSessionIds: this.store.projectedSessionIdsForLastEvent(),
          });
        }
      } catch (materializeError) {
        rethrowIfRuntimeTransactionAborted(this.store, materializeError);
        const message = errorMessage(materializeError);
        const refusal = retention.refusal(index);
        if (refusal === undefined) {
          deferRemaining = true;
          failures.push({
            envelope,
            message,
            retained: true,
            auditError: true,
          });
          continue;
        }
        // The outbox cannot take this suffix, and replaying the span would
        // fail the same way, so holding the baseline would stop the monitor
        // for good. Record the terminal outcome in this transaction instead
        // and keep admitting later siblings: nothing older is queued ahead of
        // them. A failure writing this row rolls back the span, like any
        // other storage failure.
        const unretainedData = unretainedObservationData(
          envelope.observation,
          message,
          refusal,
          index,
          emitted.length,
        );
        const unretained = unretainedData.error;
        this.recordObservationLoss(
          monitor.id,
          envelope.monitor.frontmatter.watch.type,
          options.workspacePath,
          envelope.observation,
          unretainedData,
        );
        failures.push({
          envelope,
          message: unretained,
          retained: false,
          auditError: false,
        });
      }
    }

    const retained = failures.filter((failure) => failure.retained);
    if (retained.length > 0) {
      // The store's default clock starts backoff at enqueue, after acquisition
      // and prefix materialization. Tick/envelope time is observation provenance
      // and must not consume the initial delay or be rewritten to repair it.
      // `SuffixRetention` already established that this suffix fits and is
      // serializable; a throw here is a storage failure and rolls back the span.
      this.store.enqueueMaterializationRetries(
        retained.map((failure) => ({
          workspacePath: options.workspacePath,
          monitorId: monitor.id,
          sourceName: failure.envelope.monitor.frontmatter.watch.type,
          envelope: failure.envelope,
          error: failure.message,
        })),
      );
    }
    // Refusals after every emitted envelope, or after a retained suffix began.
    recordRefusalsBefore(Number.POSITIVE_INFINITY);

    // State follows suffix admission so either failure also rolls back every
    // successful sibling, preserving the prior source/notify replay boundary.
    this.store.setMonitorState(
      monitor.id,
      options.workspacePath,
      options.nextMonitorState,
    );
    return { materialized, failures };
  }

  /** Audit and interpret only the deterministic result of a successful outer commit. */
  private async finishMaterializationSpan(
    monitor: MonitorDefinition,
    durable: DurableMaterializationSpan,
    options: MaterializationSpanOptions,
  ): Promise<MaterializationSpanResult> {
    const observed = options.observed;
    const emittedCount = durable.materialized.length;
    // Drops this span already recorded in its admission transaction. The batch
    // row carries the count so readers can tell this span did not complete
    // cleanly, even though its row is newer than the drop rows (002 §2).
    const notRetainedCount = durable.failures.filter(
      ({ retained }) => !retained,
    ).length;
    // Refusals at hold acceptance (002 §4.7) already have their own `errored`
    // loss rows. They count in `observed` but never make a span `suppressed`.
    const notHeld = options.notHeld ?? 0;
    // Do not write a false batch-level `triggered` row when every dispatched
    // envelope failed, nor a `suppressed` row for a span whose only
    // observations a hold refused. Individual rows are the truthful outcome.
    if (
      emittedCount > 0 ||
      (durable.failures.length === 0 && (notHeld === 0 || observed > notHeld))
    ) {
      try {
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath: options.workspacePath,
          sourceName: monitor.frontmatter.watch.type,
          result:
            emittedCount > 0
              ? 'triggered'
              : observed === 0 && options.sourceOutcome !== undefined
                ? options.sourceOutcome
                : observed > notHeld
                  ? 'suppressed'
                  : 'no-change',
          observationData: {
            observed,
            emitted: emittedCount,
            ...(notRetainedCount > 0 ? { notRetainedCount } : {}),
            ...(notHeld > 0 ? { notHeld } : {}),
          },
        });
      } catch {
        // Audit is best-effort and cannot roll back committed runtime state.
      }
    }
    for (const failure of durable.failures.filter(
      ({ auditError }) => auditError,
    )) {
      try {
        this.store.recordObservationHistory({
          monitorId: monitor.id,
          workspacePath: options.workspacePath,
          sourceName: monitor.frontmatter.watch.type,
          result: 'errored',
          observationData: { error: failure.message },
        });
      } catch {
        // Audit is best-effort and cannot roll back committed runtime state.
      }
    }

    // Every event/projection/snapshot is committed before optional async work.
    // Each event carries its own recipient set rather than another event's.
    for (const materialized of durable.materialized) {
      await this.interpretMaterializedObservation(
        materialized,
        options.workspacePath,
      );
    }
    return {
      emittedEventIds: durable.materialized.map(({ event }) => event.id),
      failures: durable.failures,
    };
  }

  /**
   * Interpret only committed work; optional adapter failures cannot undo
   * admission. A failure is recorded best-effort as an `errored` row.
   */
  private async interpretMaterializedObservation(
    materialized: MaterializedObservation,
    workspacePath: string,
  ): Promise<void> {
    if (
      materialized.monitor.frontmatter.payload?.form !== 'prose' ||
      !this.interpretAdapter
    ) {
      return;
    }
    try {
      await this.runInterpret(
        materialized.monitor,
        materialized.event,
        materialized.diffText,
        materialized.projectedSessionIds,
      );
    } catch (error) {
      try {
        this.store.recordObservationHistory({
          monitorId: materialized.monitor.id,
          workspacePath,
          sourceName: materialized.monitor.frontmatter.watch.type,
          result: 'errored',
          observationData: { error: errorMessage(error) },
        });
      } catch {
        // A diagnostic failure cannot undo already committed accepted work.
      }
    }
  }

  /** Refresh projections only after the workspace's deterministic admission has settled. */
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
   * `watch()` (G5). Each yielded finite batch is funnelled through the same
   * pipeline as a ticked `observe()` (notify dispatch → materialization →
   * projection). Returns a handle whose `stop()` aborts and awaits every watcher.
   * While a watcher is active, the tick loop skips that monitor's `observe()`, so
   * it is never driven twice. A source without `watch()` creates no factory:
   * only already-owned scopes reconcile here, and unowned polling state remains
   * untouched for the tick loop.
   *
   * Restart-safety: every accepted batch commits its associated source state.
   * Re-established watchers receive that baseline as previousState.
   */
  async watchMonitors(
    monitorsDir: string,
    workspacePath = monitorsDir,
    options: { onError?: (monitorId: string, error: Error) => void } = {},
  ): Promise<WatchHandle> {
    const result = await scanMonitors(monitorsDir);
    this.assertNoDuplicateIds(result, monitorsDir);

    const startup: TickAccumulator = {
      evaluated: [],
      emittedEventIds: [],
      erroredObservations: [],
      skippedMonitors: [],
    };
    this.reportMissingHeldDefinitions(result, workspacePath, startup);
    for (const error of startup.erroredObservations) {
      options.onError?.(error.monitorId, new Error(error.message));
    }

    const controllers = new Map<string, AbortController>();
    const tasks: Promise<void>[] = [];

    for (const parsed of result.monitors) {
      const errorStart = startup.erroredObservations.length;
      const monitor = this.revalidateDiscoveredMonitor(
        parsed.monitor,
        workspacePath,
        startup,
      );
      if (!monitor) {
        for (const error of startup.erroredObservations.slice(errorStart)) {
          options.onError?.(error.monitorId, new Error(error.message));
        }
        continue;
      }
      const sourceName = monitor.frontmatter.watch.type;
      const source = this.registry.get(sourceName);
      if (!source) {
        // Never leave an existing watcher open under an unresolved definition;
        // classify retained work from current scoped state, not the earlier scan.
        this.setWatchPolicy(monitor.id, workspacePath, null, monitor.filePath);
        if (this.hasCurrentNotifyHold(monitor.id, workspacePath)) {
          const message = `Notify edit blocked: unknown source "${sourceName}"; accepted holds retained.`;
          this.reportNotifyEditFailure(
            monitor.id,
            workspacePath,
            sourceName,
            message,
            startup,
          );
          options.onError?.(monitor.id, new Error(message));
          continue;
        }
        throw new Error(
          `Monitor "${monitor.id}" references unknown source "${sourceName}".`,
        );
      }
      const key = JSON.stringify([workspacePath, monitor.id]);
      const existing = this.activeWatchers.has(key);
      const canWatch = typeof source.watch === 'function';
      // Factory capability does not exempt existing watcher/poll ownership from
      // the current definition's admission boundary. Unowned observe-only scopes
      // remain ordinary polling work, untouched by watcher startup.
      if (!canWatch && !this.notifyPolicyUsers.has(key)) continue;
      // Watch startup is a source execution boundary just like a one-shot tick.
      // Isolate bad config before reserving a watcher slot or touching its state.
      const errors = validateWatchScope(
        watchConfig(monitor.frontmatter.watch),
        source.scopeSchema,
      );
      if (errors.length > 0) {
        // Held work is protected: close the admission gate so an existing watcher
        // or poll cannot commit beside it under the rejected definition. Without
        // held work, running watchers keep their startup config (002 §2.0, §4.6).
        if (this.hasHeldNotifyWork(monitor.id, workspacePath)) {
          this.setWatchPolicy(
            monitor.id,
            workspacePath,
            null,
            monitor.filePath,
          );
        }
        const error = new Error(errors.join('; '));
        if (options.onError) {
          options.onError(monitor.id, error);
        } else {
          process.stderr.write(
            `Monitor "${monitor.id}" skipped: ${error.message}\n`,
          );
        }
        continue;
      }
      const controller = new AbortController();
      // Identity token for THIS watcher: `consumeWatch` releases the slot only
      // while its own token is still current, and a superseded watcher's
      // straggling batch is rejected on token mismatch (002 §2.4).
      const watcherToken = Symbol(monitor.id);
      if (canWatch && !existing) {
        controllers.set(monitor.id, controller);
        this.activeWatchers.set(key, watcherToken);
        this.retainNotifyPolicy(monitor.id, workspacePath);
      }
      try {
        const errorStart = startup.erroredObservations.length;
        const emittedStart = startup.emittedEventIds.length;
        // Work retained before startup (including before a restart) drains
        // before held work is reconciled or the source is asked for anything
        // (002 §2.7). If it cannot drain yet, the admission gate stays closed
        // and no edit is reconciled; a later tick drains it and opens the gate.
        const blocked = this.hasRetainedWork(monitor.id, workspacePath)
          ? await this.drainMaterializationRetries(
              monitor.id,
              workspacePath,
              new Date(),
            ).then((drained) => {
              startup.emittedEventIds.push(...drained.emittedEventIds);
              return drained.blocked;
            })
          : undefined;
        if (blocked) {
          this.setWatchPolicy(
            monitor.id,
            workspacePath,
            null,
            monitor.filePath,
          );
          this.reportBlockedDrain(monitor, workspacePath, blocked, startup);
        } else {
          await this.prepareNotifyPolicy(monitor, workspacePath, startup);
        }
        // Startup may never receive a yield or tick. Publish committed projections
        // to the workspace's hook files even for an idle or completed source.
        if (startup.emittedEventIds.length > emittedStart) {
          this.refreshWorkspaceSessions(workspacePath);
        }
        for (const error of startup.erroredObservations.slice(errorStart)) {
          options.onError?.(error.monitorId, new Error(error.message));
        }
        if (!canWatch || existing) continue;

        tasks.push(
          this.consumeWatch(
            monitor,
            workspacePath,
            controller.signal,
            watcherToken,
            options.onError,
          ),
        );
      } catch (error) {
        if (canWatch && !existing) {
          controller.abort();
          controllers.delete(monitor.id);
          if (this.activeWatchers.get(key) === watcherToken)
            this.activeWatchers.delete(key);
          this.releaseNotifyPolicy(monitor.id, workspacePath);
        }
        throw error;
      }
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
   * Admit each finite watch batch before interpretation and the next iterator
   * pull. A whole-admission failure ends this iterator so its source cannot
   * advance beyond work that is absent from durable storage. Retained retries
   * count as successful admission, and the watcher drains them before its
   * next pull (002 §2.7).
   */
  private async consumeWatch(
    monitor: MonitorDefinition,
    workspacePath: string,
    signal: AbortSignal,
    watcherToken: symbol,
    onError?: (monitorId: string, error: Error) => void,
  ): Promise<void> {
    const key = JSON.stringify([workspacePath, monitor.id]);
    // Ownership is local to this runtime. A stopped or superseded iterator can
    // still settle a pending next(), but its late batch has no admission rights.
    const ownsWatch = () =>
      !signal.aborted && this.activeWatchers.get(key) === watcherToken;
    try {
      // No source factory exists until durable reconciliation permits admission
      // (002 §4.6). A corrected blocked declaration becomes the initial
      // execution snapshot; later edits change only its pacing/urgency. The
      // restart baseline handed to the factory is read in that same turn, and
      // every batch must still find it persisted when it is admitted.
      let expectedSourceState = '';
      const iterable = await this.acceptWatchWork(
        monitor,
        workspacePath,
        signal,
        (admitted) => {
          monitor = admitted;
          const source = this.registry.get(monitor.frontmatter.watch.type);
          if (!source?.watch) {
            throw new Error(
              `Monitor "${monitor.id}" has no available watch source after reconciliation.`,
            );
          }
          const monitorState = this.store.getMonitorState(
            monitor.id,
            workspacePath,
          );
          expectedSourceState = sourceStateToken(monitorState.sourceState);
          return source.watch(watchConfig(monitor.frontmatter.watch), {
            previousState: monitorState.sourceState,
            now: new Date(),
            workspacePath,
            signal,
          });
        },
      );
      if (!iterable) return;
      // Work retained before this watcher started (including before a
      // restart) completes before its first pull (002 §2.7).
      if (
        this.hasRetainedWork(monitor.id, workspacePath) &&
        !(await this.drainBeforeWatchPull(
          monitor.id,
          workspacePath,
          signal,
          ownsWatch,
          onError,
        ))
      ) {
        return;
      }
      for await (const batch of iterable) {
        if (!ownsWatch()) break;
        // JavaScript plugins may still use the old bare-observation interface.
        // Refuse it rather than inventing a checkpoint association or silently
        // persisting the batch object itself as a fabricated observation.
        if (!isObservationBatch(batch)) {
          throw new Error(
            'watch() must yield an observation batch with an observations array; migrate bare observations and checkpoint callbacks to ObservationResult.',
          );
        }
        const nextExpectedSourceState =
          batch.nextState === undefined
            ? expectedSourceState
            : sourceStateToken(batch.nextState);
        // A closed gate (a failed edit drain, an unresolved source, or a
        // rejected scope with held work) keeps this batch on the consumer's
        // stack: no newer pull, and no drop or retry is recorded for it until
        // valid reconciliation or abort (002 §4.6). Acceptance rereads the gate
        // and this watcher's token in the same synchronous turn as the batch's
        // admission transaction, which `ingest` runs before its first await.
        const accepted = await this.acceptWatchWork(
          monitor,
          workspacePath,
          signal,
          (current) =>
            this.activeWatchers.get(key) === watcherToken
              ? {
                  ingestion: this.ingest(
                    this.applyWatchPolicy(monitor, current),
                    batch.observations,
                    new Date(),
                    {
                      workspacePath,
                      expectedSourceState,
                      ...(batch.nextState !== undefined
                        ? { nextSourceState: { value: batch.nextState } }
                        : {}),
                      ...(batch.outcome
                        ? { sourceOutcome: batch.outcome }
                        : {}),
                      onNotHeld: (message) =>
                        onError?.(monitor.id, new Error(message)),
                    },
                  ),
                }
              : undefined,
        );
        // Aborted or superseded while the batch waited: it was never admitted.
        if (!accepted) break;
        const ingested = await accepted.ingestion;
        expectedSourceState = nextExpectedSourceState;
        if (ingested.failures.length > 0) {
          onError?.(
            monitor.id,
            new Error(summarizeMaterializationFailures(ingested.failures)),
          );
        }
        this.refreshWorkspaceSessions(workspacePath);
        // Abort may arrive while Interpret is suspended. Do not ask the source
        // for newer input after it has lost ownership of this watcher.
        if (!ownsWatch()) break;
        // A retained suffix of this batch completes before the next pull.
        if (
          this.hasRetainedWork(monitor.id, workspacePath) &&
          !(await this.drainBeforeWatchPull(
            monitor.id,
            workspacePath,
            signal,
            ownsWatch,
            onError,
          ))
        ) {
          break;
        }
      }
    } catch (error) {
      if (ownsWatch()) {
        const message = errorMessage(error);
        try {
          this.store.recordObservationHistory({
            monitorId: monitor.id,
            workspacePath,
            sourceName: monitor.frontmatter.watch.type,
            result: 'errored',
            observationData: { error: message },
          });
        } catch {
          // Reporting failure cannot turn rolled-back admission into success.
        }
        onError?.(
          monitor.id,
          error instanceof Error ? error : new Error(message),
        );
      }
    } finally {
      // for-await closes the iterator on a failed admission or early break.
      // Every accepted batch has settled by now: the loop awaits each one
      // before pulling again. Release only this watcher's slot, never a
      // successor's ownership token; the cache lease is this watcher's own.
      if (this.activeWatchers.get(key) === watcherToken) {
        this.activeWatchers.delete(key);
      }
      this.releaseNotifyPolicy(monitor.id, workspacePath);
    }
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
    const notHeld: NotHeldObservation[] = [];
    // Refusals made while a debounce batch was held, each with how many held
    // observations preceded it. Those held observations are older than the
    // refusal, so if an escalation later in this dispatch flushes the batch,
    // the refusal's place moves to just after them (002 §2).
    let refusedBehindHeld: { refusal: NotHeldObservation; held: number }[] = [];
    const nextState: NotifyRuntimeState = { ...state };

    // Scheduled-rollup Pace mode (002 §4.4). A `rollup` monitor accumulates
    // every observation in durable `notifyState.pendingRollup` and delivers
    // nothing until the author's `window` cron fires (no per-change interrupts,
    // §4.4 step 6). It never uses the debounce/throttle/immediate paths below,
    // so it short-circuits the rest of dispatchNotify.
    //
    // Effective edits drain captured holds atomically before this dispatcher
    // runs. Dispatch never owns cancellation of a different strategy's work.
    if (monitor.frontmatter.notify?.strategy === 'rollup') {
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
        // The flushed batch keeps arrival order, so a refusal made while `held`
        // observations were waiting belongs right after those `held` flushed
        // envelopes and before the newer ones held after it.
        for (const { refusal, held } of refusedBehindHeld) {
          refusal.emittedBefore = emitted.length + held;
        }
        refusedBehindHeld = [];
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

      // Hold acceptance (002 §4.7): an envelope that cannot be serialized never
      // joins the batch, so the state write below cannot fail on it and the
      // batch's other observations are unaffected.
      const notHeldMessage = notHeldReason(envelope, 'debounce');
      if (notHeldMessage !== undefined) {
        const refusal: NotHeldObservation = {
          observation,
          message: notHeldMessage,
          emittedBefore: emitted.length,
        };
        notHeld.push(refusal);
        const held = nextState.pendingDebounce?.observations.length ?? 0;
        if (held > 0) refusedBehindHeld.push({ refusal, held });
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

    return { emitted, nextState, notHeld };
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
      return { emitted: [], nextState, notHeld: [] };
    }

    // 1. Accumulate. Hydrate any restart-persisted envelopes (backfilling
    // `effectiveUrgency` per 002 §3 / issue #109) so a batch that survived a
    // daemon restart materializes with a valid urgency, then append this tick's
    // new observations.
    const held = (nextState.pendingRollup?.observations ?? []).map(
      hydrateStoredObservationEnvelope,
    );
    const arrived = observations.map((observation) =>
      serializeObservation(monitor, observation, observedAt),
    );

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
    // produces no delivery (§4.4 step 3). Observations arriving on the firing
    // tick go straight to materialization and are never held.
    if (windowFires && held.length + arrived.length > 0) {
      delete nextState.pendingRollup;
      return { emitted: [...held, ...arrived], nextState, notHeld: [] };
    }

    // Otherwise keep accumulating silently — no per-change interrupts (§4.4
    // step 6). Hold acceptance (002 §4.7): an arriving envelope that cannot be
    // serialized never joins the batch; its serializable siblings keep their
    // order. Persist the batch (durable accumulation, §4.4 step 1) only when
    // there is something to hold; an empty window with nothing accumulated
    // leaves `pendingRollup` absent.
    const notHeld: NotHeldObservation[] = [];
    const accumulated = [...held];
    for (const envelope of arrived) {
      const message = notHeldReason(envelope, 'rollup');
      if (message === undefined) accumulated.push(envelope);
      // A window that does not fire emits nothing, so nothing precedes it.
      else
        notHeld.push({
          observation: envelope.observation,
          message,
          emittedBefore: 0,
        });
    }
    if (accumulated.length > 0) {
      nextState.pendingRollup = { observations: accumulated };
    } else {
      delete nextState.pendingRollup;
    }
    return { emitted: [], nextState, notHeld };
  }

  /**
   * Stage one observation's event, recipient projections, cursor seeds and
   * snapshot inside the caller's span transaction (the event insert uses its
   * own nested savepoint in `store.ts`; the outer transaction commits). It
   * neither commits nor invokes Interpret: optional Interpret runs only after
   * that commit, in `interpretMaterializedObservation`.
   */
  private materializeObservation(input: ProcessObservationInput) {
    const rendered = this.renderObservationEvent(input);
    if (!rendered) return null;
    const event = this.store.insertEvent(
      rendered.event,
      rendered.baseline,
      // Ephemeral-monitor projection isolation (007 §4.6): restrict projection to
      // the declaring session so its events never reach a sibling lead session.
      input.restrictToSessionId !== undefined
        ? { restrictToSessionId: input.restrictToSessionId }
        : undefined,
    );
    return { event, diffText: rendered.diffText };
  }

  /**
   * Deterministically render one observation into the shared event row it
   * becomes, without writing it. Admission writes it with
   * {@link RuntimeStore.insertEvent}; a retained retry hands the same
   * rendering to {@link RuntimeStore.completeMaterializationRetry}, so a
   * drained retry produces exactly the event its span would have (002 §2.7).
   * Returns `null` for an observation its payload gate suppresses.
   */
  private renderObservationEvent(input: ProcessObservationInput): {
    event: Omit<MonitorEventRecord, 'id'>;
    baseline: { previousContent: string | null };
    diffText: string | null;
  } | null {
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

    // An empty snapshot is an observed empty object. Only null/undefined mean
    // no snapshot; deletion deltas must still use the prior durable baseline.
    const previousSnapshot =
      effectiveSnapshotText != null
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
      effectiveSnapshotText != null && previousSnapshot
        ? buildDiff(previousSnapshot.content, effectiveSnapshotText, strategy)
        : null;

    return {
      event: {
        workspacePath: input.workspacePath ?? null,
        monitorId: input.monitor.id,
        sourceName: input.sourceName,
        urgency: input.effectiveUrgency,
        // The delivered headline is the monitor's AUTHORED name when it has one
        // (002 §5.4, issue #449). A source title is written from the source's
        // point of view and often embeds a configuration detail — `command-poll`
        // interpolates its `objectKey`, which defaults to the joined argv, so an
        // unnamed jq-heavy poller announced itself with ~400 characters of its
        // own implementation. The author's `name` is the one human-written string
        // that says what the monitor is FOR, so it wins. Fallback when `name` is
        // absent: the source-provided title, unchanged. The source title is never
        // lost — it remains the `summary` below (sources set both), and the raw
        // command stays in `payload.command` / `objectKey` for debugging.
        title: input.monitor.frontmatter.name ?? input.observation.title,
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
        // The definition-content fingerprint (issue #451) — computed from
        // `input.monitor`, the SAME per-observation snapshot `urgency`/`title`/
        // `body` above were captured from, never a live re-scan.
        definitionFingerprint: definitionFingerprint(input.monitor),
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
      baseline: { previousContent: previousSnapshot?.content ?? null },
      diffText,
    };
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
    sessionIds = this.store.projectedSessionIdsForLastEvent(),
  ): Promise<void> {
    const adapter = this.interpretAdapter;
    if (!adapter) return;
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
