/** Actual CLI formatting must preserve monitor read budgets, including diagnostic rereads. */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const maximum = 1024 * 1024;
const valid = "---\nwatch:\n  type: schedule\n  cron: '* * * * *'\n---\n";
const legacy = '---\nsource: schedule\nscope: {}\n---\n';
const hint = 'did you mean to use the current watch shape?';
const entry = fileURLToPath(new URL('../../dist/index.cjs', import.meta.url));

// Instrument the built process at the filesystem boundary. A deterministic
// replacement after scan closure exercises the race before hint formatting;
// observing stat size alone would not prove intake remains bounded.
const preload = String.raw`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const rows = [];
const watched = file => String(file).startsWith(process.env.MONITOR_ROOT + path.sep);
const rowFor = (api, file) => { const row = {api, file: String(file), bytes: 0, closed: false, requests: []}; rows.push(row); return row; };
const fullRead = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = Reflect.apply(fullRead, this, [file, ...args]);
  if (watched(file)) { const row = rowFor('full', file); row.bytes = Buffer.byteLength(value); row.closed = true; }
  return value;
};
const descriptors = new Map();
const openSync = fs.openSync;
fs.openSync = function(file, ...args) { const fd = Reflect.apply(openSync, this, [file, ...args]); if (watched(file)) descriptors.set(fd, rowFor('sync', file)); return fd; };
const readSync = fs.readSync;
fs.readSync = function(...args) { const bytes = Reflect.apply(readSync, this, args); const row = descriptors.get(args[0]); if (row) { row.bytes += bytes; row.requests.push(args[3]); } return bytes; };
const closeSync = fs.closeSync;
fs.closeSync = function(fd) { const result = Reflect.apply(closeSync, this, [fd]); const row = descriptors.get(fd); if (row) { row.closed = true; descriptors.delete(fd); } return result; };
const open = fsp.open;
let mutated = false;
fsp.open = async function(file, ...args) {
  const handle = await Reflect.apply(open, this, [file, ...args]);
  if (!watched(file)) return handle;
  const row = rowFor('async', file);
  const read = handle.read.bind(handle);
  handle.read = async (...params) => { const result = await read(...params); row.bytes += result.bytesRead; row.requests.push(params[2]); return result; };
  const close = handle.close.bind(handle);
  handle.close = async () => {
    await close(); row.closed = true;
    if (!mutated && process.env.REPLACE_MODE && String(file) === process.env.LEGACY_FILE) {
      mutated = true;
      if (process.env.REPLACE_MODE === 'grow') fs.appendFileSync(file, 'x'.repeat(2 * 1024 * 1024));
      else { const next = String(file) + '.replacement'; fs.writeFileSync(next, '---\nsource: schedule\nscope: {}\n---\n' + 'x'.repeat(2 * 1024 * 1024)); fs.renameSync(next, file); }
    }
  };
  return handle;
};
process.on('exit', () => fs.writeFileSync(process.env.READ_TRACE, JSON.stringify(rows)));
`;

const traceSchema = z.array(
  z.object({
    api: z.enum(['full', 'sync', 'async']),
    file: z.string(),
    bytes: z.number(),
    closed: z.boolean(),
    requests: z.array(z.number()),
  }),
);

/** Execute only the prebuilt bundle: tests never rebuild shared CLI artifacts. */
function validate(
  format: string,
  files: Record<string, string>,
  mode?: string,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'validate-budget-'));
  const monitors = path.join(root, 'monitors');
  mkdirSync(monitors);
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(monitors, name), content);
  const loader = path.join(root, 'trace.cjs');
  const traceFile = path.join(root, 'reads.json');
  writeFileSync(loader, preload);
  try {
    const result = spawnSync(
      process.execPath,
      ['--require', loader, entry, 'validate', monitors, '--format', format],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          MONITOR_ROOT: monitors,
          READ_TRACE: traceFile,
          LEGACY_FILE: path.join(monitors, 'legacy.md'),
          REPLACE_MODE: mode ?? '',
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const trace = traceSchema.parse(
      JSON.parse(readFileSync(traceFile, 'utf8')),
    );
    return { output: result.stdout, trace };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.each(['text', 'json'])(
  'validate admission formatting (%s)',
  (format) => {
    it('does not reread an admission rejection and preserves the exact-boundary sibling', () => {
      const { output, trace } = validate(format, {
        'huge.md': legacy + 'x'.repeat(2 * maximum),
        'boundary.md': valid + 'x'.repeat(maximum - Buffer.byteLength(valid)),
      });
      expect(output).toContain('INPUT_LIMIT_EXCEEDED');
      expect(output).toContain('boundary');
      expect(output).not.toContain(hint);
      if (format === 'json')
        expect(JSON.parse(output)).toMatchObject({ valid: 1, invalid: 1 });
      else {
        expect(output).toContain('Valid monitors: 1');
        expect(output).toContain('Invalid monitors: 1');
      }
      expect(
        trace.filter((row) => row.api === 'full' || row.api === 'sync'),
      ).toEqual([]);
      expect(
        trace
          .filter((row) => row.api === 'async')
          .map((row) => row.bytes)
          .sort((a, b) => a - b),
      ).toEqual([maximum, maximum + 1]);
      expect(
        trace.every(
          (row) =>
            row.closed && row.requests.every((bytes) => bytes <= maximum + 1),
        ),
      ).toBe(true);
    }, 10000);

    it('keeps ordinary legacy advice and unrelated error diagnostics', () => {
      const { output, trace } = validate(format, {
        'legacy.md': legacy,
        'other.md': valid.replace('---\n', '---\nurgency: critical\n'),
        'valid.md': valid,
      });
      expect(output).toContain(hint);
      expect(output).toContain('urgency');
      if (format === 'json')
        expect(JSON.parse(output)).toMatchObject({ valid: 1, invalid: 2 });
      expect(trace.filter((row) => row.api === 'full')).toEqual([]);
      expect(
        trace
          .filter(
            (row) => row.api === 'sync' && row.file.endsWith('/legacy.md'),
          )
          .map((row) => row.bytes),
      ).toEqual([Buffer.byteLength(legacy)]);
      expect(trace.every((row) => row.closed)).toBe(true);
    }, 10000);

    it.each(['grow', 'replace'])(
      'bounds a diagnostic reread when the rejected file changes: %s',
      (mode) => {
        const { output, trace } = validate(
          format,
          { 'legacy.md': legacy, 'valid.md': valid },
          mode,
        );
        expect(output).not.toContain(hint);
        expect(output).toContain('watch');
        if (format === 'json')
          expect(JSON.parse(output)).toMatchObject({ valid: 1, invalid: 1 });
        expect(trace.filter((row) => row.api === 'full')).toEqual([]);
        expect(
          trace.filter((row) => row.api === 'sync').map((row) => row.bytes),
        ).toEqual([maximum + 1]);
        expect(
          trace.every(
            (row) =>
              row.closed && row.requests.every((bytes) => bytes <= maximum + 1),
          ),
        ).toBe(true);
      },
      10000,
    );
  },
);
