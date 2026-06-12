/**
 * Tests for keyed-collection change detection (003 §12).
 *
 * @see ../../../../docs/specs/003-source-plugins.md §12
 *
 * The §12 contract: parsed JSON output is treated as a collection of keyed objects;
 * each element becomes a tracked object with `objectKey = <monitorObjectKey>#<key>`;
 * per-object observations use the `created` / `modified` / `descoped` vocabulary
 * (never `deleted`); the baseline run records the snapshot and emits nothing;
 * reordering and whitespace are inherently ignored; `ignore-paths` fields are removed
 * before comparison; and `path` must select exactly one array.
 */
import { describe, expect, it } from 'vitest';
import {
  diffKeyedCollection,
  parseKeyedCollectionConfig,
  resolveDottedPath,
  type KeyedCollectionConfig,
} from './keyed-collection.js';

const MONITOR_KEY = 'mon';

/** Baseline → return the snapshot for the next diff. Reused across cases. */
function baseline(
  output: unknown,
  config: KeyedCollectionConfig,
): ReturnType<typeof diffKeyedCollection> {
  return diffKeyedCollection(output, config, MONITOR_KEY, undefined);
}

const TASKS_CONFIG: KeyedCollectionConfig = { path: '$.tasks', key: 'id' };

describe('parseKeyedCollectionConfig', () => {
  it('returns undefined when no collection block is present', () => {
    expect(
      parseKeyedCollectionConfig({ strategy: 'json-diff' }),
    ).toBeUndefined();
    expect(parseKeyedCollectionConfig(undefined)).toBeUndefined();
  });

  it('parses a full collection block including ignore-paths', () => {
    const parsed = parseKeyedCollectionConfig({
      strategy: 'json-diff',
      collection: {
        path: '$.tasks',
        key: 'id',
        'ignore-paths': ['$.fetchedAt'],
      },
    });
    expect(parsed).toEqual({
      path: '$.tasks',
      key: 'id',
      ignorePaths: ['$.fetchedAt'],
    });
  });

  it('parses bare dotted path strings for author-friendly monitor config', () => {
    const parsed = parseKeyedCollectionConfig({
      strategy: 'json-diff',
      collection: {
        path: 'tasks',
        key: 'id',
        'ignore-paths': ['fetchedAt'],
      },
    });
    expect(parsed).toEqual({
      path: 'tasks',
      key: 'id',
      ignorePaths: ['fetchedAt'],
    });
  });

  it('rejects a collection block missing path', () => {
    expect(() =>
      parseKeyedCollectionConfig({ collection: { key: 'id' } }),
    ).toThrow(/path/);
  });

  it('rejects a collection block missing key', () => {
    expect(() =>
      parseKeyedCollectionConfig({ collection: { path: '$.tasks' } }),
    ).toThrow(/key/);
  });

  it('rejects non-string ignore-paths', () => {
    expect(() =>
      parseKeyedCollectionConfig({
        collection: { path: '$.tasks', key: 'id', 'ignore-paths': [42] },
      }),
    ).toThrow(/ignore-paths/);
  });
});

describe('resolveDottedPath', () => {
  it('resolves the root and nested segments', () => {
    expect(resolveDottedPath({ a: 1 }, '$')).toEqual({ a: 1 });
    expect(resolveDottedPath({ a: { b: [1, 2] } }, '$.a.b')).toEqual([1, 2]);
  });

  it('returns undefined for a missing segment', () => {
    expect(resolveDottedPath({ a: {} }, '$.a.missing')).toBeUndefined();
  });

  it('accepts bare dotted paths as root-relative', () => {
    expect(resolveDottedPath({ tasks: [{ id: 'a' }] }, 'tasks')).toEqual([
      { id: 'a' },
    ]);
    expect(
      resolveDottedPath({ data: { tasks: [1, 2] } }, 'data.tasks'),
    ).toEqual([1, 2]);
  });

  it('rejects an empty path segment', () => {
    expect(() => resolveDottedPath({}, '$.a..b')).toThrow(/empty path segment/);
  });

  it('rejects index-access syntax (e.g. $.tasks[0])', () => {
    expect(() => resolveDottedPath({}, '$.tasks[0]')).toThrow(
      /unsupported syntax/,
    );
  });

  it('rejects wildcard syntax (e.g. $.tasks.*)', () => {
    expect(() => resolveDottedPath({}, '$.tasks.*')).toThrow(
      /unsupported syntax/,
    );
  });
});

describe('diffKeyedCollection — baseline (003 §12)', () => {
  it('emits nothing on the first run and records the snapshot', () => {
    const result = baseline(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      },
      TASKS_CONFIG,
    );
    expect(result.observations).toHaveLength(0);
    expect(Object.keys(result.snapshot).sort()).toEqual(['a', 'b']);
  });
});

describe('diffKeyedCollection — reordering & whitespace (003 §12)', () => {
  it('a re-sorted collection produces ZERO observations', () => {
    const first = baseline(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
          { id: 'c', v: 3 },
        ],
      },
      TASKS_CONFIG,
    );
    // Same elements, reversed order.
    const next = diffKeyedCollection(
      {
        tasks: [
          { id: 'c', v: 3 },
          { id: 'b', v: 2 },
          { id: 'a', v: 1 },
        ],
      },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(0);
  });

  it('per-element key reordering produces zero observations', () => {
    const first = baseline({ tasks: [{ id: 'a', x: 1, y: 2 }] }, TASKS_CONFIG);
    const next = diffKeyedCollection(
      { tasks: [{ y: 2, x: 1, id: 'a' }] },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(0);
  });
});

describe('diffKeyedCollection — modified (003 §12)', () => {
  it('one element changing → exactly one `modified` with keyed objectKey', () => {
    const first = baseline(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      },
      TASKS_CONFIG,
    );
    const next = diffKeyedCollection(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 99 },
        ],
      },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(1);
    const obs = next.observations[0];
    expect(obs?.changeKind).toBe('modified');
    expect(obs?.objectKey).toBe('mon#b');
  });
});

describe('diffKeyedCollection — created / descoped (003 §12)', () => {
  it('element addition → `created`', () => {
    const first = baseline({ tasks: [{ id: 'a', v: 1 }] }, TASKS_CONFIG);
    const next = diffKeyedCollection(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(1);
    expect(next.observations[0]?.changeKind).toBe('created');
    expect(next.observations[0]?.objectKey).toBe('mon#b');
  });

  it('element removal → `descoped` (NOT `deleted`)', () => {
    const first = baseline(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      },
      TASKS_CONFIG,
    );
    const next = diffKeyedCollection(
      { tasks: [{ id: 'a', v: 1 }] },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(1);
    expect(next.observations[0]?.changeKind).toBe('descoped');
    expect(next.observations[0]?.changeKind).not.toBe('deleted');
    expect(next.observations[0]?.objectKey).toBe('mon#b');
  });

  it('mixed create + modify + descope in one cycle', () => {
    const first = baseline(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      },
      TASKS_CONFIG,
    );
    const next = diffKeyedCollection(
      {
        tasks: [
          { id: 'a', v: 1 },
          { id: 'b', v: 99 },
          { id: 'c', v: 3 },
        ],
      },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    const byKind = Object.fromEntries(
      next.observations.map((o) => [o.objectKey, o.changeKind]),
    );
    expect(byKind).toEqual({ 'mon#b': 'modified', 'mon#c': 'created' });
    // 'a' unchanged → no observation for it.
    expect(byKind['mon#a']).toBeUndefined();
  });
});

describe('diffKeyedCollection — ignore-paths (003 §12)', () => {
  const CONFIG_IGNORE: KeyedCollectionConfig = {
    path: '$.tasks',
    key: 'id',
    ignorePaths: ['$.fetchedAt'],
  };

  it('a differing ignore-path field produces NO observation', () => {
    const first = baseline(
      { tasks: [{ id: 'a', v: 1, fetchedAt: '2026-06-12T00:00:00Z' }] },
      CONFIG_IGNORE,
    );
    const next = diffKeyedCollection(
      { tasks: [{ id: 'a', v: 1, fetchedAt: '2026-06-12T09:99:99Z' }] },
      CONFIG_IGNORE,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(0);
  });

  it('a real content change still fires even when an ignore-path also differs', () => {
    const first = baseline(
      { tasks: [{ id: 'a', v: 1, fetchedAt: 't0' }] },
      CONFIG_IGNORE,
    );
    const next = diffKeyedCollection(
      { tasks: [{ id: 'a', v: 2, fetchedAt: 't1' }] },
      CONFIG_IGNORE,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(1);
    expect(next.observations[0]?.changeKind).toBe('modified');
  });

  it('accepts bare ignore-path entries as element-relative paths', () => {
    const config: KeyedCollectionConfig = {
      path: 'tasks',
      key: 'id',
      ignorePaths: ['fetchedAt'],
    };
    const first = baseline(
      { tasks: [{ id: 'a', v: 1, fetchedAt: 't0' }] },
      config,
    );
    const next = diffKeyedCollection(
      { tasks: [{ id: 'a', v: 1, fetchedAt: 't1' }] },
      config,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations).toHaveLength(0);
  });
});

describe('diffKeyedCollection — path must select one array (003 §12)', () => {
  it('throws when path resolves to a non-array', () => {
    expect(() =>
      baseline({ tasks: { not: 'an array' } }, TASKS_CONFIG),
    ).toThrow(/must select an array/);
  });

  it('throws when path resolves to nothing', () => {
    expect(() => baseline({ other: [] }, TASKS_CONFIG)).toThrow(
      /must select an array/,
    );
  });

  it('supports a nested path', () => {
    const result = baseline(
      { data: { items: [{ id: 'x', v: 1 }] } },
      { path: '$.data.items', key: 'id' },
    );
    expect(Object.keys(result.snapshot)).toEqual(['x']);
  });
});

describe('diffKeyedCollection — key handling', () => {
  it('renders numeric keys as strings in objectKey', () => {
    const first = baseline({ tasks: [{ id: 1, v: 1 }] }, TASKS_CONFIG);
    const next = diffKeyedCollection(
      { tasks: [{ id: 1, v: 2 }] },
      TASKS_CONFIG,
      MONITOR_KEY,
      first.snapshot,
    );
    expect(next.observations[0]?.objectKey).toBe('mon#1');
  });

  it('throws when an element is missing the key field', () => {
    expect(() => baseline({ tasks: [{ v: 1 }] }, TASKS_CONFIG)).toThrow(
      /key field "id"/,
    );
  });

  it('throws on a duplicate key value within the collection', () => {
    expect(() =>
      baseline(
        {
          tasks: [
            { id: 'a', v: 1 },
            { id: 'a', v: 2 },
          ],
        },
        TASKS_CONFIG,
      ),
    ).toThrow(/not unique/);
  });
});
