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

  // Regression for PR #107 Copilot review: a path that begins with `$` but is
  // NOT proper explicit-root (`$` or `$.field`) is a malformed root, not a bare
  // root-relative path. It must surface an authoring error rather than silently
  // becoming `$.$tasks` and looking up a literal `$tasks` field.
  it('rejects a `$`-prefixed path that is not explicit-root form (e.g. "$tasks")', () => {
    // Throwing (rather than returning the `$tasks` array) is the whole point:
    // the author mistake surfaces instead of silently resolving the wrong field.
    expect(() =>
      resolveDottedPath({ $tasks: [{ id: 'a' }] }, '$tasks'),
    ).toThrow(/must be.*explicit-root/i);
  });

  it('still resolves a bare path whose field name happens to contain `$` (no leading `$`)', () => {
    // Leniency applies to truly bare paths; a non-leading `$` is a plain field char.
    expect(resolveDottedPath({ a$b: 1 }, 'a$b')).toBe(1);
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

// Issue #449 review: the scope-half truncation branch had no direct coverage —
// the suite only used the short `mon` scope, so reverting the bound would have
// stayed green. A `command-poll` collection's scope is the joined argv, which is
// exactly the unbounded case (003 §2.8).
describe('diffKeyedCollection — long monitor scope in display text (003 §2.8)', () => {
  /** A joined-argv-shaped scope well past the 60-char display bound. */
  const LONG_SCOPE = `sh -c gh pr list --json number,state --jq ${'[.[] | {number}]'.repeat(6)}`;

  function diffWithScope(
    previous: unknown,
    current: unknown,
  ): ReturnType<typeof diffKeyedCollection> {
    const base = diffKeyedCollection(
      previous,
      TASKS_CONFIG,
      LONG_SCOPE,
      undefined,
    );
    return diffKeyedCollection(
      current,
      TASKS_CONFIG,
      LONG_SCOPE,
      base.snapshot,
    );
  }

  it('bounds the scope half of the title while keeping the item key whole', () => {
    const result = diffWithScope(
      { tasks: [{ id: 'pr-443', state: 'OPEN' }] },
      { tasks: [{ id: 'pr-443', state: 'MERGED' }] },
    );

    const obs = result.observations[0];
    expect(obs).toBeDefined();
    // The scope is truncated in DISPLAY text…
    expect(obs?.title).not.toContain(LONG_SCOPE);
    expect(obs?.title).toContain('…');
    // …but the informative per-item key is never cut off by it.
    expect(obs?.title?.endsWith('#pr-443')).toBe(true);
    expect(obs?.summary).toBe(obs?.title);
    // …while the full `<scope>#<key>` identity is preserved untouched.
    expect(obs?.objectKey).toBe(`${LONG_SCOPE}#pr-443`);
    expect(obs?.queryScope?.['objectKey']).toBe(`${LONG_SCOPE}#pr-443`);
  });

  it('keeps a long item key whole even though the scope is bounded', () => {
    const longKey = `pr-${'9'.repeat(80)}`;
    const result = diffWithScope(
      { tasks: [{ id: longKey, state: 'OPEN' }] },
      { tasks: [{ id: longKey, state: 'MERGED' }] },
    );

    const obs = result.observations[0];
    // The item key is the informative half — it is never truncated, even when
    // it alone exceeds the scope bound.
    expect(obs?.title?.endsWith(`#${longKey}`)).toBe(true);
    expect(obs?.objectKey).toBe(`${LONG_SCOPE}#${longKey}`);
  });
});

describe('diffKeyedCollection — displayScope credential redaction (issue #449 review)', () => {
  // A credential-bearing monitor scope, mirroring api-poll's URL-as-scope
  // shape. Regression: the older behavior always interpolated
  // `monitorObjectKey` itself into the display title/summary, so a
  // keyed-collection observation from a URL-scoped source (api-poll) would
  // leak userinfo/query credentials into durable, delivered text even though
  // the equivalent non-collection branch had already been redacted.
  const RAW_SCOPE =
    'https://user:pass@status.example.com/incidents?token=secret#frag';
  const REDACTED_SCOPE = 'https://status.example.com/incidents';

  function diffWithDisplayScope(
    previous: unknown,
    current: unknown,
  ): ReturnType<typeof diffKeyedCollection> {
    const base = diffKeyedCollection(
      previous,
      TASKS_CONFIG,
      RAW_SCOPE,
      undefined,
      undefined,
      REDACTED_SCOPE,
    );
    return diffKeyedCollection(
      current,
      TASKS_CONFIG,
      RAW_SCOPE,
      base.snapshot,
      undefined,
      REDACTED_SCOPE,
    );
  }

  it('renders title/summary from the redacted displayScope, never the raw credential-bearing scope', () => {
    const result = diffWithDisplayScope(
      { tasks: [{ id: 'incident-1', state: 'OPEN' }] },
      { tasks: [{ id: 'incident-1', state: 'RESOLVED' }] },
    );

    const obs = result.observations[0];
    expect(obs).toBeDefined();
    expect(obs?.title).toBe(
      'Item changed: https://status.example.com/incidents#incident-1',
    );
    expect(obs?.summary).toBe(obs?.title);
    for (const secret of ['user:pass', 'token=secret', 'frag']) {
      expect(obs?.title).not.toContain(secret);
      expect(obs?.summary).not.toContain(secret);
    }
  });

  it('preserves the full raw scope (with credentials) in objectKey/queryScope for identity, not display', () => {
    const result = diffWithDisplayScope(
      { tasks: [{ id: 'incident-1', state: 'OPEN' }] },
      { tasks: [{ id: 'incident-1', state: 'RESOLVED' }] },
    );

    const obs = result.observations[0];
    expect(obs?.objectKey).toBe(`${RAW_SCOPE}#incident-1`);
    expect(obs?.queryScope?.['objectKey']).toBe(`${RAW_SCOPE}#incident-1`);
  });

  it('defaults displayScope to monitorObjectKey when omitted (no accidental redaction of a non-credential scope)', () => {
    const result = diffKeyedCollection(
      { tasks: [{ id: 'incident-1', state: 'RESOLVED' }] },
      TASKS_CONFIG,
      'plain-scope',
      { 'incident-1': { id: 'incident-1', state: 'OPEN' } },
    );

    const obs = result.observations[0];
    expect(obs?.title).toBe('Item changed: plain-scope#incident-1');
  });
});
