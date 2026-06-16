// Schema
export {
  monitorFrontmatterSchema,
  notifySchema,
  shapeSchema,
  payloadSchema,
} from './schema/monitor-schema.js';
export { validateScope } from './schema/validate-scope.js';
export type {
  MonitorFrontmatter,
  NotifyConfig,
  MonitorDefinition,
  Urgency,
  NotifyStrategy,
  BaselineStrategy,
} from './schema/types.js';
export type {
  PayloadForm,
  PayloadEncoding,
  ShapeConfig,
  PayloadConfig,
} from './schema/monitor-schema.js';

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
export {
  diffKeyedCollection,
  parseKeyedCollectionConfig,
  resolveDottedPath,
} from './observation/keyed-collection.js';
export type {
  KeyedCollectionConfig,
  KeyedCollectionResult,
  KeyedSnapshot,
} from './observation/keyed-collection.js';

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
export {
  buildTextDiff,
  fingerprintText,
  renderShapeArtifact,
} from './runtime/diff.js';
// Shape stage (G15): deterministic derived facts + render-then-diff
export {
  computeDerivedFacts,
  renderArtifact,
  validateCelPredicate,
} from './runtime/shape.js';
export type { DerivedFactRule, DerivedFact } from './runtime/shape.js';
export {
  applyPayloadTransform,
  validatePayloadTransform,
} from './runtime/transform.js';
export type {
  PayloadTransform,
  TransformLanguage,
  TransformOutcome,
} from './runtime/transform.js';
export { shapeObservation } from './runtime/shape-stage.js';
export type {
  ShapeStageConfig,
  ShapedObservation,
} from './runtime/shape-stage.js';
export type {
  AgentLifecycleEvent,
  AgentSessionRole,
  AgentSessionStatus,
  AgentSessionRecord,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DeliveryMode,
  ErroredObservation,
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
  PendingRollupState,
  RuntimeStatus,
  RuntimeTickResult,
  SessionEventFilter,
  SessionUnreadCounts,
  SessionHookState,
  SkippedMonitor,
  StoredObservationEnvelope,
  WatchHandle,
  UrgencyCounts,
} from './runtime/types.js';

// Adapters
export { claudeCodeAdapter } from './adapter/claude.js';
export type { AgentRuntimeAdapter } from './adapter/types.js';
