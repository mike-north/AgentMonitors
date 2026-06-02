import type {
  EventKind,
  MonitorDefinition,
  NotifyConfig,
  Urgency,
} from '../schema/types.js';
import type { Observation } from '../observation/types.js';

export type AgentLifecycleEvent =
  | 'session-opened'
  | 'session-dormant'
  | 'turn-interruptible'
  | 'turn-ended'
  | 'turn-idle'
  | 'pre-compact'
  | 'post-compact';

export type DeliveryLifecycle =
  | 'turn-interruptible'
  | 'turn-idle'
  | 'post-compact';

export type AgentSessionRole = 'lead' | 'subagent';
export type AgentSessionStatus = 'active' | 'dormant';
export type DeliveryMode = 'delivery' | 'recap';
export type UrgencyCounts = Record<Urgency, number>;

export interface OpenSessionInput {
  adapter: string;
  hostSessionId: string;
  workspacePath?: string;
  role?: AgentSessionRole;
  agentIdentity: string;
  hookStatePath: string;
}

export interface AgentSessionRecord {
  id: string;
  adapter: string;
  hostSessionId: string;
  agentIdentity: string;
  role: AgentSessionRole;
  workspacePath?: string;
  hookStatePath: string;
  status: AgentSessionStatus;
  baselineAt: Date;
  lastActiveAt: Date;
  lastRecapAt?: Date;
  dormantAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitorEventRecord {
  id: string;
  workspacePath: string | null;
  monitorId: string;
  sourceName: string;
  urgency: Urgency;
  eventKind: EventKind;
  title: string;
  body: string;
  summary: string;
  payload: unknown;
  snapshotMetadata: unknown;
  snapshotText: string | null;
  diffText: string | null;
  objectKey: string | null;
  queryScope: Record<string, string | string[]>;
  tags: string[];
  createdAt: Date;
}

export interface DeliveryEventSummary {
  eventId: string;
  monitorId: string;
  title: string;
  summary: string;
  urgency: Urgency;
  createdAt: string;
}

export interface DeliveryClaim {
  sessionId: string;
  mode: DeliveryMode;
  urgency?: Urgency;
  lifecycle: DeliveryLifecycle;
  message: string;
  unreadCounts: SessionUnreadCounts;
  events: DeliveryEventSummary[];
}

export interface SessionEventFilter {
  sessionId: string;
  monitorId?: string;
  urgency?: Urgency;
  eventKind?: EventKind;
  tags?: string[];
  scope?: Record<string, string>;
  unreadOnly?: boolean;
  sinceBaseline?: boolean;
  sinceLastRecap?: boolean;
  limit?: number;
}

export interface EventQuery {
  sessionId?: string;
  monitorId?: string;
  urgency?: Urgency;
  eventKind?: EventKind;
  tags?: string[];
  scope?: Record<string, string>;
  objectKey?: string;
  unreadOnly?: boolean;
  sinceBaseline?: boolean;
  since?: Date;
}

export type SessionUnreadCounts = UrgencyCounts & { total: number };

export interface SessionHookState {
  updatedAt: string;
  sessionId: string;
  unread: SessionUnreadCounts;
  hasPendingHigh: boolean;
  hasPendingNormal: boolean;
  hasPendingLow: boolean;
  latestHighTitles: string[];
}

export interface MonitorRuntimeState {
  lastObservationAt?: Date;
  sourceState?: unknown;
  notifyState: NotifyRuntimeState;
}

export interface PendingDebounceState {
  observations: StoredObservationEnvelope[];
  dueAt: string;
}

export interface NotifyRuntimeState {
  suppressedUntil?: string;
  pendingDebounce?: PendingDebounceState;
}

export interface StoredObservationEnvelope {
  monitor: MonitorDefinition;
  observation: Observation;
  observedAt: Date;
}

export interface ProcessObservationInput {
  monitor: MonitorDefinition;
  sourceName: string;
  observation: Observation;
  observedAt: Date;
  workspacePath?: string;
}

export interface PollingDecision {
  due: boolean;
  nextPollMs: number;
}

export interface RuntimeTickResult {
  evaluatedMonitors: string[];
  emittedEventIds: string[];
}

export interface NotifyDispatchResult {
  emitted: StoredObservationEnvelope[];
  nextState: NotifyRuntimeState;
}

export interface RuntimeStatus {
  sessions: number;
  activeSessions: number;
  dormantSessions: number;
  events: number;
}

/**
 * The outcome of evaluating a due monitor on a tick: `triggered` (≥1 observation
 * became an event), `suppressed` (observations were returned but none emitted —
 * throttled or held in a debounce batch), or `no-change` (the source returned
 * nothing).
 */
export type ObservationOutcome = 'triggered' | 'suppressed' | 'no-change';

export interface ObservationHistoryRecord {
  id: string;
  monitorId: string;
  sourceName: string;
  observationData: Record<string, unknown>;
  result: ObservationOutcome;
  createdAt: Date;
}

export interface ObservationHistoryQuery {
  monitorId?: string;
  limit?: number;
}

export interface ObservationCycleResult {
  observations: Observation[];
  nextState?: unknown;
}

export interface MonitorObservationResult {
  monitor: MonitorDefinition;
  sourceName: string;
  observations: Observation[];
  nextState?: unknown;
  observedAt: Date;
}

export interface MonitorSchedulingMetadata {
  monitor: MonitorDefinition;
  nextPollMs: number;
}

export function defaultNotifyConfigForUrgency(
  urgency: Urgency,
  notify?: NotifyConfig,
): NotifyConfig | undefined {
  if (notify) return notify;
  if (urgency === 'high') {
    return { strategy: 'debounce', 'settle-for': '15s' };
  }
  return undefined;
}
