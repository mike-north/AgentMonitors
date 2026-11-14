/**
 * Internal plain-data encoding for external-event identity and byte accounting.
 * This is independent of retained-retry envelopes and their typed Date leaf.
 *
 * Records may have Object.prototype or a null prototype. Arrays must have exactly
 * Array.prototype, dense enumerable data elements, and no own keys except their
 * indices and built-in data length. Frozen arrays are accepted; sparse, subclassed,
 * custom-prototype and typed arrays are rejected. A real array cannot have a length
 * accessor. All proxies (including revoked ones) are rejected before reflection,
 * so neither proxy traps, accessors nor custom toJSON hooks can run. Native slot
 * tests and captured read-only intrinsic methods refuse detectable hidden state
 * after prototype replacement, including keys, Headers and Intl Segments.
 *
 * The input domain is primitives, ordinary/null-prototype records and dense
 * ordinary arrays. The tested refusal list and each check are specified in
 * docs/specs/002-runtime-delivery.md §16. Other objects whose state is not their
 * own enumerable data are outside this domain; callers MUST NOT pass them and
 * detection is not promised. Non-exhaustive tested examples include array,
 * string and RegExp-string iterators, iterator helpers/wrappers, SegmentIterator,
 * FormData, Request, Response and AbortController. Probes are captured at module
 * load and assume unmodified runtime built-ins, including Object.prototype.
 *
 * First-violation order: bounds/scalar checks, proxy refusal, exact prototype,
 * native/read-only intrinsic brands, ancestor cycles, then own keys/descriptors
 * and child values in own-key order (array length/indices for arrays). Record
 * crypto predicates run only after all own descriptors and children pass, then
 * canonical key sorting. On older Node they read symbols, so the earlier gates
 * are required to exclude caller hooks. Child traversal still stops immediately
 * on its first invalid member, before later sibling descriptors are inspected.
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
import { inspect, types } from 'node:util';

/** Inclusive supported container depth, shared by validation and encoding. */
const MAX_SUPPORTED_DEPTH = 512;

/**
 * Captured native slot tests do not read receiver properties. Node's
 * internal/util/types.js forwards these to internalBinding('types') and
 * src/node_types.cc's V8 Value::Is* tests; isArrayBufferView uses ArrayBuffer.isView.
 */
const nativeStatePredicates = [
  types.isDate,
  types.isRegExp,
  types.isMap,
  types.isSet,
  types.isWeakMap,
  types.isWeakSet,
  types.isBoxedPrimitive,
  types.isAnyArrayBuffer,
  types.isArrayBufferView,
  types.isPromise,
  types.isNativeError,
  types.isMapIterator,
  types.isSetIterator,
  types.isGeneratorObject,
  types.isArgumentsObject,
  types.isModuleNamespaceObject,
  types.isExternal,
] as const;

/** Proxies must be excluded before any reflection, including prototype lookup. */
const isProxy = types.isProxy;

/**
 * On older Node 24 these wrappers read kKeyType/kKeyObject symbol properties;
 * newer Node 24 uses private/native brands (internal/crypto/keys.js). They are
 * safe only after exact record prototypes and every own descriptor are checked:
 * no own symbols/accessors remain, and Object.prototype was trusted at capture.
 */
const { isKeyObject, isCryptoKey } = types;

/** Native hidden-state predicates are independent of visible prototype identity. */
function hasUnsupportedIntrinsicState(value: object): boolean {
  return nativeStatePredicates.some((predicate) => predicate(value));
}

/** Validate each captured callable once; invocation always supplies its receiver. */
function captureIntrinsicProbe(
  method: unknown,
  args: readonly unknown[] = [],
): (value: object) => unknown {
  if (typeof method !== 'function') {
    throw new TypeError('Missing intrinsic state probe.');
  }
  return (value) => {
    const result: unknown = Reflect.apply(method, value, args);
    return result;
  };
}

/**
 * Read runtime Intl descriptors because Node 24 has families newer than the
 * compiler's ambient library. No receiver or caller-owned property is consulted.
 */
function captureIntlProbe(
  family: string,
  method = 'resolvedOptions',
  args: readonly unknown[] = [],
): (value: object) => unknown {
  const constructor: unknown = Object.getOwnPropertyDescriptor(
    Intl,
    family,
  )?.value;
  if (typeof constructor !== 'function') {
    throw new TypeError('Missing Intl constructor.');
  }
  const prototype: unknown = Object.getOwnPropertyDescriptor(
    constructor,
    'prototype',
  )?.value;
  if (typeof prototype !== 'object' || prototype === null) {
    throw new TypeError('Missing Intl prototype.');
  }
  return captureIntrinsicProbe(
    Object.getOwnPropertyDescriptor(prototype, method)?.value,
    args,
  );
}

/**
 * Undici's Headers inspector enters private fields directly. A fresh
 * null-prototype options record prevents inherited option hooks; depth -1 and
 * customInspect:false keep inspection confined to the temporary header record.
 * Only the inspector's temporary presentation records/options can be changed.
 * FormData inspects stored array methods and can mutate stored values;
 * Request/Response inspectors read receiver properties. Those are unsuitable.
 */
function captureHeadersProbe(): (value: object) => unknown {
  const method: unknown = Object.getOwnPropertyDescriptor(
    Headers.prototype,
    inspect.custom,
  )?.value;
  if (typeof method !== 'function') {
    throw new TypeError('Missing intrinsic inspector.');
  }
  return (value) => {
    const result: unknown = Reflect.apply(method, value, [
      -1,
      {
        __proto__: null,
        depth: -1,
        customInspect: false,
        colors: false,
      },
    ]);
    return result;
  };
}

/**
 * Captured methods test internal slots without property/prototype consultation.
 * Node 24 internal/url.js: protocol reads only #context and size reads only
 * #searchParams; href would synchronize pending query state and is unsuitable.
 * V8 WeakRefDeref/FinalizationRegistryUnregister check their native receivers;
 * deref preserves the receiver (keeping its target alive for this job), and a fresh
 * unregister token cannot remove an existing registration. builtins-intl.cc and
 * builtins-intl-gen.cc require each Intl receiver's own internal brand. For the
 * legacy DateTimeFormat/NumberFormat constructors, formatToParts with scalar zero
 * avoids resolvedOptions' legacy unwrapping/property lookup. Other resolvedOptions
 * methods and Locale.toString only read settings, without invoking caller hooks.
 */
const readOnlyIntrinsicProbes = [
  captureIntrinsicProbe(
    Object.getOwnPropertyDescriptor(WeakRef.prototype, 'deref')?.value,
  ),
  captureIntrinsicProbe(
    Object.getOwnPropertyDescriptor(
      FinalizationRegistry.prototype,
      'unregister',
    )?.value,
    [{}],
  ),
  captureIntrinsicProbe(
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured getter receives the candidate through Reflect.apply.
    Object.getOwnPropertyDescriptor(URL.prototype, 'protocol')?.get,
  ),
  captureIntrinsicProbe(
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured getter receives the candidate through Reflect.apply.
    Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size')?.get,
  ),
  captureIntlProbe('Collator'),
  captureIntlProbe('DateTimeFormat', 'formatToParts', [0]),
  captureIntlProbe('NumberFormat', 'formatToParts', [0]),
  captureIntlProbe('PluralRules'),
  captureIntlProbe('RelativeTimeFormat'),
  captureIntlProbe('ListFormat'),
  captureIntlProbe('Locale', 'toString'),
  captureIntlProbe('DisplayNames'),
  captureIntlProbe('Segmenter'),
  captureIntlProbe('DurationFormat'),
  // Segments.containing uses a native brand and scalar index; no cursor advances.
  captureIntrinsicProbe(
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(new Intl.Segmenter('en').segment('')) as object,
      'containing',
    )?.value,
    [0],
  ),
  captureHeadersProbe(),
] as const;

/** A successful intrinsic call proves a hidden brand; wrong receivers throw. */
function hasReadOnlyIntrinsicState(value: object): boolean {
  for (const probe of readOnlyIntrinsicProbes) {
    try {
      probe(value);
      return true;
    } catch {
      // These captured intrinsics throw on a missing slot or private field only.
    }
  }
  return false;
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
  if (isProxy(value)) {
    throw new TypeError('Proxy JSON value.');
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw new TypeError(
      array ? 'Non-plain JSON array.' : 'Non-plain JSON object.',
    );
  }
  if (
    hasUnsupportedIntrinsicState(value) ||
    (!array && hasReadOnlyIntrinsicState(value))
  ) {
    throw new TypeError('Intrinsic object state is not plain JSON data.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic JSON value.');
  }

  ancestors.add(value);
  try {
    if (array) {
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
    // All own descriptors and children passed before property-reading crypto
    // wrappers run. This preserves first-invalid-member order on older Node 24.
    if (isKeyObject(value) || isCryptoKey(value)) {
      throw new TypeError('Intrinsic object state is not plain JSON data.');
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
