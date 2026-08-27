import { Buffer } from 'node:buffer';
import type { ChangeKind } from '../observation/types.js';
import { assertExternalJsonValue, canonicalJsonStringify } from './json.js';
import type { ExternalJsonObject } from './json.js';

export { canonicalJsonStringify } from './json.js';
export type { ExternalJsonObject, ExternalJsonValue } from './json.js';

/** Schema identifier for the first source-neutral external-event envelope. */
export const EXTERNAL_EVENT_SCHEMA = 'agentmonitors.external-event.v1' as const;

/** Immutable validation limits for {@link ExternalEventEnvelope}. */
export const externalEventLimits = Object.freeze({
  envelopeBytes: 256 * 1024,
  identifierBytes: 512,
  resumeTokenBytes: 2_048,
  scopeKeys: 32,
  scopeBytes: 32 * 1024,
  scopeKeyBytes: 64,
  scopeValuesPerKey: 16,
  scopeValueBytes: 512,
  stateDepth: 32,
} as const);

/** Scope keys reserved for metadata that Agent Monitors owns. */
export const externalEventReservedScopeKeys = Object.freeze([
  'ingressSource',
  'eventKind',
  'changeKind',
  'upstreamEventId',
  'objectSequence',
  'occurredAt',
] as const);

/** Source-defined routing dimensions containing bounded strings. */
export type ExternalEventScope = Record<string, string | string[]>;

/**
 * A validated current-state event from a source outside Agent Monitors.
 *
 * @example
 * ```ts
 * const event: ExternalEventEnvelope = {
 *   schema: 'agentmonitors.external-event.v1',
 *   monitorId: 'build-health',
 *   source: 'example-build-system',
 *   upstreamEventId: 'delivery-01HX',
 *   objectId: 'build-group-123',
 *   objectSequence: 42,
 *   eventKind: 'build.updated',
 *   changeKind: 'modified',
 *   occurredAt: '2026-08-13T18:00:00Z',
 *   resumeToken: 'opaque-source-cursor',
 *   scope: { project: 'example/widgets' },
 *   state: { status: 'passed' },
 * };
 * ```
 */
export interface ExternalEventEnvelope {
  /** Exact versioned schema identifier. */
  schema: typeof EXTERNAL_EVENT_SCHEMA;
  /** Local monitor definition that owns shaping, policy, and delivery. */
  monitorId: string;
  /** Stable producer or upstream system name. */
  source: string;
  /** Producer-assigned idempotency identifier within `source`. */
  upstreamEventId: string;
  /** Stable current-state object identity within `source`. */
  objectId: string;
  /** Non-negative sequence increasing within one `source` and `objectId`. */
  objectSequence: number;
  /** Source-defined semantic event label, such as `build.updated`. */
  eventKind: string;
  /** Existing Agent Monitors change-detection classification. */
  changeKind: ChangeKind;
  /** RFC 3339 timestamp at which the upstream state occurred. */
  occurredAt: string;
  /** Opaque relay cursor excluded from semantic idempotency hashing. */
  resumeToken: string;
  /** Bounded source-defined routing metadata; reserved keys are rejected. */
  scope: ExternalEventScope;
  /** Complete current observed state, never incremental instructions. */
  state: ExternalJsonObject;
}

/** Local routing context paired with one validated external envelope. */
export interface ExternalEventIngestInput {
  /** Canonical daemon-owned workspace identity used in the receipt key. */
  workspaceIdentity: string;
  /** Source-neutral current-state event to ingest. */
  envelope: ExternalEventEnvelope;
}

/** Whether an ingest created a receipt or replayed an existing receipt. */
export type ExternalEventDisposition =
  | /** A new event was durably accepted. */ 'accepted'
  | /** The same semantic event was already accepted. */ 'duplicate';

/** Durable processing state associated with an external-event receipt. */
export type ExternalEventOutcome =
  | /** One or more normal Agent Monitors events were committed. */ 'materialized'
  | /** A supported notify delay captured the event durably. */ 'held'
  | /** Local shaping policy deliberately produced no event. */ 'suppressed'
  | /** A newer object sequence had already been accepted. */ 'stale'
  | /** Deferred materialization exhausted automatic retries. */ 'failed';

/** Stable machine-readable failure classifications for relay policy. */
export type ExternalEventErrorCode =
  | /** No daemon could be reached. Retryable. */ 'daemon_unavailable'
  | /** The daemon does not implement this protocol. Retryable after upgrade. */ 'daemon_incompatible'
  | /** The daemon could not service the request yet. Retryable. */ 'daemon_busy'
  | /** Durable local storage failed. Retryable. */ 'storage_failure'
  | /** Bounded pending capacity is currently full. Retryable. */ 'capacity_exceeded'
  | /** An unclassified local failure occurred. Retryable. */ 'internal_error'
  | /** The envelope schema version is unsupported. Permanent. */ 'unsupported_schema'
  | /** The envelope violates the versioned schema. Permanent. */ 'invalid_envelope'
  | /** A byte or cardinality limit was exceeded. Permanent. */ 'payload_too_large'
  | /** The selected local monitor is absent or ambiguous. Permanent. */ 'invalid_monitor'
  | /** The selected monitor has invalid local policy. Permanent. */ 'monitor_policy_error'
  | /** The monitor uses a notify policy unsupported by this schema. Permanent. */ 'unsupported_notify_strategy'
  | /** Client and daemon workspace identities differ. Permanent. */ 'workspace_mismatch'
  | /** An idempotency key was reused for different semantic content. Permanent. */ 'idempotency_conflict';

/** A safe external-ingress failure that never includes envelope state. */
export interface ExternalEventError {
  /** Stable failure classification. */
  code: ExternalEventErrorCode;
  /** Human-readable guidance without private payload content. */
  message: string;
  /** Whether a relay may retry without changing the event. */
  retryable: boolean;
}

/**
 * Successful durable acknowledgement for one external ingest.
 *
 * @example
 * ```ts
 * const result: ExternalEventIngestResult = {
 *   disposition: 'accepted', outcome: 'held', receiptId: '01HX...',
 *   monitorId: 'build-health', upstreamEventId: 'delivery-01HX',
 *   eventIds: [], acceptedAt: '2026-08-13T18:00:01Z',
 *   materializedAt: null,
 * };
 * ```
 */
/** Structured runtime/transport error for one external-ingress attempt. */
export class ExternalEventIngestError extends Error {
  constructor(
    readonly code: ExternalEventErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExternalEventIngestError';
  }

  toExternalEventError(): ExternalEventError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
export interface ExternalEventIngestResult {
  /** Whether this call accepted new work or found a duplicate. */
  disposition: ExternalEventDisposition;
  /** Current durable processing state of the receipt. */
  outcome: ExternalEventOutcome;
  /** Agent Monitors' stable identifier for status and retry operations. */
  receiptId: string;
  /** Local monitor that owns the accepted event. */
  monitorId: string;
  /** Producer-assigned identifier echoed for safe correlation. */
  upstreamEventId: string;
  /** Materialized Agent Monitors event IDs, empty until materialization. */
  eventIds: string[];
  /** Local durable receipt timestamp serialized as RFC 3339. */
  acceptedAt: string;
  /** Local materialization timestamp, or `null` before materialization. */
  materializedAt: string | null;
}

/** Result of validating and canonicalizing an unknown envelope value. */
export type ExternalEventEnvelopeValidationResult =
  | {
      /** Indicates that the normalized envelope fields are available. */
      success: true;
      /** Plain, canonical-key-order-independent validated envelope. */
      envelope: ExternalEventEnvelope;
      /** Recursively canonical JSON used for exact byte accounting. */
      canonicalJson: string;
      /** UTF-8 byte length of `canonicalJson`. */
      envelopeBytes: number;
    }
  | {
      /** Indicates that validation failed without throwing. */
      success: false;
      /** Safe permanent validation error. */
      error: ExternalEventError;
    };

const TOP_LEVEL_KEYS = new Set<string>([
  'schema',
  'monitorId',
  'source',
  'upstreamEventId',
  'objectId',
  'objectSequence',
  'eventKind',
  'changeKind',
  'occurredAt',
  'resumeToken',
  'scope',
  'state',
]);
const IDENTIFIER_FIELDS = [
  'monitorId',
  'source',
  'upstreamEventId',
  'objectId',
  'eventKind',
] as const;
const CHANGE_KINDS = new Set<ChangeKind>([
  'created',
  'modified',
  'deleted',
  'descoped',
]);
const RESERVED_SCOPE_KEYS = new Set<string>(externalEventReservedScopeKeys);
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function failure(
  code: 'unsupported_schema' | 'invalid_envelope' | 'payload_too_large',
  message: string,
): ExternalEventEnvelopeValidationResult {
  return { success: false, error: { code, message, retryable: false } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isValidRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const calendarTimeIsValid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
  if (!calendarTimeIsValid) return false;
  if (second < 60) return true;

  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetMilliseconds =
    offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 59, 0);
  const boundary = new Date(local.getTime() - offsetMilliseconds + 1_000);
  return (
    boundary.getUTCHours() === 0 &&
    boundary.getUTCMinutes() === 0 &&
    boundary.getUTCSeconds() === 0 &&
    boundary.getUTCDate() === 1 &&
    (boundary.getUTCMonth() === 0 || boundary.getUTCMonth() === 6)
  );
}

/** Validate and normalize one versioned source-neutral external event envelope. */
export function validateExternalEventEnvelope(
  input: unknown,
): ExternalEventEnvelopeValidationResult {
  if (!isPlainRecord(input)) {
    return failure('invalid_envelope', 'Event envelope must be a JSON object.');
  }
  let canonicalJson: string;
  try {
    assertExternalJsonValue(input, 0, externalEventLimits.stateDepth + 2);
    canonicalJson = canonicalJsonStringify(input);
  } catch {
    return failure(
      'invalid_envelope',
      'Event envelope contains a non-JSON value or excessive nesting.',
    );
  }
  const candidate = JSON.parse(canonicalJson) as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== TOP_LEVEL_KEYS.size ||
    Object.keys(candidate).some((key) => !TOP_LEVEL_KEYS.has(key))
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope must contain exactly the version 1 top-level fields.',
    );
  }
  if (typeof candidate['schema'] !== 'string') {
    return failure('invalid_envelope', 'Event envelope schema is required.');
  }
  if (candidate['schema'] !== EXTERNAL_EVENT_SCHEMA) {
    return failure(
      'unsupported_schema',
      'External event schema is not supported.',
    );
  }
  for (const field of IDENTIFIER_FIELDS) {
    const value = candidate[field];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      utf8Bytes(value) > externalEventLimits.identifierBytes
    ) {
      return failure(
        'invalid_envelope',
        `Event envelope field "${field}" is invalid.`,
      );
    }
  }
  if (
    !Number.isSafeInteger(candidate['objectSequence']) ||
    (candidate['objectSequence'] as number) < 0
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope field "objectSequence" must be a non-negative safe integer.',
    );
  }
  if (!CHANGE_KINDS.has(candidate['changeKind'] as ChangeKind)) {
    return failure(
      'invalid_envelope',
      'Event envelope field "changeKind" is invalid.',
    );
  }
  if (
    typeof candidate['occurredAt'] !== 'string' ||
    !isValidRfc3339(candidate['occurredAt'])
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope field "occurredAt" must be an RFC3339 timestamp.',
    );
  }
  if (
    typeof candidate['resumeToken'] !== 'string' ||
    candidate['resumeToken'].length === 0 ||
    utf8Bytes(candidate['resumeToken']) > externalEventLimits.resumeTokenBytes
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope field "resumeToken" is invalid.',
    );
  }

  const scope = candidate['scope'];
  if (
    !isPlainRecord(scope) ||
    Object.keys(scope).length > externalEventLimits.scopeKeys
  ) {
    return failure('invalid_envelope', 'Event envelope scope is invalid.');
  }
  for (const [key, value] of Object.entries(scope)) {
    if (
      key.length === 0 ||
      utf8Bytes(key) > externalEventLimits.scopeKeyBytes ||
      RESERVED_SCOPE_KEYS.has(key)
    ) {
      return failure(
        'invalid_envelope',
        'Event envelope scope key is invalid.',
      );
    }
    const values = Array.isArray(value) ? value : [value];
    if (
      values.length > externalEventLimits.scopeValuesPerKey ||
      values.some(
        (item) =>
          typeof item !== 'string' ||
          utf8Bytes(item) > externalEventLimits.scopeValueBytes,
      )
    ) {
      return failure(
        'invalid_envelope',
        'Event envelope scope value is invalid.',
      );
    }
  }
  const canonicalScope = canonicalJsonStringify(scope as ExternalJsonObject);
  if (utf8Bytes(canonicalScope) > externalEventLimits.scopeBytes) {
    return failure('payload_too_large', 'Event envelope scope is too large.');
  }

  const state = candidate['state'];
  if (!isPlainRecord(state)) {
    return failure(
      'invalid_envelope',
      'Event envelope state must be a JSON object.',
    );
  }
  try {
    assertExternalJsonValue(state, 1, externalEventLimits.stateDepth);
  } catch {
    return failure(
      'invalid_envelope',
      'Event envelope state contains a non-JSON value or excessive nesting.',
    );
  }

  const envelopeBytes = utf8Bytes(canonicalJson);
  if (envelopeBytes > externalEventLimits.envelopeBytes) {
    return failure('payload_too_large', 'Event envelope is too large.');
  }
  return {
    success: true,
    envelope: candidate as unknown as ExternalEventEnvelope,
    canonicalJson,
    envelopeBytes,
  };
}
