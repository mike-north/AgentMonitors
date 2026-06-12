import type { ChangeKind, Observation } from './types.js';

/**
 * Keyed-collection change detection (003 §12).
 *
 * A `change-detection.collection` block turns a source's parsed JSON output into a
 * **collection of keyed objects** rather than one opaque blob, so consumers get
 * precise per-object `created` / `modified` / `descoped` observations with stable
 * per-object `objectKey`s. The mode is source-agnostic: `api-poll` and
 * `command-poll` share this one implementation (003 §12 frames it as a generic
 * companion to §11), keeping create/modified/descoped semantics identical across
 * sources rather than duplicating — and risking divergence — in each plugin.
 *
 * `path` syntax (resolving §12's open design point): a **minimal `$.`-prefixed
 * dotted path** — a root `$` followed by `.field` segments (`$.tasks`,
 * `$.data.items`). No wildcards, filters, or recursive descent. `path` MUST select
 * exactly one array; `ignore-paths` entries use the same dotted syntax and address
 * fields **within each element** (relative to the element root, e.g. `$.fetchedAt`).
 */

/** A parsed `change-detection.collection` config (003 §12). */
export interface KeyedCollectionConfig {
  /** Dotted `$.`-path to the array within the parsed output (e.g. `$.tasks`). */
  path: string;
  /** Field on each element whose value is the per-object identity (e.g. `id`). */
  key: string;
  /**
   * Optional dotted `$.`-paths, relative to each element, removed before content
   * comparison so churn fields (timestamps, etc.) do not produce spurious
   * `modified` observations.
   */
  ignorePaths?: string[];
}

/**
 * The persisted keyed snapshot: each tracked object's normalized content (after
 * `ignore-paths` removal), keyed by its `key`-field value rendered as a string.
 * Stored under the source's `nextState` so the next cycle can diff against it.
 */
export type KeyedSnapshot = Record<string, unknown>;

/** Result of one keyed-collection diff cycle. */
export interface KeyedCollectionResult {
  /** Per-object observations (empty on the baseline run). */
  observations: Observation[];
  /** The keyed snapshot to persist for the next cycle. */
  snapshot: KeyedSnapshot;
}

/**
 * Parse a `change-detection.collection` block into a {@link KeyedCollectionConfig},
 * or return `undefined` when no collection block is present.
 *
 * Throws a precise, author-facing error (BP3) when the block is present but
 * structurally invalid (missing/empty `path` or `key`, wrong types).
 */
export function parseKeyedCollectionConfig(
  changeDetection: unknown,
): KeyedCollectionConfig | undefined {
  if (
    changeDetection === null ||
    typeof changeDetection !== 'object' ||
    Array.isArray(changeDetection)
  ) {
    return undefined;
  }
  const collection = (changeDetection as Record<string, unknown>)['collection'];
  if (collection === undefined) return undefined;
  if (
    collection === null ||
    typeof collection !== 'object' ||
    Array.isArray(collection)
  ) {
    throw new Error(
      'change-detection.collection must be an object with "path" and "key"',
    );
  }

  const c = collection as Record<string, unknown>;
  const path = c['path'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(
      'change-detection.collection.path must be a non-empty string',
    );
  }
  const key = c['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      'change-detection.collection.key must be a non-empty string',
    );
  }

  const rawIgnore = c['ignore-paths'];
  let ignorePaths: string[] | undefined;
  if (rawIgnore !== undefined) {
    if (
      !Array.isArray(rawIgnore) ||
      !rawIgnore.every((p): p is string => typeof p === 'string')
    ) {
      throw new Error(
        'change-detection.collection.ignore-paths must be an array of strings',
      );
    }
    ignorePaths = rawIgnore;
  }

  return ignorePaths ? { path, key, ignorePaths } : { path, key };
}

/**
 * Validate that a path segment contains no JSONPath-special characters that the
 * minimal `$.field.field` grammar does not support. Throws an author-facing error
 * with the offending segment named explicitly so the mistake is easy to diagnose.
 *
 * Rejected characters: `[`, `]`, `*`, `?`, and whitespace — the characters that
 * JSONPath uses for index access, wildcards, filters, and recursive-descent
 * operators. All of these are outside the declared grammar (§12).
 */
function assertValidSegment(path: string, segment: string): void {
  if (/[[\]*?\s]/.test(segment)) {
    throw new Error(
      `Invalid collection path "${path}": segment "${segment}" contains unsupported ` +
        `syntax (only plain field names are allowed — no "[index]", wildcards, or filters)`,
    );
  }
}

/**
 * Resolve a minimal `$.`-prefixed dotted path against a parsed value, returning the
 * value at that path (or `undefined` if any segment is missing). Accepts exactly the
 * form §12's examples use: a root `$`, then `.field` segments. Rejects any other
 * shape (no `[index]`, wildcards, filters, or recursive descent) with a precise
 * error so authoring mistakes surface clearly.
 */
export function resolveDottedPath(root: unknown, path: string): unknown {
  if (path === '$') return root;
  if (!path.startsWith('$.')) {
    throw new Error(
      `Invalid collection path "${path}": must start with "$." (e.g. "$.tasks")`,
    );
  }
  const segments = path.slice(2).split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid collection path "${path}": empty path segment`);
    }
    assertValidSegment(path, segment);
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Remove a single `$.`-dotted path from within an element (mutating a clone). Used
 * to strip `ignore-paths` fields before content comparison. A path that does not
 * resolve is a no-op (missing intermediate key). Rejects unsupported segment syntax
 * (same grammar as {@link resolveDottedPath}) with a precise author-facing error.
 */
function removeDottedPath(value: unknown, path: string): void {
  if (path === '$') return;
  if (!path.startsWith('$.')) {
    throw new Error(
      `Invalid ignore-paths entry "${path}": must start with "$." (e.g. "$.fetchedAt")`,
    );
  }
  const segments = path.slice(2).split('.');
  let current: unknown = value;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === undefined || segment.length === 0) {
      throw new Error(
        `Invalid ignore-paths entry "${path}": empty path segment`,
      );
    }
    assertValidSegment(path, segment);
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const last = segments[segments.length - 1];
  if (last === undefined || last.length === 0) {
    throw new Error(
      `Invalid ignore-paths entry "${path}": empty path segment`,
    );
  }
  assertValidSegment(path, last);
  if (
    current !== null &&
    typeof current === 'object' &&
    !Array.isArray(current)
  ) {
    // `Reflect.deleteProperty` instead of `delete` to remove a dynamically computed
    // key without tripping @typescript-eslint/no-dynamic-delete.
    Reflect.deleteProperty(current as Record<string, unknown>, last);
  }
}

/** Recursively sort object keys so content comparison is key-order insensitive. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Produce the comparison-normalized form of one element: a deep clone with
 * `ignore-paths` fields removed, then key-sorted for order-insensitive comparison.
 */
function normalizeElement(
  element: unknown,
  ignorePaths: string[] | undefined,
): unknown {
  const clone: unknown = structuredClone(element);
  if (ignorePaths) {
    for (const p of ignorePaths) removeDottedPath(clone, p);
  }
  return sortKeys(clone);
}

/** Deterministically serialize a normalized element for equality comparison. */
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Read the `key` field value from an element and render it as a string identity.
 * Accepts string/number/boolean key values; rejects missing or object/array keys
 * (a key must be a scalar to form a stable `objectKey`).
 */
function keyValueOf(element: unknown, keyField: string): string {
  if (
    element === null ||
    typeof element !== 'object' ||
    Array.isArray(element)
  ) {
    throw new Error(
      `collection element is not an object (cannot read key "${keyField}")`,
    );
  }
  const raw = (element as Record<string, unknown>)[keyField];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  throw new Error(
    `collection element is missing a scalar key field "${keyField}"`,
  );
}

/**
 * Diff a parsed JSON output against the prior keyed snapshot per 003 §12, emitting
 * per-object observations and returning the new snapshot to persist.
 *
 * @param parsedOutput - The source's output parsed as JSON.
 * @param config - The collection config (path / key / ignore-paths).
 * @param monitorObjectKey - The source's object identity (the URL for `api-poll`,
 *   the joined argv / `key` for `command-poll`); per-object keys are
 *   `<monitorObjectKey>#<key-value>`.
 * @param previousSnapshot - The prior keyed snapshot, or `undefined` on the baseline
 *   run (which records the snapshot and emits nothing).
 * @param observationFields - Optional extra fields merged into each emitted
 *   observation's `payload`/`snapshot`/`queryScope` (e.g. the source url/command), so
 *   the per-object observation carries the same context the blob observation would.
 *
 * @throws if `path` does not select exactly one array (authoring/observe-time error).
 */
export function diffKeyedCollection(
  parsedOutput: unknown,
  config: KeyedCollectionConfig,
  monitorObjectKey: string,
  previousSnapshot: KeyedSnapshot | undefined,
  observationFields?: {
    payload?: Record<string, unknown>;
    queryScope?: Record<string, string | string[]>;
  },
): KeyedCollectionResult {
  const resolved = resolveDottedPath(parsedOutput, config.path);
  if (!Array.isArray(resolved)) {
    throw new Error(
      `collection path "${config.path}" must select an array (got ${
        resolved === undefined ? 'nothing' : typeof resolved
      })`,
    );
  }

  // Build the current keyed snapshot of normalized content.
  const current: KeyedSnapshot = {};
  for (const element of resolved) {
    const keyValue = keyValueOf(element, config.key);
    if (Object.prototype.hasOwnProperty.call(current, keyValue)) {
      throw new Error(
        `collection key "${config.key}" value "${keyValue}" is not unique within the collection`,
      );
    }
    current[keyValue] = normalizeElement(element, config.ignorePaths);
  }

  // Baseline run: record the snapshot, emit nothing (003 §12).
  if (previousSnapshot === undefined) {
    return { observations: [], snapshot: current };
  }

  const observations: Observation[] = [];

  const emit = (keyValue: string, changeKind: ChangeKind): void => {
    const objectKey = `${monitorObjectKey}#${keyValue}`;
    const title = `${titleVerb(changeKind)}: ${objectKey}`;
    observations.push({
      title,
      summary: title,
      objectKey,
      changeKind,
      payload: { ...observationFields?.payload, key: keyValue, changeKind },
      queryScope: { ...observationFields?.queryScope, objectKey },
    });
  };

  // `created` / `modified` for keys present now.
  for (const keyValue of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(previousSnapshot, keyValue)) {
      emit(keyValue, 'created');
    } else if (
      serialize(current[keyValue]) !== serialize(previousSnapshot[keyValue])
    ) {
      emit(keyValue, 'modified');
    }
  }

  // `descoped` for keys that disappeared (003 §12 — not `deleted`).
  for (const keyValue of Object.keys(previousSnapshot)) {
    if (!Object.prototype.hasOwnProperty.call(current, keyValue)) {
      emit(keyValue, 'descoped');
    }
  }

  return { observations, snapshot: current };
}

function titleVerb(changeKind: ChangeKind): string {
  switch (changeKind) {
    case 'created':
      return 'Item added';
    case 'modified':
      return 'Item changed';
    case 'descoped':
      return 'Item removed';
    case 'deleted':
      return 'Item deleted';
  }
}
