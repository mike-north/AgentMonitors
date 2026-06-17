import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
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
  monitorEvents,
  monitorSnapshots,
  monitorState,
  observationHistory,
  sessionEventState,
  sessionObjectCursor,
} from '../inbox/schema.js';
import type {
  AgentSessionRecord,
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

function deliveryStateForRow(row: {
  firstNotifiedAt: Date | null;
  acknowledgedAt: Date | null;
}): MonitorDeliveryState {
  if (row.acknowledgedAt) return 'acknowledged';
  if (row.firstNotifiedAt) return 'claimed';
  return 'unread';
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

  getMonitorState(monitorId: string): MonitorRuntimeState {
    const row = asInternalDb(this.db)
      .select()
      .from(monitorState)
      .where(eq(monitorState.monitorId, monitorId))
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
      .where(eq(monitorState.monitorId, monitorId))
      .get();
    const values = {
      monitorId,
      lastObservationAt: state.lastObservationAt ?? null,
      lastFingerprint: null,
      sourceState: JSON.stringify(state.sourceState ?? {}),
      notifyState: JSON.stringify(state.notifyState ?? {}),
      updatedAt: now,
    };

    if (existing) {
      db.update(monitorState)
        .set({
          lastObservationAt: values.lastObservationAt,
          lastFingerprint: values.lastFingerprint,
          sourceState: values.sourceState,
          notifyState: values.notifyState,
          updatedAt: values.updatedAt,
        })
        .where(eq(monitorState.monitorId, monitorId))
        .run();
      return;
    }

    db.insert(monitorState).values(values).run();
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
    for (const session of this.sessionsForWorkspace(event.workspacePath).filter(
      (candidate) => candidate.role === 'lead',
    )) {
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
          .map((row) => rowToEvent(row.event))
      : asInternalDb(this.db)
          .select()
          .from(monitorEvents)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
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
    sourceName: string;
    result: ObservationOutcome;
    observationData: Record<string, unknown>;
  }): void {
    asInternalDb(this.db)
      .insert(observationHistory)
      .values({
        id: ulid(),
        monitorId: input.monitorId,
        sourceName: input.sourceName,
        observationData: JSON.stringify(input.observationData),
        result: input.result,
        createdAt: new Date(),
      })
      .run();
  }

  listObservationHistory(
    query: ObservationHistoryQuery = {},
  ): ObservationHistoryRecord[] {
    const rows = asInternalDb(this.db)
      .select()
      .from(observationHistory)
      .where(
        query.monitorId
          ? eq(observationHistory.monitorId, query.monitorId)
          : undefined,
      )
      .orderBy(desc(observationHistory.createdAt))
      .limit(query.limit ?? 50)
      .all();
    return rows.map((row) => ({
      id: row.id,
      monitorId: row.monitorId,
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
   * candidates by `(monitorId, objectKey)` and keep only the NEWEST event of
   * each group as DELIVERED — "where things stand now" against this recipient's
   * own baseline cursor. The newest delivered event's per-recipient
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
    // Identify, per (monitorId, objectKey, workspacePath), the NEWEST `net`
    // event in the candidate set; every OLDER `net` sibling of a multi-event
    // group is suppressed. Order by (createdAt, id): events materialized in the
    // same tick share a createdAt, so the monotonic `id` (see `eventUlid`)
    // breaks the tie in insertion order — the last is the true endpoint ("where
    // things stand now", 002 §1.1.7).
    //
    // IMPORTANT: the grouping key must include workspacePath (using the same
    // 3-tuple as advanceCursorsForClaimedEvents and the session_object_cursor
    // UNIQUE index). Omitting it caused cross-workspace folding for global
    // (null-workspace) sessions that receive projections from multiple
    // workspaces, silently dropping a delivery (regression #186).
    const ordered = [...candidates].sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const newestNetByObject = new Map<string, MonitorEventRecord>();
    const netGroupSize = new Map<string, number>();
    for (const event of ordered) {
      if (event.baselineStrategy !== 'net') continue;
      if (event.snapshotText === null || event.objectKey === null) continue;
      const key = [
        event.monitorId,
        event.objectKey,
        event.workspacePath ?? '',
      ].join('\0');
      newestNetByObject.set(key, event);
      netGroupSize.set(key, (netGroupSize.get(key) ?? 0) + 1);
    }

    if (newestNetByObject.size === 0) return candidates;

    const suppressedIds: string[] = [];
    const delivered: MonitorEventRecord[] = [];
    for (const event of candidates) {
      const collapsible =
        event.baselineStrategy === 'net' &&
        event.snapshotText !== null &&
        event.objectKey !== null;
      if (!collapsible) {
        delivered.push(event);
        continue;
      }
      const key = [
        event.monitorId,
        event.objectKey,
        event.workspacePath ?? '',
      ].join('\0');
      const newest = newestNetByObject.get(key);
      if (newest?.id === event.id) {
        // The surviving net delta: when the group ACTUALLY collapsed (>1 event),
        // recompute its per-recipient diff_text against THIS recipient's cursor →
        // endpoint artifact (002 §1.1.7), so the delivered delta spans the whole
        // catch-up, not just the last step. A single-event group ("missed
        // nothing") is left byte-identical to what materialization recorded — the
        // degenerate case where `net` ≡ `incremental` (criterion 2), so a
        // baseline event with a NULL delta is not rewritten to an empty diff.
        const groupSize = netGroupSize.get(key) ?? 1;
        if (groupSize > 1 && event.snapshotText !== null) {
          // objectKey is non-null: the `collapsible` guard above already asserts
          // `event.objectKey !== null`. The `??` fallback removed in G10 PR-B was
          // dead code; a null objectKey here is a logic bug, not a valid fallback.
          const cursor = this.getSessionObjectCursor(
            sessionId,
            event.monitorId,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            event.objectKey!,
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
        delivered.push(event);
      } else {
        // An older intermediate of a multi-event net group: suppress it.
        suppressedIds.push(event.id);
      }
    }

    if (suppressedIds.length > 0) {
      this.markNetSuppressed(sessionId, suppressedIds);
    }
    return delivered;
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
