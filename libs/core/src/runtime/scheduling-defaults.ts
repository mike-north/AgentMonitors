/**
 * Canonical runtime scheduling and notify default timings (milliseconds).
 *
 * This is the single source of truth for the daemon's per-source poll cadences
 * and the high-urgency claim-settle window. The runtime (`service.ts`) uses
 * these to decide when a monitor is due; consumers that need to *reason about*
 * that timing — e.g. the CLI `verify` command sizing its end-to-end delivery
 * budget — import these values instead of re-declaring their own copies, so a
 * change to a default propagates everywhere rather than silently drifting from a
 * hand-mirrored constant (002 §4.4 / §9.1).
 *
 * @public
 */
export const schedulingDefaults = {
  /**
   * Poll interval for a `file-fingerprint` monitor that declares no explicit
   * `watch.interval`.
   */
  fileFingerprintPollMs: 30_000,
  /**
   * Poll interval for an `api-poll` monitor that declares no explicit
   * `watch.interval`.
   */
  apiPollMs: 300_000,
  /**
   * Cron `schedule` sources have no fixed interval; the daemon re-evaluates
   * their cron expression on this cadence.
   */
  scheduleTickMs: 60_000,
  /**
   * The claim-settle window applied before a `high`-urgency event surfaces at
   * `turn-interruptible` — so `high` delivery is not instant.
   */
  highUrgencyClaimSettleMs: 15_000,
} as const;
