/**
 * Unit tests for the verify budget + scratch-trigger helpers (issue #399).
 *
 * The budget math is spec-derived (interval + settle + margin), NOT captured
 * from output: each assertion traces to the runtime defaults in
 * `libs/core/src/runtime/service.ts` (mirrored in verify-budget.ts) and
 * 002 §4.4 / §9.1.
 *
 * @see docs/specs/002-runtime-delivery.md
 * @see docs/specs/005-cli-reference.md §16
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseMonitor, type MonitorDefinition } from '@agentmonitors/core';
import {
  DEFAULT_API_POLL_INTERVAL_MS,
  DEFAULT_FILE_FINGERPRINT_INTERVAL_MS,
  DEFAULT_SCHEDULE_TICK_MS,
  HIGH_URGENCY_CLAIM_SETTLE_MS,
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
      DEFAULT_FILE_FINGERPRINT_INTERVAL_MS,
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
    expect(resolvePollIntervalMs(monitor)).toBe(DEFAULT_API_POLL_INTERVAL_MS);
  });

  it('uses the 60s tick cadence for cron-driven schedule sources', () => {
    const monitor = monitorFrom(
      "watch:\n  type: schedule\n  cron: '*/5 * * * *'",
    );
    expect(resolvePollIntervalMs(monitor)).toBe(DEFAULT_SCHEDULE_TICK_MS);
  });

  it('falls back to the default for a malformed interval rather than throwing', () => {
    // A hand-edited (schema-invalid) interval must degrade, not crash verify.
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: 'not-a-duration'",
    );
    expect(resolvePollIntervalMs(monitor)).toBe(
      DEFAULT_FILE_FINGERPRINT_INTERVAL_MS,
    );
  });
});

describe('resolveSettleMs', () => {
  it('is 0 when no notify strategy is declared', () => {
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

  it('adds the 15s high-urgency claim-settle window to the detect phase', () => {
    const monitor = monitorFrom(
      "watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  interval: '4s'\nurgency: high",
    );
    const budget = computeVerifyBudget(monitor);
    // 002 §9.1: DEFAULT_HIGH_URGENCY_SETTLE_MS applies only to detect (claim), not baseline.
    expect(budget.highClaimSettleMs).toBe(HIGH_URGENCY_CLAIM_SETTLE_MS);
    expect(budget.baselineMs).toBe(4_000 + 5_000);
    expect(budget.detectMs).toBe(4_000 + HIGH_URGENCY_CLAIM_SETTLE_MS + 5_000);
  });

  it('scales the margin to 25% of a long interval', () => {
    // api-poll default 300_000 → margin = max(5000, 75_000) = 75_000
    const monitor = monitorFrom(
      "watch:\n  type: api-poll\n  url: 'https://example.com'",
    );
    const budget = computeVerifyBudget(monitor);
    expect(budget.marginMs).toBe(75_000);
    expect(budget.intervalMs).toBe(DEFAULT_API_POLL_INTERVAL_MS);
  });
});

describe('isLiteralGlob', () => {
  it('is true for a literal single file', () => {
    expect(isLiteralGlob('watched.txt')).toBe(true);
    expect(isLiteralGlob('docs/readme.md')).toBe(true);
  });

  it('is false for any wildcard pattern', () => {
    expect(isLiteralGlob('*.md')).toBe(false);
    expect(isLiteralGlob('src/**')).toBe(false);
    expect(isLiteralGlob('data-*/report.md')).toBe(false);
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
});
