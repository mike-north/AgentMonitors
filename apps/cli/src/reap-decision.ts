/**
 * Pure decision function for idle-reaping the daemon.
 *
 * The boot-grace window prevents a race where a newly-spawned daemon reaps
 * itself before `session start` finishes registering the first session:
 *
 *   - Until a session has been seen (`hasSeenSession === false`), the required
 *     idle window is `max(reapAfterMs, bootGraceMs)`.
 *   - Once at least one session has been seen and all are closed again, the
 *     normal `reapAfterMs` applies.
 *   - Orphan daemons (never registered a session) still reap after that same
 *     `max(reapAfterMs, bootGraceMs)` window — so a daemon that boots but whose
 *     session never registers does not linger forever.
 */

export interface ShouldReapInput {
  /** Number of active sessions for this workspace right now. */
  openCount: number;
  /**
   * Whether a **live** (non-stale) channel-transport heartbeat exists for this
   * workspace right now (issue #435 Option A). A channel server is a
   * long-lived process attached to a session that pushes monitor events into
   * an otherwise-idle agent — the exact case the daemon must stay alive for.
   * It fires no hooks, so without this the daemon reaps ~5 min after the last
   * prompt and the channel goes permanently silent (issue #435).
   *
   * This is derived from the heartbeat's owner-declared TTL lease
   * (`isHeartbeatStale`), NOT a static "a channel exists" flag: when the
   * channel process dies without cleanup, its lease expires within the TTL and
   * this flips to `false`, so reaping resumes and an orphaned server (issue
   * #426) can never pin the daemon alive forever. The caller does the I/O
   * (reading and staleness-checking the registry); this function stays pure.
   */
  channelAttached: boolean;
  /** Whether at least one session has ever been open during this daemon's lifetime. */
  hasSeenSession: boolean;
  /** Timestamp (ms) when the daemon first became idle in the current idle run, or null if active. */
  idleSince: number | null;
  /** Current timestamp in ms. */
  now: number;
  /** Reap after this many idle ms. 0 disables reaping entirely. */
  reapAfterMs: number;
  /**
   * Minimum idle window before reaping a daemon that has never seen a session.
   * Guards against the boot-before-register race. Typically 10_000 ms.
   */
  bootGraceMs: number;
}

export interface ShouldReapOutput {
  reap: boolean;
  nextIdleSince: number | null;
  nextHasSeenSession: boolean;
}

/** Named constant so call sites reference the intent, not a magic number. */
export const BOOT_GRACE_MS = 10_000;

/**
 * Determine whether the daemon should stop given the current session state.
 * This function is pure (no side-effects, no Date.now() calls) to allow
 * deterministic unit testing.
 */
export function shouldReap(s: ShouldReapInput): ShouldReapOutput {
  // Reaping disabled entirely.
  if (s.reapAfterMs <= 0) {
    return {
      reap: false,
      nextIdleSince: null,
      nextHasSeenSession: s.hasSeenSession,
    };
  }

  // An open session is unambiguous activity: reset idle tracking and record
  // that a session has been seen — this is what the boot-grace window is
  // gating on (a real session registered).
  if (s.openCount > 0) {
    return {
      reap: false,
      nextIdleSince: null,
      nextHasSeenSession: true,
    };
  }

  // A live channel heartbeat ALSO counts as activity (issue #435 Option A): a
  // channel-attached session pushing into an idle agent is precisely why the
  // daemon must not reap, and the channel's lease is what makes this safe (a
  // dead server's lease expires and this goes false again). It must NOT set
  // `hasSeenSession`, though: that flag specifically means a SESSION has been
  // open, and gates the boot-grace window. A channel can attach before any
  // session ever registers (e.g. `channel serve` starting first), and if it
  // then shuts down cleanly before the first session opens, the daemon must
  // still apply `max(reapAfterMs, bootGraceMs)` — not fall through to the
  // shorter post-session `reapAfterMs` window as if a session had already been
  // seen.
  if (s.channelAttached) {
    return {
      reap: false,
      nextIdleSince: null,
      nextHasSeenSession: s.hasSeenSession,
    };
  }

  // No sessions open. Start (or continue) the idle clock.
  const idleSince = s.idleSince ?? s.now;
  const idleMs = s.now - idleSince;

  // Use the larger of reapAfterMs and bootGraceMs until a session has been seen.
  const requiredIdleMs = s.hasSeenSession
    ? s.reapAfterMs
    : Math.max(s.reapAfterMs, s.bootGraceMs);

  return {
    reap: idleMs >= requiredIdleMs,
    nextIdleSince: idleSince,
    nextHasSeenSession: s.hasSeenSession,
  };
}
