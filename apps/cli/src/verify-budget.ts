import path from 'node:path';
import {
  parseDuration,
  type MonitorDefinition,
  type Urgency,
} from '@agentmonitors/core';

/**
 * Interval/settle constants that MIRROR the runtime's scheduling and notify
 * defaults in `libs/core/src/runtime/service.ts`
 * (`DEFAULT_FILE_FINGERPRINT_POLL_MS`, `DEFAULT_API_POLL_MS`,
 * `DEFAULT_HIGH_URGENCY_SETTLE_MS`) and the schedule source's 60s tick cadence.
 *
 * `verify` derives a *poll budget* — an upper bound on how long a real change
 * legitimately takes to reach a session — from the monitor's own declared
 * timing, so it never silently under-shoots the way a fixed 40s loop did
 * (issue #399). These values are only used to size that budget and its ETA
 * display; they are NOT authoritative scheduling (the daemon owns that), so a
 * small duplication of the core defaults here is an acceptable estimate. If the
 * core defaults change, update these to match (002 §4.4 / §9.1).
 */
export const DEFAULT_FILE_FINGERPRINT_INTERVAL_MS = 30_000;
export const DEFAULT_API_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_SCHEDULE_TICK_MS = 60_000;
/** The high-urgency claim-settle window (002 §9.1) applied before a `high` event surfaces at `turn-interruptible`. */
export const HIGH_URGENCY_CLAIM_SETTLE_MS = 15_000;

/** Read the flat per-source `watch` config (everything but `type`). */
function watchConfig(watch: MonitorDefinition['frontmatter']['watch']): {
  type: string;
  [key: string]: unknown;
} {
  return watch;
}

/**
 * Resolve the monitor's effective observation interval in ms, mirroring the
 * runtime's `scheduleForMonitor` (service.ts): an explicit `watch.interval`
 * wins for interval sources; otherwise the per-source default. `schedule`
 * sources are cron-driven — there is no fixed interval — so the daemon's 60s
 * evaluation cadence is used as the budget proxy.
 */
export function resolvePollIntervalMs(monitor: MonitorDefinition): number {
  const config = watchConfig(monitor.frontmatter.watch);
  const type = config.type;
  const rawInterval = config['interval'];
  const explicit =
    typeof rawInterval === 'string'
      ? parseDurationSafe(rawInterval)
      : undefined;

  if (type === 'schedule') {
    return DEFAULT_SCHEDULE_TICK_MS;
  }
  if (type === 'api-poll') {
    return explicit ?? DEFAULT_API_POLL_INTERVAL_MS;
  }
  // file-fingerprint and any other interval-style source share the
  // file-fingerprint default when no explicit interval is declared.
  return explicit ?? DEFAULT_FILE_FINGERPRINT_INTERVAL_MS;
}

/**
 * Resolve the materialization settle delay in ms — the time the notify stage
 * holds a detected change before it is emitted as an event. A `debounce`
 * strategy holds for its `settle-for`; `throttle` emits the first change
 * immediately (0); `rollup` is window-driven and not modeled here (0). This is
 * independent of urgency — it delays when the event appears in unread at all.
 */
export function resolveSettleMs(monitor: MonitorDefinition): number {
  const notify = monitor.frontmatter.notify;
  if (!notify) return 0;
  if (notify.strategy === 'debounce') {
    return parseDurationSafe(notify['settle-for']) ?? 0;
  }
  return 0;
}

/**
 * The lifecycle `verify` claims at to prove delivery, chosen by effective
 * urgency exactly as a real hook would surface the event:
 *
 * - `high` → `turn-interruptible` (high-urgency events interrupt mid-turn,
 *   after the ~15s claim-settle window).
 * - `normal` / `low` → `post-compact` (the recap re-shows all unread regardless
 *   of urgency; normal/low never interrupt mid-turn — 002 §9, memory: only
 *   `high` notifies mid-session).
 */
export function deliveryLifecycleForUrgency(
  urgency: Urgency,
): 'turn-interruptible' | 'post-compact' {
  return urgency === 'high' ? 'turn-interruptible' : 'post-compact';
}

export interface VerifyBudget {
  /** Monitor observation interval (ms). */
  intervalMs: number;
  /** Notify materialization settle (ms). */
  settleMs: number;
  /** High-urgency claim-settle window (ms), only when claiming high at turn-interruptible. */
  highClaimSettleMs: number;
  /** Safety margin folded into each phase (ms). */
  marginMs: number;
  /** Budget to establish the first (baseline) observation (ms). */
  baselineMs: number;
  /** Budget to detect + deliver the triggered change after baseline (ms). */
  detectMs: number;
  /** Total end-to-end budget (ms). */
  totalMs: number;
}

/**
 * Compute the interval-aware verify budget from a monitor's own declared
 * timing (issue #399 criterion 2). The budget has two phases:
 *
 * - **baseline** — up to one interval (plus margin) for the daemon's first tick
 *   to establish the monitor's baseline (no event on the first observation).
 * - **detect** — up to one more interval for the post-trigger tick to observe
 *   the change, plus the notify settle, plus (for high urgency) the claim-settle
 *   window, plus margin.
 *
 * The margin is `max(5s, 25% of interval)` — it absorbs daemon poll granularity
 * and clock skew without dwarfing a short interval. Callers may override the
 * total with an explicit `--timeout`.
 */
export function computeVerifyBudget(monitor: MonitorDefinition): VerifyBudget {
  const intervalMs = resolvePollIntervalMs(monitor);
  const settleMs = resolveSettleMs(monitor);
  const highClaimSettleMs =
    monitor.frontmatter.urgency === 'high' ? HIGH_URGENCY_CLAIM_SETTLE_MS : 0;
  const marginMs = Math.max(5_000, Math.ceil(intervalMs * 0.25));
  const baselineMs = intervalMs + marginMs;
  const detectMs = intervalMs + settleMs + highClaimSettleMs + marginMs;
  return {
    intervalMs,
    settleMs,
    highClaimSettleMs,
    marginMs,
    baselineMs,
    detectMs,
    totalMs: baselineMs + detectMs,
  };
}

/**
 * Parse a duration string, returning `undefined` (rather than throwing) for a
 * malformed value so budget/settle resolution degrades to the default instead
 * of crashing verify. Valid monitors are schema-validated, but verify must be
 * robust against a hand-edited MONITOR.md.
 */
function parseDurationSafe(value: string): number | undefined {
  try {
    return parseDuration(value);
  } catch {
    return undefined;
  }
}

/**
 * Derive a scratch file path that should match `glob` when created under
 * `baseDir`, for `verify`'s auto-trigger (file-fingerprint). Strategy: keep the
 * static directory prefix of the glob (segments before the first wildcard) and
 * reuse the glob's file extension, so a pattern like `*.md`, a recursive
 * `docs` markdown glob, or `src/**` yields a matching sibling. A **literal**
 * single-file glob (e.g.
 * `watched.txt`) has no wildcard, so a scratch sibling would NOT match it — the
 * caller must observe the outcome and fail fast with a `no-change` diagnosis
 * pointing at `--manual`, never hang.
 *
 * @param glob a single `watch.globs` entry (POSIX-style, `/`-separated)
 * @param baseDir the resolved directory globs are relative to (`watch.cwd` or workspace)
 * @param token a unique-per-run token for the scratch filename
 */
export function deriveScratchTriggerPath(
  glob: string,
  baseDir: string,
  token: string,
): string {
  const segments = glob.split('/').filter((segment) => segment.length > 0);
  const fileSegment = segments[segments.length - 1] ?? '';

  // Extension from the filename segment, only when it is a real suffix (a `.`
  // after the last `*`, e.g. `*.md` → `.md`). A wildcard-only segment (`**`)
  // yields no extension.
  let ext = '';
  const dotIndex = fileSegment.lastIndexOf('.');
  if (dotIndex > 0 && !fileSegment.slice(dotIndex).includes('*')) {
    ext = fileSegment.slice(dotIndex);
  }

  // Static directory prefix: leading segments (excluding the filename segment)
  // up to the first one containing a wildcard.
  const dirSegments: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes('*')) break;
    dirSegments.push(segment);
  }

  const fileName = `agentmonitors-verify-${token}${ext}`;
  return path.join(baseDir, ...dirSegments, fileName);
}

/**
 * True when a `watch.globs` entry is a literal single file (no wildcard), for
 * which `verify` cannot place a matching scratch sibling and must fall back to
 * `--manual` guidance.
 */
export function isLiteralGlob(glob: string): boolean {
  return !glob.includes('*');
}
