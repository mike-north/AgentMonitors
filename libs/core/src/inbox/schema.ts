import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const inboxItemState = [
  'queued',
  'acked',
  'in-progress',
  'completed',
  'failed',
  'archived',
] as const;
export type InboxItemState = (typeof inboxItemState)[number];

export const urgencyValues = ['high', 'normal'] as const;
export const eventKindValues = ['mutation', 'notification', 'alert'] as const;

export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull(),
  state: text('state', { enum: inboxItemState }).notNull().default('queued'),
  urgency: text('urgency', { enum: urgencyValues }).notNull(),
  eventKind: text('event_kind', { enum: eventKindValues }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  snapshot: text('snapshot').notNull().default('{}'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ackedAt: integer('acked_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const monitorState = sqliteTable('monitor_state', {
  monitorId: text('monitor_id').primaryKey(),
  lastObservationAt: integer('last_observation_at', { mode: 'timestamp' }),
  lastFingerprint: text('last_fingerprint'),
  notifyState: text('notify_state').notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const observationHistory = sqliteTable('observation_history', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull(),
  sourceName: text('source_name').notNull(),
  observationData: text('observation_data').notNull().default('{}'),
  result: text('result', {
    enum: ['triggered', 'suppressed', 'no-change'],
  }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
