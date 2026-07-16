import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { monotonicFactory, ulid } from 'ulid';

/**
 * Monotonic ULID factory for `monitor_events` ids (G10 PR-B). Plain `ulid()` is
 * NOT ordered within a single millisecond, but the per-recipient `net` collapse
 * and the claim-time cursor advance both need a deterministic "newest event per
 * object" tiebreak when a tick materializes several events for one object in the
 * same millisecond (their `created_at` ties at the runtime tick clock). A
 * monotonic factory makes `id` strictly increasing in insertion order, so
 * ordering by `(created_at, id)` reflects materialization order exactly.
 */
const eventUlid = monotonicFactory();
import type { InboxDb } from '../inbox/db.js';
import {
  agentSessions,
  ephemeralMonitors,
  monitorEvents,
  monitorSnapshots,
  monitorState,
  observationHistory,
  sessionEventState,
  sessionObjectCursor,
} from '../inbox/schema.js';
import { EPHEMERAL_MONITOR_ID_PREFIX } from './types.js';
import type {
  AgentSessionRecord,
  EphemeralMonitorRecord,
  EventQuery,
  MonitorEventRecord,
  MonitorDeliveryProjection,
  MonitorDeliveryState,
  MonitorRuntimeState,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
  ObservationOutcome,
  OpenSessionInput,
  RuntimeStatus,
  SessionHookState,
  SessionObjectCursorRecord,
} from './types.js';
import type { Urgency } from '../schema/types.js';
import { buildTextDiff } from './diff.js';

type InternalInboxDb = BetterSQLite3Database<
  typeof import('../inbox/schema.js')
>;

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

export function computeNetCollapseView(
  candidates: MonitorEventRecord[],
): NetCollapseView {
  // Order by (createdAt, id): events materialized in the same tick share a
  // createdAt, so the monotonic `id` (see `eventUlid`) breaks the tie in
  // insertion order — the last is the true endpoint ("where things stand now",
  // 002 §1.1.7).
  const ordered = [...candidates].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
  constructor(private readonly db: InboxDb) {}

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
      })
      .run();

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
   * Materialize ONE shared `monitor_events` row and project it into matching
   * lead sessions (002 §6), computing a PER-RECIPIENT delta for each (G10,
   * 002 §1.1.2) — the shared artifact diffed against THAT session's own baseline
   * cursor, recorded on `session_event_state.diff_text`.
   *
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
   *   first delta (decided semantics Q1). When omitted, no per-recipient diff is
   *   computed (snapshot-less event).
   */
  insertEvent(
    input: Omit<MonitorEventRecord, 'id'>,
    baseline?: { previousContent: string | null },
    options?: { restrictToSessionId?: string },
  ): MonitorEventRecord {
    const db = asInternalDb(this.db);
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
    const projectionTargets = ephemeralStillActive
      ? this.sessionsForWorkspace(event.workspacePath).filter(
          (candidate) =>
            candidate.role === 'lead' &&
            (options?.restrictToSessionId === undefined ||
              (candidate.id === options.restrictToSessionId &&
                candidate.status === 'active')),
        )
      : [];
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
        if (cursor) {
          // Existing recipient: span from its own cursor. Never advanced here —
          // materialization SEEDS only; the cursor advances at claim
          // (markClaimed), so a recipient that stayed away keeps spanning from
          // its last-seen point across multiple shared observations.
          perRecipientDiff = buildTextDiff(cursor.baselineContent, artifact);
        } else {
          // First projection of this object to this session = "caught up to the
          // pre-event state": its delta is the shared diff (prior → artifact),
          // identical to today's single-baseline behavior (backward-compat).
          const previous = baseline?.previousContent ?? null;
          perRecipientDiff =
            previous !== null ? buildTextDiff(previous, artifact) : null;
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
    this.lastProjectedSessionIds = projectedSessionIds;
    return event;
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
          .orderBy(desc(monitorEvents.createdAt))
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
          .orderBy(desc(monitorEvents.createdAt))
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
        id: ulid(),
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
      .orderBy(desc(monitorSnapshots.createdAt))
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
        id: ulid(),
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
      .orderBy(desc(observationHistory.createdAt))
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
      .orderBy(desc(monitorEvents.createdAt))
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
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.id))
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
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.id))
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
   * `buildTextDiff(cursor.baselineContent, newestArtifact)` so the delta spans
   * the recipient's cursor → endpoint (not the shared snapshot baseline). The
   * older same-object events are recorded CLAIMED-BUT-SUPPRESSED
   * (`net_suppressed_at`): retained for `monitor explain` but excluded from
   * delivery (unread/pending/recap).
   *
   * `incremental` (default / NULL) events always pass through unchanged, in
   * order. Events without a `snapshotText`/`objectKey` (snapshot-less) cannot be
   * net-collapsed and pass through. A `net` group with a single event is a
   * no-op (`net` ≡ `incremental` in the degenerate single-observation span).
   *
   * @param sessionId - the claiming recipient.
   * @param candidates - the recipient's candidate events, OLDEST-FIRST.
   * @returns the events to actually deliver (suppressed intermediates removed),
   *   preserving the input order. The caller still passes the FULL candidate set
   *   (delivered + suppressed) to {@link markClaimed} so the cursor advances to
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
    const view = computeNetCollapseView(candidates);

    // No `net` group present → nothing to re-anchor or suppress; pass through.
    if (view.netGroupSizeByKey.size === 0) return candidates;

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
          buildTextDiff(cursor.baselineContent, event.snapshotText),
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
   * to the artifact of the NEWEST (latest `createdAt`, then ULID-ordered) claimed
   * event of each `(monitorId, objectKey, workspacePath)`. Events without a
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
      .orderBy(asc(monitorEvents.createdAt), asc(monitorEvents.id))
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
