import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import source from './index.js';

const FIXED_TIME = new Date('2024-06-15T09:00:00.000Z');

describe('source-schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has correct name and scopeSchema', () => {
    expect(source.name).toBe('schedule');
    expect(source.scopeSchema).toHaveProperty('properties');
  });

  it('fires an observation when called', async () => {
    const result = await source.observe(
      { cron: '0 9 * * 1-5' },
      { now: FIXED_TIME },
    );

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.title).toContain('0 9 * * 1-5');
  });

  it('uses label as title when provided', async () => {
    const result = await source.observe(
      {
        cron: '0 9 * * 1-5',
        label: 'Daily standup reminder',
      },
      { now: FIXED_TIME },
    );

    expect(result.observations[0]?.title).toBe('Daily standup reminder');
  });

  it('includes cron and timezone in snapshot', async () => {
    const result = await source.observe(
      {
        cron: '0 9 * * 1-5',
        timezone: 'America/New_York',
      },
      { now: FIXED_TIME },
    );

    const snap = result.observations[0]?.snapshot as {
      cron: string;
      timezone: string;
      triggeredAt: string;
    };
    expect(snap.cron).toBe('0 9 * * 1-5');
    expect(snap.timezone).toBe('America/New_York');
    expect(snap.triggeredAt).toBe(FIXED_TIME.toISOString());
  });

  it('defaults timezone to UTC', async () => {
    const result = await source.observe(
      { cron: '* * * * *' },
      { now: FIXED_TIME },
    );

    const snap = result.observations[0]?.snapshot as { timezone: string };
    expect(snap.timezone).toBe('UTC');
  });

  it('throws on missing cron config', () => {
    expect(() => source.observe({}, { now: FIXED_TIME })).toThrow('cron');
  });
});
