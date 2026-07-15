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
  // The monitor's author-declared baseline strategy (G13/G10 PR-B, 002 §1.1.7),
  // persisted on the shared event so the per-recipient `net` collapse can run at
  // claim time without re-scanning monitor definitions. NULL on legacy rows
  // materialized before PR-B; treated as `incremental` (the default).
  baselineStrategy: text('baseline_strategy', {
    enum: ['incremental', 'net'],
  }),
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
  // The PER-RECIPIENT delta (G10, 002 §1.1.2): the diff of this event's shaped
  // artifact against THIS session's own baseline cursor at projection time.
  // Right of the Pace→Diff seam, so two sessions at divergent baselines record
  // different spans from the SAME shared `monitor_events` row. `NULL` for a
  // baseline event (no prior to diff) and for legacy rows materialized before
  // G10 — delivery/explain fall back to the shared `monitor_events.diff_text`.
  diffText: text('diff_text'),
  // Per-recipient Interpret verdict (G14, 002 §1.1.8); absent for the deterministic
  // forms that never invoke Interpret. `interpret_reason` is the agentic-gate
  // suppression reason or the fallback-failure detail; `interpret_digest` is the
  // delivered cheap digest when the decision is `deliver`.
  interpretDecision: text('interpret_decision', {
    enum: interpretDecisionValues,
  }),
  interpretReason: text('interpret_reason'),
  interpretDigest: text('interpret_digest'),
  // The per-recipient `net` collapse marker (G10 PR-B, 002 §1.1.7). When a `net`
  // monitor's recipient claims a multi-event catch-up span for one object, the
  // newest event is delivered and the older intermediates are recorded
  // CLAIMED-BUT-SUPPRESSED here: the row is retained (so the collapse stays
  // explainable via `monitor explain`, 002 §10.7) but excluded from delivery
  // (unread/pending/recap). Set at claim time alongside `first_notified_at`.
  netSuppressedAt: integer('net_suppressed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Per-monitor runtime state: the source plugin's change-detection baseline
 * (`source_state`), notify/debounce/rollup timing (`notify_state`), and the last
 * completed-tick timestamp. Keyed by `(monitor_id, workspace_path)` — NOT
 * `monitor_id` alone — because the same monitor id can exist in unrelated
 * workspaces sharing one global DB (issue #345 / #307): keying by id alone let
 * one workspace's file-fingerprint baseline leak into another, so a second
 * project reusing the default `my-first-monitor` id reported changes for files
 * that only ever existed in the first. Uses a surrogate `id` PK plus a UNIQUE
 * index on `(monitor_id, COALESCE(workspace_path, ''))` (db.ts) so the NULL
 * (global) scope stays single-rowed — the same pattern as `session_object_cursor`.
 */
export const monitorState = sqliteTable('monitor_state', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull(),
  workspacePath: text('workspace_path'),
  lastObservationAt: integer('last_observation_at', { mode: 'timestamp' }),
  lastFingerprint: text('last_fingerprint'),
  sourceState: text('source_state').notNull().default('{}'),
  notifyState: text('notify_state').notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * The PER-RECIPIENT baseline cursor (G10, 002 §1.1.2). One row per
 * `(session_id, monitor_id, object_key, workspace_path)`: the last shaped
 * artifact this recipient was caught up to, the anchor its per-recipient Diff
 * spans FROM. Lives in the same durable SQLite DB so cursors survive a daemon
 * restart/reboot (002 §3, BP1); session-keyed so isolation is structural (one
 * session advancing its cursor never moves another's).
 *
 * `baseline_content` is DENORMALIZED (the full artifact text, not just a
 * snapshot id) so a recipient's baseline is prune-immune: pruning
 * `monitor_snapshots` history can never strand a cursor without a baseline to
 * diff against. `baseline_snapshot_id` records which event/snapshot the baseline
 * came from for diagnosis.
 *
 * Seed/advance rules (decided): materialization SEEDS a cursor only when none
 * exists (new recipient = caught up to the pre-event state); it never advances
 * an existing one. `markClaimed` advances the cursor to the artifact of the
 * newest event the recipient just claimed for that object. Cursors persist
 * across dormancy — a resuming session keeps its cursors.
 */
export const sessionObjectCursor = sqliteTable('session_object_cursor', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  monitorId: text('monitor_id').notNull(),
  objectKey: text('object_key').notNull(),
  workspacePath: text('workspace_path'),
  baselineSnapshotId: text('baseline_snapshot_id'),
  baselineContent: text('baseline_content').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const observationHistory = sqliteTable('observation_history', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull(),
  // The observing daemon's workspace (issue #345 / #307). NULL on legacy rows
  // written before the column existed; scoped explain/history queries filter by
  // exact workspace so a same-id monitor in another workspace cannot leak its
  // audit trail into this one.
  workspacePath: text('workspace_path'),
  sourceName: text('source_name').notNull(),
  observationData: text('observation_data').notNull().default('{}'),
  result: text('result', {
    enum: [
      'triggered',
      'suppressed',
      'no-change',
      'no-files-matched',
      'errored',
      'rebaselined',
    ],
  }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
