/** A value that can be represented without loss in canonical JSON. */
export type ExternalJsonValue =
  | null
  | boolean
  | number
  | string
  | ExternalJsonValue[]
  | { [key: string]: ExternalJsonValue };

/** A string-keyed JSON object. */
export type ExternalJsonObject = Record<string, ExternalJsonValue>;

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
  if (ancestors.has(value)) throw new TypeError('Cyclic JSON value.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        ownKeys.length !== value.length + 1 ||
        !lengthDescriptor ||
        lengthDescriptor.enumerable ||
        !('value' in lengthDescriptor)
      ) {
        throw new TypeError('Non-JSON array property.');
      }

      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
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
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('Non-JSON object key.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('Accessor or hidden property.');
      }
      entries.push([key, descriptor.value]);
    }
    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${encodeCanonical(
            item,
            depth + 1,
            maxDepth,
            ancestors,
          )}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Assert that a value is JSON-safe at a caller-selected container depth.
 *
 * This internal boundary uses property descriptors so validation never invokes
 * caller-provided accessors.
 */
export function assertExternalJsonValue(
  value: unknown,
  initialDepth: number,
  maxDepth: number,
): asserts value is ExternalJsonValue {
  encodeCanonical(value, initialDepth, maxDepth, new Set());
}

/**
 * Deterministically encode an unknown JSON value.
 *
 * Object keys are sorted recursively. Array order is preserved. Values with
 * accessors, hidden or symbol properties, cycles, unsafe integers, non-finite
 * numbers, sparse arrays, or non-JSON prototypes are rejected.
 */
export function canonicalJsonStringify(value: unknown): string {
  return encodeCanonical(value, 0, 512, new Set());
}
