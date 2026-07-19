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
    // Regression: an unrecognized but *present* strategy value must throw
    // immediately rather than silently falling through to Content-Type inference.
    // Before the fix, e.g. `strategy: jsondiff` (typo) would set
    // `explicitStrategy = undefined` and infer from Content-Type — violating
    // "explicit always wins" and hiding the author error.
    it('unrecognized explicit strategy throws a descriptive error and does NOT infer', async () => {
      await expect(
        source.observe(
          {
            url: 'https://api.example.com/data',
            'change-detection': { strategy: 'jsondiff' }, // typo — not a valid strategy
          },
          { now: new Date() },
        ),
      ).rejects.toThrow(
        /unknown change-detection\.strategy "jsondiff" \(expected one of: json-diff, text-diff, status-code\)/,
      );
    });

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

  // Issue #220: a non-2xx response must become an errored observation (the
  // source throws) rather than silently baselining on the error body — except
  // for the status-code strategy, where a non-2xx is a legitimate observed
  // signal. The runtime turns a thrown observe() into an `errored` history row;
  // these tests assert at the source layer (throw / no-throw) which is what
  // that behavior is built on.
  describe('non-2xx → errored observation (issue #220)', () => {
    function mockStatus(body: string, status: number): void {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          text: () => Promise.resolve(body),
          status,
        }),
      );
    }

    it('AC1/AC2: 401 throws a status-bearing error and establishes no baseline (text-diff)', async () => {
      mockStatus('Unauthorized', 401);
      const url = 'https://api.example.com/secured';
      await expect(
        source.observe({ url }, { now: new Date() }),
      ).rejects.toThrow(/api-poll received HTTP 401/);
      // Message identifies the status and the "not establishing a baseline" intent.
      await expect(
        source.observe({ url }, { now: new Date() }),
      ).rejects.toThrow(/not establishing a baseline on an error response/);
    });

    it('redacts userinfo + query credentials from the non-2xx error message (single URL)', async () => {
      // The thrown Error.message is persisted durably to observation_history and
      // shown in daemon output, and a 401/403 is the most common credential
      // failure — so it must never echo the raw credential-bearing URL. Assert
      // the secrets are ABSENT, not merely that some redaction happened.
      mockStatus('Unauthorized', 401);
      const url =
        'https://user:secretpass@api.example.com/secured?token=SECRETTOKEN';
      const observe = source.observe({ url }, { now: new Date() });
      await expect(observe).rejects.toThrow(/api-poll received HTTP 401/);
      let message = '';
      try {
        await source.observe({ url }, { now: new Date() });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      // Host is preserved for diagnosability.
      expect(message).toContain('api.example.com');
      // Credentials and request-scoped tokens are stripped.
      expect(message).not.toContain('secretpass');
      expect(message).not.toContain('SECRETTOKEN');
      expect(message).not.toContain('user:');
      // The userinfo `@` separator is gone (host-only form has no `@`).
      expect(message).not.toContain('@');
      // Note: the hardened `new URL()`-failure fallback (returns the fixed
      // '[unparseable url redacted]' placeholder) is not exercised here because
      // `redactUrlForWarning` is not exported and the only reachable path
      // requires a string that passes scope.url validation and `fetch` yet fails
      // `new URL()` — `fetch` itself rejects such input first, so the fallback
      // has no public test seam. It is covered by inspection of the helper.
    });

    it('AC1: 500 throws (json-diff) — no silent baseline on an error page', async () => {
      mockStatus('<html>Internal Server Error</html>', 500);
      await expect(
        source.observe(
          {
            url: 'https://api.example.com/json',
            'change-detection': { strategy: 'json-diff' },
          },
          { now: new Date() },
        ),
      ).rejects.toThrow(/api-poll received HTTP 500/);
    });

    it('AC1: 404 throws (default text-diff)', async () => {
      mockStatus('Not Found', 404);
      await expect(
        source.observe(
          { url: 'https://api.example.com/missing' },
          { now: new Date() },
        ),
      ).rejects.toThrow(/api-poll received HTTP 404/);
    });

    it('AC3: a 2xx response baselines exactly as before (no regression)', async () => {
      mockStatus('{"ok":true}', 200);
      const result = await source.observe(
        { url: 'https://api.example.com/ok' },
        { now: new Date() },
      );
      expect(result.observations).toHaveLength(0);
      expect(result.nextState).toBeDefined();
    });

    it('AC3: 2xx success boundaries (200, 204, 299) baseline; 300 errors', async () => {
      for (const status of [200, 204, 299]) {
        mockStatus('body', status);
        const result = await source.observe(
          { url: `https://api.example.com/edge-${String(status)}` },
          { now: new Date() },
        );
        expect(result.nextState).toBeDefined();
      }
      mockStatus('redirect', 300);
      await expect(
        source.observe(
          { url: 'https://api.example.com/edge-300' },
          { now: new Date() },
        ),
      ).rejects.toThrow(/api-poll received HTTP 300/);
    });

    it('exception: status-code strategy does NOT throw on a non-2xx (status is the watched signal)', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const config = {
        url: 'https://api.example.com/health',
        'change-detection': { strategy: 'status-code' },
      };
      // Baseline on a healthy 200.
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('ok'),
        status: 200,
      });
      const baseline = await source.observe(config, { now: new Date() });
      expect(baseline.observations).toHaveLength(0);
      // Endpoint goes 200 -> 503: must be observed, not thrown.
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('down'),
        status: 503,
      });
      const changed = await source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(changed.observations).toHaveLength(1);
    });
  });

  // Issue #219: json-diff against a non-JSON body silently degrades to text
  // comparison. The source must surface a non-fatal warning so `monitor test`
  // can steer the author to text-diff, without changing the observation outcome.
  describe('json-diff on non-JSON body → warning (issue #219)', () => {
    function mockBody(body: string): void {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          text: () => Promise.resolve(body),
          status: 200,
        }),
      );
    }

    it('warns when json-diff is configured but the body is not JSON', async () => {
      mockBody('<!DOCTYPE html><html><body>Status page</body></html>');
      const result = await source.observe(
        {
          url: 'https://status.example.com/incidents',
          'change-detection': { strategy: 'json-diff' },
        },
        { now: new Date() },
      );
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toMatch(/json-diff/);
      expect(result.warnings?.[0]).toMatch(/does not parse as JSON/);
      expect(result.warnings?.[0]).toMatch(/text-diff/);
    });

    it('redacts credentials, query, and fragment from the non-JSON warning URL', async () => {
      mockBody('<!DOCTYPE html><html><body>Status page</body></html>');
      const result = await source.observe(
        {
          url: 'https://user:pass@status.example.com/incidents?token=secret#frag',
          'change-detection': { strategy: 'json-diff' },
        },
        { now: new Date() },
      );
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain(
        'https://status.example.com/incidents',
      );
      expect(result.warnings?.[0]).not.toContain('user');
      expect(result.warnings?.[0]).not.toContain('pass');
      expect(result.warnings?.[0]).not.toContain('token=secret');
      expect(result.warnings?.[0]).not.toContain('#frag');
    });

    it('does NOT warn when json-diff body parses as JSON', async () => {
      mockBody('{"status":"operational"}');
      const result = await source.observe(
        {
          url: 'https://api.example.com/status.json',
          'change-detection': { strategy: 'json-diff' },
        },
        { now: new Date() },
      );
      // Absent or empty — no warning for a valid JSON body.
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('does NOT warn for text-diff against a non-JSON body (correct strategy)', async () => {
      mockBody('<html>page</html>');
      const result = await source.observe(
        {
          url: 'https://status.example.com/page',
          'change-detection': { strategy: 'text-diff' },
        },
        { now: new Date() },
      );
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('does NOT warn for the default (text-diff) strategy', async () => {
      mockBody('<html>page</html>');
      const result = await source.observe(
        { url: 'https://status.example.com/page' },
        { now: new Date() },
      );
      expect(result.warnings ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #230: infer change-detection strategy from the response Content-Type
  // when `change-detection.strategy` is OMITTED. An explicit value always wins
  // verbatim (no inference, no override). The inferred path never warns, because
  // inference picks the correct strategy for the body.
  //
  // @see docs/specs/003-source-plugins.md §4.3
  // @see https://www.rfc-editor.org/rfc/rfc6838#section-4.2.8 (+json suffix)
  // ---------------------------------------------------------------------------
  describe('strategy inference from Content-Type (issue #230)', () => {
    /**
     * Mock a two-poll sequence (baseline then a changed body) for one URL, with
     * an optional `Content-Type` header. Returns the observation produced by the
     * second poll so a test can assert the *resolved* strategy (carried on
     * `payload.strategy`) and the surfaced warnings.
     */
    async function observeWithContentType(
      config: Record<string, unknown>,
      contentType: string | undefined,
      bodies: { first: string; second: string },
    ): Promise<Awaited<ReturnType<typeof source.observe>>> {
      const headers =
        contentType === undefined
          ? undefined
          : {
              get: (name: string) =>
                name === 'content-type' ? contentType : null,
            };
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(bodies.first),
        status: 200,
        headers,
      });
      const baseline = await source.observe(config, { now: new Date() });

      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(bodies.second),
        status: 200,
        headers,
      });
      return source.observe(config, {
        previousState: baseline.nextState,
        now: new Date(),
      });
    }

    // AC1: omitted + application/json → json-diff
    it('omitted strategy + application/json → json-diff', async () => {
      const result = await observeWithContentType(
        { url: 'https://api.example.com/data.json' },
        'application/json',
        { first: '{"v":1}', second: '{"v":2}' },
      );
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.payload?.['strategy']).toBe('json-diff');
    });

    // AC1: a structured-syntax +json suffix (e.g. application/ld+json) → json-diff
    it('omitted strategy + application/ld+json (charset param) → json-diff', async () => {
      const result = await observeWithContentType(
        { url: 'https://api.example.com/feed' },
        'application/ld+json; charset=utf-8',
        { first: '{"v":1}', second: '{"v":2}' },
      );
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.payload?.['strategy']).toBe('json-diff');
    });

    // AC1: omitted + text/html → text-diff
    it('omitted strategy + text/html → text-diff', async () => {
      const result = await observeWithContentType(
        { url: 'https://example.com/page' },
        'text/html; charset=utf-8',
        { first: '<html>v1</html>', second: '<html>v2</html>' },
      );
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.payload?.['strategy']).toBe('text-diff');
    });

    // AC1: omitted + missing Content-Type → text-diff
    it('omitted strategy + missing Content-Type → text-diff', async () => {
      const result = await observeWithContentType(
        { url: 'https://example.com/unknown' },
        undefined,
        { first: 'plain v1', second: 'plain v2' },
      );
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.payload?.['strategy']).toBe('text-diff');
    });

    // AC3: an inferred strategy NEVER warns, even when a JSON Content-Type body
    // happens not to parse — inference is by header, not body, and never claims
    // a json-diff mismatch.
    it('inferred json-diff does NOT emit the #219 warning', async () => {
      const result = await observeWithContentType(
        { url: 'https://api.example.com/maybe.json' },
        'application/json',
        { first: '{"v":1}', second: '{"v":2}' },
      );
      expect(result.warnings ?? []).toHaveLength(0);
    });

    // AC2: explicit json-diff wins over a text/html Content-Type (honored, NOT
    // overridden to text-diff) AND emits the #219 warning for the non-JSON body.
    it('explicit json-diff + text/html → json-diff (honored) and warns', async () => {
      const result = await observeWithContentType(
        {
          url: 'https://status.example.com/incidents',
          'change-detection': { strategy: 'json-diff' },
        },
        'text/html; charset=utf-8',
        {
          first: '<html>v1</html>',
          second: '<html>v2</html>',
        },
      );
      expect(result.observations).toHaveLength(1);
      // Honored verbatim: strategy is json-diff despite the HTML Content-Type.
      expect(result.observations[0]?.payload?.['strategy']).toBe('json-diff');
      // And the #219 warning fires for the explicit json-diff-on-non-JSON case.
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toMatch(/json-diff/);
      expect(result.warnings?.[0]).toMatch(/does not parse as JSON/);
    });

    // AC2: explicit text-diff wins over an application/json Content-Type
    // (honored, NOT overridden to json-diff).
    it('explicit text-diff + application/json → text-diff (honored)', async () => {
      // Bodies that are JSON-equal (key reorder) but text-different: a text-diff
      // sees a change, a json-diff would not. Asserting an observation IS emitted
      // proves text-diff was used despite the JSON Content-Type.
      const result = await observeWithContentType(
        {
          url: 'https://api.example.com/data.json',
          'change-detection': { strategy: 'text-diff' },
        },
        'application/json',
        { first: '{"a":1,"b":2}', second: '{"b":2,"a":1}' },
      );
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.payload?.['strategy']).toBe('text-diff');
      expect(result.warnings ?? []).toHaveLength(0);
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

    // Issue #220 (composite parity): the non-2xx → errored-observation behavior
    // added for the single-URL path MUST also apply to each composite part. A
    // non-2xx part body would otherwise be baselined into the rendered snapshot,
    // making a misconfigured monitor look healthy and diffing error pages.
    it('a non-2xx composite part throws a status-bearing error (no baseline on error body)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) =>
          input === 'https://api.example.com/orders/42'
            ? Promise.resolve({
                text: () => Promise.resolve('{"status":"open"}'),
                status: 200,
              })
            : // A line endpoint returns 401 (e.g. expired token): must not baseline.
              Promise.resolve({
                text: () => Promise.resolve('Unauthorized'),
                status: 401,
              }),
        ),
      );
      // The error identifies the status, the offending part id/url, and the
      // "not establishing a baseline" intent — consistent with the single-URL path.
      await expect(
        source.observe(compositeConfig, { now: new Date() }),
      ).rejects.toThrow(/api-poll received HTTP 401 from composite part/);
      await expect(
        source.observe(compositeConfig, { now: new Date() }),
      ).rejects.toThrow(/not establishing a baseline on an error response/);
    });

    it('redacts userinfo + query credentials from a non-2xx composite-part error message', async () => {
      // The composite-part throw embeds part.url, which is persisted durably to
      // observation_history. A credential-bearing part URL must not leak there.
      const credUrl =
        'https://user:secretpass@api.example.com/orders/42?token=SECRETTOKEN';
      const cfg = {
        'change-detection': {
          composite: {
            'object-key': 'order-42',
            parts: [{ id: 'header', url: credUrl }],
          },
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve({
            text: () => Promise.resolve('Unauthorized'),
            status: 401,
          }),
        ),
      );
      let message = '';
      try {
        await source.observe(cfg, { now: new Date() });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain(
        'api-poll received HTTP 401 from composite part',
      );
      // Host preserved; credentials and tokens stripped.
      expect(message).toContain('api.example.com');
      expect(message).not.toContain('secretpass');
      expect(message).not.toContain('SECRETTOKEN');
      expect(message).not.toContain('user:');
      expect(message).not.toContain('@');
    });

    it('a 2xx composite still baselines/observes normally (no regression from the non-2xx guard)', async () => {
      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"open"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":2}',
      });
      const baseline = await source.observe(compositeConfig, {
        now: new Date(),
      });
      expect(baseline.observations).toHaveLength(0);

      mockByUrl({
        'https://api.example.com/orders/42': '{"status":"shipped"}',
        'https://api.example.com/orders/42/lines/1': '{"qty":1}',
        'https://api.example.com/orders/42/lines/2': '{"qty":2}',
      });
      const next = await source.observe(compositeConfig, {
        previousState: baseline.nextState,
        now: new Date(),
      });
      expect(next.observations).toHaveLength(1);
      expect(next.observations[0]?.objectKey).toBe('order-42');
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

  // ---------------------------------------------------------------------------
  // Issue #304: `api-poll` can wait forever or consume unbounded memory. These
  // tests exercise the three bounds directly: a request/body deadline, a
  // streamed byte cap (with a trusted Content-Length early check), and bounded
  // composite concurrency. Each bound must errored-observation the tick — no
  // partial body baselined, no `nextState` advance.
  // ---------------------------------------------------------------------------
  describe('request/body bounds (issue #304)', () => {
    function makeAbortError(): Error {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return err;
    }

    /** A `fetch` mock whose headers never arrive until the caller's signal aborts. */
    function mockNeverRespondingFetch(): ReturnType<typeof vi.fn> {
      return vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal;
            if (!signal) throw new Error('test requires an AbortSignal');
            signal.addEventListener('abort', () => {
              reject(makeAbortError());
            });
          }),
      );
    }

    /**
     * A `fetch` mock whose headers resolve immediately (2xx) but whose body
     * stream never completes a read — mimicking a stalled/trickling chunked
     * response — until the caller's signal aborts.
     */
    function mockHangingBodyFetch(): ReturnType<typeof vi.fn> {
      return vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () =>
                new Promise((_resolve, reject) => {
                  const signal = init.signal;
                  if (!signal) throw new Error('test requires an AbortSignal');
                  if (signal.aborted) {
                    reject(makeAbortError());
                    return;
                  }
                  signal.addEventListener('abort', () => {
                    reject(makeAbortError());
                  });
                }),
              releaseLock: () => {
                // no-op
              },
            }),
          },
        }),
      );
    }

    /** A `fetch` mock returning a declared `Content-Length` header, no streaming body. */
    function mockDeclaredContentLength(
      declaredBytes: number,
    ): ReturnType<typeof vi.fn> {
      return vi.fn(() =>
        Promise.resolve({
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-length'
                ? String(declaredBytes)
                : null,
          },
          text: () => Promise.resolve('should never be read'),
        }),
      );
    }

    /** A `fetch` mock streaming the given chunks with no `Content-Length` header. */
    function mockStreamingChunks(
      chunks: Uint8Array[],
    ): ReturnType<typeof vi.fn> {
      return vi.fn(() => {
        let index = 0;
        return Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => {
                if (index >= chunks.length) {
                  return Promise.resolve({ done: true, value: undefined });
                }
                const value = chunks[index];
                index += 1;
                return Promise.resolve({ done: false, value });
              },
              releaseLock: () => {
                // no-op
              },
            }),
          },
        });
      });
    }

    describe('request/body deadline', () => {
      it('aborts and errors the observation when headers never arrive', async () => {
        vi.stubGlobal('fetch', mockNeverRespondingFetch());

        await expect(
          source.observe(
            { url: 'https://api.example.com/never-responds', timeout: '1s' },
            { now: new Date() },
          ),
        ).rejects.toThrow(/timed out after 1000ms/);
      });

      it('aborts and errors the observation when the body stalls mid-stream', async () => {
        vi.stubGlobal('fetch', mockHangingBodyFetch());

        await expect(
          source.observe(
            { url: 'https://api.example.com/stalls', timeout: '1s' },
            { now: new Date() },
          ),
        ).rejects.toThrow(/timed out after 1000ms/);
      });

      it('a request that completes within the deadline is unaffected', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            text: () => Promise.resolve('fast response'),
            status: 200,
          }),
        );

        const result = await source.observe(
          { url: 'https://api.example.com/fast', timeout: '1s' },
          { now: new Date() },
        );
        expect(result.observations).toHaveLength(0);
        expect(result.nextState).toBeDefined();
      });

      it('rejects an invalid timeout override', async () => {
        await expect(
          source.observe(
            { url: 'https://api.example.com/x', timeout: 'soon' },
            { now: new Date() },
          ),
        ).rejects.toThrow(/Invalid duration: "soon"/);
      });

      it('does not advance nextState past a timed-out tick', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            text: () => Promise.resolve('baseline body'),
            status: 200,
          }),
        );
        const url = 'https://api.example.com/recovers';
        const baseline = await source.observe({ url }, { now: new Date() });

        vi.stubGlobal('fetch', mockNeverRespondingFetch());
        await expect(
          source.observe(
            { url, timeout: '1s' },
            { previousState: baseline.nextState, now: new Date() },
          ),
        ).rejects.toThrow(/timed out/);

        // A subsequent successful poll still diffs against the ORIGINAL baseline
        // (the runtime never persisted a `nextState` from the errored tick).
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            text: () => Promise.resolve('changed body'),
            status: 200,
          }),
        );
        const recovered = await source.observe(
          { url },
          { previousState: baseline.nextState, now: new Date() },
        );
        expect(recovered.observations).toHaveLength(1);
      });
    });

    describe('byte cap', () => {
      it('rejects a declared Content-Length above the cap without reading the body', async () => {
        const mockFetch = mockDeclaredContentLength(50 * 1024 * 1024);
        vi.stubGlobal('fetch', mockFetch);

        await expect(
          source.observe(
            { url: 'https://api.example.com/huge-declared' },
            { now: new Date() },
          ),
        ).rejects.toThrow(/exceeding the .*-byte cap/);
      });

      it('caps a chunked body with no Content-Length via streamed counting', async () => {
        // No single chunk exceeds the cap on its own, but the running total does
        // — proving the streamed count (not any one chunk) is the authority.
        const chunk = new Uint8Array(6 * 1024 * 1024);
        vi.stubGlobal('fetch', mockStreamingChunks([chunk, chunk]));

        await expect(
          source.observe(
            { url: 'https://api.example.com/huge-chunked' },
            { now: new Date() },
          ),
        ).rejects.toThrow(/exceeding the .*-byte cap/);
      });

      it('a body within the cap is read normally', async () => {
        const encoder = new TextEncoder();
        vi.stubGlobal(
          'fetch',
          mockStreamingChunks([
            encoder.encode('{"data":'),
            encoder.encode('"small"}'),
          ]),
        );

        const result = await source.observe(
          { url: 'https://api.example.com/small' },
          { now: new Date() },
        );
        expect(result.observations).toHaveLength(0);
        expect(result.nextState).toBeDefined();
      });
    });

    describe('composite concurrency (003 §2.6)', () => {
      it('bounds simultaneous in-flight part requests', async () => {
        const partCount = 12;
        let active = 0;
        let maxActive = 0;

        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return {
              status: 200,
              text: () => Promise.resolve(`body for ${input}`),
            };
          }),
        );

        const config = {
          'change-detection': {
            composite: {
              'object-key': 'many-parts',
              parts: Array.from({ length: partCount }, (_, i) => ({
                id: `part-${String(i)}`,
                url: `https://api.example.com/parts/${String(i)}`,
              })),
            },
          },
        };

        await source.observe(config, { now: new Date() });

        // Bounded well below "all N parts at once" — proves concurrency is
        // capped, not merely finite.
        expect(maxActive).toBeLessThan(partCount);
        expect(maxActive).toBeLessThanOrEqual(5);
      });

      it('a slow/never-responding part still errors the whole composite via its own deadline', async () => {
        vi.stubGlobal('fetch', mockNeverRespondingFetch());

        const config = {
          'change-detection': {
            composite: {
              'object-key': 'stalled-part',
              parts: [{ id: 'only', url: 'https://api.example.com/stalled' }],
            },
          },
          timeout: '1s',
        };

        await expect(
          source.observe(config, { now: new Date() }),
        ).rejects.toThrow(/timed out after 1000ms/);
      });
    });
  });
});
