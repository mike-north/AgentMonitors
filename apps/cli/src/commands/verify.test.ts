/**
 * Unit tests for internal `verify` command helpers (issue #399).
 *
 * @see docs/specs/005-cli-reference.md §16
 */
import { describe, it, expect } from 'vitest';
import type { Stage } from '../verify-report.js';
import { appendDaemonCrashStage } from './verify.js';

describe('appendDaemonCrashStage', () => {
  it('names the stage that was in flight, not the last completed stage', () => {
    // The daemon died while the `observe` phase was polling; `baseline` was the
    // last COMPLETED stage. A prior version read `stages[stages.length - 1]`
    // and wrongly blamed `baseline` (off-by-one) — and duplicated its name.
    const stages: Stage[] = [
      { name: 'daemon', status: 'pass' },
      { name: 'session', status: 'pass' },
      { name: 'baseline', status: 'pass' },
    ];

    appendDaemonCrashStage(stages, 'observe');

    const failed = stages.filter((s) => s.status === 'fail');
    expect(failed).toHaveLength(1);
    // The failed stage is the in-flight one…
    expect(failed[0]?.name).toBe('observe');
    // …and the last completed stage was not duplicated.
    expect(stages.filter((s) => s.name === 'baseline')).toHaveLength(1);
  });

  it('carries the daemon-exited detail on the failed stage', () => {
    const stages: Stage[] = [{ name: 'daemon', status: 'pass' }];
    appendDaemonCrashStage(stages, 'materialize');
    expect(stages.at(-1)).toEqual({
      name: 'materialize',
      status: 'fail',
      detail: 'daemon exited',
    });
  });
});
