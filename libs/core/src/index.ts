// Schema
export {
  monitorFrontmatterSchema,
  notifySchema,
} from './schema/monitor-schema.js';
export { validateScope } from './schema/validate-scope.js';
export type {
  MonitorFrontmatter,
  NotifyConfig,
  MonitorDefinition,
  Urgency,
  NotifyStrategy,
} from './schema/types.js';

// Parser
export { parseMonitor, parseMonitorFile } from './parser/parse-monitor.js';
export type {
  ParseResult,
  ParseError,
  ParseOutcome,
} from './parser/parse-monitor.js';
export { scanMonitors } from './parser/scan-monitors.js';
export type { ScanResult, DuplicateMonitorId } from './parser/scan-monitors.js';

// Inbox
export { createDb } from './inbox/db.js';
export type { InboxDb } from './inbox/db.js';
export { InboxService } from './inbox/inbox-service.js';
export type {
  InboxItem,
  InboxItemState,
  InboxFilter,
  EnqueuePayload,
} from './inbox/types.js';

// Observation sources
export { SourceRegistry } from './observation/registry.js';
export { generateMonitorSchema } from './observation/schema-generator.js';
export type {
  ChangeKind,
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from './observation/types.js';

// Notification
export {
  parseDuration,
  createImmediateNotifier,
  createDebounceNotifier,
  createThrottleNotifier,
} from './notify/notifier.js';
export type { Notifier, NotifyCallback } from './notify/types.js';

// Hook bridge
export {
  computeHookState,
  writeBridgeState,
  readBridgeState,
  createBridgeCallback,
} from './hook-bridge/bridge.js';
export type { HookState, UrgentItem } from './hook-bridge/types.js';

// Runtime
export { AgentMonitorRuntime } from './runtime/service.js';
export { RuntimeStore } from './runtime/store.js';
export { buildTextDiff, fingerprintText } from './runtime/diff.js';
export type {
  AgentLifecycleEvent,
  AgentSessionRole,
  AgentSessionStatus,
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DeliveryMode,
  EventQuery,
  MonitorDeliveryProjection,
  MonitorDeliveryState,
  MonitorEventRecord,
  MonitorExplainInput,
  MonitorExplainReport,
  MonitorExplainStage,
  MonitorExplainStageId,
  MonitorExplainStageStatus,
  MonitorRuntimeState,
  NotifyRuntimeState,
  ObservationHistoryQuery,
  ObservationHistoryRecord,
  ObservationOutcome,
  OpenSessionInput,
  PendingDebounceState,
  RuntimeStatus,
  RuntimeTickResult,
  SessionEventFilter,
  SessionUnreadCounts,
  SessionHookState,
  StoredObservationEnvelope,
  WatchHandle,
  UrgencyCounts,
} from './runtime/types.js';

// Adapters
export { claudeCodeAdapter } from './adapter/claude.js';
export type { AgentRuntimeAdapter } from './adapter/types.js';
