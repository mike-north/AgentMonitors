import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanMonitors } from './scan-monitors.js';

const yaml = String.raw;

function createTempMonitor(
  baseDir: string,
  folderName: string,
  content: string,
): void {
  const monitorDir = path.join(baseDir, folderName);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(path.join(monitorDir, 'MONITOR.md'), content, 'utf-8');
}

const validContent = yaml`---
name: Test monitor
watch:
  type: file-fingerprint
  globs: ["*.ts"]
urgency: normal
---

Handle file changes.
`;

const invalidContent = yaml`---
name: Bad monitor
watch:
  type: file-fingerprint
  globs: ["*.ts"]
urgency: invalid-value
---

Instructions.
`;

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmonitors-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('scanMonitors', () => {
  it('finds MONITOR.md in nested directories', async () => {
    const base = makeTempDir();
    createTempMonitor(base, 'monitor-a', validContent);
    createTempMonitor(base, 'monitor-b', validContent);

    const result = await scanMonitors(base);
    expect(result.monitors).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    const ids = result.monitors.map((m) => m.monitor.id).sort();
    expect(ids).toEqual(['monitor-a', 'monitor-b']);
  });

  it('reports parse errors without aborting', async () => {
    const base = makeTempDir();
    createTempMonitor(base, 'good', validContent);
    createTempMonitor(base, 'bad', invalidContent);

    const result = await scanMonitors(base);
    expect(result.monitors).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    const [monitor] = result.monitors;
    const [error] = result.errors;
    expect(monitor?.monitor.id).toBe('good');
    expect(error?.error).toContain('urgency');
  });

  it('returns empty results for directory with no monitors', async () => {
    const base = makeTempDir();

    const result = await scanMonitors(base);
    expect(result.monitors).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles missing directory gracefully', async () => {
    const result = await scanMonitors('/nonexistent/path/monitors');
    expect(result.monitors).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('derives folder name as monitor id', async () => {
    const base = makeTempDir();
    createTempMonitor(base, 'my-custom-name', validContent);

    const result = await scanMonitors(base);
    expect(result.monitors).toHaveLength(1);
    const [monitor] = result.monitors;
    expect(monitor?.monitor.id).toBe('my-custom-name');
  });

  // Regression for G1 / SP2: two folders with the same basename derive the same
  // monitor id, which would alias persisted monitor state. The scan must surface
  // the collision (it does not silently dedupe or drop either monitor).
  it('flags monitors whose folder-derived id collides', async () => {
    const base = makeTempDir();
    createTempMonitor(base, 'dup', validContent);
    createTempMonitor(base, path.join('nested', 'dup'), validContent);

    const result = await scanMonitors(base);

    // Both still parse successfully — duplicates are a tree-level concern,
    // not a per-file parse failure.
    expect(result.monitors).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    expect(result.duplicateIds).toHaveLength(1);
    const [dup] = result.duplicateIds;
    expect(dup?.id).toBe('dup');
    expect(dup?.filePaths).toHaveLength(2);
    expect(
      dup?.filePaths.every((p) => path.basename(path.dirname(p)) === 'dup'),
    ).toBe(true);
  });

  it('reports no duplicateIds when all ids are unique', async () => {
    const base = makeTempDir();
    createTempMonitor(base, 'monitor-a', validContent);
    createTempMonitor(base, 'monitor-b', validContent);

    const result = await scanMonitors(base);
    expect(result.duplicateIds).toEqual([]);
  });
});

const BODY = yaml`---
watch:
  type: file-fingerprint
  globs:
    - 'x'
urgency: normal
---
Body.
`;

it('discovers both flat monitor files and folder MONITOR.md files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    // flat monitor
    writeFileSync(path.join(root, 'watch-src.md'), BODY, 'utf-8');
    // folder monitor + a markdown ASSET that must NOT be treated as a monitor
    mkdirSync(path.join(root, 'pr-watch'), { recursive: true });
    writeFileSync(path.join(root, 'pr-watch', 'MONITOR.md'), BODY, 'utf-8');
    writeFileSync(
      path.join(root, 'pr-watch', 'notes.md'),
      'just notes',
      'utf-8',
    );

    const result = await scanMonitors(root);
    const ids = result.monitors.map((m) => m.monitor.id).sort();

    expect(ids).toEqual(['pr-watch', 'watch-src']);
    expect(result.duplicateIds).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('flags a flat file and a folder that derive the same id as a duplicate', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    writeFileSync(path.join(root, 'dup.md'), BODY, 'utf-8');
    mkdirSync(path.join(root, 'dup'), { recursive: true });
    writeFileSync(path.join(root, 'dup', 'MONITOR.md'), BODY, 'utf-8');

    const result = await scanMonitors(root);
    expect(result.duplicateIds.map((d) => d.id)).toEqual(['dup']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not discover a dot-prefixed flat file (.hidden.md) in the scanned root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    writeFileSync(path.join(root, '.hidden.md'), BODY, 'utf-8');
    writeFileSync(path.join(root, 'visible.md'), BODY, 'utf-8');

    const result = await scanMonitors(root);
    const ids = result.monitors.map((m) => m.monitor.id);
    expect(ids).toEqual(['visible']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A folder monitor is `<id>/MONITOR.md` (≥1 dir deep). A bare MONITOR.md sitting
// directly in the monitors root is not a valid monitor and must not be discovered
// (it would otherwise derive its id from the monitors-root directory name).
it('ignores a depth-0 MONITOR.md directly in the scanned root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    writeFileSync(path.join(root, 'MONITOR.md'), BODY, 'utf-8');
    mkdirSync(path.join(root, 'real'), { recursive: true });
    writeFileSync(path.join(root, 'real', 'MONITOR.md'), BODY, 'utf-8');

    const result = await scanMonitors(root);
    const ids = result.monitors.map((m) => m.monitor.id);
    expect(ids).toEqual(['real']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
