/** Admission limits protect validation work without changing ordinary monitor data. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scanMonitors } from '../parser/scan-monitors.js';
import { parseMonitor, parseMonitorFile } from '../parser/parse-monitor.js';
import * as shapeRuntime from '../runtime/shape.js';
import { generateMonitorSchema } from '../observation/schema-generator.js';
import { monitorFrontmatterSchema, shapeSchema } from './monitor-schema.js';

// Observe real filesystem reads without using heap measurements as an oracle.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
  };
});

const monitorPath = '/workspace/bounded/MONITOR.md';
const header = '---\nwatch:\n  type: file-fingerprint\n---\n';

describe('monitor input admission (001)', () => {
  // Collection declarations are raw arrays, not asynchronous producers of one.
  // In particular, an async parser must not unwrap a Promise past admission.
  describe.each([
    {
      label: 'tags',
      path: ['tags'],
      schema: monitorFrontmatterSchema,
      wrap: (value: unknown) => ({ watch: { type: 'schedule' }, tags: value }),
      limit: 256,
      element: 'tag',
    },
    {
      label: 'direct derive',
      path: ['derive'],
      schema: shapeSchema,
      wrap: (value: unknown) => ({ derive: value }),
      limit: 128,
      element: { name: 'rule', when: 'true' },
    },
    {
      label: 'nested derive',
      path: ['shape', 'derive'],
      schema: monitorFrontmatterSchema,
      wrap: (value: unknown) => ({
        watch: { type: 'schedule' },
        shape: { derive: value },
      }),
      limit: 128,
      element: { name: 'rule', when: 'true' },
    },
  ])('$label raw-array boundary', ({ schema, wrap, path, limit, element }) => {
    const inputs = [
      {
        label: 'valid promised array',
        create: () => Promise.resolve([element]),
      },
      {
        label: 'oversized promised array',
        create: () => Promise.resolve(Array(limit + 1).fill(element)),
      },
      {
        label: 'callable then/catch',
        create: () => ({
          then() {
            throw new Error('must not invoke then');
          },
          catch() {
            throw new Error('must not invoke catch');
          },
        }),
      },
      {
        label: 'then-only object',
        create: () => ({
          then() {
            throw new Error('must not invoke then');
          },
        }),
      },
      { label: 'ordinary object', create: () => ({}) },
      { label: 'Date', create: () => new Date('2026-11-03') },
      { label: 'Map', create: () => new Map() },
      { label: 'Set', create: () => new Set() },
      { label: 'typed array', create: () => new Uint8Array([1]) },
      { label: 'RegExp', create: () => /tags/ },
      { label: 'WeakMap', create: () => new WeakMap() },
      { label: 'WeakSet', create: () => new WeakSet() },
      { label: 'null', create: () => null },
      { label: 'string', create: () => 'tag' },
    ];
    it.each(inputs)(
      'rejects synchronous $label input as an array type error',
      ({ create }) => {
        // Resolved arrays contain valid elements: a pre-fix synchronous Promise
        // probe can throw, but cannot leave a rejected element-validation task.
        const result = schema.safeParse(wrap(create()));
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toMatchObject([
            { code: 'invalid_type', expected: 'array', path },
          ]);
      },
    );
    it.each(inputs)(
      'rejects asynchronous $label input as an array type error',
      async ({ create }) => {
        const result = await schema.safeParseAsync(wrap(create()));
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toMatchObject([
            { code: 'invalid_type', expected: 'array', path },
          ]);
      },
    );
    it('rejects a promised oversized collection without reading an element or predicate', async () => {
      let visits = 0;
      const values = new Array<unknown>(limit + 1);
      Object.defineProperty(values, 0, {
        get() {
          visits += 1;
          throw new Error('element/predicate must not be read');
        },
      });
      // Await the probe so a pre-fix getter rejection is handled by the test.
      const result = await schema.safeParseAsync(wrap(Promise.resolve(values)));
      expect(result.success).toBe(false);
      expect(visits).toBe(0);
      if (!result.success)
        expect(result.error.issues).toMatchObject([
          { code: 'invalid_type', expected: 'array', path },
        ]);
    });
    it('accepts exact raw-array boundaries in both parse modes', async () => {
      const input = wrap(Array(limit).fill(element));
      expect(schema.safeParse(input).success).toBe(true);
      expect((await schema.safeParseAsync(input)).success).toBe(true);
      expect(schema.safeParse(wrap(undefined)).success).toBe(true);
      expect((await schema.safeParseAsync(wrap(undefined))).success).toBe(true);
    });
  });

  it('rejects promised derive input before compiling any CEL predicate', async () => {
    const compile = vi.spyOn(shapeRuntime, 'validateCelPredicate');
    try {
      const result = await shapeSchema.safeParseAsync({
        derive: Promise.resolve(
          Array.from({ length: 129 }, (_, i) => ({
            name: `rule-${i}`,
            when: 'true',
          })),
        ),
      });
      expect(compile).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toMatchObject([
          { code: 'invalid_type', expected: 'array', path: ['derive'] },
        ]);
    } finally {
      compile.mockRestore();
    }
  });

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

  it('bounds production scans before decoding oversized flat and folder monitors', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scan-limits-'));
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const readResults: (() => Promise<readonly { bytesRead: number }[]>)[] = [];
    const closes: (() => number)[] = [];
    vi.mocked(fsPromises.readFile).mockClear();
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const reads = vi.spyOn(handle, 'read');
      const close = vi.spyOn(handle, 'close');
      readResults.push(async () =>
        Promise.all(reads.mock.results.map((result) => result.value)),
      );
      closes.push(() => close.mock.calls.length);
      return handle;
    });
    try {
      mkdirSync(path.join(root, 'folder'));
      const oversized = header + 'x'.repeat(2 * 1048576);
      writeFileSync(path.join(root, 'flat.md'), oversized);
      writeFileSync(path.join(root, 'folder', 'MONITOR.md'), oversized);
      writeFileSync(
        path.join(root, 'valid.md'),
        header + 'normal instructions',
      );
      writeFileSync(
        path.join(root, 'boundary.md'),
        header + 'x'.repeat(1048576 - Buffer.byteLength(header)),
      );
      const result = await scanMonitors(root);
      expect(result.errors).toEqual([
        expect.objectContaining({
          filePath: path.join(root, 'flat.md'),
          code: 'INPUT_LIMIT_EXCEEDED',
        }),
        expect.objectContaining({
          filePath: path.join(root, 'folder', 'MONITOR.md'),
          code: 'INPUT_LIMIT_EXCEEDED',
        }),
      ]);
      expect(result.monitors.map(({ monitor }) => monitor.id)).toEqual([
        'boundary',
        'valid',
      ]);
      expect(result.duplicateIds).toEqual([]);
      expect(fsPromises.readFile).not.toHaveBeenCalled();
      expect(readResults).toHaveLength(4);
      const totals = await Promise.all(
        readResults.map(async (results) =>
          (await results()).reduce((sum, result) => sum + result.bytesRead, 0),
        ),
      );
      expect(totals.sort((a, b) => a - b)).toEqual([
        Buffer.byteLength(header + 'normal instructions'),
        1048576,
        1048577,
        1048577,
      ]);
      expect(closes.map((count) => count())).toEqual([1, 1, 1, 1]);
    } finally {
      vi.mocked(fsPromises.open).mockImplementation(actual.open);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
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
