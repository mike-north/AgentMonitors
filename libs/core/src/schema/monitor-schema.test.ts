import { describe, expect, it } from 'vitest';
import { monitorFrontmatterSchema } from './monitor-schema.js';

const validMinimal = {
  name: 'Test monitor',
  source: 'file-fingerprint',
  urgency: 'normal' as const,
  scope: { globs: ['**/*.ts'] },
};

const validFull = {
  ...validMinimal,
  name: 'GitHub PR review monitor',
  source: 'api-poll',
  urgency: 'high' as const,
  scope: {
    url: 'https://api.github.com/repos/my-org/my-repo/pulls?state=open',
    auth: { type: 'bearer', 'token-env': 'GITHUB_TOKEN' },
    interval: '5m',
  },
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

    it('parses a minimal monitor without event-kind', () => {
      const result = monitorFrontmatterSchema.safeParse({
        source: 'file-fingerprint',
        urgency: 'normal',
        scope: { globs: ['x'] },
      });
      expect(result.success).toBe(true);
    });

    it('ignores an event-kind field if present (no longer part of the schema)', () => {
      const result = monitorFrontmatterSchema.safeParse({
        source: 'file-fingerprint',
        urgency: 'normal',
        'event-kind': 'mutation',
        scope: { globs: ['x'] },
      });
      // schema is non-strict, so an extra key is dropped, not an error
      expect(result.success).toBe(true);
      if (result.success) expect('event-kind' in result.data).toBe(false);
    });
  });

  describe('missing required fields', () => {
    it('accepts frontmatter that omits name (name is optional)', () => {
      const result = monitorFrontmatterSchema.safeParse({
        source: 'file-fingerprint',
        urgency: 'normal',
        scope: { globs: ['src/**/*.ts'] },
      });
      expect(result.success).toBe(true);
    });

    it('still rejects an empty-string name', () => {
      const result = monitorFrontmatterSchema.safeParse({
        name: '',
        source: 'file-fingerprint',
        urgency: 'normal',
        scope: { globs: ['x'] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing source', () => {
      const { source: _, ...rest } = validMinimal;
      const result = monitorFrontmatterSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects missing urgency', () => {
      const { urgency: _, ...rest } = validMinimal;
      const result = monitorFrontmatterSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects missing scope', () => {
      const { scope: _, ...rest } = validMinimal;
      const result = monitorFrontmatterSchema.safeParse(rest);
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

    it('rejects non-kebab-case source', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        source: 'FileFingerprint',
      });
      expect(result.success).toBe(false);
    });

    it('rejects source starting with a digit', () => {
      const result = monitorFrontmatterSchema.safeParse({
        ...validMinimal,
        source: '1source',
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
