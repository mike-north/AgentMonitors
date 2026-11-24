/**
 * Tests for the per-process channel route state (006 §4.5.2, issue #535).
 *
 * @see ../../../docs/specs/006-agent-integration.md §4.5.2
 */
import { describe, expect, it } from 'vitest';
import { ChannelRoute } from './channel-route.js';

const AT = new Date('2026-11-23T17:05:48.034Z');

describe('ChannelRoute', () => {
  it('starts unproven with no push yet, and may push', () => {
    const route = new ChannelRoute();
    expect(route.snapshot()).toEqual({
      state: 'unproven',
      evidence: 'no-push-yet',
    });
    expect(route.canPush).toBe(true);
  });

  it('becomes confirmed on a host-confirmed push', () => {
    const route = new ChannelRoute();
    route.confirmed(AT);
    expect(route.snapshot()).toEqual({
      state: 'confirmed',
      evidence: 'confirmed-push',
      lastConfirmedAt: AT.toISOString(),
    });
    expect(route.canPush).toBe(true);
  });

  it('an unconfirmed push makes it unproven for the rest of the process, even after a confirmation', () => {
    const route = new ChannelRoute();
    route.confirmed(AT);
    route.unconfirmed('unconfirmed-push');
    expect(route.canPush).toBe(false);
    expect(route.snapshot()).toMatchObject({
      state: 'unproven',
      evidence: 'unconfirmed-push',
    });
    route.confirmed(new Date('2026-11-23T18:00:00.000Z'));
    expect(route.snapshot().state).toBe('unproven');
    expect(route.canPush).toBe(false);
  });

  it('a failed push also stops pushing', () => {
    const route = new ChannelRoute();
    route.unconfirmed('push-failed');
    expect(route.canPush).toBe(false);
    expect(route.snapshot().evidence).toBe('push-failed');
  });

  it('no evidence source before any push stays open to a later attempt', () => {
    const route = new ChannelRoute();
    route.noEvidenceSource();
    expect(route.canPush).toBe(true);
    expect(route.snapshot()).toEqual({
      state: 'unproven',
      evidence: 'no-transcript',
    });
    route.confirmed(AT);
    expect(route.snapshot().state).toBe('confirmed');
  });

  it('losing the evidence source after a confirmation stops pushing', () => {
    const route = new ChannelRoute();
    route.confirmed(AT);
    route.noEvidenceSource();
    expect(route.canPush).toBe(false);
    expect(route.snapshot()).toMatchObject({
      state: 'unproven',
      evidence: 'no-transcript',
    });
  });
});
