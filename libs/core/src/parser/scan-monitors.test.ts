import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
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
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs: ["*.ts"]
---

Handle file changes.
`;

const invalidContent = yaml`---
name: Bad monitor
source: file-fingerprint
urgency: invalid-value
event-kind: mutation
scope:
  globs: ["*.ts"]
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
});
