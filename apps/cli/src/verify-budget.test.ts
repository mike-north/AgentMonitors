/**
 * Unit tests for the verify budget + scratch-trigger helpers (issue #399).
 *
 * The budget math is spec-derived (interval + settle + margin), NOT captured
 * from output: each assertion traces to the runtime's canonical
 * `schedulingDefaults` (exported from `@agentmonitors/core`, consumed by both
 * the daemon in `service.ts` and verify-budget) and 002 §4.4 / §9.1.
 *
 * @see docs/specs/002-runtime-delivery.md
 * @see docs/specs/005-cli-reference.md §16
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseMonitor,
  schedulingDefaults,
  type MonitorDefinition,
} from '@agentmonitors/core';
import {
  computeVerifyBudget,
  deliveryLifecycleForUrgency,
  deriveScratchTriggerPath,
  isLiteralGlob,
  resolvePollIntervalMs,
  resolveSettleMs,
} from './verify-budget.js';

function monitorFrom(frontmatter: string): MonitorDefinition {
  const result = parseMonitor(
    `---\n${frontmatter}\n---\nBody.\n`,
    '/tmp/ws/.claude/monitors/m/MONITOR.md',
  );
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.error}`);
  return result.monitor;
}

describe('resolvePollIntervalMs', () => {
  it('uses the file-fingerprint default when no interval is declared', () => {
    const monitor = monitorFrom(
      'watch:\n  type: file-fingerprint\n  globs:\n    - "*.md"',
    );
    // service.ts DEFAULT_FILE_FINGERPRINT_POLL_MS = 30_000
    expect(resolvePollIntervalMs(monitor)).toBe(
      schedulingDefaults.fileFingerprintPollMs,
    );
  });

  it('honors an explicit watch.interval', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: '5s'",
    );
    expect(resolvePollIntervalMs(monitor)).toBe(5_000);
  });

  it('uses the api-poll default when no interval is declared', () => {
    const monitor = monitorFrom(
      "watch:\n  type: api-poll\n  url: 'https://example.com'",
    );
    // service.ts DEFAULT_API_POLL_MS = 300_000
    expect(resolvePollIntervalMs(monitor)).toBe(schedulingDefaults.apiPollMs);
  });

  it('uses the 60s tick cadence for cron-driven schedule sources', () => {
    const monitor = monitorFrom(
      "watch:\n  type: schedule\n  cron: '*/5 * * * *'",
    );
    expect(resolvePollIntervalMs(monitor)).toBe(
      schedulingDefaults.scheduleTickMs,
    );
  });

  it('falls back to the default for a malformed interval rather than throwing', () => {
    // A hand-edited (schema-invalid) interval must degrade, not crash verify.
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: 'not-a-duration'",
    );
    expect(resolvePollIntervalMs(monitor)).toBe(
      schedulingDefaults.fileFingerprintPollMs,
    );
  });
});

describe('resolveSettleMs', () => {
  it('is 0 for normal urgency when no notify strategy is declared', () => {
    // An omitted `urgency` defaults to the `normal` band (001 §3.2) — no
    // default debounce settle applies, unlike `high` below.
    const monitor = monitorFrom(
      'watch:\n  type: file-fingerprint\n  globs:\n    - "*.md"',
    );
    expect(resolveSettleMs(monitor)).toBe(0);
  });

  it('is the debounce settle-for duration', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nnotify:\n  strategy: debounce\n  settle-for: '5m'",
    );
    expect(resolveSettleMs(monitor)).toBe(5 * 60 * 1000);
  });

  it('is 0 for throttle (first change emits immediately)', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nnotify:\n  strategy: throttle\n  suppress-for: '10m'",
    );
    expect(resolveSettleMs(monitor)).toBe(0);
  });

  // Regression (issue #406): a `high`-urgency monitor with NO explicit
  // `notify` block still gets a default debounce settle at runtime
  // (`defaultNotifyConfigForUrgency`, service.ts) before an event
  // materializes. Pre-fix, `resolveSettleMs` only read `monitor.frontmatter
  // .notify` directly and returned 0 for this case, undershooting the real
  // budget by exactly this window (~53s computed vs. ~60s actual end-to-end).
  it('applies the high-urgency default debounce settle when no notify block is declared', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nurgency: high",
    );
    expect(resolveSettleMs(monitor)).toBe(
      schedulingDefaults.highUrgencyDefaultDebounceSettleMs,
    );
  });

  it('lets an explicit notify.settle-for override the high-urgency default (not double-counted)', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nurgency: high\nnotify:\n  strategy: debounce\n  settle-for: '2m'",
    );
    // The authored settle-for wins outright — it is not added on top of the
    // default, and does not equal the default (2m !== 15s) — proving the
    // override path, not the default path, was taken.
    expect(resolveSettleMs(monitor)).toBe(2 * 60 * 1000);
    expect(resolveSettleMs(monitor)).not.toBe(
      schedulingDefaults.highUrgencyDefaultDebounceSettleMs,
    );
  });

  it('is 0 for a non-high urgency band even with no notify block', () => {
    const lowMonitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nurgency: low",
    );
    const normalMonitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nurgency: normal",
    );
    expect(resolveSettleMs(lowMonitor)).toBe(0);
    expect(resolveSettleMs(normalMonitor)).toBe(0);
  });
});

describe('deliveryLifecycleForUrgency', () => {
  it('claims high urgency at turn-interruptible (mid-turn interrupt)', () => {
    expect(deliveryLifecycleForUrgency('high')).toBe('turn-interruptible');
  });

  it('claims normal/low at post-compact (recap surfaces all unread)', () => {
    expect(deliveryLifecycleForUrgency('normal')).toBe('post-compact');
    expect(deliveryLifecycleForUrgency('low')).toBe('post-compact');
  });
});

describe('computeVerifyBudget', () => {
  it('folds interval + margin into baseline and interval + settle + margin into detect', () => {
    // interval 4s → margin = max(5000, 1000) = 5000; no settle; normal urgency.
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: '4s'\nurgency: normal",
    );
    const budget = computeVerifyBudget(monitor);
    expect(budget.intervalMs).toBe(4_000);
    expect(budget.settleMs).toBe(0);
    expect(budget.highClaimSettleMs).toBe(0);
    expect(budget.marginMs).toBe(5_000);
    expect(budget.baselineMs).toBe(4_000 + 5_000);
    expect(budget.detectMs).toBe(4_000 + 0 + 0 + 5_000);
    expect(budget.totalMs).toBe(budget.baselineMs + budget.detectMs);
  });

  it('adds both the default debounce settle and the claim-settle window to the detect phase (issue #406)', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: '4s'\nurgency: high",
    );
    const budget = computeVerifyBudget(monitor);
    // 002 §9.1: high urgency with no explicit notify still gets a default
    // debounce settle before materialization (issue #406) PLUS the
    // claim-settle window before hook-surfacing — both apply only to detect
    // (claim), not baseline.
    expect(budget.settleMs).toBe(
      schedulingDefaults.highUrgencyDefaultDebounceSettleMs,
    );
    expect(budget.highClaimSettleMs).toBe(
      schedulingDefaults.highUrgencyClaimSettleMs,
    );
    expect(budget.baselineMs).toBe(4_000 + 5_000);
    expect(budget.detectMs).toBe(
      4_000 +
        schedulingDefaults.highUrgencyDefaultDebounceSettleMs +
        schedulingDefaults.highUrgencyClaimSettleMs +
        5_000,
    );
  });

  it('scales the margin to 25% of a long interval', () => {
    // api-poll default 300_000 → margin = max(5000, 75_000) = 75_000
    const monitor = monitorFrom(
      "watch:\n  type: api-poll\n  url: 'https://example.com'",
    );
    const budget = computeVerifyBudget(monitor);
    expect(budget.marginMs).toBe(75_000);
    expect(budget.intervalMs).toBe(schedulingDefaults.apiPollMs);
  });

  // Regression (issue #406): the recommended default config — file-fingerprint
  // + urgency: high + no notify block — was spuriously FAILing verify because
  // detectMs omitted the high-urgency default debounce settle. Real
  // end-to-end delivery for this config is interval (30s) + default debounce
  // settle (15s) + claim-settle (15s) = 60s; the pre-fix budget only reached
  // 30s + 0 + 15s + margin(7.5s) = 52.5s.
  it('covers the real ~60s end-to-end time for the recommended default config (file-fingerprint + high urgency, no notify)', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\nurgency: high",
    );
    const budget = computeVerifyBudget(monitor);
    expect(budget.intervalMs).toBe(schedulingDefaults.fileFingerprintPollMs); // 30_000
    expect(budget.settleMs).toBe(
      schedulingDefaults.highUrgencyDefaultDebounceSettleMs,
    ); // 15_000 — the previously-omitted term
    expect(budget.highClaimSettleMs).toBe(
      schedulingDefaults.highUrgencyClaimSettleMs,
    ); // 15_000
    expect(budget.marginMs).toBe(7_500); // max(5000, 30_000 * 0.25)
    expect(budget.detectMs).toBe(30_000 + 15_000 + 15_000 + 7_500); // 67_500
    // The real end-to-end delivery (interval + default settle + claim-settle)
    // is 60_000ms; the budget must be at least that, with margin to spare.
    expect(budget.detectMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('isLiteralGlob', () => {
  it('is true for a literal single file', () => {
    expect(isLiteralGlob('watched.txt')).toBe(true);
    expect(isLiteralGlob('docs/readme.md')).toBe(true);
  });

  it('is false for a `*` wildcard pattern', () => {
    expect(isLiteralGlob('*.md')).toBe(false);
    expect(isLiteralGlob('src/**')).toBe(false);
    expect(isLiteralGlob('data-*/report.md')).toBe(false);
  });

  // Regression: pre-fix `isLiteralGlob` only tested `includes('*')`, so these
  // non-`*` glob-magic patterns were wrongly classified as literal single files
  // — sending the auto-trigger down the "edit the watched file itself" path
  // against a bogus filename that never matches. file-fingerprint uses `glob`
  // (minimatch), where `?`, `[…]`, and `{…}` are all wildcards, so verify must
  // treat them as patterns too.
  it('is false for non-`*` glob magic (`?`, char class, brace alternation)', () => {
    expect(isLiteralGlob('file-?.md')).toBe(false);
    expect(isLiteralGlob('file-[ab].md')).toBe(false);
    expect(isLiteralGlob('logs/[0-9]*.txt')).toBe(false);
    expect(isLiteralGlob('file-{a,b}.md')).toBe(false);
    expect(isLiteralGlob('src/{a,b}/notes.md')).toBe(false);
  });
});

describe('deriveScratchTriggerPath', () => {
  const base = '/tmp/ws';
  const token = 'abc123';

  it('places a root sibling with the glob extension for `*.md`', () => {
    expect(deriveScratchTriggerPath('*.md', base, token)).toBe(
      path.join(base, 'agentmonitors-verify-abc123.md'),
    );
  });

  it('keeps the static directory prefix for a nested pattern', () => {
    expect(deriveScratchTriggerPath('docs/notes/*.md', base, token)).toBe(
      path.join(base, 'docs', 'notes', 'agentmonitors-verify-abc123.md'),
    );
  });

  it('stops the prefix at the first wildcard segment (recursive glob)', () => {
    // `docs` then a recursive segment then `*.md`: prefix is just `docs`.
    expect(deriveScratchTriggerPath('docs/**/*.txt', base, token)).toBe(
      path.join(base, 'docs', 'agentmonitors-verify-abc123.txt'),
    );
  });

  it('yields no extension for a directory-only recursive glob', () => {
    expect(deriveScratchTriggerPath('src/**', base, token)).toBe(
      path.join(base, 'src', 'agentmonitors-verify-abc123'),
    );
  });

  // Regression: the static-prefix and extension logic pre-fix only broke on
  // `*`, so a directory segment carrying `?`/`[…]`/`{…}` magic was wrongly
  // folded into the "static" prefix, and a wildcard extension slipped through.
  it('stops the prefix at a non-`*` magic directory segment', () => {
    // `data-?` is a wildcard segment → prefix stops before it (root sibling).
    expect(deriveScratchTriggerPath('data-?/notes.md', base, token)).toBe(
      path.join(base, 'agentmonitors-verify-abc123.md'),
    );
    // A char-class directory segment likewise ends the static prefix.
    expect(deriveScratchTriggerPath('logs/[0-9]/out.txt', base, token)).toBe(
      path.join(base, 'logs', 'agentmonitors-verify-abc123.txt'),
    );
    // A brace-alternation directory segment ends the static prefix.
    expect(deriveScratchTriggerPath('src/{a,b}/notes.md', base, token)).toBe(
      path.join(base, 'src', 'agentmonitors-verify-abc123.md'),
    );
  });

  it('yields no extension when the suffix itself is glob magic', () => {
    // `*.{md,txt}` — the brace-alternation suffix is not a real extension.
    expect(deriveScratchTriggerPath('docs/*.{md,txt}', base, token)).toBe(
      path.join(base, 'docs', 'agentmonitors-verify-abc123'),
    );
    // `*.[jt]s` — a char-class suffix is likewise not a real extension.
    expect(deriveScratchTriggerPath('src/*.[jt]s', base, token)).toBe(
      path.join(base, 'src', 'agentmonitors-verify-abc123'),
    );
  });
});
