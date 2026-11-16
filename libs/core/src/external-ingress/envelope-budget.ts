/**
 * Admission counting for external envelopes, before canonical JSON allocates output.
 * Counts encoded bytes in own-key order, including every occurrence of shared data.
 * This is a resource preflight, not a replacement for json.ts's plain-data policy.
 * Only admitted inputs reach that module's complete validation and normalization.
 */
/* Indexed own-data traversal must not consult mutable iterator protocols. */
/* eslint-disable @typescript-eslint/prefer-for-of */
import { types } from 'node:util';

/** Module-load intrinsics preserve the canonical foundation's post-load trust boundary. */
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const stringifyScalar = JSON.stringify;
const AncestorSet = Set;
/* Receivers are provided through the captured intrinsic application function. */
/* eslint-disable @typescript-eslint/unbound-method */
const charCodeAt = String.prototype.charCodeAt;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
/* eslint-enable @typescript-eslint/unbound-method */

/** Reflected descriptors must not inherit data/accessor fields from Object.prototype. */
function ownDescriptorValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  return descriptor && hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

/** Size and inclusive container-depth overruns share the permanent payload code. @internal */
export class EnvelopeLimitError extends Error {}

/**
 * Count exact JSON string bytes without creating an escaped copy or scanning past
 * the remaining budget. Paired surrogates use UTF-8; lone surrogates use escapes.
 */
function stringBytes(value: string, remaining: number): number {
  // A rope can flatten on its first code-unit read. Reject its known lower bound first.
  if (value.length + 2 > remaining) {
    throw new EnvelopeLimitError();
  }
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes > remaining) throw new EnvelopeLimitError();
    const unit = apply(charCodeAt, value, [index]);
    if (
      unit === 34 ||
      unit === 92 ||
      (unit >= 8 && unit <= 10) ||
      unit === 12 ||
      unit === 13
    ) {
      bytes += 2;
    } else if (unit < 32) {
      bytes += 6;
    } else if (unit < 128) {
      bytes += 1;
    } else if (unit < 2048) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      const next = apply(charCodeAt, value, [index + 1]);
      if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else {
      bytes += 3;
    }
  }
  if (bytes > remaining) throw new EnvelopeLimitError();
  return bytes;
}

/**
 * Preflight exact encoded size, refusing proxies/accessors without invoking them.
 * Each visited occurrence consumes bytes before another child can be visited, so
 * a shared-child DAG cannot cause exponential work before refusal. Arrays can be
 * refused from their length; record own-key enumeration still costs native width,
 * but descriptors, children and string scanning stop at the first overrun. No
 * sorting, full-document encoding, parsing or fingerprinting is done during this walk.
 * The caller supplies root depth so state retains its inclusive depth-1 policy.
 * @internal
 */
export function envelopeJsonBytes(
  input: unknown,
  limit: number,
  initialDepth: number,
  maxDepth: number,
): number {
  let bytes = 0;
  const ancestors = new AncestorSet<object>();
  const consume = (count: number): void => {
    bytes += count;
    if (bytes > limit) throw new EnvelopeLimitError();
  };
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      consume(stringBytes(value, limit - bytes));
      return;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      // Scalar numbers have fixed maximum encoding cost; json.ts rejects unsafe values.
      consume(stringifyScalar(value).length);
      return;
    }
    if (typeof value !== 'object') throw new TypeError('Non-JSON value.');
    if (depth > maxDepth) throw new EnvelopeLimitError();
    if (isProxy(value)) throw new TypeError('Proxy JSON value.');
    const array = isArray(value);
    const prototype: unknown = getPrototypeOf(value);
    if (
      array
        ? prototype !== arrayPrototype
        : prototype !== objectPrototype && prototype !== null
    ) {
      throw new TypeError('Non-plain JSON container.');
    }
    if (apply(setHas, ancestors, [value])) {
      throw new TypeError('Cyclic JSON value.');
    }
    apply(setAdd, ancestors, [value]);
    consume(2);
    if (array) {
      const length = ownDescriptorValue(
        getOwnPropertyDescriptor(value, 'length'),
      );
      if (typeof length !== 'number')
        throw new TypeError('Invalid array length.');
      // Even empty-string elements require two quotes and separating commas.
      if (length > 0 && length * 2 - 1 > limit - bytes)
        throw new EnvelopeLimitError();
    }
    const keys = ownKeys(value);
    let members = 0;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('Non-JSON key.');
      if (members > 0) consume(1);
      if (!array) consume(stringBytes(key, limit - bytes) + 1);
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !hasOwn(descriptor, 'value') ||
        !hasOwn(descriptor, 'enumerable') ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError('Accessor or hidden property.');
      }
      // Descriptor values are data, never property reads from the producer object.
      const child: unknown = descriptor.value;
      visit(child, depth + 1);
      members += 1;
    }
    apply(setDelete, ancestors, [value]);
  };
  visit(input, initialDepth);
  return bytes;
}
