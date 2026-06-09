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
 *   - Orphan daemons (never registered a session) still reap after `bootGraceMs`.
 */

export interface ShouldReapInput {
  /** Number of active sessions for this workspace right now. */
  openCount: number;
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

  // Sessions are active — reset idle tracking and record that we've seen one.
  if (s.openCount > 0) {
    return {
      reap: false,
      nextIdleSince: null,
      nextHasSeenSession: true,
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
