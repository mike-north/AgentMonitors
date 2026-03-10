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
    const result = await source.observe({
      url: 'https://api.example.com/data',
    });
    expect(result).toHaveLength(0);
  });

  it('detects response changes on subsequent polls (text-diff)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('response-v1'),
      status: 200,
    });

    const url = 'https://api.example.com/text-diff-test';
    await source.observe({ url });

    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('response-v2'),
      status: 200,
    });

    const result = await source.observe({ url });
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toContain(url);
  });

  it('returns no observations when response is unchanged', async () => {
    const url = 'https://api.example.com/stable-test';

    await source.observe({ url });
    const result = await source.observe({ url });
    expect(result).toHaveLength(0);
  });

  it('throws on missing url', async () => {
    await expect(source.observe({})).rejects.toThrow('url');
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
      await source.observe(config);

      // Same status, different body — should NOT fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('body-v2'),
        status: 200,
      });
      const noChange = await source.observe(config);
      expect(noChange).toHaveLength(0);

      // Different status — should fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('body-v2'),
        status: 500,
      });
      const changed = await source.observe(config);
      expect(changed).toHaveLength(1);
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
      await source.observe(config);

      // Same JSON with different whitespace — should NOT fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('{"a":1,"b":2}'),
        status: 200,
      });
      const noChange = await source.observe(config);
      expect(noChange).toHaveLength(0);

      // Different JSON value — should fire
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('{"a":1,"b":3}'),
        status: 200,
      });
      const changed = await source.observe(config);
      expect(changed).toHaveLength(1);
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
      await source.observe(config1);

      // First poll for config2 should be baseline (no observation), not
      // inherit config1's cached response
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('response-for-key-2'),
        status: 200,
      });
      const result = await source.observe(config2);
      expect(result).toHaveLength(0);
    });
  });
});
