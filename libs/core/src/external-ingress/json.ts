/**
 * Internal plain-data encoding for external-event identity and byte accounting.
 * This is independent of retained-retry envelopes and their typed Date leaf.
 *
 * Records may have Object.prototype or a null prototype. Arrays must have exactly
 * Array.prototype, dense enumerable data elements, and no own keys except their
 * indices and built-in data length. Frozen arrays are accepted; sparse, subclassed,
 * custom-prototype and typed arrays are rejected. A real array cannot have a length
 * accessor. All proxies (including revoked ones) are rejected before reflection,
 * so neither proxy traps, accessors nor custom toJSON hooks can run. Native Node
 * brand checks reject intrinsic state even after a built-in prototype is replaced;
 * prototype identity alone does not establish that a value is a data record.
 *
 * Only containers consume depth: the root container is at initialDepth, each child
 * container adds one, and maxDepth is inclusive. Scalars below the last permitted
 * container remain valid. For example, initialDepth=1/maxDepth=2 permits two nested
 * containers; initialDepth=0/maxDepth=0 permits one. Stringification starts at zero
 * with maxDepth=512, permitting 513 containers. Bounds must be nonnegative safe
 * integers with initialDepth <= maxDepth <= 512. Larger configurations are refused
 * before inspecting input, keeping recursive traversal within a supported bound.
 *
 * Numbers must be finite, and integer-valued numbers must be safe integers,
 * including numbers written with exponents (so 1e21 and -1.5e300 are refused).
 * Numeric and string bytes follow JSON.stringify for the accepted scalar domain;
 * negative zero encodes as 0. Lone surrogate code units use lowercase Unicode
 * escapes, preserving the original JavaScript string when parsed.
 *
 * Cycles are rejected, while shared acyclic children are encoded by value at each
 * occurrence. Members are validated and encoded in own-key order, stopping at the
 * first violation before examining later member descriptors or child values. Each
 * container requires one own-key enumeration; accepted object members are sorted
 * by UTF-16 key order only after encoding, preserving array order. Thus rejected
 * subtrees are never traversed, though key enumeration costs the container's width
 * and canonical sorting costs O(k log k) for k accepted object keys.
 */
import { types } from 'node:util';

/** Inclusive supported container depth, shared by validation and encoding. */
const MAX_SUPPORTED_DEPTH = 512;

/**
 * Native internal-slot predicates do not consult properties, prototypes or hooks.
 * Built-ins keep hidden state after prototype replacement; encoding them as records
 * would discard that state and create false equality with unrelated JSON values.
 * Arrays have their own brand and plain-array policy below, never the record path.
 */
function hasUnsupportedIntrinsicState(value: object): boolean {
  return (
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isMap(value) ||
    types.isSet(value) ||
    types.isWeakMap(value) ||
    types.isWeakSet(value) ||
    types.isBoxedPrimitive(value) ||
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isPromise(value) ||
    types.isNativeError(value) ||
    types.isMapIterator(value) ||
    types.isSetIterator(value) ||
    types.isGeneratorObject(value) ||
    types.isArgumentsObject(value) ||
    types.isModuleNamespaceObject(value) ||
    types.isKeyObject(value) ||
    types.isCryptoKey(value) ||
    types.isExternal(value)
  );
}

/** A plain-data JSON value; negative zero canonicalizes to zero. @internal */
export type ExternalJsonValue =
  | null
  | boolean
  | number
  | string
  | ExternalJsonValue[]
  | { [key: string]: ExternalJsonValue };

/** A string-keyed plain-data record, including null-prototype records. @internal */
export type ExternalJsonObject = Record<string, ExternalJsonValue>;

/** Encode one occurrence, tracking only ancestors so shared children remain valid. */
function encodeCanonical(
  value: unknown,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError('Invalid JSON number.');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || depth > maxDepth) {
    throw new TypeError('Non-JSON value or excessive nesting.');
  }
  // Descriptor and prototype inspection are safe only after excluding proxies.
  if (types.isProxy(value)) {
    throw new TypeError('Proxy JSON value.');
  }
  if (hasUnsupportedIntrinsicState(value)) {
    throw new TypeError('Intrinsic object state is not plain JSON data.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic JSON value.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Non-plain JSON array.');
      }
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length: unknown = lengthDescriptor?.value;
      if (
        !lengthDescriptor ||
        lengthDescriptor.enumerable ||
        !('value' in lengthDescriptor) ||
        typeof length !== 'number' ||
        ownKeys.length !== length + 1
      ) {
        throw new TypeError('Non-JSON array property.');
      }

      const encoded: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Sparse array or array accessor.');
        }
        encoded.push(
          encodeCanonical(descriptor.value, depth + 1, maxDepth, ancestors),
        );
      }
      return `[${encoded.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Non-plain JSON object.');
    }
    const entries: [string, string][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Non-JSON object key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('Accessor or hidden property.');
      }
      // Validate before sorting: an early invalid value must not inspect siblings.
      entries.push([
        key,
        encodeCanonical(descriptor.value, depth + 1, maxDepth, ancestors),
      ]);
    }
    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Assert that a value is JSON-safe at a caller-selected container depth.
 *
 * This internal boundary uses property descriptors so validation never invokes
 * caller-provided accessors. See the module's inclusive container-depth policy.
 * @internal
 */
export function assertExternalJsonValue(
  value: unknown,
  initialDepth: number,
  maxDepth: number,
): asserts value is ExternalJsonValue {
  if (
    !Number.isSafeInteger(initialDepth) ||
    !Number.isSafeInteger(maxDepth) ||
    initialDepth < 0 ||
    maxDepth < initialDepth ||
    maxDepth > MAX_SUPPORTED_DEPTH
  ) {
    throw new TypeError('Invalid JSON depth bounds.');
  }
  encodeCanonical(value, initialDepth, maxDepth, new Set());
}

/**
 * Deterministically encode an unknown JSON value.
 *
 * Object keys are sorted recursively. Array order is preserved. Values with
 * accessors, hidden or symbol properties, cycles, unsafe integers, non-finite
 * numbers, sparse arrays, or non-JSON prototypes are rejected.
 * Uses the module's zero-based inclusive depth bound of 512.
 * @internal
 */
export function canonicalJsonStringify(value: unknown): string {
  return encodeCanonical(value, 0, MAX_SUPPORTED_DEPTH, new Set());
}
