/**
 * Synchronous durable storage for monitor observations, recipient delivery
 * state and recovery obligations. Transactions own persistence invariants;
 * source observation, scheduling and asynchronous interpretation stay outside.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import { monotonicFactory, ulid } from 'ulid';

/**
 * Public event identities retain their ULID representation. This process-local
 * factory supplies uniqueness, not cross-process event order; persisted
 * observation time and SQLite's private event sequence govern delivery order.
 */
const eventUlid = monotonicFactory();

/**
 * Public snapshot identities retain their ULID representation. This factory is
 * local to one process and cannot establish insertion order across writers.
 * SQLite's private snapshot sequence, not this ID or the wall clock, determines
 * the committed predecessor used by shared diffs.
 */
const snapshotUlid = monotonicFactory();

/**
 * Monotonic ULID factory for `observation_history` ids (issue #293). The audit
 * trail (`monitor explain`) lists rows newest-first ordered by `created_at`,
 * which is second-precision, so rows recorded in the same second would surface
 * in an arbitrary order. A monotonic `id` gives a stable within-second order for
 * this user-visible listing.
 */
const observationUlid = monotonicFactory();
const materializationRetryUlid = monotonicFactory();
import type { InboxDb } from '../inbox/db.js';
import {
  agentSessions,
  ephemeralMonitors,
  materializationRetryOutbox,
  monitorEvents,
  monitorSnapshots,
  monitorState,
  objectEventSuppressions,
  observationHistory,
  sessionEventState,
  sessionObjectCursor,
} from '../inbox/schema.js';
import { EPHEMERAL_MONITOR_ID_PREFIX } from './types.js';
import { registerRuntimeTransaction } from './runtime-transaction.js';
import type {
  AgentSessionRecord,
  EnqueueMaterializationRetryInput,
  EphemeralMonitorRecord,
  EventQuery,
  MonitorEventRecord,
  MonitorDeliveryProjection,
  MonitorDeliveryState,
  MonitorRuntimeState,
  MaterializationRetryQuery,
  MaterializationRetryRecord,
  MaterializationRetrySummary,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
  ObservationOutcome,
  OpenSessionInput,
  RuntimeStatus,
  SessionHookState,
  SessionObjectCursorRecord,
  UnretainedObservationLoss,
} from './types.js';
import {
  MATERIALIZATION_RETRY_DELAYS_MS,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  MATERIALIZATION_RETRY_MAX_BYTES,
  MATERIALIZATION_RETRY_MAX_RECORDS,
} from './types.js';
import type { Urgency } from '../schema/types.js';
import { buildDiff, changeDetectionStrategyOf } from './diff.js';
import { safeDiagnosticText } from './diagnostic-text.js';
import {
  deserializeRetryEnvelope,
  serializeRetryEnvelope,
} from './retry-envelope.js';
import { registerStoreWriter } from './store-writer.js';

type InternalInboxDb = BetterSQLite3Database<
  typeof import('../inbox/schema.js')
> & { $client: BetterSQLiteClient };

function asInternalDb(db: InboxDb): InternalInboxDb {
  return db as unknown as InternalInboxDb;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSession(
  row: typeof agentSessions.$inferSelect,
): AgentSessionRecord {
  return {
    id: row.id,
    adapter: row.adapter,
    hostSessionId: row.hostSessionId,
    agentIdentity: row.agentIdentity,
    role: row.role,
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
    hookStatePath: row.hookStatePath,
    status: row.status,
    baselineAt: row.baselineAt,
    lastActiveAt: row.lastActiveAt,
    ...(row.lastRecapAt ? { lastRecapAt: row.lastRecapAt } : {}),
    ...(row.dormantAt ? { dormantAt: row.dormantAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(
  row: typeof monitorEvents.$inferSelect,
): MonitorEventRecord {
  return {
    id: row.id,
    workspacePath: row.workspacePath ?? null,
    monitorId: row.monitorId,
    sourceName: row.sourceName,
    urgency: row.urgency,
    title: row.title,
    body: row.body,
    summary: row.summary,
    payload: parseJson(row.payload, {}),
    snapshotMetadata: parseJson(row.snapshotMetadata, {}),
    snapshotText: row.snapshotText ?? null,
    diffText: row.diffText ?? null,
    objectKey: row.objectKey ?? null,
    baselineStrategy: row.baselineStrategy ?? null,
    queryScope: parseJson(row.queryScope, {}),
    tags: parseJson(row.tags, []),
    createdAt: row.createdAt,
    definitionFingerprint: row.definitionFingerprint ?? null,
  };
}

function rowToEphemeralMonitor(
  row: typeof ephemeralMonitors.$inferSelect,
): EphemeralMonitorRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspacePath: row.workspacePath ?? null,
    sourceName: row.sourceName,
    scope: parseJson<Record<string, unknown>>(row.scope, {}),
    urgency: row.urgency,
    urgencyMax: row.urgencyMax,
    instruction: row.instruction,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.reapedAt ? { reapedAt: row.reapedAt } : {}),
  };
}

function rowToMaterializationRetry(
  row: typeof materializationRetryOutbox.$inferSelect,
): MaterializationRetryRecord {
  return {
    id: row.id,
    workspacePath: row.workspacePath ?? null,
    monitorId: row.monitorId,
    sourceName: row.sourceName,
    envelope: deserializeRetryEnvelope(row.envelope, row.id),
    envelopeBytes: row.envelopeBytes,
    attemptCount: row.attemptCount,
    status: row.status,
    nextAttemptAt: row.nextAttemptAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function materializationRetryKey(
  monitorId: string,
  workspacePath: string | null,
) {
  return and(
    eq(materializationRetryOutbox.monitorId, monitorId),
    workspacePath === null
      ? isNull(materializationRetryOutbox.workspacePath)
      : eq(materializationRetryOutbox.workspacePath, workspacePath),
  );
}

/**
 * When a retained observation entered the runtime: its reserved position in
 * the materialization order (NULL for rows queued before positions existed)
 * and its observation time, the fallback for sessions without a position.
 */
interface RetryAdmission {
  admissionSequence: number | null;
  observedAt: Date;
}

/** Bound persisted and projected failure text without letting it control terminal layout. */
function safeRetryError(message: string): string {
  return safeDiagnosticText(message);
}

/**
 * SQLite stores retry timestamps in whole seconds. Round deadlines upward so
 * persistence never shortens a backoff; the extra wait is less than one second.
 */
function retryDeadline(now: Date, delayMs: number): Date {
  return new Date(Math.ceil((now.getTime() + delayMs) / 1_000) * 1_000);
}

/** A retained-work identity no longer exists; callers can distinguish this from I/O failure. @public */
export class MaterializationRetryNotFoundError extends Error {
  /** Stable code for callers that cannot rely on class identity across process boundaries. */
  readonly code = 'materialization_retry_not_found';
  /** The requested durable work identity, never its observation payload. */
  readonly retryId: string;

  constructor(retryId: string) {
    super(`Materialization retry record not found: ${retryId}`);
    this.name = 'MaterializationRetryNotFoundError';
    this.retryId = retryId;
  }
}

/** An operation would bypass the retained-work lifecycle or consume a different observation. @public */
export class MaterializationRetryTransitionError extends Error {
  /** Stable code for lifecycle rejection, distinct from storage failure. */
  readonly code = 'materialization_retry_invalid_transition';
  /** Identity of the work whose state remains unchanged after rejection. */
  readonly retryId: string;

  constructor(retryId: string, reason: string) {
    super(`Materialization retry record ${reason}: ${retryId}`);
    this.name = 'MaterializationRetryTransitionError';
    this.retryId = retryId;
  }
}

/** Raised when a workspace/monitor retry outbox has reached its bound. @public */
export class MaterializationRetryCapacityError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'materialization_retry_capacity_exceeded';

  /** Monitor whose workspace-scoped retry outbox is full. */
  readonly monitorId: string;

  constructor(monitorId: string) {
    super(`Materialization retry capacity is exhausted for ${monitorId}.`);
    this.name = 'MaterializationRetryCapacityError';
    this.monitorId = monitorId;
  }
}

function deliveryStateForRow(row: {
  firstNotifiedAt: Date | null;
  acknowledgedAt: Date | null;
}): MonitorDeliveryState {
  if (row.acknowledgedAt) return 'acknowledged';
  if (row.firstNotifiedAt) return 'claimed';
  return 'unread';
}

/**
 * The `(monitorId, workspacePath)` lookup predicate for a `monitor_state` row
 * (issue #345 / #307). `NULL` `workspacePath` (global scope) is matched with
 * `IS NULL`; a concrete workspace with equality — the same NULL-safe idiom the
 * `session_object_cursor` reads use, and paired with the
 * `COALESCE(workspace_path, '')` UNIQUE index so each scope holds one row.
 */
function monitorStateKey(monitorId: string, workspacePath: string | null) {
  return and(
    eq(monitorState.monitorId, monitorId),
    workspacePath == null
      ? isNull(monitorState.workspacePath)
      : eq(monitorState.workspacePath, workspacePath),
  );
}

/**
 * The per-recipient `net`-collapse grouping key for an event (002 §1.1.7): the
 * `(monitorId, objectKey, workspacePath)` 3-tuple — the SAME key used by
 * {@link RuntimeStore.advanceCursorsForClaimedEvents} and the
 * `session_object_cursor` UNIQUE index (its omission caused the #186
 * cross-workspace fold). An event that cannot be net-collapsed (not `net`
 * strategy, or missing a snapshot/objectKey) is its own singleton — it is never
 * folded with any other event — so it gets a collision-proof per-event key. A
 * real 3-tuple key always contains the two `\0` join separators, so a
 * `\0`-free `singleton:<id>` key can never equal one.
 */
export function netCollapseGroupKey(event: MonitorEventRecord): string {
  const collapsible =
    event.baselineStrategy === 'net' &&
    event.snapshotText !== null &&
    event.objectKey !== null;
  if (!collapsible) return `singleton:${event.id}`;
  return [event.monitorId, event.objectKey, event.workspacePath ?? ''].join(
    '\0',
  );
}

/**
 * The read-only decision half of the per-recipient `net` collapse (002 §1.1.7):
 * given a recipient's candidate set, decide which events survive as DELIVERED
 * (the newest event of each `net` object group, plus every non-collapsible
 * event) and which older `net` siblings are SUPPRESSED — with NO database
 * writes. {@link RuntimeStore.collapseNetForClaim} layers the mutating half
 * (re-anchoring the surviving delta, recording the suppression) on top of this,
 * and the delivery PREVIEW ({@link RuntimeStore} consumers that must size a
 * capped hook context before claiming — issue #299) uses this half alone, so the
 * preview and the eventual claim agree on exactly which events are delivered and
 * in what order.
 */
export interface NetCollapseView {
  /** Events to actually deliver, in the input (oldest-first) order. */
  delivered: MonitorEventRecord[];
  /** Older `net` intermediates folded away (claimed-but-suppressed at claim). */
  suppressedIds: string[];
  /** Every candidate's id → its {@link netCollapseGroupKey}. */
  groupKeyByEventId: Map<string, string>;
  /** For `net` groups only: group key → number of collapsible events in it. */
  netGroupSizeByKey: Map<string, number>;
}

/**
 * Select net endpoints without writes. Equal-time candidates must already be
 * in canonical materialization order, as supplied by the store's event queries.
 * Stable timestamp sorting preserves that tie order without treating opaque IDs
 * as chronology. Filter/slice preserve the precondition; concatenated or external
 * candidate sets must first pass the store's canonicalization boundary.
 */
export function computeNetCollapseView(
  candidates: MonitorEventRecord[],
): NetCollapseView {
  const ordered = [...candidates].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const newestNetByObject = new Map<string, MonitorEventRecord>();
  const netGroupSizeByKey = new Map<string, number>();
  for (const event of ordered) {
    if (
      event.baselineStrategy !== 'net' ||
      event.snapshotText === null ||
      event.objectKey === null
    )
      continue;
    const key = netCollapseGroupKey(event);
    newestNetByObject.set(key, event); // later (newer) overwrites earlier
    netGroupSizeByKey.set(key, (netGroupSizeByKey.get(key) ?? 0) + 1);
  }

  const groupKeyByEventId = new Map<string, string>();
  for (const event of candidates)
    groupKeyByEventId.set(event.id, netCollapseGroupKey(event));

  // No `net` group present → every candidate passes through unchanged.
  if (newestNetByObject.size === 0)
    return {
      delivered: candidates,
      suppressedIds: [],
      groupKeyByEventId,
      netGroupSizeByKey,
    };

  const suppressedIds: string[] = [];
  const delivered: MonitorEventRecord[] = [];
  for (const event of candidates) {
    const key = groupKeyByEventId.get(event.id) ?? netCollapseGroupKey(event);
    const newest = newestNetByObject.get(key);
    // A non-collapsible event (singleton key) has no `newest` entry → delivered.
    // A collapsible event survives iff it is the newest of its object group.
    if (newest === undefined || newest.id === event.id) delivered.push(event);
    else suppressedIds.push(event.id);
  }
  return { delivered, suppressedIds, groupKeyByEventId, netGroupSizeByKey };
}

/**
 * A delivery-query condition that excludes per-recipient projections the
 * Interpret agentic gate suppressed (G14, 002 §1.1.8): the row is retained for
 * `monitor explain` but is never surfaced to a transport. `deliver`/`failed`
 * (best-effort fallback) and the absent (non-`prose`) case all deliver normally.
 */
function notInterpretSuppressed() {
  return or(
    isNull(sessionEventState.interpretDecision),
    ne(sessionEventState.interpretDecision, 'suppress'),
  );
}

/**
 * A delivery-query condition that excludes per-recipient projections the `net`
 * collapse suppressed (G10 PR-B, 002 §1.1.7): an older intermediate of a `net`
 * monitor's catch-up span whose newest sibling was delivered instead. The row is
 * retained for `monitor explain` but is never surfaced to a transport.
 */
function notNetSuppressed() {
  return isNull(sessionEventState.netSuppressedAt);
}

function scopeMatches(
  eventScope: Record<string, string | string[]>,
  requested: Record<string, string> | undefined,
): boolean {
  if (!requested) return true;
  for (const [key, value] of Object.entries(requested)) {
    const candidate = eventScope[key];
    if (Array.isArray(candidate)) {
      if (!candidate.includes(value)) return false;
      continue;
    }
    if (candidate !== value) return false;
  }
  return true;
}

export class RuntimeStore {
  /**
   * Share this connection's writer boundary with internal runtime edit drains
   * and register the runtime-owned admission span runner.
   */
  constructor(private readonly db: InboxDb) {
    registerStoreWriter(this, db);
    // Runtime-owned spans compose store operations without adding executable
    // callbacks to the published store API. Cache visibility follows the outer
    // commit, including when nested event savepoints succeeded before rollback.
    // The liveness predicate reads this same owned native connection: SQLite
    // may end the outer transaction without returning through its runner first.
    registerRuntimeTransaction(
      this,
      (operation) => {
        const previousProjectedSessionIds = this.lastProjectedSessionIds;
        try {
          return asInternalDb(this.db)
            .$client.transaction(operation)
            .immediate();
        } catch (error) {
          this.lastProjectedSessionIds = previousProjectedSessionIds;
          throw error;
        }
      },
      () => asInternalDb(this.db).$client.inTransaction,
    );
  }

  openSession(input: OpenSessionInput): AgentSessionRecord {
    const db = asInternalDb(this.db);
    const existing = db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.adapter, input.adapter),
          eq(agentSessions.hostSessionId, input.hostSessionId),
        ),
      )
      .get();

    const now = new Date();
    if (existing) {
      db.update(agentSessions)
        .set({
          agentIdentity: input.agentIdentity,
          role: input.role ?? existing.role,
          workspacePath: input.workspacePath ?? existing.workspacePath,
          hookStatePath: input.hookStatePath,
          status: 'active',
          lastActiveAt: now,
          dormantAt: null,
          updatedAt: now,
        })
        .where(eq(agentSessions.id, existing.id))
        .run();
      return this.getSessionById(existing.id);
    }

    const id = ulid();
    db.$client
      .transaction(() => {
        db.insert(agentSessions)
          .values({
            id,
            adapter: input.adapter,
            hostSessionId: input.hostSessionId,
            agentIdentity: input.agentIdentity,
            role: input.role ?? 'lead',
            workspacePath: input.workspacePath ?? null,
            hookStatePath: input.hookStatePath,
            status: 'active',
            baselineAt: now,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
            // Ordered against retry admissions without relying on whole-second
            // timestamps (002 §2.7); a resumed session keeps this position.
            registrationSequence: this.reserveAdmissionSequence(),
          })
          .run();
      })
      .immediate();

    return this.getSessionById(id);
  }

  getSessionById(id: string): AgentSessionRecord {
    const row = asInternalDb(this.db)
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get();
    if (!row) {
      throw new Error(`Session not found: ${id}`);
    }
    return rowToSession(row);
  }

  /** Look up one session by id, or `null` if it does not exist (non-throwing). */
  findSessionById(id: string): AgentSessionRecord | null {
    const row = asInternalDb(this.db)
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get();
    return row ? rowToSession(row) : null;
  }

  listSessions(): AgentSessionRecord[] {
    return asInternalDb(this.db)
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.updatedAt))
      .all()
      .map(rowToSession);
  }

  closeSession(sessionId: string): AgentSessionRecord {
    const now = new Date();
    asInternalDb(this.db)
      .update(agentSessions)
      .set({
        status: 'dormant',
        dormantAt: now,
        lastActiveAt: now,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId))
      .run();
    return this.getSessionById(sessionId);
  }

  touchSession(sessionId: string): void {
    const now = new Date();
    asInternalDb(this.db)
      .update(agentSessions)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(eq(agentSessions.id, sessionId))
      .run();
  }

  // ── Ephemeral monitors (007 §4) ─────────────────────────────────────────────

  /**
   * Persist a new ephemeral (agent-declared, session-scoped) monitor (007 §4).
   * `id` is the caller-assigned namespaced runtime identity
   * `ephemeral:<sessionId>/<ulid>` (007 §4.3). The record is durable so it
   * survives a daemon restart while the declaring session lives (007 §4.4).
   */
  insertEphemeralMonitor(input: {
    id: string;
    sessionId: string;
    workspacePath: string | null;
    sourceName: string;
    scope: Record<string, unknown>;
    urgency: Urgency;
    urgencyMax: Urgency;
    instruction: string;
    displayName?: string;
  }): EphemeralMonitorRecord {
    const now = new Date();
    asInternalDb(this.db)
      .insert(ephemeralMonitors)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        sourceName: input.sourceName,
        scope: JSON.stringify(input.scope),
        urgency: input.urgency,
        urgencyMax: input.urgencyMax,
        instruction: input.instruction,
        displayName: input.displayName ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getEphemeralMonitorById(input.id);
  }

  getEphemeralMonitorById(id: string): EphemeralMonitorRecord {
    const row = asInternalDb(this.db)
      .select()
      .from(ephemeralMonitors)
      .where(eq(ephemeralMonitors.id, id))
      .get();
    if (!row) {
      throw new Error(`Ephemeral monitor not found: ${id}`);
    }
    return rowToEphemeralMonitor(row);
  }

  /** Look up one ephemeral monitor by id, or `null` if it does not exist. */
  findEphemeralMonitorById(id: string): EphemeralMonitorRecord | null {
    const row = asInternalDb(this.db)
      .select()
      .from(ephemeralMonitors)
      .where(eq(ephemeralMonitors.id, id))
      .get();
    return row ? rowToEphemeralMonitor(row) : null;
  }

  /**
   * The ACTIVE ephemeral monitors evaluated on a tick for `workspacePath`
   * (007 §4.4). Only monitors whose declaring session is itself still `active`
   * are returned — so a dormant/closed session's ephemeral monitors never fire,
   * even in the window before the reap step flips their status (a structural
   * guard for "reaped on session end / no resurrection", 007 §4.4). Scoped to the
   * workspace plus workspace-agnostic (global) records, mirroring
   * {@link sessionsForWorkspace}.
   */
  listActiveEphemeralMonitors(
    workspacePath: string | null,
  ): EphemeralMonitorRecord[] {
    const rows = asInternalDb(this.db)
      .select({ ephemeral: ephemeralMonitors })
      .from(ephemeralMonitors)
      .innerJoin(
        agentSessions,
        eq(ephemeralMonitors.sessionId, agentSessions.id),
      )
      .where(
        and(
          eq(ephemeralMonitors.status, 'active'),
          eq(agentSessions.status, 'active'),
          workspacePath == null
            ? isNull(ephemeralMonitors.workspacePath)
            : or(
                eq(ephemeralMonitors.workspacePath, workspacePath),
                isNull(ephemeralMonitors.workspacePath),
              ),
        ),
      )
      .orderBy(asc(ephemeralMonitors.createdAt))
      .all();
    return rows.map((row) => rowToEphemeralMonitor(row.ephemeral));
  }

  /**
   * The ACTIVE ephemeral monitors declared by one session (007 §4), for
   * `watch list`. Ordered oldest-first.
   */
  listEphemeralMonitorsForSession(sessionId: string): EphemeralMonitorRecord[] {
    return asInternalDb(this.db)
      .select()
      .from(ephemeralMonitors)
      .where(
        and(
          eq(ephemeralMonitors.sessionId, sessionId),
          eq(ephemeralMonitors.status, 'active'),
        ),
      )
      .orderBy(asc(ephemeralMonitors.createdAt))
      .all()
      .map(rowToEphemeralMonitor);
  }

  /**
   * Reap ONE ephemeral monitor (007 §4.4): flip `active` → `reaped` and stamp
   * `reaped_at`. Idempotent (already-reaped rows are untouched). Retains the row
   * and its materialized events for post-hoc observability (007 §4.4 default:
   * retain unread until the session's records are reaped) — the row is never
   * deleted, so a restart can never resurrect it.
   */
  reapEphemeralMonitor(id: string): void {
    const now = new Date();
    asInternalDb(this.db)
      .update(ephemeralMonitors)
      .set({ status: 'reaped', reapedAt: now, updatedAt: now })
      .where(
        and(
          eq(ephemeralMonitors.id, id),
          eq(ephemeralMonitors.status, 'active'),
        ),
      )
      .run();
  }

  /**
   * Reap every ACTIVE ephemeral monitor declared by a session (007 §4.4) — used
   * when the session ends (explicit close) or goes dormant. Returns the ids
   * reaped.
   */
  reapEphemeralMonitorsForSession(sessionId: string): string[] {
    const active = this.listEphemeralMonitorsForSession(sessionId);
    if (active.length === 0) return [];
    const now = new Date();
    asInternalDb(this.db)
      .update(ephemeralMonitors)
      .set({ status: 'reaped', reapedAt: now, updatedAt: now })
      .where(
        and(
          eq(ephemeralMonitors.sessionId, sessionId),
          eq(ephemeralMonitors.status, 'active'),
        ),
      )
      .run();
    return active.map((record) => record.id);
  }

  /**
   * The `active` sessions for `workspacePath` (plus global) that have gone
   * dormant by inactivity (002 §6.2 / 007 §4.4 per-session dormancy trigger).
   * Used by the runtime to transition them to `dormant` and reap their ephemeral
   * monitors.
   *
   * A session's effective last-activity is the later of its `lastActiveAt` and
   * its newest active ephemeral monitor's declaration time: declaring a watch is
   * itself activity, so a session with an ephemeral monitor declared **after**
   * `staleBefore` is NOT stale even if `lastActiveAt` is older. Concretely, a
   * session that declares a watch and
   * then blocks on one long tool call (emitting no hooks) keeps its watches for
   * at least one dormancy window past the declaration, instead of being reaped
   * mid-wait and silently losing the finishing event. A crashed session stops
   * declaring, so its newest declaration ages out and cleanup still bounds.
   *
   * TODO(#396): this only extends coverage by one dormancy window past the
   * newest declaration; a wait longer than the window is still reaped. Whether a
   * live session should hold its watches for an arbitrarily long blocking wait is
   * an open spec decision — tracked by issue #396 (dormancy vs long-running-wait).
   */
  staleActiveSessions(
    workspacePath: string | null,
    staleBefore: Date,
  ): AgentSessionRecord[] {
    const internalDb = asInternalDb(this.db);
    return internalDb
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.status, 'active'),
          workspacePath == null
            ? isNull(agentSessions.workspacePath)
            : or(
                eq(agentSessions.workspacePath, workspacePath),
                isNull(agentSessions.workspacePath),
              ),
          lte(agentSessions.lastActiveAt, staleBefore),
          // Exempt a session that declared a watch within the dormancy window:
          // an active ephemeral monitor with `created_at > staleBefore` means the
          // session was active (declared) more recently than `lastActiveAt`
          // records, so it is not yet dormant (see method doc).
          notExists(
            internalDb
              .select({ one: sql`1` })
              .from(ephemeralMonitors)
              .where(
                and(
                  eq(ephemeralMonitors.sessionId, agentSessions.id),
                  eq(ephemeralMonitors.status, 'active'),
                  gt(ephemeralMonitors.createdAt, staleBefore),
                ),
              ),
          ),
        ),
      )
      .all()
      .map(rowToSession);
  }

  /**
   * Read a monitor's persisted runtime state for ONE workspace scope (issue
   * #345 / #307). State is keyed by `(monitorId, workspacePath)`, so the caller
   * MUST name the scope: the same monitor id can exist in unrelated workspaces
   * sharing one global DB, and reading the wrong scope's `sourceState` leaks one
   * workspace's file-fingerprint baseline into another. `NULL` `workspacePath`
   * (global) is matched with `IS NULL`, mirroring `getSessionObjectCursor`.
   */
  getMonitorState(
    monitorId: string,
    workspacePath: string | null,
  ): MonitorRuntimeState {
    const row = asInternalDb(this.db)
      .select()
      .from(monitorState)
      .where(monitorStateKey(monitorId, workspacePath))
      .get();
    if (!row) {
      return {
        notifyState: {},
      };
    }
    return {
      ...(row.lastObservationAt
        ? { lastObservationAt: row.lastObservationAt }
        : {}),
      sourceState: parseJson(row.sourceState, {}),
      notifyState: parseJson(row.notifyState, {}),
    };
  }

  setMonitorState(
    monitorId: string,
    workspacePath: string | null,
    state: {
      sourceState?: unknown;
      notifyState?: unknown;
      lastObservationAt?: Date | null;
    },
  ): void {
    const now = new Date();
    const db = asInternalDb(this.db);
    const existing = db
      .select()
      .from(monitorState)
      .where(monitorStateKey(monitorId, workspacePath))
      .get();

    if (existing) {
      db.update(monitorState)
        .set({
          lastObservationAt: state.lastObservationAt ?? null,
          lastFingerprint: null,
          sourceState: JSON.stringify(state.sourceState ?? {}),
          notifyState: JSON.stringify(state.notifyState ?? {}),
          updatedAt: now,
        })
        .where(eq(monitorState.id, existing.id))
        .run();
      return;
    }

    db.insert(monitorState)
      .values({
        id: ulid(),
        monitorId,
        workspacePath,
        lastObservationAt: state.lastObservationAt ?? null,
        lastFingerprint: null,
        sourceState: JSON.stringify(state.sourceState ?? {}),
        notifyState: JSON.stringify(state.notifyState ?? {}),
        updatedAt: now,
      })
      .run();
  }

  /**
   * Durably enqueue one batch of failed materializations.
   *
   * Admission is atomic per call and serialized with an immediate transaction.
   * Every envelope must match its trusted monitor/source route and satisfy the
   * caller-owned plain-data precondition documented on its input type (apart
   * from the typed `observedAt` Date). Detectable domain violations are rejected;
   * arbitrary instances with hidden private state are not supported records.
   *
   * @throws {@link MaterializationRetryCapacityError} when any affected
   * workspace/monitor would exceed its count or byte bound.
   * @throws {@link MaterializationRetrySerializationError} before mutation when
   * an envelope has a detectable violation of the supported plain-data domain.
   */
  enqueueMaterializationRetries(
    inputs: EnqueueMaterializationRetryInput[],
    now = new Date(),
  ): MaterializationRetryRecord[] {
    if (inputs.length === 0) return [];
    const db = asInternalDb(this.db);
    const prepared = inputs.map((input) => {
      // Validate the entire value domain before route reads can invoke an
      // accessor or proxy supplied inside the envelope.
      const envelope = serializeRetryEnvelope(input.envelope);
      if (input.envelope.monitor.id !== input.monitorId) {
        throw new Error('Retry envelope monitor id does not match its route.');
      }
      if (input.envelope.monitor.frontmatter.watch.type !== input.sourceName) {
        throw new Error('Retry envelope source does not match its route.');
      }
      return {
        input,
        id: materializationRetryUlid(now.getTime()),
        envelope,
        envelopeBytes: Buffer.byteLength(envelope, 'utf8'),
      };
    });

    return db.$client
      .transaction(() => {
        const additions = new Map<
          string,
          {
            monitorId: string;
            workspacePath: string | null;
            count: number;
            bytes: number;
          }
        >();
        for (const item of prepared) {
          const key = JSON.stringify([
            item.input.workspacePath,
            item.input.monitorId,
          ]);
          const addition = additions.get(key) ?? {
            monitorId: item.input.monitorId,
            workspacePath: item.input.workspacePath,
            count: 0,
            bytes: 0,
          };
          addition.count += 1;
          addition.bytes += item.envelopeBytes;
          additions.set(key, addition);
        }

        for (const addition of additions.values()) {
          const remaining = this.materializationRetryCapacity(
            addition.monitorId,
            addition.workspacePath,
          );
          if (
            addition.count > remaining.records ||
            addition.bytes > remaining.bytes
          ) {
            throw new MaterializationRetryCapacityError(addition.monitorId);
          }
        }

        const nextAttemptAt = retryDeadline(
          now,
          MATERIALIZATION_RETRY_DELAYS_MS[0],
        );
        for (const item of prepared) {
          db.insert(materializationRetryOutbox)
            .values({
              id: item.id,
              admissionSequence: this.reserveAdmissionSequence(),
              workspacePath: item.input.workspacePath,
              monitorId: item.input.monitorId,
              sourceName: item.input.sourceName,
              envelope: item.envelope,
              envelopeBytes: item.envelopeBytes,
              attemptCount: 0,
              status: 'pending',
              nextAttemptAt,
              lastError: safeRetryError(item.input.error),
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        return prepared.map((item) => this.getMaterializationRetry(item.id));
      })
      .immediate();
  }

  /**
   * Room left in one workspace/monitor retry outbox under the bounds that
   * {@link RuntimeStore.enqueueMaterializationRetries} enforces: 256 rows and
   * 8 MiB of stored envelopes, terminal rows included. This is the single
   * definition of that capacity. Runtime admission reads it inside its own
   * transaction to decide whether a failed observation's whole ordered suffix
   * can be retained before it asks enqueue to store that suffix.
   *
   * @internal
   */
  materializationRetryCapacity(
    monitorId: string,
    workspacePath: string | null,
  ): { records: number; bytes: number } {
    const usage = asInternalDb(this.db)
      .select({
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${materializationRetryOutbox.envelopeBytes}), 0)`,
      })
      .from(materializationRetryOutbox)
      .where(materializationRetryKey(monitorId, workspacePath))
      .get();
    return {
      records: Math.max(
        0,
        MATERIALIZATION_RETRY_MAX_RECORDS - (usage?.count ?? 0),
      ),
      bytes: Math.max(0, MATERIALIZATION_RETRY_MAX_BYTES - (usage?.bytes ?? 0)),
    };
  }

  /** Resolve retained work by identity; absence is a typed error, never a successful discard. */
  getMaterializationRetry(id: string): MaterializationRetryRecord {
    const row = asInternalDb(this.db)
      .select()
      .from(materializationRetryOutbox)
      .where(eq(materializationRetryOutbox.id, id))
      .get();
    if (!row) throw new MaterializationRetryNotFoundError(id);
    return rowToMaterializationRetry(row);
  }

  /**
   * List retry records oldest-first. A `dueAt` query returns pending records
   * only, even if a caller also supplies an incompatible terminal status.
   */
  listMaterializationRetries(
    query: MaterializationRetryQuery = {},
  ): MaterializationRetryRecord[] {
    const conditions = [
      query.monitorId
        ? eq(materializationRetryOutbox.monitorId, query.monitorId)
        : undefined,
      query.workspacePath === undefined
        ? undefined
        : query.workspacePath === null
          ? isNull(materializationRetryOutbox.workspacePath)
          : eq(materializationRetryOutbox.workspacePath, query.workspacePath),
      query.status
        ? eq(materializationRetryOutbox.status, query.status)
        : undefined,
      query.dueAt
        ? eq(materializationRetryOutbox.status, 'pending')
        : undefined,
      query.dueAt
        ? lte(materializationRetryOutbox.nextAttemptAt, query.dueAt)
        : undefined,
    ].filter((condition) => condition !== undefined);
    return asInternalDb(this.db)
      .select()
      .from(materializationRetryOutbox)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        asc(materializationRetryOutbox.createdAt),
        asc(materializationRetryOutbox.id),
      )
      .limit(query.limit ?? MATERIALIZATION_RETRY_MAX_RECORDS)
      .all()
      .map(rowToMaterializationRetry);
  }

  /**
   * The retry that must complete next for one workspace/monitor, pending or
   * terminal, or `undefined` when its outbox is empty. Order is admission
   * order: the position each row reserved in the materialization order when
   * it was queued (002 §2). Rows queued before positions were reserved
   * predate every positioned row and keep their enqueue order. Timestamps are
   * whole seconds, so they cannot order rows admitted in the same second.
   *
   * @internal
   */
  oldestMaterializationRetry(
    monitorId: string,
    workspacePath: string | null,
  ): MaterializationRetryRecord | undefined {
    const row = asInternalDb(this.db)
      .select()
      .from(materializationRetryOutbox)
      .where(materializationRetryKey(monitorId, workspacePath))
      .orderBy(
        sql`${materializationRetryOutbox.admissionSequence} IS NOT NULL`,
        asc(materializationRetryOutbox.admissionSequence),
        asc(materializationRetryOutbox.createdAt),
        asc(materializationRetryOutbox.id),
      )
      .limit(1)
      .get();
    return row ? rowToMaterializationRetry(row) : undefined;
  }

  /**
   * Discover every retained outbox in one exact workspace without loading
   * private envelopes. A row-list limit cannot serve this purpose: capacity is
   * per monitor, so the first full outbox must not hide other monitor routes.
   * Results use monitor-id order for stable workspace diagnostic output.
   * @public
   */
  materializationRetryMonitorIds(workspacePath: string | null): string[] {
    return asInternalDb(this.db)
      .selectDistinct({ monitorId: materializationRetryOutbox.monitorId })
      .from(materializationRetryOutbox)
      .where(
        workspacePath === null
          ? isNull(materializationRetryOutbox.workspacePath)
          : eq(materializationRetryOutbox.workspacePath, workspacePath),
      )
      .orderBy(asc(materializationRetryOutbox.monitorId))
      .all()
      .map(({ monitorId }) => monitorId);
  }

  /** Return bounded operator-safe retry diagnostics without stored envelopes. */
  materializationRetrySummary(
    monitorId: string,
    workspacePath: string | null,
  ): MaterializationRetrySummary {
    const rows = asInternalDb(this.db)
      .select({
        id: materializationRetryOutbox.id,
        status: materializationRetryOutbox.status,
        bytes: materializationRetryOutbox.envelopeBytes,
        attemptCount: materializationRetryOutbox.attemptCount,
        nextAttemptAt: materializationRetryOutbox.nextAttemptAt,
        lastError: materializationRetryOutbox.lastError,
        createdAt: materializationRetryOutbox.createdAt,
        updatedAt: materializationRetryOutbox.updatedAt,
      })
      .from(materializationRetryOutbox)
      .where(materializationRetryKey(monitorId, workspacePath))
      .orderBy(
        asc(materializationRetryOutbox.createdAt),
        asc(materializationRetryOutbox.id),
      )
      .all();
    // SQLite TEXT is not validated by the lifecycle type annotation. Reject
    // unsupported persisted states before constructing totals or records; a
    // diagnostic read must preserve retained evidence rather than relabel it.
    // Keep the failure fixed and bounded without echoing private stored text.
    if (
      rows.some(
        ({ status }: { status: unknown }) =>
          status !== 'pending' && status !== 'terminal',
      )
    ) {
      throw new Error(
        'Cannot summarize materialization retries: unsupported persisted status.',
      );
    }
    return rows.reduce<MaterializationRetrySummary>(
      (summary, row) => {
        summary[row.status] += 1;
        summary.bytes += row.bytes;
        summary.records.push({
          id: row.id,
          status: row.status,
          attemptCount: row.attemptCount,
          nextAttemptAt: row.nextAttemptAt ?? null,
          // Older writers may have retained unbounded/control-bearing errors.
          // Normalize the public projection without rewriting durable evidence.
          lastError:
            row.lastError === null ? null : safeRetryError(row.lastError),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        return summary;
      },
      { pending: 0, terminal: 0, bytes: 0, records: [] },
    );
  }

  /**
   * Retain a failed automatic attempt and advance its bounded backoff. Terminal
   * rows cannot accrue new attempts until explicitly rearmed; failure text is
   * persisted only as a bounded single-line diagnostic.
   */
  markMaterializationRetryFailed(
    id: string,
    error: string,
    now = new Date(),
  ): MaterializationRetryRecord {
    const db = asInternalDb(this.db);
    return db.$client
      .transaction(() => {
        const current = this.getMaterializationRetry(id);
        if (current.status === 'terminal') {
          throw new MaterializationRetryTransitionError(id, 'is terminal');
        }
        const attemptCount = current.attemptCount + 1;
        const terminal = attemptCount >= MATERIALIZATION_RETRY_MAX_ATTEMPTS;
        db.update(materializationRetryOutbox)
          .set({
            attemptCount,
            status: terminal ? 'terminal' : 'pending',
            nextAttemptAt: terminal
              ? null
              : retryDeadline(
                  now,
                  MATERIALIZATION_RETRY_DELAYS_MS[attemptCount] ?? 0,
                ),
            lastError: safeRetryError(error),
            updatedAt: now,
          })
          .where(eq(materializationRetryOutbox.id, id))
          .run();
        return this.getMaterializationRetry(id);
      })
      .immediate();
  }

  /**
   * Explicitly return terminal work to pending without replacing its envelope
   * or identity. Pending work cannot be reset to evade its attempt budget.
   */
  rearmMaterializationRetry(
    id: string,
    now = new Date(),
  ): MaterializationRetryRecord {
    const db = asInternalDb(this.db);
    return db.$client
      .transaction(() => {
        const current = this.getMaterializationRetry(id);
        if (current.status !== 'terminal') {
          throw new MaterializationRetryTransitionError(id, 'is not terminal');
        }
        db.update(materializationRetryOutbox)
          .set({
            attemptCount: 0,
            status: 'pending',
            nextAttemptAt: retryDeadline(
              now,
              MATERIALIZATION_RETRY_DELAYS_MS[0],
            ),
            lastError: null,
            updatedAt: now,
          })
          .where(eq(materializationRetryOutbox.id, id))
          .run();
        return this.getMaterializationRetry(id);
      })
      .immediate();
  }

  /**
   * Give up terminal retained work for good (002 §2.7): record its observation
   * as an outstanding loss through {@link RuntimeStore.recordObservationLoss}
   * and remove the retry row, in one immediate transaction, so the loss is
   * never recorded without the removal or the removal without the loss.
   *
   * The loss is superseded like an admission drop, measured from the retry's
   * own admission position: a later event for the same object key, including
   * a younger retained retry that completes, clears it. A row queued before
   * positions were reserved uses the current high-water mark instead, so only
   * an event materialized after the skip clears it.
   *
   * Only a terminal row of the named workspace/monitor can be skipped; any
   * other row, or a row that changed state after the caller read it, is
   * rejected with nothing written.
   *
   * @internal
   */
  skipMaterializationRetry(
    id: string,
    route: { monitorId: string; workspacePath: string | null },
    loss: {
      objectKey: string | undefined;
      observationData: Record<string, unknown>;
    },
  ): MaterializationRetryRecord {
    const db = asInternalDb(this.db);
    return db.$client
      .transaction(() => {
        const current = this.getMaterializationRetry(id);
        if (
          current.monitorId !== route.monitorId ||
          current.workspacePath !== route.workspacePath
        ) {
          throw new MaterializationRetryNotFoundError(id);
        }
        if (current.status !== 'terminal') {
          throw new MaterializationRetryTransitionError(id, 'is not terminal');
        }
        const admission = db
          .select({
            admissionSequence: materializationRetryOutbox.admissionSequence,
          })
          .from(materializationRetryOutbox)
          .where(eq(materializationRetryOutbox.id, id))
          .get();
        this.recordObservationLoss({
          monitorId: current.monitorId,
          workspacePath: current.workspacePath,
          sourceName: current.sourceName,
          objectKey: loss.objectKey,
          observationData: loss.observationData,
          ...(admission?.admissionSequence != null
            ? { eventWatermark: admission.admissionSequence }
            : {}),
        });
        const deleted = db
          .delete(materializationRetryOutbox)
          .where(eq(materializationRetryOutbox.id, id))
          .run().changes;
        if (deleted !== 1) {
          throw new MaterializationRetryTransitionError(
            id,
            'disappeared before commit',
          );
        }
        return current;
      })
      .immediate();
  }

  /**
   * Consume pending retained work only by committing its event, projections,
   * cursor seeds and snapshot together with removal of the retry row.
   * Terminal work requires explicit re-arm. Scheduling/due selection belongs
   * to the caller; this boundary enforces lifecycle and atomic persistence.
   *
   * Input must be the deterministic materialization of the stored envelope,
   * with the same workspace, monitor, source and object identity. That
   * includes `definitionFingerprint`: the fingerprint of the envelope's own
   * monitor snapshot, the definition the observation was made under, never
   * the current one (002 §5.3). The event's admission position is stamped
   * here from the outbox row, not taken from the input (002 §2). An omitted
   * observation key uses the monitor id, matching runtime materialization;
   * explicit keys (including the empty string) keep their identity. Rendering
   * remains the runtime's responsibility. This seam accepts event data, never
   * a callback: arbitrary asynchronous effects cannot be rolled back by SQLite.
   * Interpret and other external work belong after this method returns.
   *
   * @internal
   */
  completeMaterializationRetry(
    id: string,
    input: Omit<MonitorEventRecord, 'id'>,
    baseline?: { previousContent: string | null },
    options?: { restrictToSessionId?: string },
  ): MonitorEventRecord {
    const db = asInternalDb(this.db);
    const previousProjectedSessionIds = this.lastProjectedSessionIds;
    try {
      return db.$client
        .transaction(() => {
          const current = this.getMaterializationRetry(id);
          if (current.status === 'terminal') {
            throw new MaterializationRetryTransitionError(id, 'is terminal');
          }
          // JavaScript callers can bypass the declared event-data type.
          const suppliedInput: unknown = input;
          if (
            typeof suppliedInput !== 'object' ||
            suppliedInput === null ||
            Array.isArray(suppliedInput)
          ) {
            throw new MaterializationRetryTransitionError(
              id,
              'requires event data, not a callback',
            );
          }
          if (
            input.workspacePath !== current.workspacePath ||
            input.monitorId !== current.monitorId ||
            input.sourceName !== current.sourceName ||
            input.objectKey !==
              (current.envelope.observation.objectKey ?? current.monitorId)
          ) {
            throw new MaterializationRetryTransitionError(
              id,
              'does not match the retained observation route',
            );
          }
          // The event commits now but its observation was admitted when the
          // retry was queued; supersession of a drop compares admission (002 §2).
          // A row queued before positions were reserved predates every drop.
          const admission = db
            .select({
              admissionSequence: materializationRetryOutbox.admissionSequence,
            })
            .from(materializationRetryOutbox)
            .where(eq(materializationRetryOutbox.id, id))
            .get();
          // Only sessions that existed when the observation was admitted
          // receive it, however long the retry took (002 §2.7).
          const result = this.writeEvent(input, baseline, options, {
            admissionSequence: admission?.admissionSequence ?? null,
            observedAt: current.envelope.observedAt,
          });
          db.update(monitorEvents)
            .set({ admissionSequence: admission?.admissionSequence ?? 0 })
            .where(eq(monitorEvents.id, result.id))
            .run();
          const deleted = db
            .delete(materializationRetryOutbox)
            .where(eq(materializationRetryOutbox.id, id))
            .run().changes;
          if (deleted !== 1) {
            throw new MaterializationRetryTransitionError(
              id,
              'disappeared before commit',
            );
          }
          return result;
        })
        .immediate();
    } catch (error) {
      // insertEvent's projection cache is in memory, outside SQLite rollback.
      // A failed outer completion must not expose recipients of a rolled-back event.
      this.lastProjectedSessionIds = previousProjectedSessionIds;
      throw error;
    }
  }

  /**
   * Materialize ONE shared `monitor_events` row and project it into matching
   * lead sessions (002 §6), computing a PER-RECIPIENT delta for each (G10,
   * 002 §1.1.2) — the shared artifact diffed against THAT session's own baseline
   * cursor, recorded on `session_event_state.diff_text`.
   *
   * The event, its projections, initial recipient cursors, and supplied snapshot
   * commit together in one immediate transaction. Any failure rolls back that
   * entire materialization; callers must not save its snapshot separately.
   * An empty snapshot is present data and is persisted just like nonempty text.
   * The per-recipient diff lives here (not after an Interpret await) so all
   * durable writes complete synchronously BEFORE the critical-path boundary,
   * preserving the `ingest()` ordering invariant (002 §1.1.8).
   *
   * @param input - The shared event row. `input.diffText` is the shared
   *   object-level diff (against the latest stored snapshot) used for
   *   `events list`/history display.
   * @param baseline - The object's snapshot state immediately BEFORE this event
   *   (`previousContent`, or `null`/absent at a baseline event). Used to SEED a
   *   first-time recipient's cursor so a session registered after an earlier
   *   change hears only changes AFTER it registered, not a full-current-state
   *   first delta (decided semantics Q1). When omitted, a first-time recipient
   *   starts from the current artifact; an existing recipient keeps its cursor.
   * @throws If `input.snapshotText` is non-null but `input.objectKey` is null:
   *   persisted snapshots require an object identity. Snapshot-less events may
   *   omit that identity.
   */
  insertEvent(
    input: Omit<MonitorEventRecord, 'id'>,
    baseline?: { previousContent: string | null },
    options?: { restrictToSessionId?: string },
  ): MonitorEventRecord {
    return this.writeEvent(input, baseline, options);
  }

  /**
   * {@link RuntimeStore.insertEvent}, optionally limited to recipients that
   * were registered before the event's observation was admitted. Retry
   * completion supplies that admission; events materialized in their
   * admitting span need no limit, because admission and projection share one
   * transaction.
   */
  private writeEvent(
    input: Omit<MonitorEventRecord, 'id'>,
    baseline?: { previousContent: string | null },
    options?: { restrictToSessionId?: string },
    admittedAt?: RetryAdmission,
  ): MonitorEventRecord {
    const db = asInternalDb(this.db);
    const materialized = db.$client
      .transaction(() => {
        const id = eventUlid();
        db.insert(monitorEvents)
          .values({
            id,
            workspacePath: input.workspacePath,
            monitorId: input.monitorId,
            sourceName: input.sourceName,
            urgency: input.urgency,
            title: input.title,
            body: input.body,
            summary: input.summary,
            payload: JSON.stringify(input.payload ?? {}),
            snapshotMetadata: JSON.stringify(input.snapshotMetadata ?? {}),
            snapshotText: input.snapshotText,
            diffText: input.diffText,
            objectKey: input.objectKey,
            baselineStrategy: input.baselineStrategy,
            queryScope: JSON.stringify(input.queryScope),
            tags: JSON.stringify(input.tags),
            createdAt: input.createdAt,
            definitionFingerprint: input.definitionFingerprint,
          })
          .run();

        const event = this.getEventById(id);
        const artifact = event.snapshotText;
        const objectKey = event.objectKey;
        const projectedSessionIds: string[] = [];
        // Reap race (007 §4.4): a tick pre-fetches the active ephemeral monitors, then
        // `await source.observe()` yields; a concurrent `watch cancel` on another
        // socket can reap THIS monitor while the session stays active (session-close
        // dormancy is caught by the `status === 'active'` session filter below, but a
        // bare cancel is not). Re-check the ephemeral monitor's status at insert time
        // so an in-flight observation from a just-reaped watch projects to nobody —
        // "reaping stops further observation / delivery." Only the ephemeral path
        // (restrictToSessionId set) is re-checked; a persistent event is unaffected.
        const ephemeralStillActive =
          options?.restrictToSessionId === undefined ||
          this.findEphemeralMonitorById(event.monitorId)?.status === 'active';
        // Projection target (002 §6). For a persistent monitor, every matching LEAD
        // session (workspace match or global). For an EPHEMERAL monitor (007 §4.6),
        // projection is restricted to the DECLARING session ONLY — its events must
        // never reach a sibling lead session in the same workspace (the ephemeral
        // isolation invariant). `restrictToSessionId` names that session; it is still
        // filtered to a lead role (the declaring session is a lead by construction,
        // 007 §4.6), so a stray non-lead binding projects to nobody rather than
        // leaking. The declaring session must also still be `active`: a session reaped
        // mid-tick (its close raced this observation) must not receive a projection
        // (007 §4.4). The event row itself is still retained for durability.
        const candidates = ephemeralStillActive
          ? this.sessionsForWorkspace(event.workspacePath).filter(
              (candidate) =>
                candidate.role === 'lead' &&
                (options?.restrictToSessionId === undefined ||
                  (candidate.id === options.restrictToSessionId &&
                    candidate.status === 'active')),
            )
          : [];
        const projectionTargets =
          admittedAt === undefined
            ? candidates
            : this.sessionsRegisteredBefore(candidates, admittedAt);
        for (const session of projectionTargets) {
          // ── Per-recipient Diff (G10, 002 §1.1.2) ──────────────────────────────
          // Compute this session's delta against ITS OWN baseline cursor, and seed
          // the cursor on first projection. Only meaningful for snapshot-bearing
          // events keyed by an objectKey; snapshot-less events leave diff_text NULL.
          let perRecipientDiff: string | null = null;
          if (artifact !== null && objectKey !== null) {
            const cursor = this.getSessionObjectCursor(
              session.id,
              event.monitorId,
              objectKey,
              event.workspacePath,
            );
            // The object's declared change-detection strategy (issue #437): renders
            // a structural diffText for `strategy: json-diff` instead of a
            // compact-JSON line diff. Read from the persisted `snapshotMetadata`
            // (the source's `snapshot` metadata round-tripped through the DB).
            const strategy = changeDetectionStrategyOf(event.snapshotMetadata);
            if (cursor) {
              // Existing recipient: span from its own cursor. Never advanced here —
              // materialization SEEDS only; the cursor advances at claim
              // (markClaimed), so a recipient that stayed away keeps spanning from
              // its last-seen point across multiple shared observations.
              perRecipientDiff = buildDiff(
                cursor.baselineContent,
                artifact,
                strategy,
              );
            } else {
              // First projection of this object to this session = "caught up to the
              // pre-event state": its delta is the shared diff (prior → artifact),
              // identical to today's single-baseline behavior (backward-compat).
              const previous = baseline?.previousContent ?? null;
              perRecipientDiff =
                previous !== null
                  ? buildDiff(previous, artifact, strategy)
                  : null;
              // Seed the cursor to the state the recipient is now caught up to: the
              // prior snapshot for a non-baseline event (so the NEXT event spans
              // prior → next), or this event's own artifact at a baseline event
              // (nothing precedes it). Advanced only at claim thereafter.
              //
              // Provenance: `baselineSnapshotId` must reference the snapshot that
              // supplied `baselineContent`.  When seeding from `previous` (the
              // pre-event snapshot content), there is no cursor-accessible snapshot
              // id in scope, so we use NULL — the id is only set when seeding from
              // the current event's own artifact (the baseline case). (Copilot
              // review: comment 2.)
              this.seedSessionObjectCursor({
                sessionId: session.id,
                monitorId: event.monitorId,
                objectKey,
                workspacePath: event.workspacePath,
                baselineSnapshotId: previous !== null ? null : event.id,
                baselineContent: previous ?? artifact,
              });
            }
          }

          db.insert(sessionEventState)
            .values({
              id: ulid(),
              sessionId: session.id,
              eventId: event.id,
              diffText: perRecipientDiff,
              createdAt: event.createdAt,
              updatedAt: event.createdAt,
            })
            .run();
          projectedSessionIds.push(session.id);
        }

        if (artifact !== null) {
          if (objectKey === null) {
            throw new Error('A snapshot-bearing event requires an object key.');
          }
          this.saveSnapshot({
            workspacePath: event.workspacePath,
            monitorId: event.monitorId,
            objectKey,
            eventId: event.id,
            content: artifact,
          });
        }

        return { event, projectedSessionIds };
      })
      .immediate();

    this.lastProjectedSessionIds = materialized.projectedSessionIds;
    return materialized.event;
  }

  /**
   * The lead-session ids the most recent {@link insertEvent} projected the event
   * into (the per-recipient seam, 002 §1.1.2). The runtime reads these to drive
   * the per-recipient Interpret stage (G14) without re-querying.
   */
  private lastProjectedSessionIds: string[] = [];

  /** @returns the lead-session ids the last {@link insertEvent} projected into. */
  projectedSessionIdsForLastEvent(): string[] {
    return [...this.lastProjectedSessionIds];
  }

  /**
   * Record the per-recipient Interpret verdict (G14, 002 §1.1.8) on the
   * `session_event_state` projection. When `decision` is `suppress`, the
   * projection is retained (so the verdict stays explainable via
   * `monitor explain`, 002 §10.7) but excluded from delivery by
   * {@link unreadEventsForSession}/{@link pendingEventsForSession}.
   */
  recordInterpretDecision(
    sessionId: string,
    eventId: string,
    decision: {
      decision: 'deliver' | 'suppress' | 'failed';
      reason?: string | undefined;
      digest?: string | undefined;
    },
  ): void {
    const now = new Date();
    asInternalDb(this.db)
      .update(sessionEventState)
      .set({
        interpretDecision: decision.decision,
        interpretReason: decision.reason ?? null,
        interpretDigest: decision.digest ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          eq(sessionEventState.eventId, eventId),
        ),
      )
      .run();
  }

  /**
   * Return the per-session interpret verdicts for a set of events (G14,
   * 002 §1.1.8). Used by the delivery path to prefer the agentic digest over
   * the raw `summary`/`body` for `prose` monitors. Only rows that have an
   * `interpret_digest` recorded are included; callers fall back to
   * `event.summary || event.body || event.title` when absent.
   */
  interpretDigestsForSession(
    sessionId: string,
    eventIds: string[],
  ): Map<string, string> {
    if (eventIds.length === 0) return new Map();
    const rows = asInternalDb(this.db)
      .select({
        eventId: sessionEventState.eventId,
        interpretDigest: sessionEventState.interpretDigest,
      })
      .from(sessionEventState)
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          inArray(sessionEventState.eventId, eventIds),
        ),
      )
      .all();
    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.interpretDigest) result.set(row.eventId, row.interpretDigest);
    }
    return result;
  }

  /**
   * Return the PER-RECIPIENT delta for a set of events for one session (G10,
   * 002 §1.1.2): the diff this session computed against its OWN baseline cursor,
   * recorded on `session_event_state.diff_text`. Only events with a
   * non-NULL per-recipient `diff_text` are included; callers fall back to the
   * shared `MonitorEventRecord.diffText` for legacy (pre-G10, NULL) rows.
   */
  perRecipientDiffsForSession(
    sessionId: string,
    eventIds: string[],
  ): Map<string, string> {
    if (eventIds.length === 0) return new Map();
    const rows = asInternalDb(this.db)
      .select({
        eventId: sessionEventState.eventId,
        diffText: sessionEventState.diffText,
      })
      .from(sessionEventState)
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          inArray(sessionEventState.eventId, eventIds),
        ),
      )
      .all();
    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.diffText !== null) result.set(row.eventId, row.diffText);
    }
    return result;
  }

  /**
   * Batch variant of {@link perRecipientDiffsForSession}: fetches per-recipient
   * diff text for `eventId` across ALL the given `sessionIds` in a SINGLE query,
   * then groups the results by session id in memory.
   *
   * Use this instead of calling {@link perRecipientDiffsForSession} in a per-
   * session loop (which would be O(N) queries for N recipients).  (G10, 002
   * §1.1.2; Copilot review: comment 3.)
   *
   * @returns Map from sessionId → diff text for the event.  Sessions with a NULL
   *   or missing row are omitted; callers should fall back to the shared event
   *   diff or the snapshot artifact.
   */
  perRecipientDiffsForAllSessions(
    sessionIds: string[],
    eventId: string,
  ): Map<string, string> {
    if (sessionIds.length === 0) return new Map();
    const rows = asInternalDb(this.db)
      .select({
        sessionId: sessionEventState.sessionId,
        diffText: sessionEventState.diffText,
      })
      .from(sessionEventState)
      .where(
        and(
          inArray(sessionEventState.sessionId, sessionIds),
          eq(sessionEventState.eventId, eventId),
        ),
      )
      .all();
    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.diffText !== null) result.set(row.sessionId, row.diffText);
    }
    return result;
  }

  getEventById(id: string): MonitorEventRecord {
    const row = asInternalDb(this.db)
      .select()
      .from(monitorEvents)
      .where(eq(monitorEvents.id, id))
      .get();
    if (!row) {
      throw new Error(`Event not found: ${id}`);
    }
    return rowToEvent(row);
  }

  listEvents(query: EventQuery = {}): MonitorEventRecord[] {
    const conditions = [];
    if (query.monitorId)
      conditions.push(eq(monitorEvents.monitorId, query.monitorId));
    if (query.urgency)
      conditions.push(eq(monitorEvents.urgency, query.urgency));
    if (query.objectKey)
      conditions.push(eq(monitorEvents.objectKey, query.objectKey));
    if (query.since) conditions.push(gt(monitorEvents.createdAt, query.since));
    // Scope to the requested workspace plus workspace-agnostic events. The inbox
    // DB is global; the same monitorId can exist in multiple workspaces, so a
    // workspace-scoped caller (e.g. `monitor explain`) must not see another
    // workspace's events (issue #94 review, comment 3408123729).
    if (query.workspacePath !== undefined) {
      const workspaceCondition = or(
        eq(monitorEvents.workspacePath, query.workspacePath),
        isNull(monitorEvents.workspacePath),
      );
      if (workspaceCondition) conditions.push(workspaceCondition);
    }

    let rows = query.sessionId
      ? asInternalDb(this.db)
          .select({
            event: monitorEvents,
            state: sessionEventState,
          })
          .from(sessionEventState)
          .innerJoin(
            monitorEvents,
            eq(sessionEventState.eventId, monitorEvents.id),
          )
          .where(
            and(
              eq(sessionEventState.sessionId, query.sessionId),
              ...(query.unreadOnly
                ? [isNull(sessionEventState.acknowledgedAt)]
                : []),
              ...conditions,
            ),
          )
          // Preserve persisted observation time; SQLite's sequence resolves
          // equal-time history consistently across independent writers.
          .orderBy(desc(monitorEvents.createdAt), desc(monitorEvents.sequence))
          .all()
          .map((row) => ({
            ...rowToEvent(row.event),
            // Only the session-scoped path joins session_event_state, so only
            // it can report per-session delivery state (issue #338). `--unread`
            // filters on `acknowledgedAt IS NULL` (002 §7), which INCLUDES
            // claimed-but-unacknowledged events; this field lets a caller tell
            // those apart from a genuinely never-surfaced event.
            deliveryState: deliveryStateForRow(row.state),
          }))
      : asInternalDb(this.db)
          .select()
          .from(monitorEvents)
          // Ephemeral-monitor events (007 §4.6 isolation) must NEVER surface on an
          // unscoped (session-less) read: their body is the declaring session's
          // private free-text instruction, and this branch bypasses the
          // per-session projection gate that keeps them scoped. A sibling session
          // could otherwise read another session's ephemeral event. They remain
          // fully readable via the declaring session's session-scoped path above
          // (query.sessionId set). Persistent-monitor events are unaffected. The
          // `ephemeral:` id prefix is reserved (007 §4.3) so a persistent id can
          // never match this predicate.
          .where(
            and(
              notLike(
                monitorEvents.monitorId,
                `${EPHEMERAL_MONITOR_ID_PREFIX}%`,
              ),
              ...conditions,
            ),
          )
          // Preserve persisted observation time; SQLite's sequence resolves
          // equal-time history consistently across independent writers.
          .orderBy(desc(monitorEvents.createdAt), desc(monitorEvents.sequence))
          .all()
          .map(rowToEvent);

    if (query.tags?.length) {
      rows = rows.filter((row) =>
        query.tags?.every((tag) => row.tags.includes(tag)),
      );
    }

    if (query.scope) {
      rows = rows.filter((row) => scopeMatches(row.queryScope, query.scope));
    }

    if (query.sessionId && query.sinceBaseline) {
      const session = this.getSessionById(query.sessionId);
      rows = rows.filter((row) => row.createdAt >= session.baselineAt);
    }

    return rows;
  }

  saveSnapshot(input: {
    workspacePath?: string | null;
    monitorId: string;
    objectKey: string;
    eventId: string;
    content: string;
  }): void {
    asInternalDb(this.db)
      .insert(monitorSnapshots)
      .values({
        id: snapshotUlid(),
        workspacePath: input.workspacePath ?? null,
        monitorId: input.monitorId,
        objectKey: input.objectKey,
        eventId: input.eventId,
        content: input.content,
        createdAt: new Date(),
      })
      .run();
  }

  latestSnapshot(
    monitorId: string,
    objectKey: string,
    workspacePath?: string | null,
  ): { content: string } | null {
    const row = asInternalDb(this.db)
      .select()
      .from(monitorSnapshots)
      .where(
        and(
          eq(monitorSnapshots.monitorId, monitorId),
          eq(monitorSnapshots.objectKey, objectKey),
          workspacePath == null
            ? isNull(monitorSnapshots.workspacePath)
            : eq(monitorSnapshots.workspacePath, workspacePath),
        ),
      )
      // The predecessor is the last retained materialization, independent of
      // observation timestamps, wall-clock reversals or process-local IDs.
      .orderBy(desc(monitorSnapshots.sequence))
      .get();
    return row ? { content: row.content } : null;
  }

  /**
   * The per-recipient baseline cursor (G10, 002 §1.1.2) for one
   * `(sessionId, monitorId, objectKey, workspacePath)`, or `null` if this
   * recipient has never had this object projected. NULL `workspacePath` (global)
   * is matched with `IS NULL` so a global cursor is read back exactly.
   */
  getSessionObjectCursor(
    sessionId: string,
    monitorId: string,
    objectKey: string,
    workspacePath?: string | null,
  ): SessionObjectCursorRecord | null {
    const row = asInternalDb(this.db)
      .select()
      .from(sessionObjectCursor)
      .where(
        and(
          eq(sessionObjectCursor.sessionId, sessionId),
          eq(sessionObjectCursor.monitorId, monitorId),
          eq(sessionObjectCursor.objectKey, objectKey),
          workspacePath == null
            ? isNull(sessionObjectCursor.workspacePath)
            : eq(sessionObjectCursor.workspacePath, workspacePath),
        ),
      )
      .get();
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      monitorId: row.monitorId,
      objectKey: row.objectKey,
      workspacePath: row.workspacePath ?? null,
      baselineSnapshotId: row.baselineSnapshotId ?? null,
      baselineContent: row.baselineContent,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * SEED a per-recipient cursor (G10, 002 §1.1.2). Insert-only: if a cursor for
   * the key already exists it is left untouched — materialization seeds a cursor
   * only on a recipient's first projection of an object; it never advances an
   * existing one (that is {@link advanceSessionObjectCursor}, called at claim).
   */
  seedSessionObjectCursor(input: {
    sessionId: string;
    monitorId: string;
    objectKey: string;
    workspacePath: string | null;
    baselineSnapshotId: string | null;
    baselineContent: string;
  }): void {
    const existing = this.getSessionObjectCursor(
      input.sessionId,
      input.monitorId,
      input.objectKey,
      input.workspacePath,
    );
    if (existing) return;
    asInternalDb(this.db)
      .insert(sessionObjectCursor)
      .values({
        id: ulid(),
        sessionId: input.sessionId,
        monitorId: input.monitorId,
        objectKey: input.objectKey,
        workspacePath: input.workspacePath,
        baselineSnapshotId: input.baselineSnapshotId,
        baselineContent: input.baselineContent,
        updatedAt: new Date(),
      })
      .run();
  }

  /**
   * ADVANCE a per-recipient cursor (G10, 002 §1.1.2) to a freshly-seen artifact
   * — the recipient was just shown this state, so its NEXT diff should span FROM
   * here. Called from {@link markClaimed}. Upserts so an advance can also create
   * the cursor if a legacy claim path never seeded one.
   */
  advanceSessionObjectCursor(input: {
    sessionId: string;
    monitorId: string;
    objectKey: string;
    workspacePath: string | null;
    baselineSnapshotId: string | null;
    baselineContent: string;
  }): void {
    const db = asInternalDb(this.db);
    const existing = this.getSessionObjectCursor(
      input.sessionId,
      input.monitorId,
      input.objectKey,
      input.workspacePath,
    );
    const now = new Date();
    if (existing) {
      db.update(sessionObjectCursor)
        .set({
          baselineSnapshotId: input.baselineSnapshotId,
          baselineContent: input.baselineContent,
          updatedAt: now,
        })
        .where(
          and(
            eq(sessionObjectCursor.sessionId, input.sessionId),
            eq(sessionObjectCursor.monitorId, input.monitorId),
            eq(sessionObjectCursor.objectKey, input.objectKey),
            input.workspacePath == null
              ? isNull(sessionObjectCursor.workspacePath)
              : eq(sessionObjectCursor.workspacePath, input.workspacePath),
          ),
        )
        .run();
      return;
    }
    db.insert(sessionObjectCursor)
      .values({
        id: ulid(),
        sessionId: input.sessionId,
        monitorId: input.monitorId,
        objectKey: input.objectKey,
        workspacePath: input.workspacePath,
        baselineSnapshotId: input.baselineSnapshotId,
        baselineContent: input.baselineContent,
        updatedAt: now,
      })
      .run();
  }

  recordObservationHistory(input: {
    monitorId: string;
    workspacePath: string | null;
    sourceName: string;
    result: ObservationOutcome;
    observationData: Record<string, unknown>;
  }): void {
    asInternalDb(this.db)
      .insert(observationHistory)
      .values({
        id: observationUlid(),
        monitorId: input.monitorId,
        workspacePath: input.workspacePath,
        sourceName: input.sourceName,
        observationData: JSON.stringify(input.observationData),
        result: input.result,
        createdAt: new Date(),
      })
      .run();
  }

  /**
   * Keep the sessions that were registered before a retained observation was
   * admitted (002 §2.7). Both positions come from the materialization-order
   * counter, so a session registered in the same second as the admission is
   * still ordered correctly. Data written before positions were reserved
   * falls back as follows: a retry without a position predates every
   * positioned session, so such a session is excluded; a session without a
   * position is compared by its whole-second registration time against the
   * observation time, the only order an earlier version recorded.
   */
  private sessionsRegisteredBefore(
    candidates: AgentSessionRecord[],
    admittedAt: RetryAdmission,
  ): AgentSessionRecord[] {
    if (candidates.length === 0) return candidates;
    const positions = new Map(
      asInternalDb(this.db)
        .select({
          id: agentSessions.id,
          registrationSequence: agentSessions.registrationSequence,
        })
        .from(agentSessions)
        .where(
          inArray(
            agentSessions.id,
            candidates.map(({ id }) => id),
          ),
        )
        .all()
        .map((row) => [row.id, row.registrationSequence] as const),
    );
    return candidates.filter((session) => {
      const registered = positions.get(session.id) ?? null;
      if (registered === null) {
        return session.baselineAt.getTime() <= admittedAt.observedAt.getTime();
      }
      return (
        admittedAt.admissionSequence !== null &&
        registered < admittedAt.admissionSequence
      );
    });
  }

  /**
   * Reserve the next position in the `monitor_events` materialization order
   * for an observation admitted now but materialized later (a retained retry).
   *
   * Events take positions from that table's AUTOINCREMENT counter
   * (`sqlite_sequence`) when they commit. A retained observation has no event
   * yet, so admission advances the same counter by one and keeps the value: it
   * is above every event committed and every drop recorded before it, and
   * below every later one. SQLite documents `sqlite_sequence` as writable;
   * raising it only makes the next event skip the reserved value. Must run
   * inside the admitting transaction.
   *
   * Registering a session reserves a position the same way, so a retry can
   * be ordered against the sessions that existed when it was admitted
   * (002 §2.7). A registration position never belongs to an event.
   */
  private reserveAdmissionSequence(): number {
    const client = asInternalDb(this.db).$client;
    const raised = client
      .prepare<[], { seq: number }>(
        `UPDATE sqlite_sequence SET seq = seq + 1
         WHERE name = 'monitor_events' RETURNING seq`,
      )
      .get();
    if (raised) return raised.seq;
    // No event has ever been inserted, so the counter has no row yet.
    const created = client
      .prepare<[], { seq: number }>(
        `INSERT INTO sqlite_sequence (name, seq)
         VALUES ('monitor_events',
           (SELECT coalesce(max(sequence), 0) FROM monitor_events) + 1)
         RETURNING seq`,
      )
      .get();
    if (!created) {
      throw new Error('Could not reserve a materialization position.');
    }
    return created.seq;
  }

  /**
   * Record that the runtime lost one observation it could not keep (002 §2):
   * admission dropped it because the retry outbox could not retain its ordered
   * suffix, or a debounce/rollup hold refused it because its envelope cannot
   * be serialized (002 §4.7). This is the one place a loss gets its drop
   * identity, so every kind of loss is tracked as outstanding the same way.
   * Called inside the admitting span's transaction, so the loss commits or
   * rolls back with that span.
   *
   * Besides the `errored` history row, it stores what supersedes the loss
   * later: the observation's raw `objectKey` (only a string counts) and the
   * high-water mark of the event materialization order at this write (see
   * {@link RuntimeStore.reserveAdmissionSequence}). The caller writes it at the
   * lost observation's place in the span's dispatched order: events of earlier
   * siblings, and retries admitted before the loss, are at or below that
   * watermark; events of later siblings and later spans, and retries admitted
   * after the loss, are above it.
   *
   * `eventWatermark` replaces that high-water mark for an observation that
   * was admitted earlier than this write: a skipped retry passes its own
   * admission position, so retained work admitted after it, which carries
   * newer state, supersedes the loss when it completes.
   *
   * @internal
   */
  recordObservationLoss(input: {
    monitorId: string;
    workspacePath: string | null;
    sourceName: string;
    objectKey: string | undefined;
    observationData: Record<string, unknown>;
    eventWatermark?: number;
  }): void {
    asInternalDb(this.db)
      .insert(observationHistory)
      .values({
        id: observationUlid(),
        monitorId: input.monitorId,
        workspacePath: input.workspacePath,
        sourceName: input.sourceName,
        observationData: JSON.stringify(input.observationData),
        result: 'errored',
        createdAt: new Date(),
        unretainedObjectKey: input.objectKey ?? null,
        unretainedEventWatermark:
          input.eventWatermark ??
          sql`(SELECT max(
          coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'monitor_events'), 0),
          coalesce((SELECT max(${monitorEvents.sequence}) FROM ${monitorEvents}), 0)
        ))`,
      })
      .run();
  }

  /**
   * List observation-history rows, newest first. When `query.workspacePath` is
   * provided the result is scoped to that exact workspace (issue #345 / #307) —
   * an observation tick always runs for one concrete workspace, so (unlike
   * `monitor_events`) there is no workspace-agnostic history to fold in, and a
   * same-id monitor in another workspace must not leak its audit trail here.
   * Omitting `workspacePath` returns rows across all workspaces (diagnostic
   * listing), mirroring how `listEvents` leaves the scope open when unset.
   */
  listObservationHistory(
    query: ObservationHistoryQuery = {},
  ): ObservationHistoryRecord[] {
    const conditions = [
      query.monitorId
        ? eq(observationHistory.monitorId, query.monitorId)
        : // Unscoped enumeration (no monitorId) must not leak another session's
          // ephemeral-monitor audit rows — the ephemeral id embeds the declaring
          // session and its observation counts would cross session boundaries
          // (007 §4.6). A monitorId-targeted query (used by `monitor explain` /
          // doctor / reminder diagnosis) is a deliberate lookup and is unaffected.
          notLike(
            observationHistory.monitorId,
            `${EPHEMERAL_MONITOR_ID_PREFIX}%`,
          ),
      query.workspacePath !== undefined
        ? eq(observationHistory.workspacePath, query.workspacePath)
        : undefined,
    ].filter((condition) => condition !== undefined);
    const rows = asInternalDb(this.db)
      .select()
      .from(observationHistory)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      // Second-precision `created_at` ties for rows recorded in one second; the
      // monotonic `id` (see `observationUlid`) keeps this newest-first audit
      // listing stably ordered (issue #293).
      .orderBy(desc(observationHistory.createdAt), desc(observationHistory.id))
      .limit(query.limit ?? 50)
      .all();
    return rows.map((row) => ({
      id: row.id,
      monitorId: row.monitorId,
      workspacePath: row.workspacePath ?? null,
      sourceName: row.sourceName,
      observationData: parseJson<Record<string, unknown>>(
        row.observationData,
        {},
      ),
      result: row.result,
      createdAt: row.createdAt,
    }));
  }

  /**
   * The outstanding observations of one workspace/monitor that the runtime
   * could not keep (002 §2): drops the retry outbox could not retain and
   * observations a hold refused (002 §4.7). `undefined` when there are none.
   *
   * A drop row is an `errored` history row written by
   * {@link RuntimeStore.recordObservationLoss}. It stays outstanding
   * until it is superseded, and nothing else clears it:
   * - a drop with an object key, by a `monitor_events` row of the same
   *   monitor, workspace and object key whose observation was admitted after
   *   the drop: its `admission_sequence` (a completed retry) or else its
   *   `sequence` is above the drop's watermark. A retry admitted before the
   *   drop carries older state, so its completion never clears it;
   * - a drop without one, by a later `triggered` history row of the same
   *   monitor and workspace whose span lost nothing (no positive
   *   `notRetainedCount` or `notHeld`), ordered by `(created_at, id)`. The
   *   losing span's own batch row carries its counts, so it never supersedes
   *   its own losses.
   *
   * Quiet ticks, notify holds, observe failures, a span whose only failure was
   * retained, and events for other keys therefore leave a keyed drop reported.
   * The partial and outcome indexes on `observation_history` and the
   * object-key index on `monitor_events` keep this cheap enough for every
   * doctor/explain call.
   *
   * @internal
   */
  outstandingUnretainedObservationLoss(
    monitorId: string,
    workspacePath: string,
  ): UnretainedObservationLoss | undefined {
    const db = asInternalDb(this.db);
    const drop = observationHistory;
    // json_extract raises on malformed JSON; every row is written with
    // JSON.stringify, but guard so one bad legacy row cannot fail diagnosis.
    const laterLost = (field: 'notRetainedCount' | 'notHeld') =>
      sql`coalesce(CASE WHEN json_valid(superseding.observation_data) THEN json_extract(superseding.observation_data, ${`$.${field}`}) END, 0)`;
    const drops = and(
      eq(drop.monitorId, monitorId),
      eq(drop.workspacePath, workspacePath),
      isNotNull(drop.unretainedEventWatermark),
      or(
        and(
          isNotNull(drop.unretainedObjectKey),
          sql`NOT EXISTS (
            SELECT 1 FROM ${monitorEvents} AS superseding
            WHERE superseding.monitor_id = ${drop.monitorId}
              AND superseding.workspace_path = ${drop.workspacePath}
              AND superseding.object_key = ${drop.unretainedObjectKey}
              AND superseding.sequence > ${drop.unretainedEventWatermark}
              AND coalesce(superseding.admission_sequence, superseding.sequence)
                > ${drop.unretainedEventWatermark}
          )`,
        ),
        and(
          isNull(drop.unretainedObjectKey),
          sql`NOT EXISTS (
            SELECT 1 FROM ${observationHistory} AS superseding
            WHERE superseding.monitor_id = ${drop.monitorId}
              AND superseding.workspace_path = ${drop.workspacePath}
              AND superseding.result = 'triggered'
              AND (superseding.created_at, superseding.id) > (${drop.createdAt}, ${drop.id})
              AND ${laterLost('notRetainedCount')} <= 0
              AND ${laterLost('notHeld')} <= 0
          )`,
        ),
      ),
    );
    const newest = db
      .select()
      .from(observationHistory)
      .where(drops)
      .orderBy(desc(observationHistory.createdAt), desc(observationHistory.id))
      .limit(1)
      .get();
    if (!newest) return undefined;
    const count =
      db
        .select({ n: sql<number>`count(*)` })
        .from(observationHistory)
        .where(drops)
        .get()?.n ?? 1;
    const data = parseJson<Record<string, unknown>>(newest.observationData, {});
    const text = (key: string): string | undefined => {
      const value = data[key];
      return typeof value === 'string' ? safeDiagnosticText(value) : undefined;
    };
    const integer = (key: string): number | undefined => {
      const value = data[key];
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? value
        : undefined;
    };
    const position = integer('position');
    const spanSize = integer('spanSize');
    const objectKey = text('objectKey');
    const title = text('title');
    return {
      count,
      recordedAt: newest.createdAt,
      error: text('error') ?? '',
      ...(position !== undefined ? { position } : {}),
      ...(spanSize !== undefined ? { spanSize } : {}),
      ...(objectKey !== undefined ? { objectKey } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  }

  /**
   * Monitor ids with at least one drop row in this workspace, whether or not it
   * is still outstanding, ordered by id. Doctor uses it to report the losses of
   * monitors that have no one unambiguous parsed definition, including
   * ephemeral monitors, which never have one (002 §2).
   *
   * @internal
   */
  unretainedObservationMonitorIds(workspacePath: string): string[] {
    return asInternalDb(this.db)
      .selectDistinct({ monitorId: observationHistory.monitorId })
      .from(observationHistory)
      .where(
        and(
          eq(observationHistory.workspacePath, workspacePath),
          isNotNull(observationHistory.unretainedEventWatermark),
        ),
      )
      .orderBy(asc(observationHistory.monitorId))
      .all()
      .map(({ monitorId }) => monitorId);
  }

  /**
   * Ids of every pending event of a monitor, in one workspace, that was
   * materialized under a definition other than `currentFingerprint` (issue #451).
   *
   * "Pending" means at least one recipient projection has not acknowledged the
   * event AND can still be delivered: net-collapsed intermediates and
   * Interpret-suppressed projections never deliver and ack-all never
   * acknowledges them, so they are excluded by the same rule the unread and
   * reminder paths use. A row with a NULL fingerprint (materialized before the column existed)
   * never matches: SQL `<>` against NULL is not true, which is the intended
   * "unknown, never flagged" reading. Unlike `listEvents`, this is not bounded by
   * a display limit, so the answer is a total.
   */
  pendingEventIdsOutsideDefinition(
    monitorId: string,
    workspacePath: string | null,
    currentFingerprint: string,
  ): string[] {
    const workspaceCondition =
      workspacePath === null
        ? isNull(monitorEvents.workspacePath)
        : or(
            eq(monitorEvents.workspacePath, workspacePath),
            isNull(monitorEvents.workspacePath),
          );
    return asInternalDb(this.db)
      .selectDistinct({ id: monitorEvents.id })
      .from(monitorEvents)
      .innerJoin(
        sessionEventState,
        eq(sessionEventState.eventId, monitorEvents.id),
      )
      .where(
        and(
          eq(monitorEvents.monitorId, monitorId),
          workspaceCondition,
          ne(monitorEvents.definitionFingerprint, currentFingerprint),
          isNull(sessionEventState.acknowledgedAt),
          notInterpretSuppressed(),
          notNetSuppressed(),
        ),
      )
      .orderBy(asc(monitorEvents.id))
      .all()
      .map((row) => row.id);
  }

  listDeliveryProjectionsForMonitor(
    monitorId: string,
    workspacePath?: string,
  ): MonitorDeliveryProjection[] {
    const conditions = [eq(monitorEvents.monitorId, monitorId)];
    // Scope to the requested workspace's sessions plus workspace-agnostic
    // (global) sessions. The inbox DB is global and the same monitorId can exist
    // in multiple workspaces, so an unscoped query overcounts projections from
    // other workspaces' sessions (issue #94 review, comment 3408123736).
    if (workspacePath !== undefined) {
      const workspaceCondition = or(
        eq(agentSessions.workspacePath, workspacePath),
        isNull(agentSessions.workspacePath),
      );
      if (workspaceCondition) conditions.push(workspaceCondition);
    }
    const rows = asInternalDb(this.db)
      .select({
        event: monitorEvents,
        state: sessionEventState,
        session: agentSessions,
      })
      .from(sessionEventState)
      .innerJoin(monitorEvents, eq(sessionEventState.eventId, monitorEvents.id))
      .innerJoin(
        agentSessions,
        eq(sessionEventState.sessionId, agentSessions.id),
      )
      .where(and(...conditions))
      // Diagnostics use the same persisted time/materialization tie order as
      // recipient delivery, including rows written by another process.
      .orderBy(desc(monitorEvents.createdAt), desc(monitorEvents.sequence))
      .all();

    return rows.map(({ event, state, session }) => ({
      eventId: event.id,
      sessionId: session.id,
      sessionRole: session.role,
      sessionStatus: session.status,
      deliveryState: deliveryStateForRow(state),
      workspacePath: session.workspacePath ?? null,
      createdAt: state.createdAt,
      ...(state.firstNotifiedAt
        ? { firstNotifiedAt: state.firstNotifiedAt }
        : {}),
      ...(state.lastClaimAt ? { lastClaimAt: state.lastClaimAt } : {}),
      ...(state.lastClaimLifecycle
        ? { lastClaimLifecycle: state.lastClaimLifecycle }
        : {}),
      ...(state.acknowledgedAt ? { acknowledgedAt: state.acknowledgedAt } : {}),
      ...(state.interpretDecision
        ? { interpretDecision: state.interpretDecision }
        : {}),
      ...(state.interpretReason
        ? { interpretReason: state.interpretReason }
        : {}),
      ...(state.interpretDigest
        ? { interpretDigest: state.interpretDigest }
        : {}),
      // Per-recipient `net`-collapse suppression marker (G10 PR-B, 002 §1.1.7):
      // an older intermediate of a `net` catch-up span whose newest sibling was
      // delivered instead. Retained here so the collapse stays explainable via
      // `monitor explain` (§10.7), but it was never surfaced to a transport.
      ...(state.netSuppressedAt ? { netSuppressed: true } : {}),
      // Per-recipient delta (G10, 002 §1.1.2): the diff this recipient computed
      // against its own cursor. Fall back to the shared event-level diff for
      // legacy (pre-G10) rows where the per-recipient column is NULL.
      ...(() => {
        const diff = state.diffText ?? event.diffText;
        return diff !== null ? { diffText: diff } : {};
      })(),
    }));
  }

  sessionsForWorkspace(workspacePath?: string | null): AgentSessionRecord[] {
    return asInternalDb(this.db)
      .select()
      .from(agentSessions)
      .where(
        workspacePath == null
          ? isNull(agentSessions.workspacePath)
          : or(
              eq(agentSessions.workspacePath, workspacePath),
              isNull(agentSessions.workspacePath),
            ),
      )
      .orderBy(asc(agentSessions.createdAt))
      .all()
      .map(rowToSession);
  }

  unreadEventsForSession(
    sessionId: string,
    urgency?: 'low' | 'normal' | 'high',
  ): MonitorEventRecord[] {
    const conditions = [eq(sessionEventState.sessionId, sessionId)];
    if (urgency) conditions.push(eq(monitorEvents.urgency, urgency));
    const rows = asInternalDb(this.db)
      .select({
        event: monitorEvents,
        state: sessionEventState,
      })
      .from(sessionEventState)
      .innerJoin(monitorEvents, eq(sessionEventState.eventId, monitorEvents.id))
      .where(
        and(
          ...conditions,
          isNull(sessionEventState.acknowledgedAt),
          notInterpretSuppressed(),
          notNetSuppressed(),
        ),
      )
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.sequence))
      .all();
    return rows.map((row) => rowToEvent(row.event));
  }

  pendingEventsForSession(
    sessionId: string,
    urgency?: 'low' | 'normal' | 'high',
  ): MonitorEventRecord[] {
    const conditions = [eq(sessionEventState.sessionId, sessionId)];
    if (urgency) conditions.push(eq(monitorEvents.urgency, urgency));
    const rows = asInternalDb(this.db)
      .select({
        event: monitorEvents,
      })
      .from(sessionEventState)
      .innerJoin(monitorEvents, eq(sessionEventState.eventId, monitorEvents.id))
      .where(
        and(
          ...conditions,
          isNull(sessionEventState.acknowledgedAt),
          isNull(sessionEventState.firstNotifiedAt),
          notInterpretSuppressed(),
          notNetSuppressed(),
        ),
      )
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.sequence))
      .all();
    return rows.map((row) => rowToEvent(row.event));
  }

  acknowledgeEvents(sessionId: string, eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const now = new Date();
    asInternalDb(this.db)
      .update(sessionEventState)
      .set({ acknowledgedAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          inArray(sessionEventState.eventId, eventIds),
        ),
      )
      .run();
  }

  /**
   * Retract a caller-supplied SET of a monitor's events by id — the create AND
   * delete rows `verify --use-workspace-daemon` captured for its OWN scratch file
   * — plus every durable trace they left: their per-recipient
   * `session_event_state` projections (across ALL sessions, not one), any
   * `monitor_snapshots` captured for them, and the `session_object_cursor` the
   * projection seeded for that object in each affected session.
   *
   * Deletion is BY EVENT ID (not a `(monitorId, objectKey)` sweep): the caller —
   * verify's wait loop — already lists the exact events its synthetic file
   * produced, so it threads their ids here (issue #407 review). This bounds the
   * blast radius to those rows and CANNOT touch a real, pre-existing event that
   * merely shares the same watched path (e.g. an earlier unacked delete on a
   * literal-glob monitor). `monitorId` is applied as a defense-in-depth guard so
   * a stray id belonging to another monitor is ignored rather than deleted.
   *
   * This is a targeted retraction of KNOWN-synthetic events — a file verify
   * itself created and deleted — NOT a general delivery-suppression path; never
   * point it at real monitored events.
   *
   * @returns the removed event ids (only those that existed and matched
   *   `monitorId`) and the (deduped) lead-session ids whose projections were
   *   deleted, so the caller can refresh their hook-state.
   */
  retractObjectEvents(input: {
    workspacePath?: string | null;
    monitorId: string;
    objectKey: string;
    eventIds: string[];
  }): { removedEventIds: string[]; affectedSessionIds: string[] } {
    const db = asInternalDb(this.db);
    if (input.eventIds.length === 0) {
      return { removedEventIds: [], affectedSessionIds: [] };
    }
    // Resolve the caller's candidate ids to the rows that actually exist AND
    // belong to this monitor. Deleting only these (never a broad key sweep) is
    // what keeps a real historical event at the same path from being swept.
    const removedEventIds = db
      .select({ id: monitorEvents.id })
      .from(monitorEvents)
      .where(
        and(
          eq(monitorEvents.monitorId, input.monitorId),
          inArray(monitorEvents.id, input.eventIds),
        ),
      )
      .all()
      .map((row) => row.id);
    return this.deleteResolvedObjectEvents(removedEventIds, input);
  }

  /**
   * Retract every event a monitor has materialized for one `object_key` (issue
   * #414) — the by-KEY companion to {@link retractObjectEvents} (which deletes by
   * explicit id). This IS a `(monitorId, objectKey)` sweep, so it must ONLY be
   * pointed at a synthetic object key that no real monitored file ever shares —
   * `verify`'s per-run scratch path (`…/agentmonitors-verify-<token><ext>`). It
   * powers the durable {@link objectEventSuppressions} tombstone: when verify has
   * proven delivery it retracts the create and leaves a tombstone, and the daemon
   * calls this on the tick the file's deletion event materializes, erasing it
   * before any later session sees it — without verify blocking a poll interval.
   */
  retractObjectEventsByKey(input: {
    workspacePath?: string | null;
    monitorId: string;
    objectKey: string;
  }): { removedEventIds: string[]; affectedSessionIds: string[] } {
    const db = asInternalDb(this.db);
    const conditions = [
      eq(monitorEvents.monitorId, input.monitorId),
      eq(monitorEvents.objectKey, input.objectKey),
    ];
    if (input.workspacePath !== undefined) {
      conditions.push(
        input.workspacePath === null
          ? isNull(monitorEvents.workspacePath)
          : eq(monitorEvents.workspacePath, input.workspacePath),
      );
    }
    const removedEventIds = db
      .select({ id: monitorEvents.id })
      .from(monitorEvents)
      .where(and(...conditions))
      .all()
      .map((row) => row.id);
    return this.deleteResolvedObjectEvents(removedEventIds, input);
  }

  /**
   * Delete a resolved set of a monitor object's event rows and every durable
   * trace they left — shared by {@link retractObjectEvents} (id-scoped) and
   * {@link retractObjectEventsByKey} (key-scoped). The caller is responsible for
   * resolving `removedEventIds` safely; this just performs the cascade.
   */
  private deleteResolvedObjectEvents(
    removedEventIds: string[],
    input: {
      workspacePath?: string | null;
      monitorId: string;
      objectKey: string;
    },
  ): { removedEventIds: string[]; affectedSessionIds: string[] } {
    const db = asInternalDb(this.db);
    if (removedEventIds.length === 0) {
      return { removedEventIds, affectedSessionIds: [] };
    }
    const affectedSessionIds = [
      ...new Set(
        db
          .select({ sessionId: sessionEventState.sessionId })
          .from(sessionEventState)
          .where(inArray(sessionEventState.eventId, removedEventIds))
          .all()
          .map((row) => row.sessionId),
      ),
    ];
    db.delete(sessionEventState)
      .where(inArray(sessionEventState.eventId, removedEventIds))
      .run();
    db.delete(monitorSnapshots)
      .where(inArray(monitorSnapshots.eventId, removedEventIds))
      .run();
    db.delete(monitorEvents)
      .where(inArray(monitorEvents.id, removedEventIds))
      .run();
    // Cursors are keyed by object, not event id: drop only the cursors the
    // retracted events' projection seeded — i.e. those of the AFFECTED sessions
    // (never every session at this path), matched the same workspace-or-null way
    // {@link listEvents} scopes. Without this scoping a retraction at a literal
    // path would wipe an UNAFFECTED session's real baseline for that path and
    // trigger a spurious re-fire (issue #407 review).
    if (affectedSessionIds.length > 0) {
      const cursorConditions = [
        eq(sessionObjectCursor.monitorId, input.monitorId),
        eq(sessionObjectCursor.objectKey, input.objectKey),
        inArray(sessionObjectCursor.sessionId, affectedSessionIds),
      ];
      if (input.workspacePath !== undefined) {
        const workspaceCondition =
          input.workspacePath === null
            ? isNull(sessionObjectCursor.workspacePath)
            : or(
                eq(sessionObjectCursor.workspacePath, input.workspacePath),
                isNull(sessionObjectCursor.workspacePath),
              );
        if (workspaceCondition) cursorConditions.push(workspaceCondition);
      }
      db.delete(sessionObjectCursor)
        .where(and(...cursorConditions))
        .run();
    }
    return { removedEventIds, affectedSessionIds };
  }

  /**
   * Install (or refresh) a durable {@link objectEventSuppressions} tombstone for
   * a `(monitorId, objectKey, workspacePath)` (issue #414), upserting on that
   * triple so a re-run of verify against the same path never accumulates stale
   * rows. `expiresAt` bounds its life so nothing lingers permanently.
   */
  upsertObjectSuppression(input: {
    monitorId: string;
    objectKey: string;
    workspacePath?: string | null;
    reason?: string;
    createdAt: Date;
    expiresAt: Date;
  }): void {
    const db = asInternalDb(this.db);
    const workspacePath = input.workspacePath ?? null;
    db.delete(objectEventSuppressions)
      .where(
        and(
          eq(objectEventSuppressions.monitorId, input.monitorId),
          eq(objectEventSuppressions.objectKey, input.objectKey),
          workspacePath === null
            ? isNull(objectEventSuppressions.workspacePath)
            : eq(objectEventSuppressions.workspacePath, workspacePath),
        ),
      )
      .run();
    db.insert(objectEventSuppressions)
      .values({
        id: ulid(),
        monitorId: input.monitorId,
        objectKey: input.objectKey,
        workspacePath,
        reason: input.reason ?? 'verify-scratch',
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .run();
  }

  /**
   * List the currently-active (non-expired at `now`) object-event suppressions
   * for a workspace — both workspace-scoped and workspace-agnostic rows, matching
   * how {@link listEvents} scopes — so the runtime tick can retract any events
   * their tombstoned object keys have (re-)materialized (issue #414).
   */
  activeObjectSuppressions(
    workspacePath: string | undefined,
    now: Date,
  ): {
    monitorId: string;
    objectKey: string;
    workspacePath: string | null;
  }[] {
    const db = asInternalDb(this.db);
    const conditions = [gt(objectEventSuppressions.expiresAt, now)];
    if (workspacePath !== undefined) {
      const workspaceCondition = or(
        eq(objectEventSuppressions.workspacePath, workspacePath),
        isNull(objectEventSuppressions.workspacePath),
      );
      // `or(...)` is typed `SQL | undefined` (undefined only if ALL args are, which they never are here), so this is a type-narrowing to push into the `SQL[]`, not a runtime branch — matching the same idiom used elsewhere in this file.
      if (workspaceCondition) conditions.push(workspaceCondition);
    }
    return db
      .select({
        monitorId: objectEventSuppressions.monitorId,
        objectKey: objectEventSuppressions.objectKey,
        workspacePath: objectEventSuppressions.workspacePath,
      })
      .from(objectEventSuppressions)
      .where(and(...conditions))
      .all();
  }

  /**
   * Delete every object-event suppression whose `expiresAt` is at or before
   * `now` (issue #414), so an interrupted verify run — or a scratch deletion that
   * never re-materialized — leaves nothing permanent in the tombstone table.
   */
  purgeExpiredObjectSuppressions(now: Date): void {
    const db = asInternalDb(this.db);
    db.delete(objectEventSuppressions)
      .where(lte(objectEventSuppressions.expiresAt, now))
      .run();
  }

  /**
   * Resolve a candidate identity set back to authoritative persisted records in
   * delivery order. External callers and mixed-urgency concatenations may not
   * preserve equal-time order; opaque IDs or supplied artifacts cannot repair
   * it. Session-scoped views are retained only when verified against that
   * recipient's projection. Reject missing/duplicate identities before any
   * collapse side effects.
   */
  private canonicalEventCandidates(
    sessionId: string,
    candidates: MonitorEventRecord[],
  ): MonitorEventRecord[] {
    if (candidates.length === 0) return [];
    const suppliedById = new Map(candidates.map((event) => [event.id, event]));
    const ids = candidates.map((event) => event.id);
    if (suppliedById.size !== ids.length) {
      throw new Error('Duplicate event in collapse candidates');
    }
    const rows = asInternalDb(this.db)
      .select({ event: monitorEvents, state: sessionEventState })
      .from(monitorEvents)
      .leftJoin(
        sessionEventState,
        and(
          eq(sessionEventState.eventId, monitorEvents.id),
          eq(sessionEventState.sessionId, sessionId),
        ),
      )
      .where(inArray(monitorEvents.id, ids))
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.sequence))
      .all();
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((row) => row.event.id));
      throw new Error(
        `Event not found: ${ids.find((id) => !found.has(id)) ?? ''}`,
      );
    }
    return rows.map((row) => {
      const supplied = suppliedById.get(row.event.id);
      const projectionDiff = row.state?.diffText;
      const requestsRecipientDiff =
        supplied !== undefined && supplied.diffText !== row.event.diffText;
      // Delta representation and optional lifecycle state are independent:
      // listEvents(session) carries deliveryState but still has a shared diff.
      // Only a non-shared delta requests this recipient's CURRENT projection,
      // including when a prior claim has re-anchored it since the caller's read.
      // Supplied text is never authoritative; stale, forged or foreign overlays
      // cannot replace persisted artifacts or the requested recipient's state.
      return {
        ...rowToEvent(row.event),
        ...(projectionDiff != null && requestsRecipientDiff
          ? { diffText: projectionDiff }
          : {}),
        ...(row.state && supplied?.deliveryState !== undefined
          ? { deliveryState: deliveryStateForRow(row.state) }
          : {}),
      };
    });
  }

  /**
   * Apply the per-recipient `net` collapse to a recipient's candidate delivery
   * set at claim time (G10 PR-B, 002 §1.1.7).
   *
   * For each event whose persisted `baselineStrategy` is `net`, group the
   * candidates by `(monitorId, objectKey, workspacePath)` — the same 3-tuple
   * used by {@link advanceCursorsForClaimedEvents} and the
   * `session_object_cursor` UNIQUE index — and keep only the NEWEST event of
   * each group as DELIVERED — "where things stand now" against this
   * recipient's own baseline cursor. The newest delivered event's per-recipient
   * `session_event_state.diff_text` is RECOMPUTED as
   * `buildDiff(cursor.baselineContent, newestArtifact, strategy)` (issue #437:
   * strategy-aware — structural for `json-diff`, line-based otherwise) so the
   * delta spans the recipient's cursor → endpoint (not the shared snapshot
   * baseline). The older same-object events are recorded CLAIMED-BUT-SUPPRESSED
   * (`net_suppressed_at`): retained for `monitor explain` but excluded from
   * delivery (unread/pending/recap).
   *
   * `incremental` (default / NULL) events always pass through unchanged, in
   * order. Events without a `snapshotText`/`objectKey` (snapshot-less) cannot be
   * net-collapsed and pass through. A `net` group with a single event is a
   * no-op (`net` ≡ `incremental` in the degenerate single-observation span).
   *
   * @param sessionId - the claiming recipient.
   * @param candidates - a unique set of persisted candidate event identities.
   *   Stored content and canonical delivery order are authoritative. Unknown or
   *   duplicate IDs fail before mutation.
   * @returns the events to actually deliver (suppressed intermediates removed),
   *   in persisted observation-time/materialization order. The caller still
   *   passes the FULL candidate set (delivered + suppressed) to {@link markClaimed} so the cursor advances to
   *   the newest claimed artifact and the suppressed rows are consumed
   *   (`first_notified_at`).
   */
  collapseNetForClaim(
    sessionId: string,
    candidates: MonitorEventRecord[],
  ): MonitorEventRecord[] {
    // The DECISION half (which events survive as delivered vs which older `net`
    // siblings are suppressed) is the pure, side-effect-free
    // {@link computeNetCollapseView} — shared verbatim with the delivery preview
    // (issue #299) so a capped hook context claims exactly the events it renders.
    const canonical = this.canonicalEventCandidates(sessionId, candidates);
    const view = computeNetCollapseView(canonical);

    // No `net` group present → nothing to re-anchor or suppress.
    if (view.netGroupSizeByKey.size === 0) return canonical;

    // The MUTATION half. For each surviving delivered event whose group ACTUALLY
    // collapsed (>1 net event), recompute its per-recipient diff_text against
    // THIS recipient's cursor → endpoint artifact (002 §1.1.7), so the delivered
    // delta spans the whole catch-up, not just the last step. A single-event
    // group ("missed nothing") is left byte-identical to what materialization
    // recorded — the degenerate case where `net` ≡ `incremental`, so a baseline
    // event with a NULL delta is not rewritten to an empty diff.
    for (const event of view.delivered) {
      if (
        event.baselineStrategy !== 'net' ||
        event.snapshotText === null ||
        event.objectKey === null
      )
        continue;
      const key = view.groupKeyByEventId.get(event.id);
      const groupSize = key ? (view.netGroupSizeByKey.get(key) ?? 1) : 1;
      if (groupSize <= 1) continue;
      const cursor = this.getSessionObjectCursor(
        sessionId,
        event.monitorId,
        event.objectKey,
        event.workspacePath,
      );
      if (cursor) {
        this.setPerRecipientDiff(
          sessionId,
          event.id,
          buildDiff(
            cursor.baselineContent,
            event.snapshotText,
            changeDetectionStrategyOf(event.snapshotMetadata),
          ),
        );
      }
    }

    if (view.suppressedIds.length > 0) {
      this.markNetSuppressed(sessionId, view.suppressedIds);
    }
    return view.delivered;
  }

  /**
   * Record the per-recipient `net`-collapse suppression marker (G10 PR-B,
   * 002 §1.1.7) on the given projections: claimed-but-suppressed intermediates,
   * retained for `monitor explain` but excluded from delivery.
   */
  private markNetSuppressed(sessionId: string, eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const now = new Date();
    asInternalDb(this.db)
      .update(sessionEventState)
      .set({ netSuppressedAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          inArray(sessionEventState.eventId, eventIds),
        ),
      )
      .run();
  }

  /**
   * Overwrite the per-recipient delta (`session_event_state.diff_text`) for one
   * projection. Used by the `net` collapse to re-anchor the surviving delta to
   * the recipient's cursor → endpoint span at claim time (G10 PR-B, 002 §1.1.7).
   */
  private setPerRecipientDiff(
    sessionId: string,
    eventId: string,
    diffText: string,
  ): void {
    const now = new Date();
    asInternalDb(this.db)
      .update(sessionEventState)
      .set({ diffText, updatedAt: now })
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          eq(sessionEventState.eventId, eventId),
        ),
      )
      .run();
  }

  markClaimed(sessionId: string, eventIds: string[], lifecycle: string): void {
    if (eventIds.length === 0) return;
    const now = new Date();
    asInternalDb(this.db)
      .update(sessionEventState)
      .set({
        firstNotifiedAt: now,
        lastClaimAt: now,
        lastClaimLifecycle: lifecycle,
        updatedAt: now,
      })
      .where(
        and(
          eq(sessionEventState.sessionId, sessionId),
          inArray(sessionEventState.eventId, eventIds),
        ),
      )
      .run();

    // Advance this recipient's per-object baseline cursor (G10, 002 §1.1.2): the
    // cursor means "the last artifact this recipient was actually shown", so a
    // claim moves it to the artifact of the NEWEST claimed event for each object.
    // Only snapshot-bearing events carry an artifact to advance to.
    this.advanceCursorsForClaimedEvents(sessionId, eventIds);
  }

  /**
   * For a set of just-claimed events, advance the recipient's per-object cursor
   * to the artifact of the NEWEST claimed event (persisted `createdAt`, then
   * SQLite sequence) of each `(monitorId, objectKey, workspacePath)`. Events without a
   * snapshot artifact are skipped (nothing to span from). (G10, 002 §1.1.2.)
   */
  private advanceCursorsForClaimedEvents(
    sessionId: string,
    eventIds: string[],
  ): void {
    const rows = asInternalDb(this.db)
      .select()
      .from(monitorEvents)
      .where(inArray(monitorEvents.id, eventIds))
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.sequence))
      .all();

    // Iterating in ascending order and overwriting leaves the NEWEST claimed
    // event per object as the survivor.
    const newestByObject = new Map<
      string,
      {
        monitorId: string;
        objectKey: string;
        workspacePath: string | null;
        eventId: string;
        artifact: string;
      }
    >();
    for (const row of rows) {
      if (row.snapshotText === null || row.objectKey === null) continue;
      const workspacePath = row.workspacePath ?? null;
      // Use NUL (\0) delimiter — cannot appear in monitor IDs, object keys, or
      // workspace paths, so this is collision-free even when those values contain
      // spaces or any other printable character. (Copilot review: comment 1.)
      const key = [row.monitorId, row.objectKey, workspacePath ?? ''].join(
        '\0',
      );
      newestByObject.set(key, {
        monitorId: row.monitorId,
        objectKey: row.objectKey,
        workspacePath,
        eventId: row.id,
        artifact: row.snapshotText,
      });
    }

    for (const target of newestByObject.values()) {
      this.advanceSessionObjectCursor({
        sessionId,
        monitorId: target.monitorId,
        objectKey: target.objectKey,
        workspacePath: target.workspacePath,
        baselineSnapshotId: target.eventId,
        baselineContent: target.artifact,
      });
    }
  }

  updateSessionRecap(sessionId: string): void {
    const now = new Date();
    asInternalDb(this.db)
      .update(agentSessions)
      .set({ lastRecapAt: now, lastActiveAt: now, updatedAt: now })
      .where(eq(agentSessions.id, sessionId))
      .run();
  }

  sessionHookState(
    sessionId: string,
    pending: {
      high: boolean;
      normal: boolean;
      low: boolean;
      titles: string[];
    },
  ): SessionHookState {
    const unreadHigh = this.unreadEventsForSession(sessionId, 'high').length;
    const unreadNormal = this.unreadEventsForSession(
      sessionId,
      'normal',
    ).length;
    const unreadLow = this.unreadEventsForSession(sessionId, 'low').length;
    return {
      updatedAt: new Date().toISOString(),
      sessionId,
      unread: {
        high: unreadHigh,
        normal: unreadNormal,
        low: unreadLow,
        total: unreadHigh + unreadNormal + unreadLow,
      },
      hasPendingHigh: pending.high,
      hasPendingNormal: pending.normal,
      hasPendingLow: pending.low,
      latestHighTitles: pending.titles,
    };
  }

  status(): RuntimeStatus {
    const sessions = this.listSessions();
    const counts = asInternalDb(this.db)
      .select({ count: sql<number>`count(*)` })
      .from(monitorEvents)
      .all();
    const eventCount = counts[0]?.count ?? 0;
    return {
      sessions: sessions.length,
      activeSessions: sessions.filter((session) => session.status === 'active')
        .length,
      dormantSessions: sessions.filter(
        (session) => session.status === 'dormant',
      ).length,
      events: eventCount,
    };
  }
}
