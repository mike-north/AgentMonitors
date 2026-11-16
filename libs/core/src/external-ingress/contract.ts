/**
 * Versioned source-neutral envelope admission. Producer data can describe state
 * and routing dimensions; local monitor definitions retain all delivery policy.
 * Resource admission precedes canonical JSON validation and normalization.
 * @public
 */
/* Admission uses indexed own-data traversal instead of mutable iterator protocols. */
/* eslint-disable @typescript-eslint/prefer-for-of */
import { Buffer } from 'node:buffer';
import { types } from 'node:util';
import { canonicalJsonStringify } from './json.js';
import { isEnvelopeLimitError, envelopeJsonBytes } from './envelope-budget.js';
import type { ExternalJsonObject } from './json.js';

export { canonicalJsonStringify } from './json.js';
export type { ExternalJsonObject, ExternalJsonValue } from './json.js';

/** Captured intrinsics keep resource and semantic admission independent of later replacements. */
const apply = Reflect.apply;
const keysOf = Object.keys;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const isSafeInteger = Number.isSafeInteger;
const numberFrom = Number;
const parseJson = JSON.parse;
const NativeDate = Date;
/* Receivers are supplied explicitly; no mutable call/apply method is used. */
/* eslint-disable @typescript-eslint/unbound-method */
const byteLength = Buffer.byteLength;
const setHas = Set.prototype.has;
const regexpExec = RegExp.prototype.exec;
const setUTCFullYear = Date.prototype.setUTCFullYear;
const setUTCHours = Date.prototype.setUTCHours;
const getTime = Date.prototype.getTime;
const getUTCHours = Date.prototype.getUTCHours;
const getUTCMinutes = Date.prototype.getUTCMinutes;
const getUTCSeconds = Date.prototype.getUTCSeconds;
const getUTCDate = Date.prototype.getUTCDate;
/* eslint-enable @typescript-eslint/unbound-method */

/** Schema identifier for the first source-neutral external-event envelope. @public */
export const EXTERNAL_EVENT_SCHEMA = 'agentmonitors.external-event.v1' as const;

/**
 * Immutable semantic-envelope limits for {@link ExternalEventEnvelope}.
 * The daemon's 1 MiB transport budget also covers unrelated control requests;
 * this 256 KiB bound counts canonical envelope bytes independently of framing.
 * Importing CLI admission policy here would invert the core/host dependency.
 * @public
 */
export const externalEventLimits = Object.freeze({
  /** Maximum canonical envelope size in UTF-8 bytes (256 KiB). */
  envelopeBytes: 262_144,
  /** Maximum UTF-8 bytes for each producer or routing identifier. */
  identifierBytes: 512,
  /** Maximum UTF-8 bytes in the opaque relay cursor. */
  resumeTokenBytes: 2_048,
  /** Maximum number of source-defined routing dimensions. */
  scopeKeys: 32,
  /** Maximum canonical routing metadata size in UTF-8 bytes (32 KiB). */
  scopeBytes: 32_768,
  /** Maximum UTF-8 bytes in one routing dimension name. */
  scopeKeyBytes: 64,
  /** Maximum alternatives for one routing dimension. */
  scopeValuesPerKey: 16,
  /** Maximum UTF-8 bytes in each routing dimension value. */
  scopeValueBytes: 512,
  /** Maximum state container levels, counting the state root as level one. */
  stateDepth: 32,
} as const);

/** Scope keys reserved for metadata that Agent Monitors owns. @public */
export const externalEventReservedScopeKeys = Object.freeze([
  'ingressSource',
  'eventKind',
  'changeKind',
  'upstreamEventId',
  'objectSequence',
  'occurredAt',
] as const);

/** Source-defined routing dimensions containing bounded strings. @public */
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
 * @public
 */
// A closed alias composes with the JSON value index signature; interfaces can be augmented.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ExternalEventEnvelope = {
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
  /** Frozen v1 lifecycle classification, intentionally matching current observation kinds. */
  changeKind: 'created' | 'modified' | 'deleted' | 'descoped';
  /** RFC 3339 timestamp at which the upstream state occurred. */
  occurredAt: string;
  /** Opaque relay cursor excluded from semantic idempotency hashing. */
  resumeToken: string;
  /** Bounded source-defined routing metadata; reserved keys are rejected. */
  scope: ExternalEventScope;
  /** Complete current observed state, never incremental instructions. */
  state: ExternalJsonObject;
};

/** Local routing context paired with one validated external envelope. @internal */
export interface ExternalEventIngestInput {
  /** Canonical daemon-owned workspace identity used in the receipt key. */
  workspaceIdentity: string;
  /** Source-neutral current-state event to ingest. */
  envelope: ExternalEventEnvelope;
}

/** Whether an ingest created a receipt or replayed an existing receipt. @internal */
export type ExternalEventDisposition =
  | /** A new event was durably accepted. */ 'accepted'
  | /** The same semantic event was already accepted. */ 'duplicate';

/** Durable processing state associated with an external-event receipt. @internal */
export type ExternalEventOutcome =
  | /** One or more normal Agent Monitors events were committed. */ 'materialized'
  | /** A supported notify delay captured the event durably. */ 'held'
  | /** Local shaping policy deliberately produced no event. */ 'suppressed'
  | /** A newer object sequence had already been accepted. */ 'stale'
  | /** Deferred materialization exhausted automatic retries. */ 'failed';

/** Implemented envelope-admission failures; `retryable` carries retry policy. @public */
export type ExternalEventErrorCode =
  | /** The envelope schema version is unsupported. */ 'unsupported_schema'
  | /** The envelope violates the versioned schema. */ 'invalid_envelope'
  | /** A byte, cardinality or container-depth limit was exceeded. */ 'payload_too_large';

/** A safe external-ingress failure that never includes envelope state. @public */
export interface ExternalEventError {
  /** Stable failure classification. */
  code: ExternalEventErrorCode;
  /** Human-readable guidance without private payload content. */
  message: string;
  /** Sole retry-policy signal; envelope validation always returns `false`. */
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
 * @internal
 */
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

/** Result of validating and canonicalizing an unknown envelope value. @public */
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

/** Producer fields exclude local filesystem identities and monitor policy. */
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
] as const satisfies readonly (keyof ExternalEventEnvelope)[]);
/** The complete schema cardinality is captured before its Set prototype can change. */
const TOP_LEVEL_KEY_COUNT = TOP_LEVEL_KEYS.size;
/** Producer identities share a UTF-8 bound independently of their character count. */
const IDENTIFIER_FIELDS = [
  'monitorId',
  'source',
  'upstreamEventId',
  'objectId',
  'eventKind',
] as const;
/**
 * The exhaustive record binds validation to the closed v1 field type without
 * exposing an internal tuple in the package declaration rollup. Internal
 * observation classifications can evolve without widening this wire schema.
 */
const CHANGE_KINDS = new Set<string>(
  keysOf({
    created: true,
    modified: true,
    deleted: true,
    descoped: true,
  } satisfies Record<ExternalEventEnvelope['changeKind'], true>),
);
/** Runtime provenance cannot be overwritten by producer routing dimensions. */
const RESERVED_SCOPE_KEYS = new Set<string>(externalEventReservedScopeKeys);
/** Timestamp syntax is checked separately from calendar and leap-second validity. */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** Failures expose a fixed diagnostic and never include producer state. */
function failure(
  code: 'unsupported_schema' | 'invalid_envelope' | 'payload_too_large',
  message: string,
): ExternalEventEnvelopeValidationResult {
  return { success: false, error: { code, message, retryable: false } };
}

/** Reject proxies before reflection; accepted records carry only ordinary data. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    isProxy(value) ||
    isArray(value)
  ) {
    return false;
  }
  try {
    const prototype = getPrototypeOf(value) as unknown;
    return prototype === objectPrototype || prototype === null;
  } catch {
    return false;
  }
}

/** UTF-16 length is a cheap lower bound that avoids flattening an already oversized rope. */
function exceedsUtf8Bytes(value: string, limit: number): boolean {
  return (
    value.length > limit || apply(byteLength, Buffer, [value, 'utf8']) > limit
  );
}

/** Permit RFC 3339 variants while refusing impossible dates and leap boundaries. */
function isValidRfc3339(value: string): boolean {
  const match = apply(regexpExec, RFC3339, [value]);
  if (!match) return false;
  const year = numberFrom(match[1]);
  const month = numberFrom(match[2]);
  const day = numberFrom(match[3]);
  const hour = numberFrom(match[4]);
  const minute = numberFrom(match[5]);
  const second = numberFrom(match[6]);
  const offsetHour = match[8] === undefined ? 0 : numberFrom(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : numberFrom(match[9]);
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
  const local = new NativeDate(0);
  apply(setUTCFullYear, local, [year, month - 1, day]);
  apply(setUTCHours, local, [hour, minute, 59, 0]);
  const boundary = new NativeDate(
    apply(getTime, local, []) - offsetMilliseconds + 1_000,
  );
  return (
    apply(getUTCHours, boundary, []) === 0 &&
    apply(getUTCMinutes, boundary, []) === 0 &&
    apply(getUTCSeconds, boundary, []) === 0 &&
    apply(getUTCDate, boundary, []) === 1
  );
}

/**
 * Refuse the legacy prototype-setter key in normalized producer metadata/state.
 * Only fresh JSON.parse output reaches this walk: user accessors and proxies have
 * already been refused, and descriptor reads never consult inherited members.
 * General JSON encoding retains ordinary own keys; this is an envelope safety
 * boundary for downstream consumers that may copy producer-owned state.
 */
function containsPrototypeKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const keys = keysOf(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === '__proto__') {
      return true;
    }
    if (key !== undefined) {
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (
        descriptor &&
        hasOwn(descriptor, 'value') &&
        containsPrototypeKey(descriptor.value)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate and normalize one versioned source-neutral external event envelope.
 *
 * @example
 * ```ts
 * const result = validateExternalEventEnvelope(parsedJson);
 * if (result.success) {
 *   const identity = externalEventSemanticHash(result.envelope);
 *   console.log(identity, result.envelopeBytes);
 * } else {
 *   console.error(result.error.code, result.error.retryable);
 * }
 * ```
 * @public
 */
export function validateExternalEventEnvelope(
  input: unknown,
): ExternalEventEnvelopeValidationResult {
  if (!isPlainRecord(input)) {
    return failure('invalid_envelope', 'Event envelope must be a JSON object.');
  }
  // Resource admission must finish before any canonical encoding or parsing.
  try {
    envelopeJsonBytes(
      input,
      externalEventLimits.envelopeBytes,
      0,
      externalEventLimits.stateDepth,
    );
  } catch (error) {
    return isEnvelopeLimitError(error)
      ? failure(
          'payload_too_large',
          'Event envelope exceeds a size or nesting limit.',
        )
      : failure(
          'invalid_envelope',
          'Event envelope contains a non-JSON value.',
        );
  }
  // The preflight has refused accessors and proxies before these data reads.
  const candidate = input;
  const candidateKeys = keysOf(candidate);
  let validFields = candidateKeys.length === TOP_LEVEL_KEY_COUNT;
  for (let index = 0; index < candidateKeys.length; index += 1) {
    if (!apply(setHas, TOP_LEVEL_KEYS, [candidateKeys[index]])) {
      validFields = false;
    }
  }
  if (!validFields) {
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
  for (let index = 0; index < IDENTIFIER_FIELDS.length; index += 1) {
    const field = IDENTIFIER_FIELDS[index];
    if (field === undefined) {
      continue;
    }
    const value = candidate[field];
    if (typeof value !== 'string' || value.length === 0) {
      return failure(
        'invalid_envelope',
        `Event envelope field "${field}" is invalid.`,
      );
    }
    if (exceedsUtf8Bytes(value, externalEventLimits.identifierBytes)) {
      return failure(
        'payload_too_large',
        `Event envelope field "${field}" is too large.`,
      );
    }
  }
  if (
    !isSafeInteger(candidate['objectSequence']) ||
    (candidate['objectSequence'] as number) < 0
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope field "objectSequence" must be a non-negative safe integer.',
    );
  }
  if (!apply(setHas, CHANGE_KINDS, [candidate['changeKind']])) {
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
    candidate['resumeToken'].length === 0
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope field "resumeToken" is invalid.',
    );
  }

  if (
    exceedsUtf8Bytes(
      candidate['resumeToken'],
      externalEventLimits.resumeTokenBytes,
    )
  ) {
    return failure(
      'payload_too_large',
      'Event envelope resume token is too large.',
    );
  }

  const scope = candidate['scope'];
  if (!isPlainRecord(scope)) {
    return failure('invalid_envelope', 'Event envelope scope is invalid.');
  }
  const scopeKeys = keysOf(scope);
  if (scopeKeys.length > externalEventLimits.scopeKeys) {
    return failure(
      'payload_too_large',
      'Event envelope has too many scope keys.',
    );
  }
  for (let index = 0; index < scopeKeys.length; index += 1) {
    const key = scopeKeys[index];
    if (key === undefined) {
      continue;
    }
    const value = scope[key];
    if (key.length === 0 || apply(setHas, RESERVED_SCOPE_KEYS, [key])) {
      return failure(
        'invalid_envelope',
        'Event envelope scope key is invalid.',
      );
    }
    if (exceedsUtf8Bytes(key, externalEventLimits.scopeKeyBytes)) {
      return failure(
        'payload_too_large',
        'Event envelope scope key is too large.',
      );
    }
    const values: unknown[] = isArray(value) ? value : [value];
    if (values.length > externalEventLimits.scopeValuesPerKey) {
      return failure(
        'payload_too_large',
        'Event envelope has too many scope values.',
      );
    }
    for (let index = 0; index < values.length; index += 1) {
      // Missing array elements remain invalid even when a prototype supplies a getter.
      const descriptor = getOwnPropertyDescriptor(values, index);
      const item: unknown =
        descriptor && hasOwn(descriptor, 'value')
          ? descriptor.value
          : undefined;
      if (typeof item !== 'string') {
        return failure(
          'invalid_envelope',
          'Event envelope scope value is invalid.',
        );
      }
      if (exceedsUtf8Bytes(item, externalEventLimits.scopeValueBytes)) {
        return failure(
          'payload_too_large',
          'Event envelope scope value is too large.',
        );
      }
    }
  }
  try {
    envelopeJsonBytes(
      scope,
      externalEventLimits.scopeBytes,
      0,
      externalEventLimits.stateDepth,
    );
  } catch (error) {
    return isEnvelopeLimitError(error)
      ? failure('payload_too_large', 'Event envelope scope is too large.')
      : failure('invalid_envelope', 'Event envelope scope is invalid.');
  }

  const state = candidate['state'];
  if (!isPlainRecord(state)) {
    return failure(
      'invalid_envelope',
      'Event envelope state must be a JSON object.',
    );
  }
  let canonicalJson: string;
  try {
    // json.ts remains the authority for arrays, hidden state, numbers and prototypes.
    canonicalJson = canonicalJsonStringify(candidate);
  } catch {
    return failure(
      'invalid_envelope',
      'Event envelope contains a non-JSON value.',
    );
  }
  // Verify the produced bytes independently: a counting defect must never admit an overrun.
  const envelopeBytes: number = apply(byteLength, Buffer, [
    canonicalJson,
    'utf8',
  ]);
  if (envelopeBytes > externalEventLimits.envelopeBytes) {
    return failure('payload_too_large', 'Event envelope is too large.');
  }
  // Resource, JSON-domain and complete field checks above establish this shape;
  // parsing fresh canonical bytes removes caller-owned references and descriptors.
  const normalized = parseJson(canonicalJson) as ExternalEventEnvelope;
  if (
    containsPrototypeKey(normalized.scope) ||
    containsPrototypeKey(normalized.state)
  ) {
    return failure(
      'invalid_envelope',
      'Event envelope contains an unsafe object key.',
    );
  }
  return {
    success: true,
    envelope: normalized,
    canonicalJson,
    envelopeBytes,
  };
}
