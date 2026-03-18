/**
 * Integration tests for the agentmonitors CLI.
 *
 * These tests spawn the built CLI as a subprocess and verify
 * stdout, stderr, and exit codes.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string[], cwd?: string): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, AGENTMONITORS_DB: ':memory:' },
    cwd,
  };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], opts) as string;
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; status: number };
    return {
      stdout: (e.stdout ?? '') as string,
      stderr: (e.stderr ?? '') as string,
      exitCode: e.status ?? 1,
    };
  }
}

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'agentmonitors-test-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CLI --help', () => {
  it('shows help text', () => {
    const result = run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Durable observation and inbox delivery');
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('validate');
    expect(result.stdout).toContain('scan');
    expect(result.stdout).toContain('inbox');
  });
});

describe('init', () => {
  it('scaffolds a file-fingerprint monitor by default', () => {
    const dir = path.join(tempDir, 'init-test-1');
    mkdirSync(dir, { recursive: true });
    const result = run(
      ['init', 'my-monitor', '--dir', path.join(dir, 'monitors')],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created monitor');
  });

  it('scaffolds an api-poll monitor with --source', () => {
    const dir = path.join(tempDir, 'init-test-2');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'api-watcher',
        '--dir',
        path.join(dir, 'monitors'),
        '--source',
        'api-poll',
      ],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created monitor');
  });

  it('rejects invalid --source value', () => {
    const dir = path.join(tempDir, 'init-test-3');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'bad',
        '--dir',
        path.join(dir, 'monitors'),
        '--source',
        'nonexistent',
      ],
      dir,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'nonexistent'");
  });

  it('rejects duplicate monitor name', () => {
    const dir = path.join(tempDir, 'init-test-4');
    mkdirSync(dir, { recursive: true });
    run(['init', 'dup-monitor', '--dir', path.join(dir, 'monitors')], dir);
    const result = run(
      ['init', 'dup-monitor', '--dir', path.join(dir, 'monitors')],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists');
  });
});

describe('validate', () => {
  it('validates monitors in a directory', () => {
    const dir = path.join(tempDir, 'validate-test');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'test-monitor', '--dir', monitorsDir], dir);
    const result = run(['validate', monitorsDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  it('errors on nonexistent directory', () => {
    const result = run(['validate', '/tmp/nonexistent-agentmonitors-test-dir']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });

  it('returns JSON error when --format json and path missing', () => {
    const result = run([
      'validate',
      '/tmp/nonexistent-agentmonitors-test-dir',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toContain('does not exist');
  });

  it('rejects invalid --format value', () => {
    const result = run(['validate', '.', '--format', 'xml']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'xml'");
  });
});

describe('scan', () => {
  it('scans monitors and returns JSON', () => {
    const dir = path.join(tempDir, 'scan-test');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'scan-monitor', '--dir', monitorsDir], dir);
    const result = run(['scan', monitorsDir, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.monitors).toHaveLength(1);
    expect(parsed.monitors[0]).toHaveProperty('event-kind');
    expect(parsed.monitors[0]).toHaveProperty('tags');
    expect(parsed.monitors[0]).toHaveProperty('notify');
  });

  it('errors on nonexistent directory', () => {
    const result = run(['scan', '/tmp/nonexistent-agentmonitors-test-dir']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });
});

describe('source list', () => {
  it('lists sources in text format', () => {
    const result = run(['source', 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('file-fingerprint');
    expect(result.stdout).toContain('api-poll');
    expect(result.stdout).toContain('schedule');
  });

  it('lists sources in JSON format', () => {
    const result = run(['source', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(3);
    const names = parsed.map((s: { name: string }) => s.name);
    expect(names).toContain('file-fingerprint');
    expect(names).toContain('api-poll');
    expect(names).toContain('schedule');
  });
});

describe('monitor test', () => {
  it('errors on missing file', () => {
    const result = run(['monitor', 'test', '/tmp/nonexistent-monitor.md']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Monitor file not found');
  });

  it('returns JSON error on missing file with --format json', () => {
    const result = run([
      'monitor',
      'test',
      '/tmp/nonexistent-monitor.md',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toContain('Monitor file not found');
  });

  it('tests a valid file-fingerprint monitor', () => {
    const dir = path.join(tempDir, 'monitor-test');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'fp-monitor', '--dir', monitorsDir], dir);

    const monitorFile = path.join(monitorsDir, 'fp-monitor', 'MONITOR.md');
    const result = run(['monitor', 'test', monitorFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Baseline established');
    expect(result.stdout).toContain('fingerprint');
  });

  it('returns JSON output for a valid monitor', () => {
    const dir = path.join(tempDir, 'monitor-test-json');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'fp-json', '--dir', monitorsDir], dir);

    const monitorFile = path.join(monitorsDir, 'fp-json', 'MONITOR.md');
    const result = run(['monitor', 'test', monitorFile, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.monitor).toBe('My monitor');
    expect(parsed.source).toBe('file-fingerprint');
    expect(parsed.baseline).toBe(true);
    expect(parsed).toHaveProperty('observations');
  });

  it('errors on invalid MONITOR.md content', () => {
    const dir = path.join(tempDir, 'monitor-test-invalid');
    mkdirSync(dir, { recursive: true });
    const badFile = path.join(dir, 'MONITOR.md');
    writeFileSync(badFile, 'no frontmatter here', 'utf-8');
    const result = run(['monitor', 'test', badFile]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Parse error');
  });
});

describe('inbox list', () => {
  it('returns empty list', () => {
    const result = run(['inbox', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([]);
  });

  it('rejects invalid --state value', () => {
    const result = run(['inbox', 'list', '--state', 'banana']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'banana'");
  });

  it('rejects invalid --urgency value', () => {
    const result = run(['inbox', 'list', '--urgency', 'extreme']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'extreme'");
  });

  it('rejects invalid --format value', () => {
    const result = run(['inbox', 'list', '--format', 'xml']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'xml'");
  });

  it('rejects invalid --since date', () => {
    const result = run(['inbox', 'list', '--since', 'not-a-date']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('valid ISO 8601 date');
  });
});
