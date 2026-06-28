import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import source from './index.js';
import {
  buildCompositeObservation,
  parseCompositeConfig,
  renderCompositeSnapshot,
} from './composite.js';

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

    it('json-diff: warns and falls back to text comparison for non-JSON bodies', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Intentionally quiet: this test asserts the warning text below.
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const config = {
        url: 'https://status.example.com/incidents/123',
        'change-detection': { strategy: 'json-diff' },
      };

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('<html>open</html>'),
        status: 200,
      });
      const baseline = await source.observe(config, { now: new Date() });
      expect(baseline.observations).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('json-diff'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('text-diff'));

      warn.mockClear();
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('<html>resolved</html>'),
        status: 200,
      });
      const changed = await source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(changed.observations).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON'),
      );
    });

    it('json-diff: redacts URL secrets from non-JSON warnings', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Intentionally quiet: this test asserts the warning text below.
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('<html>open</html>'),
        status: 200,
      });
      await source.observe(
        {
          url: 'https://user:secret@status.example.com/incidents/123?token=abc#frag',
          'change-detection': { strategy: 'json-diff' },
        },
        { now: new Date() },
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('https://status.example.com/incidents/123'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'));
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('token=abc'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('frag'));
    });

    it('text-diff: does not warn for non-JSON bodies', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Intentionally quiet: text-diff is the expected HTML/plain-text mode.
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('<html>open</html>'),
        status: 200,
      });
      await source.observe(
        {
          url: 'https://status.example.com/incidents/123',
          'change-detection': { strategy: 'text-diff' },
        },
        { now: new Date() },
      );

      expect(warn).not.toHaveBeenCalled();
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

    it('requires JSON without emitting the plain json-diff text fallback warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Intentionally quiet: collection mode is JSON-only and does not fall back.
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockBody('<html>not json</html>');

      await expect(
        source.observe(collectionConfig, { now: new Date() }),
      ).rejects.toThrow(SyntaxError);
      expect(warn).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // Composite observation (003 §2.6): a source assembles ONE observation from
  // MANY calls — N requests reduced into one stable composite snapshot under a
  // single objectKey. The runtime then diffs that one snapshot against the
  // consumer's baseline exactly as it would a single-call snapshot (§2.5).
  //
  // @see docs/specs/003-source-plugins.md §2.6
  // @see docs/specs/003-source-plugins.md §2.5
  // ---------------------------------------------------------------------------
  describe('composite observation (003 §2.6)', () => {
    /**
     * Mock `fetch` so each part URL returns a body from a lookup table. The mock
     * resolves by URL, so the order the source issues calls in is irrelevant —
     * this lets the determinism test reorder bodies without reordering URLs.
     */
    function mockByUrl(bodies: Record<string, string>): void {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
          const body = bodies[input];
          if (body === undefined) {
            return Promise.reject(new Error(`unexpected fetch: ${input}`));
          }
          return Promise.resolve({
            text: () => Promise.resolve(body),
            status: 200,
          });
        }),
      );
    }

    const compositeConfig = {
      'change-detection': {
        composite: {
          'object-key': 'order-42',
          title: 'Order 42 composite',
          parts: [
            { id: 'header', url: 'https://api.example.com/orders/42' },
            { id: 'line-1', url: 'https://api.example.com/orders/42/lines/1' },
            { id: 'line-2', url: 'https://api.example.com/orders/42/lines/2' },
          ],
        },
      },
    };

    it('reduces N calls into one observation under one objectKey', async () => {
      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"open"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":2}',
      });
      const baseline = await source.observe(compositeConfig, {
        now: new Date(),
      });
      // Baseline run for a stateful source: nothing emitted, cursor established.
      expect(baseline.observations).toHaveLength(0);
      expect(baseline.nextState).toBeDefined();
      // The source issued exactly THREE underlying calls (N=3) on this one
      // observe() — proving the fan-in.
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);

      // One line changes; the whole is re-observed and re-assembled.
      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"open"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":99}',
      });
      const next = await source.observe(compositeConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });

      // Exactly ONE observation — the composite whole, not one per call.
      expect(next.observations).toHaveLength(1);
      const obs = next.observations[0];
      // ONE objectKey for the whole (§2.6), not one per underlying call.
      expect(obs?.objectKey).toBe('order-42');
      // The snapshot is the assembled WHOLE — every part is present, including
      // the unchanged ones — proving it is a composite snapshot, not a delta.
      expect(obs?.snapshotText).toContain('{"status":"open"}');
      expect(obs?.snapshotText).toContain('{"qty":1}');
      expect(obs?.snapshotText).toContain('{"qty":99}');
      // The source returns a snapshot, never a diff (§2.5).
      expect(obs).not.toHaveProperty('diffText');
    });

    it('renders a deterministic snapshot regardless of part-fetch ordering', async () => {
      // Same underlying state, parts declared in a different order: the rendered
      // composite MUST be byte-identical so the runtime diff is not churned by
      // ordering (§2.6 stability requirement).
      const orderA = {
        'change-detection': {
          composite: {
            'object-key': 'k',
            parts: [
              { id: 'b', url: 'https://x/b' },
              { id: 'a', url: 'https://x/a' },
            ],
          },
        },
      };
      const orderB = {
        'change-detection': {
          composite: {
            'object-key': 'k',
            parts: [
              { id: 'a', url: 'https://x/a' },
              { id: 'b', url: 'https://x/b' },
            ],
          },
        },
      };
      const bodies = { 'https://x/a': 'AAA', 'https://x/b': 'BBB' };

      mockByUrl(bodies);
      const a1 = await source.observe(orderA, { now: new Date() });
      mockByUrl(bodies);
      const a2 = await source.observe(orderA, {
        previousState: { composite: 'force-change' },
        now: new Date(),
      });
      mockByUrl(bodies);
      const b2 = await source.observe(orderB, {
        previousState: { composite: 'force-change' },
        now: new Date(),
      });

      expect(a1.observations).toHaveLength(0); // baseline
      // Both declaration orders render the same composite snapshot.
      expect(a2.observations[0]?.snapshotText).toBe(
        b2.observations[0]?.snapshotText,
      );
      // And the source-owned change-detection state is identical, so a re-poll
      // with no underlying change produces no phantom diff.
      expect(a2.nextState).toEqual(b2.nextState);
    });

    it('an unchanged composite emits nothing on re-poll', async () => {
      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"open"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":2}',
      });
      const baseline = await source.observe(compositeConfig, {
        now: new Date(),
      });
      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"open"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":2}',
      });
      const next = await source.observe(compositeConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(next.observations).toHaveLength(0);
    });

    it('a failed underlying call fails the whole observation (baseline preserved)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) =>
          input === 'https://x/a'
            ? Promise.resolve({ text: () => Promise.resolve('A'), status: 200 })
            : Promise.reject(new Error('boom')),
        ),
      );
      const cfg = {
        'change-detection': {
          composite: {
            'object-key': 'k',
            parts: [
              { id: 'a', url: 'https://x/a' },
              { id: 'b', url: 'https://x/b' },
            ],
          },
        },
      };
      // §2.6 partial-failure policy: a failed part throws — nextState never
      // advances, so the prior baseline is preserved (002 §3). We never silently
      // emit a composite missing a part.
      await expect(source.observe(cfg, { now: new Date() })).rejects.toThrow(
        /boom/,
      );
    });

    it('rejects composite combined with keyed-collection (mutually exclusive)', async () => {
      await expect(
        source.observe(
          {
            url: 'https://api.example.com/x',
            'change-detection': {
              strategy: 'json-diff',
              collection: { path: '$.tasks', key: 'id' },
              composite: {
                'object-key': 'k',
                parts: [{ id: 'a', url: 'https://x/a' }],
              },
            },
          },
          { now: new Date() },
        ),
      ).rejects.toThrow(/mutually exclusive/);
    });

    // Fix 1 (Copilot review): a non-string `url` alongside `composite` must be
    // rejected even though `url` is not required in composite mode. A present
    // but wrong-typed `url` is a misconfiguration on any path.
    it('rejects a non-string url even when composite is present', async () => {
      await expect(
        source.observe(
          {
            url: 42, // non-string — must be rejected regardless of composite
            'change-detection': {
              composite: {
                'object-key': 'k',
                parts: [{ id: 'a', url: 'https://x/a' }],
              },
            },
          },
          { now: new Date() },
        ),
      ).rejects.toThrow(/scope\.url must be a string/);
    });

    describe('composite helpers (unit)', () => {
      it('parseCompositeConfig returns undefined when no composite block', () => {
        expect(parseCompositeConfig({ strategy: 'text-diff' })).toBeUndefined();
        expect(parseCompositeConfig(undefined)).toBeUndefined();
      });

      it('parseCompositeConfig rejects an empty parts array', () => {
        expect(() =>
          parseCompositeConfig({ composite: { 'object-key': 'k', parts: [] } }),
        ).toThrow(/non-empty array/);
      });

      it('parseCompositeConfig rejects a missing object-key', () => {
        expect(() =>
          parseCompositeConfig({
            composite: { parts: [{ id: 'a', url: 'https://x/a' }] },
          }),
        ).toThrow(/object-key/);
      });

      it('renderCompositeSnapshot is stable under input reordering', () => {
        const r1 = renderCompositeSnapshot([
          { id: 'b', body: 'B' },
          { id: 'a', body: 'A' },
        ]);
        const r2 = renderCompositeSnapshot([
          { id: 'a', body: 'A' },
          { id: 'b', body: 'B' },
        ]);
        expect(r1).toBe(r2);
      });

      it('buildCompositeObservation carries one objectKey and no diff', () => {
        const parts = [
          { id: 'a', body: 'A' },
          { id: 'b', body: 'B' },
        ];
        // Caller renders once and passes the result; buildCompositeObservation
        // must NOT render again (fix 3).
        const snapshotText = renderCompositeSnapshot(parts);
        const obs = buildCompositeObservation(
          { objectKey: 'whole', parts: [], title: 'T' },
          parts,
          snapshotText,
        );
        expect(obs.objectKey).toBe('whole');
        expect(obs.title).toBe('T');
        expect(obs).not.toHaveProperty('diffText');
        expect(obs.snapshotText).toContain('A');
        expect(obs.snapshotText).toContain('B');
        // The snapshotText is exactly the pre-rendered value (no second render).
        expect(obs.snapshotText).toBe(snapshotText);
      });
    });
  });

  // Integration: drive the composite source through the REAL runtime and prove
  // the runtime — not the source — computes the delivery diff over the one
  // composite snapshot, materializing a single event under the one objectKey.
  describe('composite × runtime integration (003 §2.6 + §2.5)', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      vi.useRealTimers();
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });

    function mockByUrl(bodies: Record<string, string>): void {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
          const body = bodies[input];
          if (body === undefined) {
            return Promise.reject(new Error(`unexpected fetch: ${input}`));
          }
          return Promise.resolve({
            text: () => Promise.resolve(body),
            status: 200,
          });
        }),
      );
    }

    it('reduces N calls into one event under one objectKey, runtime computes the diff', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      const rootDir = mkdtempSync(path.join(tmpdir(), 'api-composite-'));
      tempDirs.push(rootDir);

      const monitorDir = path.join(
        rootDir,
        '.claude',
        'monitors',
        'composite-doc',
      );
      mkdirSync(monitorDir, { recursive: true });
      writeFileSync(
        path.join(monitorDir, 'MONITOR.md'),
        `---
name: Composite document
watch:
  type: api-poll
  interval: '1s'
  change-detection:
    composite:
      object-key: 'doc-7'
      title: 'Document 7'
      parts:
        - id: 'header'
          url: 'https://api.example.com/doc/7'
        - id: 'section-1'
          url: 'https://api.example.com/doc/7/s/1'
        - id: 'section-2'
          url: 'https://api.example.com/doc/7/s/2'
urgency: normal
---
When the document changes, act on it.
`,
        'utf-8',
      );
      const monitorsDir = path.join(rootDir, '.claude', 'monitors');

      const db = createDb(':memory:');
      const registry = new SourceRegistry();
      registry.register(source);
      const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
        claudeCodeAdapter,
      ]);
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'claude-api-composite',
          workspacePath: rootDir,
        }),
      );

      // Tick 1: stateful-source baseline. The composite is assembled from 3 calls
      // but emits no event yet; the runtime has no stored snapshot to diff.
      mockByUrl({
        'https://api.example.com/doc/7': 'TITLE: Draft',
        'https://api.example.com/doc/7/s/1': 'one',
        'https://api.example.com/doc/7/s/2': 'two',
      });
      const baselineTick = await runtime.tick(monitorsDir, rootDir);
      expect(baselineTick.emittedEventIds).toHaveLength(0);

      // First change: one section changes upstream. The composite is re-assembled
      // from 3 calls and ONE event materializes; the runtime stores this as the
      // first baseline snapshot for object `doc-7` (no prior snapshot ⇒ no diff).
      vi.advanceTimersByTime(2_000);
      mockByUrl({
        'https://api.example.com/doc/7': 'TITLE: Draft',
        'https://api.example.com/doc/7/s/1': 'one',
        'https://api.example.com/doc/7/s/2': 'two v2',
      });
      const firstChange = await runtime.tick(monitorsDir, rootDir);
      expect(firstChange.emittedEventIds).toHaveLength(1);

      // Second change: another section edit. The composite is assembled from 3
      // calls again; the RUNTIME diffs the one composite snapshot against the
      // snapshot it stored on the first change — exactly as a single-call
      // snapshot would be diffed (§2.6). The source never computes this diff.
      vi.advanceTimersByTime(2_000);
      mockByUrl({
        'https://api.example.com/doc/7': 'TITLE: Draft',
        'https://api.example.com/doc/7/s/1': 'one',
        'https://api.example.com/doc/7/s/2': 'two v3 CHANGED',
      });
      const secondChange = await runtime.tick(monitorsDir, rootDir);

      // Exactly ONE event per change — the composite whole, under ONE objectKey.
      expect(secondChange.emittedEventIds).toHaveLength(1);
      const events = runtime.listEvents({ sessionId: session.id });
      expect(events).toHaveLength(2);
      for (const e of events) {
        // Every materialized composite event is keyed by the single whole-object
        // key — not one event per underlying call.
        expect(e.objectKey).toBe('doc-7');
      }
      const latest = events.find((e) =>
        e.snapshotText?.includes('two v3 CHANGED'),
      );
      // The runtime produced the diff (the source never does, §2.5) …
      expect(latest?.diffText).not.toBeNull();
      expect(latest?.diffText).toContain('CHANGED');
      // … over the composite whole-state snapshot (all sections present).
      expect(latest?.snapshotText).toContain('TITLE: Draft');
      expect(latest?.snapshotText).toContain('one');
      expect(latest?.snapshotText).toContain('two v3 CHANGED');
    });
  });
});
