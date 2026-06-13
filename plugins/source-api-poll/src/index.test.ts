import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import source from './index.js';

describe('source-api-poll', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        text: () => Promise.resolve('{"data": "initial"}'),
        status: 200,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct name and scopeSchema', () => {
    expect(source.name).toBe('api-poll');
    expect(source.scopeSchema).toHaveProperty('properties');
  });

  it('returns no observations on first poll (baseline)', async () => {
    const result = await source.observe(
      {
        url: 'https://api.example.com/data',
      },
      { now: new Date() },
    );
    expect(result.observations).toHaveLength(0);
    expect(result.nextState).toBeDefined();
  });

  it('detects response changes on subsequent polls (text-diff)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('response-v1'),
      status: 200,
    });

    const url = 'https://api.example.com/text-diff-test';
    const baseline = await source.observe({ url }, { now: new Date() });

    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('response-v2'),
      status: 200,
    });

    const result = await source.observe(
      { url },
      { previousState: baseline.nextState, now: new Date() },
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.title).toContain(url);
  });

  it('returns no observations when response is unchanged', async () => {
    const url = 'https://api.example.com/stable-test';

    const baseline = await source.observe({ url }, { now: new Date() });
    const result = await source.observe(
      { url },
      { previousState: baseline.nextState, now: new Date() },
    );
    expect(result.observations).toHaveLength(0);
  });

  it('throws on missing url', async () => {
    await expect(source.observe({}, { now: new Date() })).rejects.toThrow(
      'url',
    );
  });

  describe('change-detection strategies', () => {
    it('status-code: detects status change, ignores body change', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const config = {
        url: 'https://api.example.com/status-test',
        'change-detection': { strategy: 'status-code' },
      };

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('body-v1'),
        status: 200,
      });
      const baseline = await source.observe(config, { now: new Date() });

      // Same status, different body — should NOT fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('body-v2'),
        status: 200,
      });
      const noChange = await source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(noChange.observations).toHaveLength(0);

      // Different status — should fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('body-v2'),
        status: 500,
      });
      const changed = await source.observe(config, {
        previousState: noChange.nextState,
        now: new Date(),
      });
      expect(changed.observations).toHaveLength(1);
    });

    it('json-diff: ignores whitespace differences in JSON', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const config = {
        url: 'https://api.example.com/json-diff-test',
        'change-detection': { strategy: 'json-diff' },
      };

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('{"a": 1,  "b": 2}'),
        status: 200,
      });
      const baseline = await source.observe(config, { now: new Date() });

      // Same JSON with different whitespace — should NOT fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('{"a":1,"b":2}'),
        status: 200,
      });
      const noChange = await source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(noChange.observations).toHaveLength(0);

      // Different JSON value — should fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('{"a":1,"b":3}'),
        status: 200,
      });
      const changed = await source.observe(config, {
        previousState: noChange.nextState,
        now: new Date(),
      });
      expect(changed.observations).toHaveLength(1);
    });
  });

  describe('cursor protocol (003 §13)', () => {
    it('templates the persisted cursor into the URL and extracts the next cursor', async () => {
      const mockFetch = vi.fn(async (input: string) => {
        const since = new URL(input).searchParams.get('since');
        const cursor = String(Number(since) + 1);
        const changes = since === '2' ? [{ id: 'a', value: 1 }] : [];
        return {
          text: () => Promise.resolve(JSON.stringify({ cursor, changes })),
          status: 200,
        };
      });
      vi.stubGlobal('fetch', mockFetch);

      const config = {
        url: 'https://api.example.com/changes?since={{state}}',
        'change-detection': { strategy: 'json-diff' },
        cursor: { initial: '0', 'next-state': '$.cursor' },
      };

      const baseline = await source.observe(config, { now: new Date() });
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://api.example.com/changes?since=0',
        expect.any(Object),
      );
      expect(baseline.observations).toHaveLength(0);
      expect(baseline.nextState).toMatchObject({ cursor: '1' });

      const cursorOnly = await source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://api.example.com/changes?since=1',
        expect.any(Object),
      );
      expect(cursorOnly.observations).toHaveLength(0);
      expect(cursorOnly.nextState).toMatchObject({ cursor: '2' });

      const changed = await source.observe(config, {
        previousState: cursorOnly.nextState,
        now: new Date(),
      });
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://api.example.com/changes?since=2',
        expect.any(Object),
      );
      expect(changed.observations).toHaveLength(1);
      expect(changed.nextState).toMatchObject({ cursor: '3' });
    });
  });

  // Keyed-collection change detection (003 §12) wired through api-poll. The shared
  // diff lives in @agentmonitors/core; these verify api-poll consumes it correctly.
  describe('keyed-collection (003 §12)', () => {
    function mockBody(body: string): void {
      (
        globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        text: () => Promise.resolve(body),
        status: 200,
      });
    }

    const collectionConfig = {
      url: 'https://api.example.com/tasks',
      'change-detection': {
        strategy: 'json-diff',
        collection: { path: '$.tasks', key: 'id' },
      },
    };

    it('baseline run emits nothing', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockBody('{"tasks":[{"id":"a","v":1}]}');
      const result = await source.observe(collectionConfig, {
        now: new Date(),
      });
      expect(result.observations).toHaveLength(0);
    });

    it('a re-sorted collection produces zero observations', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockBody('{"tasks":[{"id":"a","v":1},{"id":"b","v":2}]}');
      const baseline = await source.observe(collectionConfig, {
        now: new Date(),
      });
      mockBody('{"tasks":[{"id":"b","v":2},{"id":"a","v":1}]}');
      const next = await source.observe(collectionConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(next.observations).toHaveLength(0);
    });

    it('one element changing → exactly one modified with keyed objectKey', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockBody('{"tasks":[{"id":"a","v":1},{"id":"b","v":2}]}');
      const baseline = await source.observe(collectionConfig, {
        now: new Date(),
      });
      mockBody('{"tasks":[{"id":"a","v":1},{"id":"b","v":99}]}');
      const next = await source.observe(collectionConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(next.observations).toHaveLength(1);
      expect(next.observations[0]?.changeKind).toBe('modified');
      expect(next.observations[0]?.objectKey).toBe(
        'https://api.example.com/tasks#b',
      );
    });

    it('element addition → created; removal → descoped (not deleted)', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockBody('{"tasks":[{"id":"a","v":1}]}');
      const baseline = await source.observe(collectionConfig, {
        now: new Date(),
      });
      mockBody('{"tasks":[{"id":"a","v":1},{"id":"b","v":2}]}');
      const added = await source.observe(collectionConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(added.observations).toHaveLength(1);
      expect(added.observations[0]?.changeKind).toBe('created');

      mockBody('{"tasks":[{"id":"a","v":1}]}');
      const removed = await source.observe(collectionConfig, {
        previousState: added.nextState,
        now: new Date(),
      });
      expect(removed.observations).toHaveLength(1);
      expect(removed.observations[0]?.changeKind).toBe('descoped');
      expect(removed.observations[0]?.changeKind).not.toBe('deleted');
      expect(removed.observations[0]?.objectKey).toBe(
        'https://api.example.com/tasks#b',
      );
    });

    it('ignore-paths removes churn fields before comparison', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const ignoreConfig = {
        url: 'https://api.example.com/tasks',
        'change-detection': {
          strategy: 'json-diff',
          collection: {
            path: '$.tasks',
            key: 'id',
            'ignore-paths': ['$.fetchedAt'],
          },
        },
      };
      mockBody('{"tasks":[{"id":"a","v":1,"fetchedAt":"t0"}]}');
      const baseline = await source.observe(ignoreConfig, { now: new Date() });
      // Only fetchedAt differs — must NOT fire.
      mockBody('{"tasks":[{"id":"a","v":1,"fetchedAt":"t1"}]}');
      const next = await source.observe(ignoreConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(next.observations).toHaveLength(0);
    });

    it('rejects collection under a non-json-diff strategy at observe time', async () => {
      await expect(
        source.observe(
          {
            url: 'https://api.example.com/tasks',
            'change-detection': {
              strategy: 'text-diff',
              collection: { path: '$.tasks', key: 'id' },
            },
          },
          { now: new Date() },
        ),
      ).rejects.toThrow(/requires strategy: json-diff/);
    });
  });

  describe('cache isolation', () => {
    it('different configs for same URL maintain separate baselines', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const url = 'https://api.example.com/shared-url';
      const config1 = { url, headers: { 'X-Api-Key': 'key-1' } };
      const config2 = { url, headers: { 'X-Api-Key': 'key-2' } };

      // Baseline for config1
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('response-for-key-1'),
        status: 200,
      });
      await source.observe(config1, { now: new Date() });

      // First poll for config2 should be baseline (no observation), not
      // inherit config1's cached response
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('response-for-key-2'),
        status: 200,
      });
      const result = await source.observe(config2, { now: new Date() });
      expect(result.observations).toHaveLength(0);
    });
  });
});
