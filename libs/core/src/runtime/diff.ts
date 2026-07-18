import { createHash } from 'node:crypto';
import {
  computeDerivedFacts,
  renderArtifact,
  type DerivedFactRule,
} from './shape.js';

export function fingerprintText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildTextDiff(previous: string, current: string): string {
  if (previous === current) return '';

  const prevLines = previous.split('\n');
  const currLines = current.split('\n');
  const max = Math.max(prevLines.length, currLines.length);
  const chunks: string[] = [];

  for (let i = 0; i < max; i++) {
    const before = prevLines[i];
    const after = currLines[i];
    if (before === after) continue;
    const line = i + 1;
    if (before !== undefined) chunks.push(`- ${String(line)}: ${before}`);
    if (after !== undefined) chunks.push(`+ ${String(line)}: ${after}`);
    if (chunks.length >= 20) break;
  }

  return chunks.join('\n');
}

/**
 * Read the `change-detection.strategy` an observation was captured under, from
 * the persisted `snapshot`/`snapshotMetadata` metadata a source attaches to
 * every observation (e.g. `plugins/source-command-poll`, `plugins/source-api-poll`
 * both set `snapshot.strategy`). Returns `undefined` for anything that isn't a
 * recognizable metadata object with a string `strategy` field — callers treat
 * that as "use the default line-diff renderer" (issue #437).
 */
export function changeDetectionStrategyOf(
  snapshotMetadata: unknown,
): string | undefined {
  if (
    snapshotMetadata === null ||
    typeof snapshotMetadata !== 'object' ||
    Array.isArray(snapshotMetadata)
  ) {
    return undefined;
  }
  const strategy = (snapshotMetadata as Record<string, unknown>)['strategy'];
  return typeof strategy === 'string' ? strategy : undefined;
}

/**
 * Render the delta between two snapshot texts for `diffText` (002 §5.2),
 * choosing the renderer by the object's `change-detection.strategy` (issue
 * #437). `strategy: json-diff` renders a **structural** diff — added/removed/
 * changed elements or key paths — instead of {@link buildTextDiff}'s
 * compact-JSON-degrades-to-remove-all/add-all line diff. Every other strategy
 * (including `undefined`, `text-diff`, `exit-code`) renders via
 * {@link buildTextDiff} unchanged.
 *
 * Falls back to {@link buildTextDiff} whenever `strategy: json-diff` is
 * declared but either side does not parse as JSON — identical to each source's
 * own `hasChanged` fallback (003 §11.3/§4.2), so the diff renderer never
 * disagrees with the strategy that decided a change occurred.
 */
export function buildDiff(
  previous: string,
  current: string,
  strategy?: string,
): string {
  if (strategy === 'json-diff') {
    const structural = buildJsonDiff(previous, current);
    if (structural !== undefined) return structural;
  }
  return buildTextDiff(previous, current);
}

/**
 * Maximum number of structural diff entries (added/removed/changed) rendered
 * before an explicit elision marker line is appended — the `json-diff` analog
 * of {@link buildTextDiff}'s 20-changed-line cap (002 §5.2), since this text
 * reaches LLM context windows (issue #437 AC3).
 */
const MAX_JSON_DIFF_ENTRIES = 20;

/** Max rendered length (chars) of one entry's JSON value before truncation. */
const MAX_JSON_DIFF_VALUE_LENGTH = 300;

/** Element-identity field candidates tried, in priority order, for arrays of objects. */
const IDENTITY_KEY_CANDIDATES = [
  'id',
  'key',
  'uuid',
  '_id',
  'slug',
  'sha',
  'number',
  'name',
];

type JsonDiffEntry =
  | { kind: 'removed'; path: string; value: unknown }
  | { kind: 'added'; path: string; value: unknown }
  | { kind: 'changed'; path: string; previous: unknown; current: unknown }
  | { kind: 'reordered'; path: string; current: unknown };

/**
 * Render a **structural** diff between two JSON texts: added/removed/changed
 * elements or key paths, bounded to {@link MAX_JSON_DIFF_ENTRIES} entries with
 * an elision marker (issue #437 AC1/AC3). Returns `undefined` — signaling the
 * caller to fall back to {@link buildTextDiff} — when either text fails to
 * parse as JSON, mirroring the `json-diff` `hasChanged` fallback used to decide
 * whether a change occurred in the first place (003 §11.3).
 */
export function buildJsonDiff(
  previous: string,
  current: string,
): string | undefined {
  if (previous === current) return '';

  let prevParsed: unknown;
  let currParsed: unknown;
  try {
    prevParsed = JSON.parse(previous);
    currParsed = JSON.parse(current);
  } catch {
    return undefined;
  }

  const entries = diffJsonValues('', prevParsed, currParsed);
  if (entries.length === 0) return '';
  return renderJsonDiffEntries(entries);
}

function diffJsonValues(
  path: string,
  prev: unknown,
  curr: unknown,
): JsonDiffEntry[] {
  if (deepEqualJson(prev, curr)) return [];
  if (Array.isArray(prev) && Array.isArray(curr)) {
    return diffJsonArray(path, prev, curr);
  }
  if (isPlainRecord(prev) && isPlainRecord(curr)) {
    return diffJsonObject(path, prev, curr);
  }
  return [{ kind: 'changed', path, previous: prev, current: curr }];
}

function diffJsonObject(
  path: string,
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): JsonDiffEntry[] {
  const entries: JsonDiffEntry[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of [...keys].sort()) {
    const childPath = fieldPath(path, key);
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const hasCurr = Object.prototype.hasOwnProperty.call(curr, key);
    if (hasPrev && !hasCurr) {
      entries.push({ kind: 'removed', path: childPath, value: prev[key] });
    } else if (!hasPrev && hasCurr) {
      entries.push({ kind: 'added', path: childPath, value: curr[key] });
    } else {
      entries.push(...diffJsonValues(childPath, prev[key], curr[key]));
    }
  }
  return entries;
}

/**
 * Diff two arrays by element identity where feasible, index-based otherwise
 * (issue #437 AC2): arrays of objects try a stable-key heuristic first
 * ({@link findIdentityKey}), then fall back to whole-element deep-equality
 * matching (added/removed only — no reliable identity to report a `changed`
 * element against); arrays of anything else diff positionally by index
 * ({@link diffJsonArrayByIndex}, inherently order-sensitive, so a reorder
 * there always yields ordinary `changed`/`added`/`removed` entries).
 *
 * Both identity-based matchers ({@link diffJsonArrayByKey},
 * {@link diffJsonArrayByDeepEquality}) are themselves order-INsensitive by
 * construction (they match by key/content, not position) — but `hasChanged`
 * (003 §4.2/§11.3, each `json-diff` source) is array-order-SENSITIVE (it
 * sorts object keys, never array elements), so a pure element reorder is a
 * real detected change. Both matchers therefore fall back to an explicit
 * `reordered` entry when they find no other diff, preserving the invariant
 * "change detected ⟺ non-empty diffText" (issue #437 follow-up).
 */
function diffJsonArray(
  path: string,
  prev: unknown[],
  curr: unknown[],
): JsonDiffEntry[] {
  const prevObjects = prev.every(isPlainRecord) ? prev : undefined;
  const currObjects = curr.every(isPlainRecord) ? curr : undefined;

  if (prevObjects && currObjects) {
    const identityKey = findIdentityKey(prevObjects, currObjects);
    if (identityKey !== undefined) {
      return diffJsonArrayByKey(path, identityKey, prevObjects, currObjects);
    }
    return diffJsonArrayByDeepEquality(path, prevObjects, currObjects);
  }

  return diffJsonArrayByIndex(path, prev, curr);
}

/** A field is a usable element identity iff every element has it as a unique scalar. */
function findIdentityKey(
  prev: Record<string, unknown>[],
  curr: Record<string, unknown>[],
): string | undefined {
  for (const candidate of IDENTITY_KEY_CANDIDATES) {
    if (
      isUniqueScalarKey(prev, candidate) &&
      isUniqueScalarKey(curr, candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function isUniqueScalarKey(
  elements: Record<string, unknown>[],
  key: string,
): boolean {
  const seen = new Set<string>();
  for (const element of elements) {
    const value = element[key];
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return false;
    }
    const serialized = String(value);
    if (seen.has(serialized)) return false;
    seen.add(serialized);
  }
  return true;
}

function diffJsonArrayByKey(
  path: string,
  key: string,
  prev: Record<string, unknown>[],
  curr: Record<string, unknown>[],
): JsonDiffEntry[] {
  const prevByKey = new Map(prev.map((el) => [String(el[key]), el]));
  const currByKey = new Map(curr.map((el) => [String(el[key]), el]));
  const entries: JsonDiffEntry[] = [];

  for (const [keyValue, element] of prevByKey) {
    if (!currByKey.has(keyValue)) {
      entries.push({
        kind: 'removed',
        path: keyedElementPath(path, key, keyValue),
        value: element,
      });
    }
  }
  for (const [keyValue, element] of currByKey) {
    if (!prevByKey.has(keyValue)) {
      entries.push({
        kind: 'added',
        path: keyedElementPath(path, key, keyValue),
        value: element,
      });
    }
  }
  for (const [keyValue, currElement] of currByKey) {
    const prevElement = prevByKey.get(keyValue);
    if (prevElement !== undefined) {
      entries.push(
        ...diffJsonValues(
          keyedElementPath(path, key, keyValue),
          prevElement,
          currElement,
        ),
      );
    }
  }

  // Same key set, same content per key — but json-diff's `hasChanged` (003
  // §4.2/§11.3) is array-ORDER-sensitive (it sorts object keys, never array
  // elements), so a pure reorder is a real detected change. The invariant
  // "change detected ⟺ non-empty diffText" must hold even though identity-key
  // matching is itself order-insensitive, so surface the reorder explicitly
  // instead of silently rendering an empty diff (issue #437 follow-up).
  if (entries.length === 0) {
    const prevOrder = prev.map((el) => String(el[key]));
    const currOrder = curr.map((el) => String(el[key]));
    if (!arraysEqualByValue(prevOrder, currOrder)) {
      entries.push({ kind: 'reordered', path, current: currOrder });
    }
  }

  return entries;
}

/**
 * No stable identity field is available, so match elements by deep equality
 * (a multiset match) rather than position — this is order-insensitive, unlike
 * {@link diffJsonArrayByIndex}. There is no element identity to attach a
 * `changed` entry to, so an element whose content changed renders as one
 * `removed` (old content) plus one `added` (new content) entry. `path` is the
 * caller's location (empty at the array's own top level, a dotted/bracketed
 * field path when this array is nested — e.g. `items` — so a removed/added
 * entry never loses which field it came from, issue #437 review).
 */
function diffJsonArrayByDeepEquality(
  path: string,
  prev: Record<string, unknown>[],
  curr: Record<string, unknown>[],
): JsonDiffEntry[] {
  const unmatchedCurr = [...curr];
  const removed: Record<string, unknown>[] = [];
  for (const prevElement of prev) {
    const matchIndex = unmatchedCurr.findIndex((currElement) =>
      deepEqualJson(prevElement, currElement),
    );
    if (matchIndex === -1) {
      removed.push(prevElement);
    } else {
      unmatchedCurr.splice(matchIndex, 1);
    }
  }
  const entries: JsonDiffEntry[] = removed.map((value) => ({
    kind: 'removed' as const,
    path,
    value,
  }));
  for (const value of unmatchedCurr) {
    entries.push({ kind: 'added', path, value });
  }

  // Every element matched (a perfect multiset match) but the raw arrays are
  // not byte-identical — the only way that happens is a pure reorder, which
  // is a real change under json-diff's order-sensitive `hasChanged` (see the
  // matching note in diffJsonArrayByKey above). Surface it rather than
  // silently rendering an empty diff (issue #437 follow-up).
  if (entries.length === 0 && !arraysPositionallyEqual(prev, curr)) {
    entries.push({ kind: 'reordered', path, current: curr });
  }

  return entries;
}

function diffJsonArrayByIndex(
  path: string,
  prev: unknown[],
  curr: unknown[],
): JsonDiffEntry[] {
  const entries: JsonDiffEntry[] = [];
  const max = Math.max(prev.length, curr.length);
  for (let i = 0; i < max; i++) {
    const childPath = indexPath(path, i);
    if (i >= curr.length) {
      entries.push({ kind: 'removed', path: childPath, value: prev[i] });
    } else if (i >= prev.length) {
      entries.push({ kind: 'added', path: childPath, value: curr[i] });
    } else {
      entries.push(...diffJsonValues(childPath, prev[i], curr[i]));
    }
  }
  return entries;
}

function fieldPath(base: string, field: string): string {
  return base ? `${base}.${field}` : field;
}

function indexPath(base: string, index: number): string {
  return `${base}[${String(index)}]`;
}

function keyedElementPath(base: string, key: string, value: string): string {
  return `${base}[${key}=${value}]`;
}

/** Structural JSON equality: sorts object keys so key order never counts as a change. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Elementwise string-array equality, used to detect an identity-key reorder. */
function arraysEqualByValue(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Elementwise deep-JSON-equality, used to detect a deep-equality-match reorder. */
function arraysPositionallyEqual(a: unknown[], b: unknown[]): boolean {
  return (
    a.length === b.length && a.every((value, i) => deepEqualJson(value, b[i]))
  );
}

function renderJsonDiffEntries(entries: JsonDiffEntry[]): string {
  const capped = entries.slice(0, MAX_JSON_DIFF_ENTRIES);
  const lines = capped.map(renderJsonDiffEntry);
  if (entries.length > MAX_JSON_DIFF_ENTRIES) {
    lines.push(
      `… ${String(entries.length - MAX_JSON_DIFF_ENTRIES)} more changes elided`,
    );
  }
  return lines.join('\n');
}

/**
 * Render a path suffix for a diff entry label: a field-name path gets a
 * separating space (`removed status: ...`); a bracketed array-element path
 * (`[id=1]`, `[1]`) attaches directly (`removed[id=1]: ...`), and an empty
 * path (whole-element entries with no identity, e.g. deep-equality array
 * matching) attaches nothing (`removed: ...`).
 */
function formatPathSuffix(path: string): string {
  if (!path) return '';
  return path.startsWith('[') ? path : ` ${path}`;
}

function renderJsonDiffEntry(entry: JsonDiffEntry): string {
  switch (entry.kind) {
    case 'removed':
      return `- removed${formatPathSuffix(entry.path)}: ${renderJsonValue(entry.value)}`;
    case 'added':
      return `+ added${formatPathSuffix(entry.path)}: ${renderJsonValue(entry.value)}`;
    case 'changed':
      return `~ changed${formatPathSuffix(entry.path)}: ${renderJsonValue(entry.previous)} -> ${renderJsonValue(entry.current)}`;
    case 'reordered':
      return `~ reordered${formatPathSuffix(entry.path)}: ${renderJsonValue(entry.current)}`;
  }
}

function renderJsonValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_JSON_DIFF_VALUE_LENGTH) return serialized;
  return `${serialized.slice(0, MAX_JSON_DIFF_VALUE_LENGTH)}…(truncated)`;
}

/**
 * Render a shaped snapshot to the stable Shape artifact (§1.1.5), the input the
 * runtime diffs **instead of** the raw source. Deterministic and pure over
 * `(snapshot, now, rules)`: the only time input is the injected `now`. Computes
 * the derived facts (§1.1.4), then renders the shaped state to a byte-stable
 * artifact. The same shaped state at the same `now` MUST render to byte-identical
 * text (no phantom diff).
 *
 * @param snapshot - The shaped snapshot (the source's raw facts).
 * @param now - The runtime-injected tick clock, in epoch milliseconds.
 * @param rules - The author-declared `shape.derive` rules, in order.
 * @returns The byte-stable rendered artifact.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4–§1.1.5
 */
export function renderShapeArtifact(
  snapshot: unknown,
  now: number,
  rules: readonly DerivedFactRule[],
): string {
  const facts = computeDerivedFacts(snapshot, now, rules);
  return renderArtifact(snapshot, facts);
}
