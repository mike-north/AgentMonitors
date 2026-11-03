/** Admission limits protect validation work without changing ordinary monitor data. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMonitor, parseMonitorFile } from '../parser/parse-monitor.js';
import { generateMonitorSchema } from '../observation/schema-generator.js';
import { monitorFrontmatterSchema } from './monitor-schema.js';

const monitorPath = '/workspace/bounded/MONITOR.md';
const header = '---\nwatch:\n  type: file-fingerprint\n---\n';

describe('monitor input admission (001)', () => {
  it('advertises the tag bound to editor schema consumers', () => {
    expect(generateMonitorSchema([])).toMatchObject({
      properties: { tags: { maxItems: 256 } },
    });
  });
  it.each([
    ['tags', 256],
    ['derive', 128],
  ] as const)(
    'rejects oversized %s before reading any element',
    (field, limit) => {
      const values = new Array<unknown>(limit + 1);
      Object.defineProperty(values, 0, {
        get() {
          throw new Error('element validator must not run');
        },
      });
      const result = monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint' },
        ...(field === 'tags'
          ? { tags: values }
          : { shape: { derive: values } }),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toContain(
          'INPUT_LIMIT_EXCEEDED',
        );
        expect(result.error.issues[0]?.path).toEqual(
          field === 'tags' ? ['tags'] : ['shape', 'derive'],
        );
      }
    },
  );

  it('accepts both collection boundaries and preserves ordinary validation', () => {
    expect(
      monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint' },
        tags: Array.from({ length: 256 }, (_, i) => `tag-${i}`),
        shape: {
          derive: Array.from({ length: 128 }, (_, i) => ({
            name: `rule-${i}`,
            when: 'true',
          })),
        },
      }).success,
    ).toBe(true);
    expect(
      monitorFrontmatterSchema.safeParse({
        watch: { type: 'file-fingerprint' },
        tags: [42],
      }).success,
    ).toBe(false);
  });

  it('returns a structured collection error from authored YAML', () => {
    const content = `---\nwatch:\n  type: file-fingerprint\ntags: [${Array(257).fill('tag').join(',')}]\n---\n`;
    expect(parseMonitor(content, monitorPath)).toMatchObject({
      ok: false,
      code: 'INPUT_LIMIT_EXCEEDED',
      filePath: monitorPath,
    });
  });

  it('accepts exactly 1 MiB and rejects UTF-8 bytes above it before parsing YAML', () => {
    expect(
      parseMonitor(
        header + 'x'.repeat(1048576 - Buffer.byteLength(header)),
        monitorPath,
      ).ok,
    ).toBe(true);
    expect(parseMonitor('é'.repeat(524289), monitorPath)).toMatchObject({
      ok: false,
      code: 'INPUT_LIMIT_EXCEEDED',
    });
  });

  it('applies the same byte limit to files on disk', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'monitor-limits-'));
    const file = path.join(root, 'monitor.md');
    try {
      writeFileSync(file, header + 'x'.repeat(1048576));
      expect(parseMonitorFile(file)).toMatchObject({
        ok: false,
        code: 'INPUT_LIMIT_EXCEEDED',
        filePath: file,
      });
      writeFileSync(
        file,
        header + 'x'.repeat(1048576 - Buffer.byteLength(header)),
      );
      expect(parseMonitorFile(file).ok).toBe(true);
      writeFileSync(file, header + 'normal instructions');
      expect(parseMonitorFile(file)).toMatchObject({
        ok: true,
        monitor: { instructions: 'normal instructions' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
