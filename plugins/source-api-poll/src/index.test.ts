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

  // Issue #153 item 6: Node fetch wraps the real cause (ECONNREFUSED/DNS/timeout)
  // as err.cause. The source must propagate it so `monitor explain` shows the
  // real reason instead of the generic "fetch failed".
  describe('network error cause propagation (issue #153 item 6)', () => {
    it('surfaces the underlying cause message when fetch throws', async () => {
      const underlying = new Error('connect ECONNREFUSED 127.0.0.1:9999');
      const fetchError = new TypeError('fetch failed');
      // Simulate how Node undici sets the cause
      Object.defineProperty(fetchError, 'cause', {
        value: underlying,
        enumerable: true,
      });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));

      await expect(
        source.observe(
          { url: 'http://127.0.0.1:9999/unreachable' },
          { now: new Date() },
        ),
      ).rejects.toThrow(/fetch failed.*ECONNREFUSED/i);
    });

    it('sets the caught fetchErr as the Error cause property (full chain reachable)', async () => {
      const underlying = new Error('getaddrinfo ENOTFOUND nxdomain.invalid');
      const fetchError = new TypeError('fetch failed');
      Object.defineProperty(fetchError, 'cause', {
        value: underlying,
        enumerable: true,
      });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));

      let thrown: unknown;
      try {
        await source.observe(
          { url: 'http://nxdomain.invalid' },
          { now: new Date() },
        );
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      // The direct cause is the original fetchErr (preserve-caught-error);
      // the underlying network error is reachable as thrown.cause.cause.
      expect((thrown as Error).cause).toBe(fetchError);
      expect(((thrown as Error).cause as TypeError).cause).toBe(underlying);
    });

    it('still throws when fetch fails with no cause', async () => {
      const fetchError = new TypeError('fetch failed');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));

      await expect(
        source.observe(
          { url: 'http://unreachable.invalid' },
          { now: new Date() },
        ),
      ).rejects.toThrow('fetch failed');
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
