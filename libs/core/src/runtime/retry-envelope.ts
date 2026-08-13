import type { StoredObservationEnvelope } from './types.js';

/**
 * Raised when a retry envelope cannot be persisted and restored without
 * changing its data.
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

function assertJsonSafe(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail(path, 'non-finite numbers are unsupported.');
    return;
  }
  if (typeof value !== 'object')
    fail(path, `${typeof value} values are unsupported.`);
  if (value instanceof Date) {
    if (path !== '$.observedAt' || Number.isNaN(value.getTime()))
      fail(path, 'Date values are unsupported here.');
    return;
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
  if (!Object.hasOwn(envelope, 'observedAt'))
    fail('$.observedAt', 'a valid Date is required.');
  return JSON.stringify(envelope);
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
