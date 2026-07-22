// Schema
export {
  monitorFrontmatterSchema,
  notifySchema,
  shapeSchema,
  payloadSchema,
  // Backs the `BaselineStrategy` union below (`typeof baselineStrategyValues[number]`) —
  // exported alongside it so API Extractor can resolve the type without an
  // ae-forgotten-export warning in the checked-in API report.
  baselineStrategyValues,
} from './schema/monitor-schema.js';
export {
  validateScope,
  validateWatchScope,
  changeDetectionCollectionError,
  invalidTimezoneError,
  isValidIanaTimeZone,
} from './schema/validate-scope.js';
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

// Local-data permission model (issue #292): owner-only enforcement shared by
// core persistence and the CLI's socket/lock/coordination artifacts, so the
// thin CLI (AP6) does not invent its own permission logic.
export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  isErrnoException,
  restrictExistingPathMode,
  restrictSocketMode,
  withRestrictedUmask,
  writePrivateFileAtomic,
} from './security/local-permissions.js';
export type { WritePrivateFileAtomicOptions } from './security/local-permissions.js';

// Inbox
export { createDb } from './inbox/db.js';
export type { InboxDb } from './inbox/db.js';
export { InboxService } from './inbox/inbox-service.js';
// Backs the `InboxItemState` union below (`typeof inboxItemState[number]`) —
// exported alongside it so API Extractor can resolve the type without an
// ae-forgotten-export warning in the checked-in API report.
export { inboxItemState } from './inbox/schema.js';
export type {
  InboxItem,
  InboxItemState,
  InboxFilter,
  EnqueuePayload,
} from './inbox/types.js';

// Observation sources
export { SourceRegistry } from './observation/registry.js';
export { generateMonitorSchema } from './observation/schema-generator.js';
export { displayObjectKey } from './observation/display.js';
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
  parseOperationTimeoutMs,
  DEFAULT_OPERATION_TIMEOUT_MS,
  OPERATION_TIMEOUT_PATTERN,
  MAX_OPERATION_TIMEOUT_MS,
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
export {
  AgentMonitorRuntime,
  isVerifyScratchObjectKey,
} from './runtime/service.js';
export { RuntimeStore } from './runtime/store.js';
// Canonical runtime scheduling/notify default timings — the single source of
// truth the daemon schedules against, exported so timing-aware consumers (the
// CLI `verify` budget) reason from the real values instead of hand-mirrored copies.
export { schedulingDefaults } from './runtime/scheduling-defaults.js';
export {
  buildDiff,
  buildTextDiff,
  fingerprintText,
  renderShapeArtifact,
} from './runtime/diff.js';
export type { ChangeDetectionStrategy } from './runtime/diff.js';
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
// Hook-deliver debug diagnosis (issue #334): why `hook deliver` surfaced
// nothing at a given lifecycle — held by the settle window, or a coalesced
// normal/low reminder suppressed by an already-claimed / partially-claimed
// unread set. Read-only; never claims or mutates.
export {
  classifyReminderHold,
  classifySettleWindowHold,
} from './runtime/hook-delivery-diagnosis.js';
export type {
  HookDeliveryDiagnosis,
  HookDeliveryHold,
  HookDeliveryHoldReason,
} from './runtime/hook-delivery-diagnosis.js';
export type {
  AgentLifecycleEvent,
  AgentSessionRole,
  AgentSessionStatus,
  AgentSessionRecord,
  DeclareEphemeralMonitorInput,
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DeliveryMode,
  DeliveryReservation,
  DoctorDeliveryCounts,
  EphemeralMonitorRecord,
  EphemeralMonitorStatus,
  DoctorMonitorRollup,
  DoctorParseError,
  DoctorReportInput,
  ErroredObservation,
  EventQuery,
  InterpretDecision,
  MonitorDeliveryProjection,
  MonitorDeliveryState,
  MonitorDoctorReport,
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
  SessionObjectCursorRecord,
  SessionUnreadCounts,
  SessionHookState,
  SkippedMonitor,
  StoredObservationEnvelope,
  WatchHandle,
  UrgencyCounts,
} from './runtime/types.js';
export { defaultNotifyConfigForUrgency } from './runtime/types.js';

// Adapters
export { claudeCodeAdapter } from './adapter/claude.js';
export type { AgentRuntimeAdapter } from './adapter/types.js';
export { createClaudeInterpretAdapter } from './adapter/interpret.js';
export type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
  ClaudeInterpretAdapterOptions,
} from './adapter/interpret.js';
