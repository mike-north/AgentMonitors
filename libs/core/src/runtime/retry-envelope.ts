/**
 * Defines the retry outbox's supported plain-data domain. Validation rejects
 * detectable unsupported values without caller-defined reads or serialization
 * hooks. Callers must supply records, not objects with private intrinsic state;
 * only the observation timestamp has typed hydration semantics.
 */
import { types } from 'node:util';
import type { StoredObservationEnvelope } from './types.js';

/**
 * Raised for a detected violation of the retry envelope's supported plain-data
 * domain, before any member of its batch is persisted.
 *
 * @public
 */
export class MaterializationRetrySerializationError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'materialization_retry_serialization_failed';
  /** Path to the first value that cannot be represented as JSON. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(
      `Materialization retry envelope must be JSON-safe at ${path}: ${reason}`,
    );
    this.name = 'MaterializationRetrySerializationError';
    this.path = path;
  }
}

function fail(path: string, reason: string): never {
  throw new MaterializationRetrySerializationError(path, reason);
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Prototype identity does not establish that a value is an ordinary data record:
 * built-ins retain internal state when their prototypes are replaced. These
 * intrinsic checks reject the brands Node exposes without coercion or hooks.
 * Callers still own the plain-data precondition for undetectable private state.
 */
function hasUnsupportedIntrinsicState(value: object): boolean {
  return (
    types.isBoxedPrimitive(value) ||
    types.isMap(value) ||
    types.isSet(value) ||
    types.isWeakMap(value) ||
    types.isWeakSet(value) ||
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isRegExp(value) ||
    types.isNativeError(value) ||
    types.isPromise(value) ||
    types.isMapIterator(value) ||
    types.isSetIterator(value) ||
    types.isGeneratorObject(value) ||
    types.isArgumentsObject(value) ||
    types.isModuleNamespaceObject(value) ||
    types.isExternal(value)
  );
}

function assertJsonSafe(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail(path, 'non-finite numbers are unsupported.');
    if (Object.is(value, -0))
      fail(path, 'negative zero cannot round-trip through JSON.');
    return;
  }
  if (typeof value !== 'object')
    fail(path, `${typeof value} values are unsupported.`);
  // Proxies can present plain descriptors while changing reads or supplying
  // hidden toJSON hooks. Detect even revoked proxies before any reflection.
  if (types.isProxy(value)) fail(path, 'proxy values are unsupported.');
  // Brand checks must not walk the prototype chain: a non-proxy object can
  // inherit a proxy whose traps mutate its data during instanceof. Inspect
  // intrinsic brands and direct prototype identity only throughout validation.
  if (types.isDate(value)) {
    // Only the observation timestamp has a defined Date hydration contract.
    // Own properties and subclasses can customize serialization or carry data
    // JSON would discard; reject them without calling any caller-supplied hook.
    if (
      path !== '$.observedAt' ||
      Reflect.getPrototypeOf(value) !== Date.prototype ||
      Reflect.ownKeys(value).length !== 0
    ) {
      fail(path, 'only an unmodified observedAt Date is supported.');
    }
    let timestamp: number;
    try {
      timestamp = Date.prototype.getTime.call(value);
    } catch {
      fail(path, 'a real Date value is required.');
    }
    if (Number.isNaN(timestamp)) fail(path, 'an invalid Date is unsupported.');
    return;
  }
  if (hasUnsupportedIntrinsicState(value)) {
    fail(path, 'intrinsic object state is not plain JSON data.');
  }
  if (ancestors.has(value)) fail(path, 'cyclic references are unsupported.');

  const isArray = Array.isArray(value);
  const prototype = Reflect.getPrototypeOf(value);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    fail(path, `only plain ${isArray ? 'arrays' : 'objects'} are supported.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0)
    fail(path, 'symbol-keyed properties are unsupported.');

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (isArray) {
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      fail(path, 'array holes or extra properties are unsupported.');
    }
  }

  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length' && isArray) continue;
      const propertyPath = isArray ? `${path}[${key}]` : childPath(path, key);
      if (!descriptor.enumerable)
        fail(propertyPath, 'non-enumerable properties are unsupported.');
      if ('get' in descriptor || 'set' in descriptor)
        fail(propertyPath, 'accessor properties are unsupported.');
      assertJsonSafe(descriptor.value, propertyPath, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialize without invoking unvalidated accessors or custom `toJSON` hooks.
 * `observedAt` is the sole allowed Date and is restored on read.
 *
 * @internal
 */
export function serializeRetryEnvelope(
  envelope: StoredObservationEnvelope,
): string {
  assertJsonSafe(envelope, '$', new Set());
  const observedAt: unknown = Object.getOwnPropertyDescriptor(
    envelope,
    'observedAt',
  )?.value;
  if (!types.isDate(observedAt)) {
    fail('$.observedAt', 'a valid Date is required.');
  }
  // Do not let JSON.stringify select a Date serialization hook: persist the
  // already-validated instant explicitly, then restore that typed leaf on read.
  return JSON.stringify({
    ...envelope,
    observedAt: Date.prototype.toISOString.call(observedAt),
  });
}

/** Restore the one typed Date after reading a validated JSON envelope. @internal */
export function deserializeRetryEnvelope(
  serialized: string,
  recordId: string,
): StoredObservationEnvelope {
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const observedAt = new Date(String(parsed['observedAt']));
  if (Number.isNaN(observedAt.getTime()))
    throw new Error(
      `Retry outbox record ${recordId} has an invalid observedAt.`,
    );
  return { ...parsed, observedAt } as unknown as StoredObservationEnvelope;
}
