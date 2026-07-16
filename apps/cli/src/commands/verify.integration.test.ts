/**
 * Integration tests for `agentmonitors verify` (issue #399).
 *
 * These spawn the built CLI as a subprocess against a real temp workspace.
 * `verify` itself boots and tears down an isolated daemon internally, so the
 * test only invokes the one command and asserts the PASS/FAIL verdict, the
 * delivered additionalContext, the failing stage, and scratch cleanup — the
 * whole point of the command is that the caller does none of the manual recipe.
 *
 * @see docs/specs/005-cli-reference.md §16
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the CLI. Strips ambient AGENTMONITORS_* so an isolated verify run never
 * inherits the developer's real socket/db (mirrors cli.integration.test.ts).
 */
function run(args: string[], cwd: string): RunResult {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'AGENTMONITORS_SOCKET' &&
        key !== 'AGENTMONITORS_DB',
    ) as [string, string][],
  );
  const opts: ExecFileSyncOptions = { encoding: 'utf-8', env, cwd };
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

function writeMonitor(
  workspace: string,
  id: string,
  frontmatter: string,
): void {
  const dir = path.join(workspace, '.claude', 'monitors', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\n${frontmatter}\n---\nWhen this changes, review it.\n`,
    'utf-8',
  );
}

/** Files matching the auto-trigger scratch name (must be gone after cleanup). */
function scratchFiles(workspace: string): string[] {
  return readdirSync(workspace).filter((name) =>
    name.startsWith('agentmonitors-verify-'),
  );
}

describe('agentmonitors verify', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'verify-it-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reaches PASS on a real file-fingerprint change and delivers additionalContext (criterion 1)', () => {
    const ws = path.join(tempDir, 'pass');
    mkdirSync(ws, { recursive: true });
    // normal urgency → post-compact recap: proves end-to-end delivery WITHOUT
    // the 15s high-urgency claim-settle window, keeping the test fast. A 1s
    // interval keeps the budget small.
    writeMonitor(
      ws,
      'docs-watch',
      `name: Docs watch\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    const result = run(
      ['verify', 'docs-watch', '--workspace', ws, '--format', 'json'],
      ws,
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      stages: { name: string; status: string }[];
      additionalContext: string | null;
    };
    expect(report.ok).toBe(true);
    // Every pipeline stage passed through delivery.
    const deliver = report.stages.find((s) => s.name === 'deliver');
    expect(deliver?.status).toBe('pass');
    // The delivered proof artifact carries the monitor body.
    expect(report.additionalContext).toBeTruthy();
    expect(report.additionalContext).toContain('review it');

    // Criterion 4: the scratch file it created was cleaned up.
    expect(scratchFiles(ws)).toHaveLength(0);
  }, 60_000);

  it('FAILs with the observe stage when the trigger changes nothing observable (no-change)', () => {
    const ws = path.join(tempDir, 'nochange');
    mkdirSync(path.join(ws, 'data-1'), { recursive: true });
    // Glob requires a `data-*/` prefix; the auto-trigger scratch lands at the
    // workspace root, so it never matches — a deterministic no-change. An
    // existing matched file (data-1/report.md) means the post-trigger
    // observation is `no-change` (matched set unchanged), not
    // `no-files-matched`.
    writeMonitor(
      ws,
      'nc',
      `name: NC\nwatch:\n  type: file-fingerprint\n  globs:\n    - 'data-*/report.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'data-1', 'report.md'), 'orig', 'utf-8');

    const result = run(
      ['verify', 'nc', '--workspace', ws, '--format', 'json'],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('no-change');
    const observe = report.stages.find((s) => s.name === 'observe');
    expect(observe?.status).toBe('fail');
    // The workspace-root scratch file was still cleaned up.
    expect(scratchFiles(ws)).toHaveLength(0);
  }, 60_000);

  it('FAILs with a budget-exceeded verdict when a manual run gets no change in time', () => {
    const ws = path.join(tempDir, 'budget');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'm',
      `name: M\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}\n  interval: '1s'\nurgency: normal`,
    );
    writeFileSync(path.join(ws, 'readme.md'), 'hello', 'utf-8');

    // --manual + a short --timeout, and we make NO change → the detect phase
    // exhausts its budget and reports budget-exceeded on the observe stage.
    const result = run(
      [
        'verify',
        'm',
        '--workspace',
        ws,
        '--manual',
        '--timeout',
        '3000',
        '--format',
        'json',
      ],
      ws,
    );
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failure: { kind: string } | null;
      stages: { name: string; status: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('budget-exceeded');
    expect(report.stages.find((s) => s.name === 'observe')?.status).toBe(
      'fail',
    );
  }, 60_000);

  it('errors clearly when the named monitor does not exist (setup)', () => {
    const ws = path.join(tempDir, 'missing');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'present',
      `name: Present\nwatch:\n  type: file-fingerprint\n  globs:\n    - '*.md'\n  cwd: ${JSON.stringify(ws)}`,
    );

    const result = run(['verify', 'absent', '--workspace', ws], ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Monitor "absent" not found');
    expect(result.stderr).toContain('present');
  });

  it('lists the choices when no monitor id is given and several exist (setup)', () => {
    const ws = path.join(tempDir, 'ambiguous');
    mkdirSync(ws, { recursive: true });
    writeMonitor(
      ws,
      'one',
      `watch:\n  type: file-fingerprint\n  globs:\n    - '*.md'`,
    );
    writeMonitor(
      ws,
      'two',
      `watch:\n  type: file-fingerprint\n  globs:\n    - '*.txt'`,
    );

    const result = run(['verify', '--workspace', ws], ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Multiple monitors found');
    expect(result.stderr).toContain('one');
    expect(result.stderr).toContain('two');
  });
});
