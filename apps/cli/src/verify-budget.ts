import path from 'node:path';
import { hasMagic } from 'glob';
import {
  defaultNotifyConfigForUrgency,
  parseDuration,
  schedulingDefaults,
  type MonitorDefinition,
  type Urgency,
} from '@agentmonitors/core';

/**
 * `verify` derives a *poll budget* — an upper bound on how long a real change
 * legitimately takes to reach a session — from the monitor's own declared
 * timing, so it never silently under-shoots the way a fixed 40s loop did
 * (issue #399). The interval/settle inputs to that budget come straight from
 * the runtime's canonical `schedulingDefaults` (002 §4.4 / §9.1), so this
 * estimate can never drift from the daemon's real cadences the way a
 * hand-mirrored copy would.
 */

/**
 * True when a `watch.globs` entry contains any glob magic (wildcard) character
 * — `*`, `?`, a `[…]` class, or a `{…}` brace alternation — under the *same*
 * matcher `file-fingerprint` uses (`glob`). `magicalBraces` is enabled so a
 * brace pattern like `file-{a,b}.md` is treated as magic, matching how
 * file-fingerprint's default-options `globSync` expands braces. Using the real
 * library (not a hand-rolled `includes('*')`) keeps verify's literal/pattern
 * decision consistent with what the daemon will actually match.
 */
function globHasMagic(glob: string): boolean {
  return hasMagic(glob, { magicalBraces: true });
}

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
    return schedulingDefaults.scheduleTickMs;
  }
  if (type === 'api-poll') {
    return explicit ?? schedulingDefaults.apiPollMs;
  }
  // file-fingerprint and any other interval-style source share the
  // file-fingerprint default when no explicit interval is declared.
  return explicit ?? schedulingDefaults.fileFingerprintPollMs;
}

/**
 * Resolve the materialization settle delay in ms — the time the notify stage
 * holds a detected change before it is emitted as an event. A `debounce`
 * strategy holds for its `settle-for`; `throttle` emits the first change
 * immediately (0); `rollup` is window-driven and not modeled here (0).
 *
 * This is NOT independent of urgency: a `high`-urgency monitor with no
 * explicit `notify` block still gets a default debounce settle at runtime
 * (`defaultNotifyConfigForUrgency`, `highUrgencyDefaultDebounceSettleMs`) —
 * delegating to that same function (rather than re-deriving the default here)
 * keeps this budget from drifting out of sync with the engine's actual notify
 * timing (issue #406).
 */
export function resolveSettleMs(monitor: MonitorDefinition): number {
  const notify = defaultNotifyConfigForUrgency(
    monitor.frontmatter.urgency,
    monitor.frontmatter.notify,
  );
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
  /**
   * Wall-clock budget the observe stage needs to DECISIVELY confirm a
   * `no-change` verdict (issue #442 round 19): two DISTINCT post-trigger
   * observation-history rows both reporting `no-change` — not just one stale
   * row persisting — which takes roughly two full ticks (one to record the
   * first post-trigger `no-change`, a second full interval later to confirm
   * it wasn't a one-off). `2 * intervalMs + marginMs`; no settle term, since a
   * genuine no-change tick never enters a notify settle window. `verify.ts`
   * extends the observe stage's deadline to at least this value — but ONLY
   * when using the default derived budget; an explicit `--timeout-ms` is
   * honored as-is (a timeout shorter than one interval still fails fast with
   * `budget-exceeded`, per the documented CLI flag semantics).
   */
  noChangeConfirmMs: number;
  /**
   * Budget granted to the materialize + deliver stages, counted from the
   * moment the observe stage actually resolves — `settleMs + highClaimSettleMs
   * + marginMs` (i.e. `detectMs - intervalMs`, the portion of `detectMs` that
   * isn't the observe-stage interval term).
   *
   * `detectDeadline` (`observeFrom + detectMs`) is sized on the assumption
   * observe resolves within one interval, leaving this remainder for
   * materialize/deliver. But `noChangeConfirmMs` can extend the observe
   * stage's own deadline past `detectDeadline` (issue #442 round 19) — so a
   * *real* triggered row that lands in that extension window (after
   * `detectDeadline` but before the extended observe deadline) would
   * otherwise hand materialize/deliver an already-expired deadline and zero
   * remaining time (issue #442 round 20). `verify.ts` grants materialize and
   * deliver a fresh deadline of `max(detectDeadline, observeResolvedAt +
   * postObserveBudgetMs)` — the same remainder budget, just measured from
   * when observe actually finished — for the DEFAULT derived budget only; an
   * explicit `--timeout-ms` is still honored as the hard total (never
   * extended past its own `detectDeadline`).
   */
  postObserveBudgetMs: number;
  /**
   * Total end-to-end budget (ms) — the worst-case default maximum, including
   * the round-20 materialize/deliver extension: `baselineMs +
   * max(detectMs, noChangeConfirmMs) + postObserveBudgetMs`. The
   * `max(detectMs, noChangeConfirmMs)` term is the observe stage's own
   * worst-case deadline (extended for the two-distinct-row `no-change`
   * discriminator); `postObserveBudgetMs` is then re-granted to
   * materialize/deliver measured from whenever observe actually resolves,
   * so it is additive rather than overlapping with the observe window.
   */
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
 * total with an explicit `--timeout-ms`.
 */
export function computeVerifyBudget(monitor: MonitorDefinition): VerifyBudget {
  const intervalMs = resolvePollIntervalMs(monitor);
  const settleMs = resolveSettleMs(monitor);
  const highClaimSettleMs =
    monitor.frontmatter.urgency === 'high'
      ? schedulingDefaults.highUrgencyClaimSettleMs
      : 0;
  const marginMs = Math.max(5_000, Math.ceil(intervalMs * 0.25));
  const baselineMs = intervalMs + marginMs;
  const detectMs = intervalMs + settleMs + highClaimSettleMs + marginMs;
  const noChangeConfirmMs = intervalMs * 2 + marginMs;
  const postObserveBudgetMs = settleMs + highClaimSettleMs + marginMs;
  return {
    intervalMs,
    settleMs,
    highClaimSettleMs,
    marginMs,
    baselineMs,
    detectMs,
    noChangeConfirmMs,
    postObserveBudgetMs,
    totalMs:
      baselineMs + Math.max(detectMs, noChangeConfirmMs) + postObserveBudgetMs,
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

  // Extension from the filename segment, only when the suffix after the last
  // `.` is a real, magic-free extension (e.g. `*.md` → `.md`). A suffix that is
  // itself a wildcard (`*.{md,txt}`, `*.[jt]s`) or a wildcard-only segment
  // (`**`) yields no extension.
  let ext = '';
  const dotIndex = fileSegment.lastIndexOf('.');
  if (dotIndex > 0 && !globHasMagic(fileSegment.slice(dotIndex))) {
    ext = fileSegment.slice(dotIndex);
  }

  // Static directory prefix: leading segments (excluding the filename segment)
  // up to the first one containing any glob magic (`*`, `?`, `[…]`, `{…}`).
  const dirSegments: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (globHasMagic(segment)) break;
    dirSegments.push(segment);
  }

  const fileName = `agentmonitors-verify-${token}${ext}`;
  return path.join(baseDir, ...dirSegments, fileName);
}

/**
 * True when a `watch.globs` entry is a literal single file (no glob magic — not
 * just no `*`, but also no `?`, `[…]`, or `{…}`), for which `verify` cannot
 * place a matching scratch sibling and must fall back to editing the file
 * itself or to `--manual` guidance. Backed by the real `glob` matcher so this
 * agrees with what `file-fingerprint` treats as a pattern.
 */
export function isLiteralGlob(glob: string): boolean {
  return !globHasMagic(glob);
}
