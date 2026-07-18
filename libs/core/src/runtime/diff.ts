import { createHash } from 'node:crypto';
import { sortKeys } from '../observation/keyed-collection.js';
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
 * The `change-detection.strategy` values a bundled source (`source-api-poll`,
 * `source-command-poll`) may set on `snapshot.strategy` (003 §4.2/§11.3). This
 * is an **open** vocabulary — the source contract ([003 §2](../../../../docs/specs/003-source-plugins.md#2-source-contract))
 * does not require every source to set it, and a third-party source MAY declare
 * its own strategy string — so the `(string & {})` member preserves literal
 * autocompletion for the four recognized values while still accepting an
 * arbitrary string (issue #437 review: avoid an unconstrained `string` on a
 * curated public-API signature per this repo's "explicit named unions/interfaces
 * for public contracts" convention).
 */
export type ChangeDetectionStrategy =
  | 'json-diff'
  | 'text-diff'
  | 'exit-code'
  | 'status-code'
  | (string & {});

/**
 * Read the `change-detection.strategy` an observation was captured under, from
 * the persisted `snapshot`/`snapshotMetadata` metadata a source attaches to
 * every observation (e.g. `plugins/source-command-poll`, `plugins/source-api-poll`
 * both set `snapshot.strategy`). Returns `undefined` for anything that isn't a
 * recognizable metadata object with a string `strategy` field — callers treat
 * that as "use the default line-diff renderer" (issue #437). Setting
 * `snapshot.strategy` is a bundled-source convention, not a source-contract
 * requirement (003 §2) — a third-party source that omits it simply always
 * renders via {@link buildTextDiff}.
 */
export function changeDetectionStrategyOf(
  snapshotMetadata: unknown,
): ChangeDetectionStrategy | undefined {
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
  strategy?: ChangeDetectionStrategy,
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

/**
 * Max rendered length (chars) of one path segment (an object key or an
 * identity-key value used in a `[key=value]` element path) before truncation
 * — untrusted JSON content, so an attacker-controlled key/id must not be able
 * to inflate `diffText` on its own (issue #437 review: a 100,000-char `id`
 * previously produced a 100,345-char one-entry diff).
 */
const MAX_PATH_SEGMENT_LENGTH = 60;

/**
 * Hard cap (chars) on the fully-rendered `diffText`, independent of the
 * per-entry/per-value/per-path-segment caps above — a last-resort backstop
 * against a pathological input (e.g. very deep nesting inflating path length,
 * or many entries each near their own caps) still producing an oversized
 * `diffText` (issue #437 review).
 */
const MAX_JSON_DIFF_OUTPUT_LENGTH = 20_000;

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
 * Rendered when two JSON texts are structurally equal (same value once key
 * order/whitespace are normalized) but not byte-identical — e.g. a
 * reformatted/re-serialized snapshot with reordered keys or different
 * whitespace. Without this, `buildJsonDiff` would return `''` for a
 * byte-different pair, violating "change detected ⟺ non-empty `diffText`"
 * wherever a caller treats a byte-different snapshot as a real change (issue
 * #437 review).
 */
const FORMATTING_ONLY_DIFF =
  '~ formatting-only change (no structural difference)';

/**
 * Accumulates structural diff entries with a hard cap on how many are
 * actually retained (`cap + 1`, enough to detect "more than cap" and render
 * an exact elision count) while still counting every entry the traversal
 * visits (issue #437 review: "stop accumulating past cap+1 and keep a running
 * count for the elision line" — a pathological input with a huge number of
 * changed leaves must not force the whole entry list into memory just to
 * render 20 of them and a count of the rest).
 */
class DiffEntrySink {
  private readonly stored: JsonDiffEntry[] = [];
  private count = 0;

  constructor(private readonly cap: number) {}

  push(entry: JsonDiffEntry): void {
    this.count++;
    if (this.stored.length <= this.cap) this.stored.push(entry);
  }

  /** Entries actually retained, up to `cap + 1` (never the unbounded total). */
  get entries(): readonly JsonDiffEntry[] {
    return this.stored;
  }

  /** Every entry the traversal has visited so far, capped or not. */
  get total(): number {
    return this.count;
  }
}

/**
 * Render a **structural** diff between two JSON texts: added/removed/changed
 * elements or key paths, bounded to {@link MAX_JSON_DIFF_ENTRIES} entries with
 * an elision marker (issue #437 AC1/AC3). Returns `undefined` — signaling the
 * caller to fall back to {@link buildTextDiff} — when either text fails to
 * parse as JSON, mirroring the `json-diff` `hasChanged` fallback used to decide
 * whether a change occurred in the first place (003 §11.3). Also returns
 * `undefined` when the structural traversal itself overflows the call stack
 * on a pathologically deep JSON value (`RangeError`, issue #437 review:
 * `JSON.parse` tolerates roughly 4.2M nesting levels but the recursive
 * traversal below overflows around 2,500) — this keeps the diff renderer
 * total: the caller's `buildTextDiff` fallback still produces a `diffText`
 * instead of the ingest path throwing an uncaught `RangeError`.
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

  const sink = new DiffEntrySink(MAX_JSON_DIFF_ENTRIES);
  try {
    diffJsonValues(sink, '', prevParsed, currParsed);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }

  if (sink.total === 0) {
    // Raw texts differ (the `previous === current` guard above already
    // returned) but the parsed values are structurally equal — a
    // formatting-only change (issue #437 review, empty-per-recipient-diff).
    return FORMATTING_ONLY_DIFF;
  }
  return renderJsonDiffEntries(sink);
}

function diffJsonValues(
  sink: DiffEntrySink,
  path: string,
  prev: unknown,
  curr: unknown,
): void {
  if (deepEqualJson(prev, curr)) return;
  if (Array.isArray(prev) && Array.isArray(curr)) {
    diffJsonArray(sink, path, prev, curr);
    return;
  }
  if (isPlainRecord(prev) && isPlainRecord(curr)) {
    diffJsonObject(sink, path, prev, curr);
    return;
  }
  sink.push({ kind: 'changed', path, previous: prev, current: curr });
}

function diffJsonObject(
  sink: DiffEntrySink,
  path: string,
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): void {
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of [...keys].sort()) {
    const childPath = fieldPath(path, key);
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const hasCurr = Object.prototype.hasOwnProperty.call(curr, key);
    if (hasPrev && !hasCurr) {
      sink.push({ kind: 'removed', path: childPath, value: prev[key] });
    } else if (!hasPrev && hasCurr) {
      sink.push({ kind: 'added', path: childPath, value: curr[key] });
    } else {
      diffJsonValues(sink, childPath, prev[key], curr[key]);
    }
  }
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
  sink: DiffEntrySink,
  path: string,
  prev: unknown[],
  curr: unknown[],
): void {
  const prevObjects = prev.every(isPlainRecord) ? prev : undefined;
  const currObjects = curr.every(isPlainRecord) ? curr : undefined;

  if (prevObjects && currObjects) {
    const identityKey = findIdentityKey(prevObjects, currObjects);
    if (identityKey !== undefined) {
      diffJsonArrayByKey(sink, path, identityKey, prevObjects, currObjects);
      return;
    }
    diffJsonArrayByDeepEquality(sink, path, prevObjects, currObjects);
    return;
  }

  diffJsonArrayByIndex(sink, path, prev, curr);
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
  sink: DiffEntrySink,
  path: string,
  key: string,
  prev: Record<string, unknown>[],
  curr: Record<string, unknown>[],
): void {
  const prevByKey = new Map(prev.map((el) => [String(el[key]), el]));
  const currByKey = new Map(curr.map((el) => [String(el[key]), el]));
  const totalBefore = sink.total;

  for (const [keyValue, element] of prevByKey) {
    if (!currByKey.has(keyValue)) {
      sink.push({
        kind: 'removed',
        path: keyedElementPath(path, key, keyValue),
        value: element,
      });
    }
  }
  for (const [keyValue, element] of currByKey) {
    if (!prevByKey.has(keyValue)) {
      sink.push({
        kind: 'added',
        path: keyedElementPath(path, key, keyValue),
        value: element,
      });
    }
  }
  for (const [keyValue, currElement] of currByKey) {
    const prevElement = prevByKey.get(keyValue);
    if (prevElement !== undefined) {
      diffJsonValues(
        sink,
        keyedElementPath(path, key, keyValue),
        prevElement,
        currElement,
      );
    }
  }

  // Same key set, same content per key — but json-diff's `hasChanged` (003
  // §4.2/§11.3) is array-ORDER-sensitive (it sorts object keys, never array
  // elements), so a pure reorder is a real detected change. The invariant
  // "change detected ⟺ non-empty diffText" must hold even though identity-key
  // matching is itself order-insensitive, so surface the reorder explicitly
  // instead of silently rendering an empty diff (issue #437 follow-up). Uses
  // `sink.total` (monotonic across the whole traversal) rather than a local
  // entries array so the check stays correct even once the sink is capped.
  if (sink.total === totalBefore) {
    const prevOrder = prev.map((el) => String(el[key]));
    const currOrder = curr.map((el) => String(el[key]));
    if (!arraysEqualByValue(prevOrder, currOrder)) {
      sink.push({ kind: 'reordered', path, current: currOrder });
    }
  }
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
 *
 * Matches via a counted multiset keyed by each element's canonicalized string
 * (computed ONCE per element, not per probe) instead of an `O(N*M)`
 * `findIndex` + full re-stringify per comparison — the earlier version diffed
 * a reversed 5,000-element array in roughly 1.5s of synchronous daemon-tick
 * time; this is `O(N+M)` (issue #437 review).
 *
 * Each bucket is consumed with `pop()`, not `shift()`: `shift()` re-indexes
 * every remaining element in the bucket, so a large duplicate-value bucket
 * (many elements canonicalizing to the same string) degenerates to `O(M^2)`
 * on its own — a daemon-tick stall proportional to duplicate count, not just
 * array length (issue #437 follow-up review). Since every element in a
 * bucket is deep-equal by construction (same canonical string), which
 * physical element is matched first is immaterial to the emitted diff.
 */
function diffJsonArrayByDeepEquality(
  sink: DiffEntrySink,
  path: string,
  prev: Record<string, unknown>[],
  curr: Record<string, unknown>[],
): void {
  const prevCanon = prev.map(canonicalizeJson);
  const currCanon = curr.map(canonicalizeJson);

  const remainingByCanon = new Map<string, Record<string, unknown>[]>();
  curr.forEach((element, i) => {
    const canon = currCanon[i] ?? '';
    const bucket = remainingByCanon.get(canon);
    if (bucket) bucket.push(element);
    else remainingByCanon.set(canon, [element]);
  });

  const totalBefore = sink.total;
  for (let i = 0; i < prev.length; i++) {
    const canon = prevCanon[i] ?? '';
    const bucket = remainingByCanon.get(canon);
    if (bucket && bucket.length > 0) {
      bucket.pop();
    } else {
      sink.push({ kind: 'removed', path, value: prev[i] });
    }
  }
  for (const bucket of remainingByCanon.values()) {
    for (const value of bucket) sink.push({ kind: 'added', path, value });
  }

  // Every element matched (a perfect multiset match) but the raw arrays are
  // not byte-identical — the only way that happens is a pure reorder, which
  // is a real change under json-diff's order-sensitive `hasChanged` (see the
  // matching note in diffJsonArrayByKey above). Surface it rather than
  // silently rendering an empty diff (issue #437 follow-up). Compares the
  // already-computed canonical strings (no re-canonicalization).
  if (sink.total === totalBefore) {
    const reordered =
      prevCanon.length !== currCanon.length ||
      prevCanon.some((canon, i) => canon !== currCanon[i]);
    if (reordered) sink.push({ kind: 'reordered', path, current: curr });
  }
}

function diffJsonArrayByIndex(
  sink: DiffEntrySink,
  path: string,
  prev: unknown[],
  curr: unknown[],
): void {
  const max = Math.max(prev.length, curr.length);
  for (let i = 0; i < max; i++) {
    const childPath = indexPath(path, i);
    if (i >= curr.length) {
      sink.push({ kind: 'removed', path: childPath, value: prev[i] });
    } else if (i >= prev.length) {
      sink.push({ kind: 'added', path: childPath, value: curr[i] });
    } else {
      diffJsonValues(sink, childPath, prev[i], curr[i]);
    }
  }
}

function fieldPath(base: string, field: string): string {
  const segment = escapePathSegment(field);
  return base ? `${base}.${segment}` : segment;
}

function indexPath(base: string, index: number): string {
  return `${base}[${String(index)}]`;
}

function keyedElementPath(base: string, key: string, value: string): string {
  return `${base}[${key}=${escapePathSegment(value)}]`;
}

/**
 * Bound and escape an untrusted string (an object key, or an identity-key
 * value) before it is interpolated into a rendered diff path (issue #437
 * review):
 *
 * - Truncates at a code-point boundary (never splitting a surrogate pair) to
 *   {@link MAX_PATH_SEGMENT_LENGTH}, so a pathologically long key/id cannot
 *   inflate `diffText` on its own (a 100,000-char `id` previously produced a
 *   100,345-char one-entry diff).
 * - Backslash-escapes the characters that carry meaning in the rendered path
 *   syntax itself (`.` the field separator, `[`/`]`/`=` the element-path
 *   delimiters, and `\` itself) so an untrusted key/value can never be
 *   confused with path structure — e.g. an object key literally named `[x]`
 *   no longer renders as `+ added[x]: 1`, indistinguishable from the
 *   `[index]`/`[key=value]` array-element syntax.
 * - Escapes control characters (C0, DEL, C1, and the U+2028/U+2029 line/
 *   paragraph separators) to a `\uXXXX` form so an embedded newline can never
 *   fabricate an extra rendered diff line.
 */
function escapePathSegment(value: string): string {
  const { text, truncated } = truncateAtCodePoint(
    value,
    MAX_PATH_SEGMENT_LENGTH,
  );
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '.' || ch === '[' || ch === ']' || ch === '=') {
      out += `\\${ch}`;
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return truncated ? `${out}…` : out;
}

/**
 * Truncate `value` to at most `maxLength` **code points** (never a raw
 * UTF-16 index, which can split a surrogate pair — e.g. an astral emoji —
 * producing a lone surrogate that renders as a garbled escape). Shared by
 * {@link escapePathSegment} and {@link renderJsonValue}/{@link
 * boundTotalOutput} (issue #437 review).
 */
function truncateAtCodePoint(
  value: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  let out = '';
  let count = 0;
  for (const ch of value) {
    if (count >= maxLength) return { text: out, truncated: true };
    out += ch;
    count++;
  }
  return { text: out, truncated: false };
}

/**
 * Structural JSON equality: compares recursively without ever serializing a
 * whole subtree, so an unchanged subtree costs `O(size)` once rather than
 * `O(size)` at every ancestor level that also happens to differ elsewhere
 * (issue #437 review — the old `JSON.stringify(sortKeysDeep(...))`-based
 * check re-canonicalized both entire subtrees at every recursion level of
 * {@link diffJsonValues}). Key order never counts as a change because object
 * comparison checks membership, not position.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) && deepEqualJson(a[k], b[k]),
    );
  }
  return false;
}

/**
 * Canonicalize one value to a key-order-insensitive string, for use as a
 * multiset hash key ({@link diffJsonArrayByDeepEquality}) — computed exactly
 * ONCE per element rather than per pairwise probe. Reuses `sortKeys` from
 * `observation/keyed-collection.ts` (the same key-order-insensitive
 * canonicalization keyed-collection diffing already implements) instead of a
 * duplicate copy (issue #437 review).
 */
function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Elementwise string-array equality, used to detect an identity-key reorder. */
function arraysEqualByValue(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function renderJsonDiffEntries(sink: DiffEntrySink): string {
  const capped = sink.entries.slice(0, MAX_JSON_DIFF_ENTRIES);
  const lines = capped.map(renderJsonDiffEntry);
  if (sink.total > MAX_JSON_DIFF_ENTRIES) {
    lines.push(
      `… ${String(sink.total - MAX_JSON_DIFF_ENTRIES)} more changes elided`,
    );
  }
  return boundTotalOutput(lines.join('\n'));
}

/**
 * Final backstop over the fully-rendered `diffText`: even with every
 * per-entry, per-value, and per-path-segment cap applied, a pathologically
 * deep object graph (many nested field paths, each near its own length cap)
 * could still add up to an oversized string. Truncates at a code-point
 * boundary with an explicit elision marker (issue #437 review).
 *
 * The marker's own length is reserved from the truncation budget FIRST, then
 * appended — truncating to `MAX_JSON_DIFF_OUTPUT_LENGTH` and appending the
 * marker afterward would let the marker push the final string past the
 * documented hard cap (issue #437 follow-up review).
 */
function boundTotalOutput(rendered: string): string {
  if (rendered.length <= MAX_JSON_DIFF_OUTPUT_LENGTH) return rendered;
  const marker = `\n… output truncated at ${String(MAX_JSON_DIFF_OUTPUT_LENGTH)} characters`;
  const budget = Math.max(0, MAX_JSON_DIFF_OUTPUT_LENGTH - marker.length);
  const { text } = truncateAtCodePoint(rendered, budget);
  return `${text}${marker}`;
}

/**
 * Render a path suffix for a diff entry label: a field-name path gets a
 * separating space (`removed status: ...`); a bracketed array-element path
 * (`[id=1]`, `[1]`) attaches directly (`removed[id=1]: ...`), and an empty
 * path (whole-element entries with no identity, e.g. deep-equality array
 * matching) attaches nothing (`removed: ...`). A field name that itself began
 * with `[` is unambiguous here because {@link escapePathSegment} always
 * backslash-escapes a literal `[`/`]`/`=` within key/value content — only the
 * unescaped brackets this module generates for real array/keyed-element
 * syntax ever start a path.
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
  const { text, truncated } = truncateAtCodePoint(
    serialized,
    MAX_JSON_DIFF_VALUE_LENGTH,
  );
  return truncated ? `${text}…(truncated)` : serialized;
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
