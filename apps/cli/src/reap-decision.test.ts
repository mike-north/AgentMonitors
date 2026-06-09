import { describe, it, expect } from 'vitest';
import { shouldReap, BOOT_GRACE_MS } from './reap-decision.js';

const BASE_NOW = 1_000_000; // arbitrary stable epoch for deterministic tests

describe('shouldReap', () => {
  // -------------------------------------------------------------------------
  // reapAfterMs === 0 → always disabled
  // -------------------------------------------------------------------------
  it('never reaps when reapAfterMs is 0 (disabled)', () => {
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: BASE_NOW - 999_999, // very long idle
      now: BASE_NOW,
      reapAfterMs: 0,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false);
    expect(result.nextIdleSince).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Active sessions reset idle tracking
  // -------------------------------------------------------------------------
  it('resets idleSince and does not reap while sessions are active', () => {
    const result = shouldReap({
      openCount: 2,
      hasSeenSession: false,
      idleSince: BASE_NOW - 50_000,
      now: BASE_NOW,
      reapAfterMs: 1_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false);
    expect(result.nextIdleSince).toBeNull();
    expect(result.nextHasSeenSession).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Boot-grace window: idle > reapAfterMs but < bootGraceMs, !hasSeenSession
  // → must NOT reap (registration is still in flight)
  // -------------------------------------------------------------------------
  it(
    'does NOT reap when idle exceeds reapAfterMs but bootGrace has not elapsed ' +
      'and no session has ever been seen',
    () => {
      // reapAfterMs = 1 s, bootGraceMs = 10 s, idle = 5 s → no reap
      const result = shouldReap({
        openCount: 0,
        hasSeenSession: false,
        idleSince: BASE_NOW - 5_000,
        now: BASE_NOW,
        reapAfterMs: 1_000,
        bootGraceMs: 10_000,
      });
      expect(result.reap).toBe(false);
      expect(result.nextIdleSince).toBe(BASE_NOW - 5_000);
    },
  );

  // -------------------------------------------------------------------------
  // Boot-grace elapsed, still no session → must reap (orphan daemon)
  // -------------------------------------------------------------------------
  it('reaps an orphan daemon once bootGraceMs elapses with no session ever seen', () => {
    // reapAfterMs = 1 s, bootGraceMs = 10 s, idle = 11 s → reap
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: false,
      idleSince: BASE_NOW - 11_000,
      now: BASE_NOW,
      reapAfterMs: 1_000,
      bootGraceMs: 10_000,
    });
    expect(result.reap).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Post-session idle reaches reapAfterMs → reap
  // -------------------------------------------------------------------------
  it('reaps after reapAfterMs once a session has been seen and then closed', () => {
    // reapAfterMs = 5 s, hasSeenSession = true, idle = 5 s → reap
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: BASE_NOW - 5_000,
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(true);
  });

  it('does NOT reap before reapAfterMs when a session has been seen', () => {
    // reapAfterMs = 5 s, idle = 4 s → no reap yet
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: BASE_NOW - 4_000,
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false);
    expect(result.nextIdleSince).toBe(BASE_NOW - 4_000);
  });

  // -------------------------------------------------------------------------
  // idleSince initialised on first idle tick (was null before)
  // -------------------------------------------------------------------------
  it('sets idleSince to now when first becoming idle', () => {
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: null, // first idle tick
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false); // 0 ms idle — way below 5 s
    expect(result.nextIdleSince).toBe(BASE_NOW);
  });

  // -------------------------------------------------------------------------
  // Session reappears after idle → resets idleSince
  // -------------------------------------------------------------------------
  it('resets idleSince when a session reappears after a period of idleness', () => {
    // Daemon was idle but a new session opened before reap threshold
    const result = shouldReap({
      openCount: 1,
      hasSeenSession: true,
      idleSince: BASE_NOW - 3_000,
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false);
    expect(result.nextIdleSince).toBeNull(); // reset
    expect(result.nextHasSeenSession).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Exact-boundary: idle === reapAfterMs → reap (>= semantics)
  // -------------------------------------------------------------------------
  it('reaps exactly at the reapAfterMs boundary (>= semantics)', () => {
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: BASE_NOW - 5_000,
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(true);
  });

  it('does NOT reap one ms before the reapAfterMs boundary', () => {
    const result = shouldReap({
      openCount: 0,
      hasSeenSession: true,
      idleSince: BASE_NOW - 4_999,
      now: BASE_NOW,
      reapAfterMs: 5_000,
      bootGraceMs: BOOT_GRACE_MS,
    });
    expect(result.reap).toBe(false);
  });
});
