import { describe, expect, it } from 'vitest';
import { monitorFrontmatterSchema } from './monitor-schema.js';

const validMinimal = {
  name: 'Test monitor',
  watch: { type: 'file-fingerprint', globs: ['**/*.ts'] },
  urgency: 'normal' as const,
};

const validFull = {
  ...validMinimal,
  name: 'GitHub PR review monitor',
  watch: {
    type: 'api-poll',
    url: 'https://api.github.com/repos/my-org/my-repo/pulls?state=open',
    auth: { type: 'bearer', 'token-env': 'GITHUB_TOKEN' },
    interval: '5m',
  },
  urgency: 'high' as const,
  notify: { strategy: 'debounce' as const, 'settle-for': '5m' },
  tags: ['github', 'review', 'code-review'],
};

describe('monitorFrontmatterSchema', () => {
  describe('valid monitors', () => {
    it('accepts minimal valid monitor', () => {
      const result = monitorFrontmatterSchema.safeParse(validMinimal);
      expect(result.success).toBe(true);
    });

    it('accepts full valid monitor with all fields', () => {
      const result = monitorFrontmatterSchema.safeParse(validFull);
      expect(result.success).toBe(true);
    });

    it('accepts throttle notify strategy', () => {
      const input = {
        ...validMinimal,
        notify: { strategy: 'throttle' as const, 'suppress-for': '10m' },
      };
      const result = monitorFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('accepts monitor without notify (immediate delivery)', () => {
      const result = monitorFrontmatterSchema.safeParse(validMinimal);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notify).toBeUndefined();
      }
    });

    it('accepts monitor without tags', () => {
      const result = monitorFrontmatterSchema.safeParse(validMinimal);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toBeUndefined();
      }
    });

    it('accepts all urgency values', () => {
      // `low` is first-class (PP5, 001 §3.2) and must be accepted, not just
      // `normal`/`high`; this guards against the schema narrowing it away.
      for (const urgency of ['low', 'normal', 'high']) {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency,
        });
        expect(result.success, `urgency "${urgency}" should be accepted`).toBe(
          true,
        );
      }
    });

    // G13 / 001 §3.7 / 002 §1.1.7: the `baseline-strategy` authoring field.
    describe('baseline-strategy (G13, 001 §3.7)', () => {
      it('accepts baseline-strategy: incremental', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          'baseline-strategy': 'incremental',
        });
        expect(result.success).toBe(true);
        if (result.success) {
          // 001 §3.7: surfaced under the camelCase `baselineStrategy` key.
          expect(result.data.baselineStrategy).toBe('incremental');
        }
      });

      it('accepts baseline-strategy: net', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          'baseline-strategy': 'net',
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.baselineStrategy).toBe('net');
        }
      });

      it('defaults to incremental when baseline-strategy is omitted (backward compatible)', () => {
        // 001 §3.7 / 002 §1.1.7: omitting the field MUST behave as `incremental`.
        const result = monitorFrontmatterSchema.safeParse(validMinimal);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.baselineStrategy).toBe('incremental');
        }
      });

      it('rejects an unknown baseline-strategy value', () => {
        // 001 §3.7: only `incremental` and `net` are valid; anything else is an
        // authoring error caught by `validate`.
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          'baseline-strategy': 'cumulative',
        });
        expect(result.success).toBe(false);
      });
    });

    it('parses a minimal monitor without event-kind', () => {
      const result = monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint', globs: ['x'] },
        urgency: 'normal',
      });
      expect(result.success).toBe(true);
    });

    it('ignores an event-kind field if present (no longer part of the schema)', () => {
      const result = monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint', globs: ['x'] },
        urgency: 'normal',
        'event-kind': 'mutation',
      });
      // schema is non-strict, so an extra key is dropped, not an error
      expect(result.success).toBe(true);
      if (result.success) expect('event-kind' in result.data).toBe(false);
    });

    it('carries arbitrary per-source config keys flat inside watch', () => {
      const result = monitorFrontmatterSchema.safeParse({
        watch: {
          type: 'api-poll',
          url: 'https://example.com/api',
          method: 'GET',
          interval: '5m',
        },
        urgency: 'normal',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.watch.type).toBe('api-poll');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((result.data.watch as any).url).toBe('https://example.com/api');
      }
    });
  });

  describe('missing required fields', () => {
    it('accepts frontmatter that omits name (name is optional)', () => {
      const result = monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint', globs: ['src/**/*.ts'] },
        urgency: 'normal',
      });
      expect(result.success).toBe(true);
    });

    it('still rejects an empty-string name', () => {
      const result = monitorFrontmatterSchema.safeParse({
        name: '',
        watch: { type: 'file-fingerprint', globs: ['x'] },
        urgency: 'normal',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing watch', () => {
      const { watch: _, ...rest } = validMinimal;
      const result = monitorFrontmatterSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects watch block without type', () => {
      const result = monitorFrontmatterSchema.safeParse({
        watch: { globs: ['**/*.ts'] },
        urgency: 'normal',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing urgency', () => {
      const { urgency: _, ...rest } = validMinimal;
      const result = monitorFrontmatterSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects old source/scope shape (hard cut — no back-compat)', () => {
      const result = monitorFrontmatterSchema.safeParse({
        source: 'file-fingerprint',
        urgency: 'normal',
        scope: { globs: ['**/*.ts'] },
      });
      // `watch` is required, so this must fail
      expect(result.success).toBe(false);
    });
  });

  describe('invalid field values', () => {
    it('rejects empty name', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        name: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid urgency', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        urgency: 'critical',
      });
      expect(result.success).toBe(false);
    });

    describe('urgency band (range) — issue #109 / 001 §3.2', () => {
      it('parses a bare scalar as a degenerate band (urgency === urgencyMax)', () => {
        // Backward compat: `urgency: normal` is the band normal..normal.
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'normal',
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.urgency).toBe('normal');
        expect(result.data.urgencyMax).toBe('normal');
      });

      it('parses a range "normal..high" into low/high bounds', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'normal..high',
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        // The band's low bound is kept under `urgency` (the base/default
        // effective urgency); the high bound under `urgencyMax`.
        expect(result.data.urgency).toBe('normal');
        expect(result.data.urgencyMax).toBe('high');
      });

      it('parses the widest band "low..high"', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'low..high',
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.urgency).toBe('low');
        expect(result.data.urgencyMax).toBe('high');
      });

      it('parses an explicit degenerate range "high..high"', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'high..high',
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.urgency).toBe('high');
        expect(result.data.urgencyMax).toBe('high');
      });

      it('tolerates surrounding/internal whitespace in a range', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: ' normal .. high ',
        });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.urgency).toBe('normal');
        expect(result.data.urgencyMax).toBe('high');
      });

      it('rejects an inverted range "high..normal" (lo must be ≤ hi)', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'high..normal',
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.issues[0]?.message).toMatch(/invert/i);
      });

      it('rejects an inverted range "normal..low"', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'normal..low',
        });
        expect(result.success).toBe(false);
      });

      it('rejects a range with an unknown bound "low..critical"', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'low..critical',
        });
        expect(result.success).toBe(false);
      });

      it('rejects a malformed range with more than two bounds', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: 'low..normal..high',
        });
        expect(result.success).toBe(false);
      });

      it('rejects an empty bound "..high"', () => {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          urgency: '..high',
        });
        expect(result.success).toBe(false);
      });
    });

    it('rejects non-kebab-case watch.type', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        watch: { type: 'FileFingerprint' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects watch.type starting with a digit', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        watch: { type: '1source' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('notify validation', () => {
    it('rejects invalid notify strategy', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'coalesce' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects debounce without settle-for', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'debounce' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects throttle without suppress-for', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'throttle' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid duration format in settle-for', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'debounce', 'settle-for': '5 minutes' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid duration format in suppress-for', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'throttle', 'suppress-for': 'forever' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid duration strings', () => {
      for (const duration of ['5s', '10m', '1h', '2d']) {
        const result = monitorFrontmatterSchema.safeParse({
          ...validMinimal,
          notify: { strategy: 'debounce', 'settle-for': duration },
        });
        expect(result.success).toBe(true);
      }
    });
  });

  // Scheduled-rollup Pace mode (G12). Proof criterion (a): `validate` accepts a
  // rollup monitor (with a `window` cron) and rejects `strategy: rollup` missing
  // `window`. `validate` runs the frontmatter through this schema (via
  // parseMonitor), so asserting acceptance/rejection here is the contract test.
  //
  // @see docs/specs/001-monitor-definition.md §3.6
  // @see docs/specs/002-runtime-delivery.md §4.4
  describe('rollup notify (G12, 001 §3.6)', () => {
    it('accepts a rollup monitor with a window cron', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'rollup', window: '0 9 * * 1-5' },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // The discriminated union narrows to the rollup branch.
      expect(result.data.notify).toEqual({
        strategy: 'rollup',
        window: '0 9 * * 1-5',
      });
    });

    it('accepts a rollup monitor with an optional timezone', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: {
          strategy: 'rollup',
          window: '0 9 * * 1-5',
          timezone: 'America/Los_Angeles',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.notify).toEqual({
        strategy: 'rollup',
        window: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
      });
    });

    it('rejects a rollup monitor missing the required window', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'rollup' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a rollup window that is not a five-field cron expression', () => {
      // Four fields — too few for a five-field cron.
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'rollup', window: '0 9 * *' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty rollup window string', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        notify: { strategy: 'rollup', window: '' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('tags validation', () => {
    it('accepts empty tags array', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        tags: [],
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-string tags', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        tags: [42],
      });
      expect(result.success).toBe(false);
    });
  });
});
