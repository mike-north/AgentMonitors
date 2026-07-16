/**
 * Guard tests pinning the canonical runtime scheduling/notify defaults to the
 * spec. The expected values are written by hand from the spec, NOT captured
 * from the export — so a change to a default is caught here and traced back to
 * the governing rule rather than silently rubber-stamped.
 *
 * @see docs/specs/002-runtime-delivery.md §4.4 (poll cadences)
 * @see docs/specs/002-runtime-delivery.md §9.1 (high-urgency claim-settle)
 */
import { describe, it, expect } from 'vitest';
import { schedulingDefaults } from './scheduling-defaults.js';

describe('schedulingDefaults', () => {
  it('matches the spec-defined poll cadences and settle window (ms)', () => {
    // 002 §4.4: file-fingerprint / other interval sources poll every 30s.
    expect(schedulingDefaults.fileFingerprintPollMs).toBe(30_000);
    // 002 §4.4: api-poll defaults to 300s (5m) when no interval is declared.
    expect(schedulingDefaults.apiPollMs).toBe(300_000);
    // 002 §4.4/§2.2: schedule monitors are evaluated once per minute
    // (`elapsed >= 60_000`).
    expect(schedulingDefaults.scheduleTickMs).toBe(60_000);
    // 002 §9.1: the high-urgency claim-settle window is 15s.
    expect(schedulingDefaults.highUrgencyClaimSettleMs).toBe(15_000);
  });
});
