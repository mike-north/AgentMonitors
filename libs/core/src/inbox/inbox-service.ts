import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ulid } from 'ulid';
import type { InboxDb } from './db.js';
import { inboxItems } from './schema.js';
import type { InboxItemState } from './schema.js';
import type { EnqueuePayload, InboxFilter, InboxItem } from './types.js';

type InternalInboxDb = BetterSQLite3Database<typeof import('./schema.js')> & {
  $client: BetterSQLiteClient;
};

function asInternalDb(db: InboxDb): InternalInboxDb {
  return db as unknown as InternalInboxDb;
}

function rowToItem(row: typeof inboxItems.$inferSelect): InboxItem {
  return {
    id: row.id,
    monitorId: row.monitorId,
    state: row.state,
    urgency: row.urgency,
    eventKind: row.eventKind,
    title: row.title,
    body: row.body,
    snapshot: JSON.parse(row.snapshot) as unknown,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ackedAt: row.ackedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

/** Valid state transitions: current state → allowed next states. */
const VALID_TRANSITIONS: Record<InboxItemState, InboxItemState[]> = {
  queued: ['acked'],
  acked: ['in-progress'],
  'in-progress': ['completed', 'failed'],
  completed: ['archived'],
  failed: ['archived'],
  archived: [],
};

/**
 * Service for managing inbox items with a state-machine lifecycle.
 *
 * State machine: `queued → acked → in-progress → completed|failed → archived`
 *
 * @param onMutation - Optional callback fired after every state change, used by the hook bridge
 *   to write updated state to disk.
 */
export class InboxService {
  private readonly db: InboxDb;
  private readonly onMutation: (() => void) | undefined;

  constructor(db: InboxDb, onMutation?: () => void) {
    this.db = db;
    this.onMutation = onMutation;
  }

  /** Look up an item and validate the state transition, throwing on invalid transitions or missing IDs. */
  private requireTransition(
    id: string,
    targetState: InboxItemState,
  ): InboxItem {
    const item = this.getById(id);
    if (!item) {
      throw new Error(`Inbox item not found: ${id}`);
    }
    const allowed = VALID_TRANSITIONS[item.state];
    if (!allowed.includes(targetState)) {
      throw new Error(
        `Invalid state transition: cannot move from "${item.state}" to "${targetState}"`,
      );
    }
    return item;
  }

  /** Enqueue a new inbox item. Returns the generated ULID. */
  enqueue(payload: EnqueuePayload): string {
    const now = new Date();
    const id = ulid();
    const db = asInternalDb(this.db);

    db.insert(inboxItems)
      .values({
        id,
        monitorId: payload.monitorId,
        state: 'queued',
        urgency: payload.urgency,
        eventKind: payload.eventKind,
        title: payload.title,
        body: payload.body ?? '',
        snapshot: JSON.stringify(payload.snapshot ?? {}),
        tags: JSON.stringify(payload.tags ?? []),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.onMutation?.();
    return id;
  }

  /** Mark an item as acknowledged (agent has seen it). */
  ack(id: string): void {
    this.requireTransition(id, 'acked');
    const now = new Date();
    asInternalDb(this.db)
      .update(inboxItems)
      .set({ state: 'acked', ackedAt: now, updatedAt: now })
      .where(eq(inboxItems.id, id))
      .run();
    this.onMutation?.();
  }

  /** Move an item to in-progress (agent is actively working on it). */
  start(id: string): void {
    this.requireTransition(id, 'in-progress');
    const now = new Date();
    asInternalDb(this.db)
      .update(inboxItems)
      .set({ state: 'in-progress', updatedAt: now })
      .where(eq(inboxItems.id, id))
      .run();
    this.onMutation?.();
  }

  /** Mark an item as successfully completed. */
  complete(id: string): void {
    this.requireTransition(id, 'completed');
    const now = new Date();
    asInternalDb(this.db)
      .update(inboxItems)
      .set({ state: 'completed', completedAt: now, updatedAt: now })
      .where(eq(inboxItems.id, id))
      .run();
    this.onMutation?.();
  }

  /** Mark an item as failed. The error message is appended to the body, preserving the original content. */
  fail(id: string, error?: string): void {
    const item = this.requireTransition(id, 'failed');
    const now = new Date();
    const db = asInternalDb(this.db);
    if (error) {
      const existingBody = item.body;
      const separator = existingBody ? '\n\n---\n\n' : '';
      db.update(inboxItems)
        .set({
          state: 'failed',
          body: `${existingBody}${separator}Error: ${error}`,
          updatedAt: now,
        })
        .where(eq(inboxItems.id, id))
        .run();
    } else {
      db.update(inboxItems)
        .set({ state: 'failed', updatedAt: now })
        .where(eq(inboxItems.id, id))
        .run();
    }
    this.onMutation?.();
  }

  /** Archive a completed or failed item. */
  archive(id: string): void {
    this.requireTransition(id, 'archived');
    const now = new Date();
    asInternalDb(this.db)
      .update(inboxItems)
      .set({ state: 'archived', updatedAt: now })
      .where(eq(inboxItems.id, id))
      .run();
    this.onMutation?.();
  }

  /** Get a single item by ID, or null if not found. */
  getById(id: string): InboxItem | null {
    const row = asInternalDb(this.db)
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, id))
      .get();
    return row ? rowToItem(row) : null;
  }

  /** List items matching the filter, ordered newest-first. */
  list(filter?: InboxFilter): InboxItem[] {
    const conditions = this.buildConditions(filter);

    const rows = asInternalDb(this.db)
      .select()
      .from(inboxItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(inboxItems.createdAt))
      .all();

    return rows.map(rowToItem);
  }

  private buildConditions(filter?: InboxFilter) {
    const conditions = [];

    if (filter?.state) {
      if (Array.isArray(filter.state)) {
        conditions.push(inArray(inboxItems.state, filter.state));
      } else {
        conditions.push(eq(inboxItems.state, filter.state));
      }
    }
    if (filter?.urgency) {
      conditions.push(eq(inboxItems.urgency, filter.urgency));
    }
    if (filter?.eventKind) {
      conditions.push(eq(inboxItems.eventKind, filter.eventKind));
    }
    if (filter?.monitorId) {
      conditions.push(eq(inboxItems.monitorId, filter.monitorId));
    }
    if (filter?.since) {
      conditions.push(gte(inboxItems.createdAt, filter.since));
    }
    if (filter?.until) {
      conditions.push(lte(inboxItems.createdAt, filter.until));
    }
    if (filter?.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM json_each(${inboxItems.tags}) WHERE json_each.value = ${tag})`,
        );
      }
    }

    return conditions;
  }
}
