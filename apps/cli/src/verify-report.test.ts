/**
 * Unit tests for the verify PASS/FAIL renderers (issue #399). These assert the
 * user-facing report contract (spec 005 §16) without booting a daemon: the
 * daemon-died path in particular is hard to induce deterministically end-to-end,
 * so its distinct reporting (criterion 3) is proven here.
 *
 * @see docs/specs/005-cli-reference.md §16
 */
import { describe, it, expect } from 'vitest';
import {
  renderVerifyJson,
  renderVerifyText,
  type VerifyResult,
} from './verify-report.js';

const passResult: VerifyResult = {
  ok: true,
  monitorId: 'docs-watch',
  elapsedMs: 3200,
  additionalContext:
    'AgentMon: monitored changes are pending\n\n### docs-watch (high)\nreview',
  stages: [
    { name: 'daemon', status: 'pass', detail: 'booted' },
    { name: 'session', status: 'pass', detail: 'registered' },
    { name: 'baseline', status: 'pass', detail: 'first observation recorded' },
    { name: 'trigger', status: 'pass', detail: 'wrote scratch file' },
    { name: 'observe', status: 'pass', detail: 'change detected (triggered)' },
    { name: 'materialize', status: 'pass', detail: '1 unread event(s)' },
    {
      name: 'deliver',
      status: 'pass',
      detail: 'claimed at turn-interruptible',
    },
  ],
};

describe('renderVerifyText — PASS', () => {
  it('prints PASS and echoes the delivered additionalContext as the proof artifact', () => {
    const text = renderVerifyText(passResult);
    expect(text).toContain('agentmonitors verify: docs-watch');
    expect(text).toContain('PASS  docs-watch delivers end-to-end (3.2s)');
    expect(text).toContain('Delivered additionalContext:');
    expect(text).toContain('### docs-watch (high)');
    // Every stage renders with its pass glyph.
    expect(text).toContain('✓ deliver');
  });
});

describe('renderVerifyText — FAIL naming the stage', () => {
  it('no-change: names the observe stage and the trigger-did-nothing message', () => {
    const result: VerifyResult = {
      ok: false,
      monitorId: 'nc',
      elapsedMs: 1500,
      failure: {
        kind: 'no-change',
        message: 'the trigger did not change what this monitor observes.',
      },
      stages: [
        { name: 'daemon', status: 'pass', detail: 'booted' },
        { name: 'observe', status: 'fail', detail: 'no change detected' },
      ],
    };
    const text = renderVerifyText(result);
    expect(text).toContain('FAIL  observe — the trigger did not change');
    expect(text).not.toContain('PASS');
  });

  it('budget-exceeded: names the observe stage', () => {
    const result: VerifyResult = {
      ok: false,
      monitorId: 'slow',
      elapsedMs: 40000,
      failure: {
        kind: 'budget-exceeded',
        message: 'no change was observed within the budget (3s).',
      },
      stages: [
        {
          name: 'observe',
          status: 'fail',
          detail: 'no change observed within 3s',
        },
      ],
    };
    expect(renderVerifyText(result)).toContain(
      'FAIL  observe — no change was observed within the budget',
    );
  });

  it('daemon-died: surfaces the daemon’s own captured output distinctly (criterion 3)', () => {
    const result: VerifyResult = {
      ok: false,
      monitorId: 'crash',
      elapsedMs: 8000,
      failure: {
        kind: 'daemon-died',
        message: 'the daemon exited (code 1) before delivery completed.',
      },
      daemonStderr: 'Error: no such table: agent_sessions',
      stages: [
        { name: 'daemon', status: 'pass', detail: 'booted' },
        { name: 'observe', status: 'fail', detail: 'daemon exited' },
      ],
    };
    const text = renderVerifyText(result);
    expect(text).toContain('FAIL  observe — the daemon exited (code 1)');
    expect(text).toContain('Daemon output:');
    expect(text).toContain('Error: no such table: agent_sessions');
  });
});

describe('renderVerifyJson', () => {
  it('emits a stable machine shape with ok/stages/failure/additionalContext', () => {
    const parsed = JSON.parse(renderVerifyJson(passResult)) as Record<
      string,
      unknown
    >;
    expect(parsed['ok']).toBe(true);
    expect(parsed['monitorId']).toBe('docs-watch');
    expect(parsed['failure']).toBeNull();
    expect(parsed['additionalContext']).toContain('### docs-watch');
    expect(Array.isArray(parsed['stages'])).toBe(true);
    expect((parsed['stages'] as unknown[]).length).toBe(7);
  });

  it('nulls absent optionals on a FAIL result', () => {
    const result: VerifyResult = {
      ok: false,
      monitorId: 'nc',
      elapsedMs: 1500,
      failure: { kind: 'no-change', message: 'trigger did nothing' },
      stages: [{ name: 'observe', status: 'fail', detail: 'no change' }],
    };
    const parsed = JSON.parse(renderVerifyJson(result)) as Record<
      string,
      unknown
    >;
    expect(parsed['ok']).toBe(false);
    expect(parsed['additionalContext']).toBeNull();
    expect(parsed['daemonStderr']).toBeNull();
    expect((parsed['failure'] as Record<string, unknown>)['kind']).toBe(
      'no-change',
    );
  });
});
