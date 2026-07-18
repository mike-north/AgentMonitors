/**
 * Tests for the `diffText` renderers (002 §5.2).
 *
 * `buildTextDiff` is the line-level unified-style renderer used by default.
 * `buildDiff`/`buildJsonDiff` add a **structural** renderer for
 * `change-detection.strategy: json-diff` objects (issue #437): compact-JSON
 * snapshots previously degraded `buildTextDiff` into a whole-line
 * remove-all/add-all because the entire array serialized onto one line.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2
 * @see ../../../../docs/specs/003-source-plugins.md §11.3, §4.2 (json-diff strategy)
 */
import { describe, expect, it } from 'vitest';
import {
  buildDiff,
  buildJsonDiff,
  buildTextDiff,
  changeDetectionStrategyOf,
} from './diff.js';

describe('changeDetectionStrategyOf', () => {
  it('reads the strategy field off snapshot metadata', () => {
    expect(changeDetectionStrategyOf({ strategy: 'json-diff' })).toBe(
      'json-diff',
    );
  });

  it('returns undefined for metadata without a strategy field', () => {
    expect(changeDetectionStrategyOf({ command: ['gh', 'pr', 'list'] })).toBe(
      undefined,
    );
  });

  it('returns undefined for a non-string strategy value', () => {
    expect(changeDetectionStrategyOf({ strategy: 42 })).toBe(undefined);
  });

  it('returns undefined for null, arrays, and non-objects', () => {
    expect(changeDetectionStrategyOf(null)).toBe(undefined);
    expect(changeDetectionStrategyOf(['strategy'])).toBe(undefined);
    expect(changeDetectionStrategyOf('json-diff')).toBe(undefined);
    expect(changeDetectionStrategyOf(undefined)).toBe(undefined);
  });
});

describe('buildDiff — strategy dispatch', () => {
  // Regression test (issue #437): a `gh pr list --json` style command-poll
  // monitor emits compact single-line JSON. Under the OLD buildTextDiff-only
  // renderer, losing one array element rendered as one ~750-char removed line
  // and one ~700-char added line — the reader had to eyeball two giant lines
  // to find the one changed element. This must FAIL if buildDiff regresses to
  // calling buildTextDiff for `strategy: json-diff`.
  it('AC5: a 5-element compact-JSON array losing one element diffs ONLY the removed element', () => {
    const prev = JSON.stringify([
      { number: 426, title: 'chore: bump deps' },
      { number: 428, title: 'fix(cli): handle empty stdout' },
      { number: 430, title: 'fix(source-command-poll): kill process tree' },
      { number: 431, title: 'docs: update roadmap' },
      { number: 432, title: 'test: add regression coverage' },
    ]);
    // PR 430 merged and left the list.
    const curr = JSON.stringify([
      { number: 426, title: 'chore: bump deps' },
      { number: 428, title: 'fix(cli): handle empty stdout' },
      { number: 431, title: 'docs: update roadmap' },
      { number: 432, title: 'test: add regression coverage' },
    ]);

    const diff = buildDiff(prev, curr, 'json-diff');

    expect(diff).toBe(
      '- removed[number=430]: {"number":430,"title":"fix(source-command-poll): kill process tree"}',
    );
    // The unrelated surviving elements must never appear in the rendered diff.
    expect(diff).not.toContain('426');
    expect(diff).not.toContain('bump deps');
    expect(diff).not.toContain('432');
  });

  it('AC1: renders added/removed/changed structurally, not a text line diff', () => {
    const prev = JSON.stringify({ status: 'queued', retries: 0 });
    const curr = JSON.stringify({ status: 'done', retries: 0 });
    const diff = buildDiff(prev, curr, 'json-diff');
    expect(diff).toBe('~ changed status: "queued" -> "done"');
  });

  it('AC4: text-diff strategy renders identically to buildTextDiff (unchanged)', () => {
    const prev = '{"a":1,"b":2}';
    const curr = '{"a":1,"b":3}';
    expect(buildDiff(prev, curr, 'text-diff')).toBe(buildTextDiff(prev, curr));
  });

  it('AC4: an undefined/omitted strategy renders identically to buildTextDiff (unchanged)', () => {
    const prev = 'line one\nline two';
    const curr = 'line one\nline three';
    expect(buildDiff(prev, curr, undefined)).toBe(buildTextDiff(prev, curr));
  });

  it('AC4: exit-code strategy renders identically to buildTextDiff (unchanged)', () => {
    const prev = 'ok';
    const curr = 'fail';
    expect(buildDiff(prev, curr, 'exit-code')).toBe(buildTextDiff(prev, curr));
  });

  it('falls back to buildTextDiff when json-diff is declared but a side fails to parse', () => {
    const prev = 'not json at all';
    const curr = 'still not json';
    expect(buildDiff(prev, curr, 'json-diff')).toBe(buildTextDiff(prev, curr));
  });

  it('returns empty string when the texts are identical under json-diff', () => {
    const text = '{"a":1}';
    expect(buildDiff(text, text, 'json-diff')).toBe('');
  });

  it('returns empty string under json-diff when only whitespace/key order differs', () => {
    const prev = '{"a":1,"b":2}';
    const curr = '{ "b": 2, "a": 1 }';
    expect(buildDiff(prev, curr, 'json-diff')).toBe('');
  });
});

describe('buildJsonDiff — array of objects', () => {
  it('AC2: diffs by a stable identity key (id) when every element has a unique id', () => {
    const prev = JSON.stringify([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    const curr = JSON.stringify([
      { id: 1, name: 'alpha' },
      { id: 3, name: 'gamma' },
    ]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).toBe(
      [
        '- removed[id=2]: {"id":2,"name":"beta"}',
        '+ added[id=3]: {"id":3,"name":"gamma"}',
      ].join('\n'),
    );
  });

  it('AC2: reports a field-level change for a matched identity as "changed", not remove+add', () => {
    const prev = JSON.stringify([{ id: 1, title: 'Old title' }]);
    const curr = JSON.stringify([{ id: 1, title: 'New title' }]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).toBe('~ changed[id=1].title: "Old title" -> "New title"');
  });

  it('AC2: falls back to deep-equality matching when no field is a unique scalar key', () => {
    // No id/key/uuid/etc. field at all — every candidate key is absent.
    const prev = JSON.stringify([
      { color: 'red', size: 'M' },
      { color: 'blue', size: 'L' },
    ]);
    const curr = JSON.stringify([
      { color: 'blue', size: 'L' },
      { color: 'green', size: 'S' },
    ]);
    const diff = buildJsonDiff(prev, curr);
    // No identity, so a changed element renders as remove + add (no `changed`
    // path attribution) and the untouched {blue,L} element is not repeated.
    expect(diff).toBe(
      [
        '- removed: {"color":"red","size":"M"}',
        '+ added: {"color":"green","size":"S"}',
      ].join('\n'),
    );
  });

  // REGRESSION (issue #437 follow-up, Copilot review thread 3608676215):
  // identity-based array matching (both diffJsonArrayByKey and
  // diffJsonArrayByDeepEquality) is itself order-insensitive — it matches by
  // key/content, not position — but json-diff's `hasChanged` (003 §4.2/§11.3)
  // is array-ORDER-sensitive (it sorts object keys, never array elements), so
  // a pure reorder WOULD have fired a real observation. Before this fix,
  // buildJsonDiff rendered '' for a pure reorder (no removed/added/changed
  // entries found), which violates "change detected ⟺ non-empty diffText":
  // an agent reading an empty diffText for a materialized event would
  // wrongly conclude nothing changed. The chosen semantic is (b): a reorder
  // with no other content change renders an explicit `reordered` entry
  // rather than treating it as a non-change end-to-end — because making
  // detection itself order-insensitive would be a much larger, riskier
  // change to two source plugins' `hasChanged` and would silently drop
  // genuinely meaningful reorders (e.g. a priority-ordered queue).
  it('REGRESSION: a pure reorder of a DEEP-EQUALITY-matched array (no identity key) is a real change and must not render an empty diff', () => {
    const prev = JSON.stringify([{ a: 1 }, { a: 2 }]);
    const curr = JSON.stringify([{ a: 2 }, { a: 1 }]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).not.toBe('');
    expect(diff).toBe('~ reordered: [{"a":2},{"a":1}]');
  });

  it('REGRESSION: a pure reorder of a KEYED array (stable identity key) is a real change and must not render an empty diff', () => {
    const prev = JSON.stringify([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    const curr = JSON.stringify([
      { id: 2, name: 'beta' },
      { id: 1, name: 'alpha' },
    ]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).not.toBe('');
    expect(diff).toBe('~ reordered: ["2","1"]');
  });

  it('a reorder alongside a real content change reports the content change, not a spurious reorder entry', () => {
    const prev = JSON.stringify([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    // Reordered AND element id=2's name changed.
    const curr = JSON.stringify([
      { id: 2, name: 'BETA' },
      { id: 1, name: 'alpha' },
    ]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).toBe('~ changed[id=2].name: "beta" -> "BETA"');
  });

  it('AC2: index-based fallback for an array of primitives', () => {
    const prev = JSON.stringify([1, 2, 3]);
    const curr = JSON.stringify([1, 5, 3]);
    expect(buildJsonDiff(prev, curr)).toBe('~ changed[1]: 2 -> 5');
  });

  it('AC2: index-based fallback reports trailing added/removed primitives', () => {
    const prev = JSON.stringify(['a', 'b']);
    const curr = JSON.stringify(['a', 'b', 'c']);
    expect(buildJsonDiff(prev, curr)).toBe('+ added[2]: "c"');
  });

  it('a key candidate that is not unique within one side is rejected in favor of the next candidate', () => {
    // Two elements share number=1 (not unique) but "id" IS unique — id should win.
    const prev = JSON.stringify([
      { id: 'a', number: 1, v: 'x' },
      { id: 'b', number: 1, v: 'y' },
    ]);
    const curr = JSON.stringify([
      { id: 'a', number: 1, v: 'x' },
      { id: 'c', number: 1, v: 'z' },
    ]);
    const diff = buildJsonDiff(prev, curr);
    expect(diff).toBe(
      [
        '- removed[id=b]: {"id":"b","number":1,"v":"y"}',
        '+ added[id=c]: {"id":"c","number":1,"v":"z"}',
      ].join('\n'),
    );
  });
});

describe('buildJsonDiff — nested key paths', () => {
  it('reports a nested object field change with a dotted path', () => {
    const prev = JSON.stringify({ meta: { count: 4, tag: 'x' } });
    const curr = JSON.stringify({ meta: { count: 5, tag: 'x' } });
    expect(buildJsonDiff(prev, curr)).toBe('~ changed meta.count: 4 -> 5');
  });

  it('reports an added top-level key', () => {
    const prev = JSON.stringify({ a: 1 });
    const curr = JSON.stringify({ a: 1, b: 2 });
    expect(buildJsonDiff(prev, curr)).toBe('+ added b: 2');
  });

  it('reports a removed top-level key', () => {
    const prev = JSON.stringify({ a: 1, b: 2 });
    const curr = JSON.stringify({ a: 1 });
    expect(buildJsonDiff(prev, curr)).toBe('- removed b: 2');
  });

  it('reports a type-mismatch change (object -> scalar) as a single changed entry', () => {
    const prev = JSON.stringify({ a: { nested: true } });
    const curr = JSON.stringify({ a: 'flat' });
    expect(buildJsonDiff(prev, curr)).toBe(
      '~ changed a: {"nested":true} -> "flat"',
    );
  });

  // Copilot review thread 3608676211: diffJsonArrayByDeepEquality previously
  // hardcoded path: '' regardless of where the array appeared, so a nested
  // array's removed/added entries silently lost their field location. A
  // top-level array (path === '') is unaffected — `- removed: {...}` stays
  // exactly as AC1's example — but a NESTED array (no stable identity key)
  // must carry its field path so the reader knows which array changed.
  it('a nested array with no identity key carries its field path on removed/added entries', () => {
    const prev = JSON.stringify({
      items: [{ color: 'red' }, { color: 'blue' }],
    });
    const curr = JSON.stringify({
      items: [{ color: 'blue' }, { color: 'green' }],
    });
    const diff = buildJsonDiff(prev, curr);
    expect(diff).toBe(
      [
        '- removed items: {"color":"red"}',
        '+ added items: {"color":"green"}',
      ].join('\n'),
    );
  });
});

describe('buildJsonDiff — parse failure fallback', () => {
  it('returns undefined when the previous text does not parse as JSON', () => {
    expect(buildJsonDiff('not json', '{"a":1}')).toBe(undefined);
  });

  it('returns undefined when the current text does not parse as JSON', () => {
    expect(buildJsonDiff('{"a":1}', 'not json')).toBe(undefined);
  });

  it('returns undefined when both sides fail to parse', () => {
    expect(buildJsonDiff('not json', 'also not json')).toBe(undefined);
  });
});

describe('buildJsonDiff — bounded output (AC3)', () => {
  it('caps entries and appends an elision marker beyond the entry cap', () => {
    const prevArr = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      v: 'same',
    }));
    const currArr = prevArr.map((el) => ({
      ...el,
      v: `changed-${String(el.id)}`,
    }));
    const diff = buildJsonDiff(
      JSON.stringify(prevArr),
      JSON.stringify(currArr),
    );
    expect(diff).toBeDefined();
    const lines = (diff ?? '').split('\n');
    // 20 changed-entry lines + 1 elision marker line.
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('… 10 more changes elided');
  });

  it('truncates an individual oversized value with a truncation marker', () => {
    const bigValue = 'x'.repeat(1000);
    const prev = JSON.stringify({ blob: 'y' });
    const curr = JSON.stringify({ blob: bigValue });
    const diff = buildJsonDiff(prev, curr) ?? '';
    expect(diff).toContain('…(truncated)');
    // The full 1000-char blob must never appear verbatim in the rendered diff.
    expect(diff).not.toContain(bigValue);
    expect(diff.length).toBeLessThan(400);
  });
});

describe('buildTextDiff — unchanged baseline behavior', () => {
  it('returns empty string for identical text', () => {
    expect(buildTextDiff('same', 'same')).toBe('');
  });

  it('renders a per-line remove/add diff', () => {
    expect(buildTextDiff('a\nb\nc', 'a\nx\nc')).toBe('- 2: b\n+ 2: x');
  });

  it('caps output at 20 changed-line chunks', () => {
    const prevLines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`);
    const currLines = prevLines.map((_, i) => `changed ${String(i)}`);
    const diff = buildTextDiff(prevLines.join('\n'), currLines.join('\n'));
    expect(diff.split('\n')).toHaveLength(20);
  });
});
