/**
 * Admission budgets for decoded daemon JSON. Byte framing bounds allocation;
 * these independent budgets bound schema traversal and error construction.
 * Only JSON.parse output is accepted here, so values have no getters or cycles.
 */

/** A local control request may carry bulk IDs, but is not an artifact transport. @internal */
export const MAX_DAEMON_REQUEST_BYTES = 1024 * 1024;
/** Per-array elements and per-record own keys, including unknown fields. */
const MAX_COLLECTION_ENTRIES = 1000;
/** Total root, container, and scalar values in one request, counted once each. */
const MAX_REQUEST_VALUES = 10000;
/** Root has depth zero; every array element or record value adds one level. */
const MAX_REQUEST_DEPTH = 32;
/** Stable wire classification, distinct from unsupported methods and application errors. @internal */
export const INPUT_LIMIT_ERROR_CODE = 'INPUT_LIMIT_EXCEEDED';

/**
 * Return one bounded diagnostic before any schema or runtime work. Iterative
 * traversal avoids consuming the JavaScript stack on deeply nested JSON.
 * Checking widths before reading children also avoids element-level errors
 * for a collection that should have been rejected as a whole.
 * @internal
 */
export function requestInputLimitViolation(input: unknown): string | undefined {
  const pending = [{ value: input, depth: 0 }];
  let admittedValues = 1;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) {
      break;
    }
    if (item.depth > MAX_REQUEST_DEPTH) {
      return `Request nesting must not exceed ${String(MAX_REQUEST_DEPTH)} levels`;
    }
    if (item.value === null || typeof item.value !== 'object') {
      continue;
    }
    const keys = Array.isArray(item.value)
      ? undefined
      : Object.keys(item.value);
    const length = Array.isArray(item.value)
      ? item.value.length
      : (keys?.length ?? 0);
    if (length > MAX_COLLECTION_ENTRIES) {
      return `Request collections must contain at most ${String(MAX_COLLECTION_ENTRIES)} entries`;
    }
    admittedValues += length;
    if (admittedValues > MAX_REQUEST_VALUES) {
      return `Request must contain at most ${String(MAX_REQUEST_VALUES)} values`;
    }
    // Width/aggregate admission has already bounded this container. Walk its
    // existing array or own keys without allocating a second values collection.
    if (Array.isArray(item.value)) {
      for (const value of item.value) {
        pending.push({ value, depth: item.depth + 1 });
      }
    } else {
      for (const key of keys ?? []) {
        const value: unknown = Reflect.get(item.value, key);
        pending.push({ value, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}
