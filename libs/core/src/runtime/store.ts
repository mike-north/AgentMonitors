import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ulid } from 'ulid';
import type { InboxDb } from '../inbox/db.js';
import {
  agentSessions,
  monitorEvents,
  monitorSnapshots,
  monitorState,
  sessionEventState,
} from '../inbox/schema.js';
import * as schema from '../inbox/schema.js';
import type {
  AgentSessionRecord,
  EventQuery,
  MonitorEventRecord,
  MonitorRuntimeState,
  OpenSessionInput,
  RuntimeStatus,
  SessionHookState,
} from './types.js';

type InternalInboxDb = BetterSQLite3Database<typeof schema>;

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
    eventKind: row.eventKind,
    title: row.title,
    body: row.body,
    summary: row.summary,
    payload: parseJson(row.payload, {}),
    snapshotMetadata: parseJson(row.snapshotMetadata, {}),
    snapshotText: row.snapshotText ?? null,
    diffText: row.diffText ?? null,
    objectKey: row.objectKey ?? null,
    queryScope: parseJson(row.queryScope, {}),
    tags: parseJson(row.tags, []),
    createdAt: row.createdAt,
  };
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

  insertEvent(input: Omit<MonitorEventRecord, 'id'>): MonitorEventRecord {
    const db = asInternalDb(this.db);
    const id = ulid();
    db.insert(monitorEvents)
      .values({
        id,
        workspacePath: input.workspacePath,
        monitorId: input.monitorId,
        sourceName: input.sourceName,
        eventKind: input.eventKind,
        urgency: input.urgency,
        title: input.title,
        body: input.body,
        summary: input.summary,
        payload: JSON.stringify(input.payload ?? {}),
        snapshotMetadata: JSON.stringify(input.snapshotMetadata ?? {}),
        snapshotText: input.snapshotText,
        diffText: input.diffText,
        objectKey: input.objectKey,
        queryScope: JSON.stringify(input.queryScope),
        tags: JSON.stringify(input.tags),
        createdAt: input.createdAt,
      })
      .run();

    const event = this.getEventById(id);
    for (const session of this.sessionsForWorkspace(event.workspacePath).filter(
      (candidate) => candidate.role === 'lead',
    )) {
      db.insert(sessionEventState)
        .values({
          id: ulid(),
          sessionId: session.id,
          eventId: event.id,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        })
        .run();
    }
    return event;
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
    if (query.eventKind)
      conditions.push(eq(monitorEvents.eventKind, query.eventKind));
    if (query.objectKey)
      conditions.push(eq(monitorEvents.objectKey, query.objectKey));
    if (query.since) conditions.push(gt(monitorEvents.createdAt, query.since));

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
      .where(and(...conditions, isNull(sessionEventState.acknowledgedAt)))
      .orderBy(asc(monitorEvents.createdAt))
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
        ),
      )
      .orderBy(asc(monitorEvents.createdAt))
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
