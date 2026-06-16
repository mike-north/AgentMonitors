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

export const urgencyValues = ['low', 'normal', 'high'] as const;

export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  monitorId: text('monitor_id').notNull(),
  state: text('state', { enum: inboxItemState }).notNull().default('queued'),
  urgency: text('urgency', { enum: urgencyValues }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  snapshot: text('snapshot').notNull().default('{}'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ackedAt: integer('acked_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const agentSessionStatus = ['active', 'dormant'] as const;
export type AgentSessionStatus = (typeof agentSessionStatus)[number];

export const agentSessionRole = ['lead', 'subagent'] as const;
export type AgentSessionRole = (typeof agentSessionRole)[number];

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  adapter: text('adapter').notNull(),
  hostSessionId: text('host_session_id').notNull(),
  agentIdentity: text('agent_identity').notNull(),
  role: text('role', { enum: agentSessionRole }).notNull().default('lead'),
  workspacePath: text('workspace_path'),
  hookStatePath: text('hook_state_path').notNull(),
  status: text('status', { enum: agentSessionStatus }).notNull(),
  baselineAt: integer('baseline_at', { mode: 'timestamp' }).notNull(),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }).notNull(),
  lastRecapAt: integer('last_recap_at', { mode: 'timestamp' }),
  dormantAt: integer('dormant_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const monitorEvents = sqliteTable('monitor_events', {
  id: text('id').primaryKey(),
  workspacePath: text('workspace_path'),
  monitorId: text('monitor_id').notNull(),
  sourceName: text('source_name').notNull(),
  urgency: text('urgency', { enum: urgencyValues }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  summary: text('summary').notNull().default(''),
  payload: text('payload').notNull().default('{}'),
  snapshotMetadata: text('snapshot_metadata').notNull().default('{}'),
  snapshotText: text('snapshot_text'),
  diffText: text('diff_text'),
  objectKey: text('object_key'),
  queryScope: text('query_scope').notNull().default('{}'),
  tags: text('tags').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const monitorSnapshots = sqliteTable('monitor_snapshots', {
  id: text('id').primaryKey(),
  workspacePath: text('workspace_path'),
  monitorId: text('monitor_id').notNull(),
  objectKey: text('object_key').notNull(),
  eventId: text('event_id').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/**
 * The per-recipient Interpret decision (G14, 002 §1.1.8). Recorded on
 * `session_event_state` because Interpret runs **right of the per-recipient
 * seam** — its verdict is per recipient, not the shared tick-level
 * `observation_history`. `deliver` = the agentic gate passed (or no gate);
 * `suppress` = the agentic gate judged the delta not substantive (no delivery);
 * `failed` = the AI tool errored and the runtime fell back to the deterministic
 * `rendered` artifact (best-effort, 002 §1.1.8).
 */
export const interpretDecisionValues = [
  'deliver',
  'suppress',
  'failed',
] as const;
export type InterpretDecision = (typeof interpretDecisionValues)[number];

export const sessionEventState = sqliteTable('session_event_state', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  eventId: text('event_id').notNull(),
  firstNotifiedAt: integer('first_notified_at', { mode: 'timestamp' }),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
  lastClaimAt: integer('last_claim_at', { mode: 'timestamp' }),
  lastClaimLifecycle: text('last_claim_lifecycle'),
  // Per-recipient Interpret verdict (G14, 002 §1.1.8); absent for the deterministic
  // forms that never invoke Interpret. `interpret_reason` is the agentic-gate
  // suppression reason or the fallback-failure detail; `interpret_digest` is the
  // delivered cheap digest when the decision is `deliver`.
  interpretDecision: text('interpret_decision', {
    enum: interpretDecisionValues,
  }),
  interpretReason: text('interpret_reason'),
  interpretDigest: text('interpret_digest'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const monitorState = sqliteTable('monitor_state', {
  monitorId: text('monitor_id').primaryKey(),
  lastObservationAt: integer('last_observation_at', { mode: 'timestamp' }),
  lastFingerprint: text('last_fingerprint'),
  sourceState: text('source_state').notNull().default('{}'),
  notifyState: text('notify_state').notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const observationHistory = sqliteTable('observation_history', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull(),
  sourceName: text('source_name').notNull(),
  observationData: text('observation_data').notNull().default('{}'),
  result: text('result', {
    enum: ['triggered', 'suppressed', 'no-change', 'errored', 'rebaselined'],
  }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
