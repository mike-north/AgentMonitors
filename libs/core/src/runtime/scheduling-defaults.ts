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
  /**
   * The debounce settle window `defaultNotifyConfigForUrgency` applies to a
   * `high`-urgency monitor that declares no explicit `notify` block — so a
   * high-urgency event still holds for a settle window before it materializes,
   * even without an authored `notify:` override. This is a *different* window
   * than `highUrgencyClaimSettleMs` (that one delays hook-surfacing after
   * materialization; this one delays materialization itself) — both happen to
   * default to 15s today, but they are independent knobs.
   *
   * MUST remain an exact multiple of 1000: `defaultNotifyConfigForUrgency`
   * formats this value as a whole-second `settle-for` string (`${ms / 1000}s`)
   * because `parseDuration`'s grammar (`notifier.ts`) has no sub-second unit —
   * a non-multiple would format as e.g. `"15.5s"`, which `parseDuration` cannot
   * parse and throws on. Pinned by `types.test.ts`.
   */
  highUrgencyDefaultDebounceSettleMs: 15_000,
} as const;
