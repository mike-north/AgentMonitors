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
 * after prototype replacement, including keys and Intl Segments.
 *
 * The input domain is primitives, ordinary/null-prototype records and dense
 * ordinary arrays. The tested refusal list and each check are specified in
 * docs/specs/002-runtime-delivery.md §16. Other objects whose state is not their
 * own enumerable data are outside this domain; callers MUST NOT pass them and
 * detection is not promised. Non-exhaustive tested examples include array,
 * string and RegExp-string iterators, iterator helpers/wrappers, SegmentIterator,
 * URL, URLSearchParams, Headers, FormData, Request, Response and AbortController.
 * Probes are captured at module load and assume unmodified runtime built-ins,
 * including Object.prototype.
 *
 * For every input, inside or outside the plain-data domain, validation and
 * encoding never run caller code, assuming unmodified built-ins at module load.
 * Later changes to any built-in prototype must neither run code nor change a
 * result. Captured functions, indexed traversal and own-data internal buffers
 * keep internal work independent of mutable prototype protocols.
 *
 * Descriptor fields are read only when owned by the reflected descriptor, so
 * later Object.prototype changes cannot turn accessors into data or run hooks.
 *
 * First-violation order: bounds/scalar checks, proxy refusal, exact prototype,
 * native/read-only intrinsic brands, ancestor cycles, then own keys/descriptors
 * and child values in own-key order (array length/indices for arrays). Record
 * crypto refusal depends on a genuine key created at module load: symbol-backed
 * runtimes refuse keys at the own-symbol gate and never run property-reading
 * crypto predicates, so post-load inherited symbol getters cannot run. Private-
 * brand runtimes run captured crypto predicates after all own descriptors and
 * children pass, before canonical key sorting. Both paths preserve the first
 * invalid string member before key refusal; child traversal stops before later
 * sibling descriptors are inspected.
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
/* Indexed reads must not consult a caller-replaced array iterator. */
/* eslint-disable @typescript-eslint/prefer-for-of */
import { createSecretKey } from 'node:crypto';
import { types } from 'node:util';

/**
 * Trusted intrinsics are captured once. Direct calls and captured Reflect.apply
 * never consult Function.prototype.call/apply or later built-in replacements.
 */
const apply = Reflect.apply;
const defineProperty = Reflect.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const setPrototypeOf = Object.setPrototypeOf;
const ownKeysOf = Reflect.ownKeys;
const isArray = Array.isArray;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const isFiniteNumber = Number.isFinite;
const isInteger = Number.isInteger;
const isSafeInteger = Number.isSafeInteger;
const stringifyScalar = JSON.stringify;
const indexString = String;
const JsonTypeError = TypeError;
const AncestorSet = Set;
// Receivers are supplied explicitly through captured Reflect.apply.
/* eslint-disable @typescript-eslint/unbound-method */
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
/* eslint-enable @typescript-eslint/unbound-method */
const sortArray = Array.prototype.sort;
const joinArray = Array.prototype.join;

/** Dense buffers have no inherited numeric setters, protocols or species. */
function internalBuffer<T>(): T[] {
  const buffer: T[] = [];
  setPrototypeOf(buffer, null);
  return buffer;
}

/** Full null-prototype descriptors cannot inherit accessor descriptor fields. */
function appendOwn<T>(buffer: T[], value: T): void {
  const descriptor = {
    __proto__: null,
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  };
  defineProperty(buffer, indexString(buffer.length), descriptor);
}

/** Only encoded strings reach joining, so no element coercion can invoke hooks. */
function joinEncoded(buffer: string[]): string {
  return apply(joinArray, buffer, [',']);
}

/** Inclusive supported container depth, shared by validation and encoding. */
const MAX_SUPPORTED_DEPTH = 512;

/** Own-field checks remain stable after callers replace Object.hasOwn. */
const hasOwn = Object.hasOwn;

/** Missing descriptor fields must never consult Object.prototype. */
function ownDescriptorField(
  descriptor: PropertyDescriptor | undefined,
  field: keyof PropertyDescriptor,
): unknown {
  return descriptor && hasOwn(descriptor, field)
    ? descriptor[field]
    : undefined;
}

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
 * A fresh genuine key selects the runtime representation under the module-load
 * built-in trust assumption; caller input cannot influence this decision. Older
 * Node 24 keys carry own symbols and its crypto wrappers read symbol properties,
 * including inherited properties on ordinary records. Never call those wrappers
 * there: the own-symbol gate already refuses keys. Newer Node 24 keys use private/
 * native brands (internal/crypto/keys.js), whose predicates read no properties.
 */
const cryptoUsesPrivateBrands =
  Object.getOwnPropertySymbols(createSecretKey(new Uint8Array(16))).length ===
  0;

/** Captured crypto predicates are invoked only on the private-brand runtime. */
const { isKeyObject, isCryptoKey } = types;

/** Native hidden-state predicates are independent of visible prototype identity. */
function hasUnsupportedIntrinsicState(value: object): boolean {
  for (let index = 0; index < nativeStatePredicates.length; index += 1) {
    const predicate = nativeStatePredicates[index];
    if (predicate?.(value)) {
      return true;
    }
  }
  return false;
}

/** Validate each captured callable once; invocation always supplies its receiver. */
function captureIntrinsicProbe(
  method: unknown,
  args: readonly unknown[] = [],
): (value: object) => unknown {
  if (typeof method !== 'function') {
    throw new JsonTypeError('Missing intrinsic state probe.');
  }
  return (value) => {
    const result: unknown = apply(method, value, args);
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
  const constructor: unknown = ownDescriptorField(
    getOwnPropertyDescriptor(Intl, family),
    'value',
  );
  if (typeof constructor !== 'function') {
    throw new JsonTypeError('Missing Intl constructor.');
  }
  const prototype: unknown = ownDescriptorField(
    getOwnPropertyDescriptor(constructor, 'prototype'),
    'value',
  );
  if (typeof prototype !== 'object' || prototype === null) {
    throw new JsonTypeError('Missing Intl prototype.');
  }
  return captureIntrinsicProbe(
    ownDescriptorField(getOwnPropertyDescriptor(prototype, method), 'value'),
    args,
  );
}

/**
 * Captured native methods test internal slots without property consultation.
 * Wrong receivers must throw natively: JavaScript error construction can run
 * inherited hooks even when the probing method itself was captured at load.
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
    ownDescriptorField(
      getOwnPropertyDescriptor(WeakRef.prototype, 'deref'),
      'value',
    ),
  ),
  captureIntrinsicProbe(
    ownDescriptorField(
      getOwnPropertyDescriptor(FinalizationRegistry.prototype, 'unregister'),
      'value',
    ),
    [{}],
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
    ownDescriptorField(
      getOwnPropertyDescriptor(
        getPrototypeOf(new Intl.Segmenter('en').segment('')) as object,
        'containing',
      ),
      'value',
    ),
    [0],
  ),
] as const;

/**
 * A successful intrinsic call proves a hidden brand; wrong receivers throw.
 * Only fixed-argument, hook-free probes belong here: an exception from caller
 * code must never be mistaken for a missing slot and admit a genuine member.
 */
function hasReadOnlyIntrinsicState(value: object): boolean {
  for (let index = 0; index < readOnlyIntrinsicProbes.length; index += 1) {
    const probe = readOnlyIntrinsicProbes[index];
    if (!probe) {
      continue;
    }
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
    return stringifyScalar(value);
  }
  if (typeof value === 'number') {
    if (!isFiniteNumber(value) || (isInteger(value) && !isSafeInteger(value))) {
      throw new JsonTypeError('Invalid JSON number.');
    }
    return stringifyScalar(value);
  }
  if (typeof value !== 'object' || depth > maxDepth) {
    throw new JsonTypeError('Non-JSON value or excessive nesting.');
  }
  // Descriptor and prototype inspection are safe only after excluding proxies.
  if (isProxy(value)) {
    throw new JsonTypeError('Proxy JSON value.');
  }
  const array = isArray(value);
  const prototype = getPrototypeOf(value) as unknown;
  if (
    array
      ? prototype !== arrayPrototype
      : prototype !== objectPrototype && prototype !== null
  ) {
    throw new JsonTypeError(
      array ? 'Non-plain JSON array.' : 'Non-plain JSON object.',
    );
  }
  if (
    hasUnsupportedIntrinsicState(value) ||
    (!array && hasReadOnlyIntrinsicState(value))
  ) {
    throw new JsonTypeError('Intrinsic object state is not plain JSON data.');
  }
  if (apply(setHas, ancestors, [value])) {
    throw new JsonTypeError('Cyclic JSON value.');
  }

  apply(setAdd, ancestors, [value]);
  try {
    if (array) {
      const ownKeys = ownKeysOf(value);
      const lengthDescriptor = getOwnPropertyDescriptor(value, 'length');
      const length = ownDescriptorField(lengthDescriptor, 'value');
      if (
        !lengthDescriptor ||
        ownDescriptorField(lengthDescriptor, 'enumerable') !== false ||
        !hasOwn(lengthDescriptor, 'value') ||
        typeof length !== 'number' ||
        ownKeys.length !== length + 1
      ) {
        throw new JsonTypeError('Non-JSON array property.');
      }

      const encoded = internalBuffer<string>();
      for (let index = 0; index < length; index += 1) {
        const descriptor = getOwnPropertyDescriptor(value, indexString(index));
        if (!descriptor) {
          throw new JsonTypeError('Sparse array or array accessor.');
        }
        if (
          ownDescriptorField(descriptor, 'enumerable') !== true ||
          !hasOwn(descriptor, 'value')
        ) {
          throw new JsonTypeError('Accessor or hidden property.');
        }
        appendOwn(
          encoded,
          encodeCanonical(
            ownDescriptorField(descriptor, 'value'),
            depth + 1,
            maxDepth,
            ancestors,
          ),
        );
      }
      return `[${joinEncoded(encoded)}]`;
    }

    const entries = internalBuffer<[string, string]>();
    const keys = ownKeysOf(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') {
        throw new JsonTypeError('Non-JSON object key.');
      }
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        ownDescriptorField(descriptor, 'enumerable') !== true ||
        !hasOwn(descriptor, 'value')
      ) {
        throw new JsonTypeError('Accessor or hidden property.');
      }
      // Validate before sorting: an early invalid value must not inspect siblings.
      appendOwn(entries, [
        key,
        encodeCanonical(
          ownDescriptorField(descriptor, 'value'),
          depth + 1,
          maxDepth,
          ancestors,
        ),
      ]);
    }
    // Symbol-backed keys already refused in own-key order. Private brands follow
    // descriptors and children so their first invalid member keeps precedence.
    if (cryptoUsesPrivateBrands && (isKeyObject(value) || isCryptoKey(value))) {
      throw new JsonTypeError('Intrinsic object state is not plain JSON data.');
    }
    apply(sortArray, entries, [
      (left: [string, string], right: [string, string]) =>
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    ]);
    const encoded = internalBuffer<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry) {
        appendOwn(encoded, `${stringifyScalar(entry[0])}:${entry[1]}`);
      }
    }
    return `{${joinEncoded(encoded)}}`;
  } finally {
    apply(setDelete, ancestors, [value]);
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
    !isSafeInteger(initialDepth) ||
    !isSafeInteger(maxDepth) ||
    initialDepth < 0 ||
    maxDepth < initialDepth ||
    maxDepth > MAX_SUPPORTED_DEPTH
  ) {
    throw new JsonTypeError('Invalid JSON depth bounds.');
  }
  encodeCanonical(value, initialDepth, maxDepth, new AncestorSet());
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
  return encodeCanonical(value, 0, MAX_SUPPORTED_DEPTH, new AncestorSet());
}
