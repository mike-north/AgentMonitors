/**
 * Integration tests for the agentmonitors CLI.
 *
 * These tests spawn the built CLI as a subprocess and verify
 * stdout, stderr, and exit codes.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeLocalState } from '../local-state.js';
import { daemonAvailable, callDaemon } from '../daemon-ipc.js';
import { decodeToon } from '../toon-format.js';

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');
const CLI_PACKAGE_DIR = path.resolve(__dirname, '../..');
// Repo root holds the activation plugin. The config-drift UAT below reads the
// plugin's REAL hooks.json from here (no copies) so it breaks when that file
// drifts. apps/cli → ../../ is the monorepo root.
const REPO_ROOT = path.resolve(CLI_PACKAGE_DIR, '..', '..');
const PLUGIN_HOOKS_JSON_PATH = path.join(
  REPO_ROOT,
  'agent-plugins',
  'agentmonitors',
  'hooks',
  'hooks.json',
);

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DaemonHandle {
  stop: () => void;
  waitForExit: () => Promise<void>;
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

function runWithEnv(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
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

function runWithCleanEnv(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): RunResult {
  const strippedKeys = new Set(['AGENTMONITORS_SOCKET']);
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => value !== undefined && !strippedKeys.has(key),
        ) as [string, string][],
      ),
      ...env,
    },
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

/**
 * All environment variables that `is-agentic-tui` inspects to detect an agentic
 * TUI. Used by {@link runAsHuman} to build a clean non-agentic subprocess env.
 *
 * @see https://github.com/mike-north/is-agentic-tui
 */
const AGENTIC_TUI_ENV_KEYS = [
  // Claude Code
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PATH',
  // Cursor
  'CURSOR_AGENT',
  'CURSOR_INVOKED_AS',
  // Gemini CLI
  'GEMINI_CLI',
  // Aider
  'AIDER',
  'OR_APP_NAME',
  'OR_SITE_URL',
  // Codex
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  // Cline
  'CLINE_ACTIVE',
  // Kiro CLI
  'Q_TERM',
  'QTERM_SESSION_ID',
] as const;

/**
 * Runs the CLI as if it were called by a human (non-agentic) terminal.
 *
 * Strips all environment variables that `is-agentic-tui` uses for detection so
 * the test is hermetic even when the test runner itself runs inside an agentic
 * TUI such as Claude Code (which sets `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`,
 * etc. in the current process's environment, which would otherwise be inherited).
 */
function runAsHuman(
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd?: string,
): RunResult {
  // Build an env that excludes all agentic-TUI signals so detection sees a
  // clean non-agentic environment regardless of what the test runner inherits.
  const agenticKeys = new Set<string>(AGENTIC_TUI_ENV_KEYS);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) => v !== undefined && !agenticKeys.has(k),
      ) as [string, string][],
    ),
    ...extraEnv,
  };

  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env,
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

/**
 * Like {@link runWithEnv} but pipes `input` to the child's STDIN. Claude Code
 * hooks receive their payload as JSON on stdin (not env vars), so the
 * `hook deliver` tests must feed the payload this way. `execFileSync`'s `input`
 * option writes the string to the child's stdin and closes it, so the command's
 * stdin read sees `end` immediately — no hang.
 */
function runWithStdin(
  args: string[],
  env: Record<string, string>,
  input: string,
  cwd?: string,
): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
    input,
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

async function startDaemon(
  monitorsDir: string,
  workspace: string,
  env: Record<string, string>,
  socketPath: string,
): Promise<DaemonHandle> {
  const child = spawn(
    'node',
    [
      CLI_PATH,
      'daemon',
      'run',
      monitorsDir,
      '--workspace',
      workspace,
      '--poll-ms',
      '200',
      '--socket',
      socketPath,
    ],
    {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      existsSync(socketPath) &&
      stdout.includes('AgentMon daemon listening')
    ) {
      return {
        stop: () => {
          child.kill('SIGTERM');
        },
        waitForExit: () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => resolve());
          }),
      };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon exited early with code ${child.exitCode}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill('SIGTERM');
  throw new Error(
    `Timed out waiting for daemon startup.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
  );
}

let tempDir: string;

beforeAll(() => {
  execFileSync('pnpm', ['build'], {
    cwd: CLI_PACKAGE_DIR,
    stdio: 'pipe',
    env: process.env,
  });
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

describe('CLI --version', () => {
  // Regression: index.ts shipped with a hardcoded `.version('0.0.0')`, so the
  // published 0.3.0 CLI reported 0.0.0 — making it impossible to tell which
  // version a user actually has installed. The version must come from
  // package.json, and this test must compare against the manifest (never a
  // literal) so re-hardcoding or a bundle-layout change fails it. Runs against
  // the built dist/index.cjs, so it also proves the path resolution survives
  // bundling.
  it('reports the version from package.json (never a hardcoded literal)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(CLI_PACKAGE_DIR, 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(manifest.version).not.toBe('0.0.0');

    const result = run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });
});

describe('channel serve', () => {
  it('registers the channel serve command and its flags', () => {
    const result = run(['channel', 'serve', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--poll-ms');
    expect(result.stdout).toContain('--host-session-id');
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

  it('scaffolds an api-poll monitor with --type', () => {
    const dir = path.join(tempDir, 'init-test-2');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'api-watcher',
        '--dir',
        path.join(dir, 'monitors'),
        '--type',
        'api-poll',
      ],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created monitor');
  });

  it('scaffolds an incoming-changes monitor that passes validate', () => {
    const dir = path.join(tempDir, 'init-incoming');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'spec-watch',
        '--dir',
        monitorsDir,
        '--type',
        'incoming-changes',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('Created monitor');

    // The scaffolded scope must validate against the registered source's
    // scopeSchema (paths required) — proves both registration and the template.
    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { source: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.monitors[0]?.source).toBe('incoming-changes');
  });

  // AC7 — the scaffolded command-poll template validates against the registered
  // source's scopeSchema (`command` required), proving registration + the template.
  it('scaffolds a command-poll monitor that passes validate', () => {
    const dir = path.join(tempDir, 'init-command-poll');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', 'cmd-watch', '--dir', monitorsDir, '--type', 'command-poll'],
      dir,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('Created monitor');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { source: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.monitors[0]?.source).toBe('command-poll');
  });

  it('rejects invalid --type value', () => {
    const dir = path.join(tempDir, 'init-test-3');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'bad',
        '--dir',
        path.join(dir, 'monitors'),
        '--type',
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

  // Regression for G1 / SP2: two folders with the same basename derive the same
  // monitor id; validate must fail (exit 1) and name the collision.
  it('rejects duplicate monitor ids', () => {
    const dir = path.join(tempDir, 'validate-dup-test');
    const monitorsDir = path.join(dir, 'monitors');
    const body = [
      '---',
      'name: Dup',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    for (const rel of ['dup', path.join('nested', 'dup')]) {
      const d = path.join(monitorsDir, rel);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'MONITOR.md'), body, 'utf-8');
    }

    const result = run(['validate', monitorsDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Duplicate monitor id "dup"');

    const json = run(['validate', monitorsDir, '--format', 'json']);
    const parsed = JSON.parse(json.stdout) as {
      duplicateIds: { id: string; filePaths: string[] }[];
    };
    expect(parsed.duplicateIds).toHaveLength(1);
    expect(parsed.duplicateIds[0]?.id).toBe('dup');
    expect(parsed.duplicateIds[0]?.filePaths).toHaveLength(2);
  });

  // Full per-source JSON Schema validation: a present-but-wrong-typed scope field
  // (globs must be an array of strings) is rejected, where the old required-fields
  // -only check silently accepted it.
  it('rejects a scope that violates the source schema', () => {
    const dir = path.join(tempDir, 'validate-badscope-test');
    const monitorDir = path.join(dir, 'monitors', 'bad-scope');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Bad scope',
      'watch:',
      '  type: file-fingerprint',
      '  globs: 42',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toMatch(/scope|array|type/);
  });

  // issue #109 / 001 §3.2: an authored urgency band `lo..hi` is valid.
  it('accepts a range urgency band (lo..hi)', () => {
    const dir = path.join(tempDir, 'validate-range-urgency-test');
    const monitorDir = path.join(dir, 'monitors', 'banded');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Banded',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: normal..high',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  // issue #109 / 001 §3.2: an inverted band (lo > hi) must be rejected.
  it('rejects an inverted urgency band (high..normal)', () => {
    const dir = path.join(tempDir, 'validate-inverted-urgency-test');
    const monitorDir = path.join(dir, 'monitors', 'inverted');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Inverted',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: high..normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toContain('urgency');
  });

  // G13 / 001 §3.7 / 002 §1.1.7: `baseline-strategy` accepts incremental and
  // net, and rejects any other value.
  for (const strategy of ['incremental', 'net'] as const) {
    it(`accepts baseline-strategy: ${strategy}`, () => {
      const dir = path.join(tempDir, `validate-baseline-${strategy}-test`);
      const monitorDir = path.join(dir, 'monitors', 'baselined');
      mkdirSync(monitorDir, { recursive: true });
      const body = [
        '---',
        'name: Baselined',
        'watch:',
        '  type: file-fingerprint',
        '  globs: ["*.ts"]',
        'urgency: normal',
        `baseline-strategy: ${strategy}`,
        '---',
        'Handle it.',
        '',
      ].join('\n');
      writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

      const result = run(['validate', path.join(dir, 'monitors')]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Valid monitors: 1');
    });
  }

  it('rejects an unknown baseline-strategy value', () => {
    const dir = path.join(tempDir, 'validate-baseline-unknown-test');
    const monitorDir = path.join(dir, 'monitors', 'bad-baseline');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Bad baseline',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: normal',
      'baseline-strategy: cumulative',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toContain('baseline-strategy');
  });

  // G12 / 001 §3.6, 002 §4.4: a scheduled-rollup monitor (`strategy: rollup`
  // with a `window` cron) is accepted by `validate`. Proof criterion (a),
  // exercised end-to-end through the real CLI.
  it('accepts a rollup notify monitor with a window cron', () => {
    const dir = path.join(tempDir, 'validate-rollup-accept-test');
    const monitorDir = path.join(dir, 'monitors', 'daily-digest');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Daily digest',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'notify:',
      '  strategy: rollup',
      "  window: '0 9 * * 1-5'",
      'urgency: low',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  // G12 / 001 §3.6: `strategy: rollup` WITHOUT the required `window` is rejected.
  // Proof criterion (a), rejection half.
  it('rejects a rollup notify monitor missing the required window', () => {
    const dir = path.join(tempDir, 'validate-rollup-reject-test');
    const monitorDir = path.join(dir, 'monitors', 'bad-rollup');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Bad rollup',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'notify:',
      '  strategy: rollup',
      'urgency: low',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
  });

  // Issue #153 item 3: the inverted-range error must not repeat "urgency" twice.
  // Before the fix: `urgency: urgency range "high..normal" is inverted …`
  // After: `urgency: range "high..normal" is inverted …`
  it('inverted urgency error does not double the field name', () => {
    const dir = path.join(tempDir, 'validate-inverted-urgency-nodupe-test');
    const monitorDir = path.join(dir, 'monitors', 'inverted-dupe');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Inverted Dupe',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: high..normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    // The error line must contain exactly one "urgency" occurrence as the
    // field prefix, and the message itself must not repeat it.
    const errorLine = result.stdout
      .split('\n')
      .find((l) => l.includes('inverted'));
    expect(errorLine).toBeDefined();
    // Should be "urgency: range …" not "urgency: urgency range …"
    expect(errorLine).toMatch(/urgency:\s+range/);
    expect(errorLine).not.toMatch(/urgency:\s+urgency/);
  });

  // Issue #153 item 1: invalid monitors must display the monitor ID (like valid
  // monitors do) rather than the full file path.
  it('invalid monitors display the monitor ID, not the full file path', () => {
    const dir = path.join(tempDir, 'validate-error-id-test');
    const monitorDir = path.join(dir, 'monitors', 'my-broken-monitor');
    mkdirSync(monitorDir, { recursive: true });
    // Write a monitor with invalid frontmatter (missing required watch.type)
    const body = [
      '---',
      'name: Broken',
      'watch:',
      '  type: unknown-source-xyz',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    // The error must show the monitor ID, not the absolute path to MONITOR.md
    expect(result.stdout).toContain('my-broken-monitor');
    expect(result.stdout).not.toContain('/MONITOR.md');
  });

  // Copilot review fix (id=3416005973): monitorIdFromPath must mirror parseMonitor's
  // empty/dot-prefixed guard so it returns '' for such ids (triggering the file-path
  // fallback in the caller) rather than a confusing ".hidden-monitor" label.
  // Note: glob's `**` pattern silently skips dot-prefixed directories, so a
  // `.hidden-monitor` folder in the monitors tree is simply not discovered — the
  // validate command exits 0 with "No monitors found." This test confirms that
  // behaviour (dot-prefixed folders are not surfaced as errors).
  it('silently skips dot-prefixed monitor folder names (glob excludes them)', () => {
    const dir = path.join(tempDir, 'validate-dot-id-test');
    const monitorsDir = path.join(dir, 'monitors');
    const monitorDir = path.join(monitorsDir, '.hidden-monitor');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Dot Prefixed',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', monitorsDir]);
    // glob skips dot-prefixed dirs: no monitors found, exits 0, no ".hidden-monitor" label.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('.hidden-monitor');
    expect(result.stdout).toContain('No monitors found.');
  });

  // Issue #153 item 2: validate with a file path must name monitor test as the
  // symmetric command.
  it('rejects a file path and names monitor test as the alternative', () => {
    const dir = path.join(tempDir, 'validate-file-arg-test');
    const monitorDir = path.join(dir, 'monitors', 'some-monitor');
    mkdirSync(monitorDir, { recursive: true });
    run(['init', 'some-monitor', '--dir', path.join(dir, 'monitors')], dir);

    const monitorFile = path.join(monitorDir, 'MONITOR.md');
    const result = run(['validate', monitorFile]);
    expect(result.exitCode).toBe(1);
    // Error must mention the symmetric command so authors know what to use instead
    expect(result.stderr).toContain('monitor test');
    // The path in the remediation must be single-quoted to handle spaces/special chars.
    // Copilot fix id=3416006173.
    expect(result.stderr).toContain(`'${monitorFile}'`);
  });

  // Copilot thread 3410689135: the generated JSON Schema pattern for `urgency`
  // must accept the same leading/trailing whitespace that the Zod parser accepts
  // (it calls `.trim()` before validating bounds). Both validation surfaces must
  // agree so editors that consume the generated schema don't flag valid files.
  it('accepts a whitespace-padded urgency value that the parser trims', () => {
    const dir = path.join(tempDir, 'validate-whitespace-urgency-test');
    const monitorDir = path.join(dir, 'monitors', 'ws-padded');
    mkdirSync(monitorDir, { recursive: true });
    // Quoted YAML string with surrounding spaces — YAML preserves them, so the
    // parser receives the string with leading/trailing spaces and must trim.
    const body = [
      '---',
      'name: Whitespace padded',
      'watch:',
      '  type: file-fingerprint',
      '  globs: ["*.ts"]',
      "urgency: ' normal .. high '",
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  it('hints when a monitor uses the old top-level source/scope shape', () => {
    const dir = path.join(tempDir, 'validate-old-shape-test');
    const monitorDir = path.join(dir, 'monitors', 'old-shape');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Old shape',
      'source: file-fingerprint',
      'scope:',
      '  globs: ["*.ts"]',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('did you mean');
    expect(result.stdout).toContain('watch:');
    expect(result.stdout).toContain('type: file-fingerprint');
  });

  // Regression for nit id=3408121150 — CRLF line endings (Windows) must not
  // silently suppress the migration hint. The frontmatter extractor must tolerate
  // \r\n and still surface the old-shape suggestion.
  it('hints when the old source/scope shape is in a CRLF-encoded file', () => {
    const dir = path.join(tempDir, 'validate-old-shape-crlf-test');
    const monitorDir = path.join(dir, 'monitors', 'old-shape-crlf');
    mkdirSync(monitorDir, { recursive: true });
    // Construct the body with explicit CRLF (\r\n) line endings throughout.
    const lf = [
      '---',
      'name: Old shape CRLF',
      'source: file-fingerprint',
      'scope:',
      '  globs: ["*.ts"]',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\r\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), lf, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('did you mean');
    expect(result.stdout).toContain('watch:');
    expect(result.stdout).toContain('type: file-fingerprint');
  });

  // Regression for nit id=3408121150 — a UTF-8 BOM at the start of the file must
  // not prevent frontmatter extraction.
  it('hints when the old source/scope shape is in a file with a UTF-8 BOM', () => {
    const dir = path.join(tempDir, 'validate-old-shape-bom-test');
    const monitorDir = path.join(dir, 'monitors', 'old-shape-bom');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Old shape BOM',
      'source: file-fingerprint',
      'scope:',
      '  globs: ["*.ts"]',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    // Prepend the UTF-8 BOM byte-sequence (U+FEFF).
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      '\uFEFF' + body,
      'utf-8',
    );

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('did you mean');
    expect(result.stdout).toContain('watch:');
    expect(result.stdout).toContain('type: file-fingerprint');
  });

  // Regression for nit id=3408121155 — `scope:` with inline content (e.g. `scope: { ... }`)
  // must still be recognised so the hint fires. Previously only `scope:` with an
  // empty value matched; a key with inline content was silently ignored.
  it('hints when scope: has inline content (not just a bare key)', () => {
    const dir = path.join(tempDir, 'validate-old-shape-scope-inline-test');
    const monitorDir = path.join(dir, 'monitors', 'old-shape-scope-inline');
    mkdirSync(monitorDir, { recursive: true });
    // `scope:` here has an inline YAML mapping value, not just a bare key.
    const body = [
      '---',
      'name: Old shape inline scope',
      'source: file-fingerprint',
      'scope: { globs: ["*.ts"] }',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('did you mean');
    expect(result.stdout).toContain('watch:');
    expect(result.stdout).toContain('type: file-fingerprint');
  });

  it('rejects an unknown source name', () => {
    const dir = path.join(tempDir, 'validate-unknownsource-test');
    const monitorDir = path.join(dir, 'monitors', 'mystery');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Mystery',
      'watch:',
      '  type: not-a-real-source',
      '  foo: bar',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unknown source');
  });

  // AC7 — a command-poll monitor missing the required `command` field is rejected
  // with a clear, field-naming message (full per-source JSON Schema validation).
  it('rejects a command-poll monitor missing `command`', () => {
    const dir = path.join(tempDir, 'validate-command-poll-missing');
    const monitorDir = path.join(dir, 'monitors', 'cmd-bad');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Missing command',
      'watch:',
      '  type: command-poll',
      '  interval: 5m',
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('command');
  });

  // AC7 — a well-formed command-poll monitor (argv `command`) validates.
  it('accepts a well-formed command-poll monitor', () => {
    const dir = path.join(tempDir, 'validate-command-poll-ok');
    const monitorDir = path.join(dir, 'monitors', 'cmd-ok');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Git status',
      'watch:',
      '  type: command-poll',
      '  command:',
      '    - git',
      '    - status',
      '    - --porcelain',
      '  interval: 5m',
      'urgency: normal',
      '---',
      'Review the working-tree changes.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  it('rejects unknown command-poll change-detection keys', () => {
    const dir = path.join(tempDir, 'validate-command-poll-bogus-cd-key');
    const monitorDir = path.join(dir, 'monitors', 'cmd-bogus-cd');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Git status',
      'watch:',
      '  type: command-poll',
      '  command:',
      '    - git',
      '    - status',
      '  change-detection:',
      '    strategy: json-diff',
      '    bogus-nonsense-key: 123',
      'urgency: normal',
      '---',
      'Review the working-tree changes.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');

    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('bogus-nonsense-key');
  });

  // 003 §12 BP3 — a `change-detection.collection` block is only valid under
  // `strategy: json-diff`. Under text-diff/exit-code it must be rejected with a
  // clear message, for both poll sources.
  function collectionMonitorBody(
    sourceType: string,
    strategy: string,
    watchLines: string[],
  ): string {
    return [
      '---',
      'name: Tasks',
      'watch:',
      `  type: ${sourceType}`,
      ...watchLines,
      '  change-detection:',
      `    strategy: ${strategy}`,
      '    collection:',
      "      path: '$.tasks'",
      "      key: 'id'",
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
  }

  it('rejects a collection under text-diff (api-poll) with a clear message', () => {
    const dir = path.join(tempDir, 'validate-collection-textdiff');
    const monitorDir = path.join(dir, 'monitors', 'coll-text');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      collectionMonitorBody('api-poll', 'text-diff', [
        "  url: 'https://api.example.com/tasks'",
      ]),
      'utf-8',
    );
    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      'change-detection.collection requires strategy: json-diff',
    );
  });

  it('rejects a collection under exit-code (command-poll) with a clear message', () => {
    const dir = path.join(tempDir, 'validate-collection-exitcode');
    const monitorDir = path.join(dir, 'monitors', 'coll-exit');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      collectionMonitorBody('command-poll', 'exit-code', [
        '  command:',
        '    - git',
        '    - status',
      ]),
      'utf-8',
    );
    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      'change-detection.collection requires strategy: json-diff',
    );
  });

  it('accepts a json-diff + collection monitor (api-poll)', () => {
    const dir = path.join(tempDir, 'validate-collection-ok');
    const monitorDir = path.join(dir, 'monitors', 'coll-ok');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      collectionMonitorBody('api-poll', 'json-diff', [
        "  url: 'https://api.example.com/tasks'",
      ]),
      'utf-8',
    );
    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
  });

  // Reconciliation proof (PR #107 over the #111 tightened schema): a keyed-collection
  // monitor written with the bare-dotted authoring shorthand (`path: tasks`, not
  // `$.tasks`) must still pass `validate`. #111 added an explicit
  // `additionalProperties: false` allow-list to `command-poll`'s change-detection that
  // intentionally KEEPS `collection`; #107 lets authors write bare paths inside it.
  // Both must survive: the bare-path form validates clean (exit 0) under the tightened
  // schema rather than being rejected as an unknown shape.
  it('accepts a bare-path json-diff + collection monitor (command-poll)', () => {
    const dir = path.join(tempDir, 'validate-collection-bare-path');
    const monitorDir = path.join(dir, 'monitors', 'coll-bare');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Tasks',
      'watch:',
      '  type: command-poll',
      '  command:',
      '    - echo',
      '    - "{}"',
      '  change-detection:',
      '    strategy: json-diff',
      '    collection:',
      '      path: tasks', // bare dotted form — no `$.` prefix (#107)
      "      key: 'id'",
      '      ignore-paths:',
      '        - fetchedAt', // bare element-relative ignore path (#107)
      'urgency: normal',
      '---',
      'Handle it.',
      '',
    ].join('\n');
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');
    const result = run(['validate', path.join(dir, 'monitors')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Valid monitors: 1');
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
    expect(parsed.monitors[0]).not.toHaveProperty('event-kind');
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
    const result = run(['source', 'list', '--format', 'text']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Config fields:');
    expect(result.stdout).toContain('interval');
    expect(result.stdout).toContain('ignore');
    expect(result.stdout).toContain('Default observe interval is 30s');
    expect(result.stdout).not.toContain('Scope fields:');
    expect(result.stdout).toContain('file-fingerprint');
    expect(result.stdout).toContain('api-poll');
    expect(result.stdout).toContain('command-poll');
    expect(result.stdout).toContain('schedule');
    expect(result.stdout).toContain('incoming-changes');
  });

  it('lists sources in JSON format', () => {
    const result = run(['source', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(5);
    const names = parsed.map((s: { name: string }) => s.name);
    expect(names).toContain('file-fingerprint');
    expect(names).toContain('api-poll');
    expect(names).toContain('command-poll');
    expect(names).toContain('schedule');
    expect(names).toContain('incoming-changes');
    expect(parsed[0]).toHaveProperty('configFields');
    const fileFingerprint = parsed.find(
      (source: { name: string }) => source.name === 'file-fingerprint',
    ) as {
      configFields: string[];
      fieldDescriptions: Record<string, string>;
    };
    expect(fileFingerprint.configFields).toContain('interval');
    expect(fileFingerprint.configFields).toContain('ignore');
    expect(fileFingerprint.fieldDescriptions['ignore']).toContain(
      'exclude glob',
    );
    expect(fileFingerprint.fieldDescriptions['interval']).toContain(
      'Default observe interval is 30s',
    );
    const commandPoll = parsed.find(
      (source: { name: string }) => source.name === 'command-poll',
    ) as { fieldDescriptions: Record<string, string> };
    expect(commandPoll.fieldDescriptions['command']).toContain('command[0]');
    expect(commandPoll.fieldDescriptions['command']).toContain("['sh', '-c'");
  });

  it('auto-detects toon when run by an agent (no --format flag, CLAUDECODE=1)', () => {
    const result = runWithEnv(['source', 'list'], {
      AGENTMONITORS_DB: ':memory:',
      CLAUDECODE: '1',
    });
    expect(result.exitCode).toBe(0);
    // TOON output does not use JSON braces for the root array
    expect(result.stdout).not.toMatch(/^\s*\[$/m);
    // All source names are present in the toon output
    expect(result.stdout).toContain('file-fingerprint');
    expect(result.stdout).toContain('api-poll');
  });

  it('auto-detects text when run by a human (no --format flag, no agentic env vars)', () => {
    // runAsHuman strips all env vars that is-agentic-tui uses so the test is
    // hermetic even when the test runner itself runs inside an agentic TUI.
    const result = runAsHuman(['source', 'list'], {
      AGENTMONITORS_DB: ':memory:',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Config fields:');
    expect(result.stdout).toContain('file-fingerprint');
  });

  it('toon source list output round-trips to the JSON value after normalizing description rows', () => {
    const jsonResult = run(['source', 'list', '--format', 'json']);
    const toonResult = run(['source', 'list', '--format', 'toon']);
    expect(jsonResult.exitCode).toBe(0);
    expect(toonResult.exitCode).toBe(0);
    const fromJson = JSON.parse(jsonResult.stdout) as unknown;
    const fromToon = decodeToon(toonResult.stdout) as {
      fieldDescriptions:
        | Record<string, string>
        | { field: string; description: string }[];
    }[];
    const normalizedToon = fromToon.map((source) => ({
      ...source,
      fieldDescriptions: Array.isArray(source.fieldDescriptions)
        ? Object.fromEntries(
            source.fieldDescriptions.map(({ field, description }) => [
              field,
              description,
            ]),
          )
        : source.fieldDescriptions,
    }));
    expect(normalizedToon).toEqual(fromJson);
  });

  it('rejects invalid --format value for source list', () => {
    const result = run(['source', 'list', '--format', 'xml']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('xml');
  });
});

describe('--format toon for structured-output commands', () => {
  it('scan auto-detects toon when run by an agent (no --format flag, CLAUDECODE=1)', () => {
    const dir = path.join(tempDir, 'scan-toon-default');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'my-monitor', '--dir', monitorsDir], dir);
    const result = runWithEnv(['scan', monitorsDir], {
      AGENTMONITORS_DB: ':memory:',
      CLAUDECODE: '1',
    });
    expect(result.exitCode).toBe(0);
    // Not raw JSON (no outer braces)
    expect(result.stdout.trim()).not.toMatch(/^\{/);
    // The monitor id is present
    expect(result.stdout).toContain('my-monitor');
  });

  it('scan auto-detects text when run by a human (no --format flag, no agentic env vars)', () => {
    const dir = path.join(tempDir, 'scan-toon-human-default');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'human-monitor', '--dir', monitorsDir], dir);
    // runAsHuman strips all env vars that is-agentic-tui uses so the test is
    // hermetic even when the test runner itself runs inside an agentic TUI.
    const result = runAsHuman(['scan', monitorsDir], {
      AGENTMONITORS_DB: ':memory:',
    });
    expect(result.exitCode).toBe(0);
    // Human text format has a header row with padded columns
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('human-monitor');
  });

  it('scan toon output round-trips to identical JSON value as --format json', () => {
    const dir = path.join(tempDir, 'scan-toon-roundtrip');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'rtrip-monitor', '--dir', monitorsDir], dir);
    const jsonResult = run(['scan', monitorsDir, '--format', 'json']);
    const toonResult = run(['scan', monitorsDir, '--format', 'toon']);
    expect(jsonResult.exitCode).toBe(0);
    expect(toonResult.exitCode).toBe(0);
    const fromJson = JSON.parse(jsonResult.stdout) as unknown;
    const fromToon = decodeToon(toonResult.stdout);
    expect(fromToon).toEqual(fromJson);
  });

  it('scan --format json output is byte-for-byte unchanged (no regression)', () => {
    const dir = path.join(tempDir, 'scan-json-unchanged');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'stable-monitor', '--dir', monitorsDir], dir);
    // --format json must still produce valid JSON with the documented shape
    const result = run(['scan', monitorsDir, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    // duplicateIds is DuplicateMonitorId[] — objects with { id, filePaths } —
    // NOT string[]. The CLI passes result.duplicateIds through directly.
    const parsed = JSON.parse(result.stdout) as {
      monitors: {
        id: string;
        name: string;
        source: string;
        urgency: string;
        tags: string[];
        notify: string | null;
      }[];
      errors: { filePath: string; error: string }[];
      duplicateIds: { id: string; filePaths: string[] }[];
    };
    expect(parsed.monitors).toHaveLength(1);
    expect(parsed.monitors[0]).toMatchObject({
      id: 'stable-monitor',
      source: 'file-fingerprint',
    });
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.duplicateIds).toHaveLength(0);
  });

  it('scan --format toon produces toon (not json, not plain text table)', () => {
    const dir = path.join(tempDir, 'scan-toon-explicit');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'explicit-toon-monitor', '--dir', monitorsDir], dir);
    const result = run(['scan', monitorsDir, '--format', 'toon']);
    expect(result.exitCode).toBe(0);
    // Not the text table format (text has a header row with padded columns)
    expect(result.stdout).not.toContain('ID'.padEnd(30));
    // Is TOON (contains the monitor id as a value, not as a JSON key with quotes)
    expect(result.stdout).toContain('explicit-toon-monitor');
    // Is parseable by the TOON decoder
    expect(() => decodeToon(result.stdout)).not.toThrow();
  });
});

describe('daemon status', () => {
  it('returns a non-running status payload when the daemon is down', () => {
    const socketPath = path.join(tempDir, 'daemon-status-down.sock');
    const result = runWithEnv(
      ['daemon', 'status', '--socket', socketPath, '--format', 'json'],
      {
        AGENTMONITORS_DB: ':memory:',
        AGENTMONITORS_SOCKET: socketPath,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      running: boolean;
      socketPath: string;
      sessions: number;
      activeSessions: number;
      dormantSessions: number;
      events: number;
    };
    expect(parsed.running).toBe(false);
    expect(parsed.socketPath).toBe(socketPath);
    expect(parsed.sessions).toBe(0);
    expect(parsed.activeSessions).toBe(0);
    expect(parsed.dormantSessions).toBe(0);
    expect(parsed.events).toBe(0);
  });
});

/**
 * Issue #117: `daemon once` (and the `daemon run` periodic log) must stop
 * printing a clean `emitted 0 event(s)` when a monitor's `observe()` errored on
 * the tick — an author cannot otherwise distinguish a genuine no-change (not a
 * bug) from a broken source (the disease behind #105).
 *
 * `daemon once` runs the tick in-process (no socket, no daemon), so these
 * assertions drive the real CLI subprocess with `:memory:` storage — no orphan
 * daemon to reap, fully deterministic, no network.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/117
 */
describe('daemon once error visibility (issue #117)', () => {
  // A command-poll monitor whose command emits JSON where the keyed-collection
  // `path` resolves to a NON-array. Static `validate` cannot catch this — the
  // failure is data-dependent (the command's runtime output), so it surfaces
  // only when `observe()` runs. This is exactly #105's class of bug.
  const erroringMonitorBody = `---
name: Errors on observe
watch:
  type: command-poll
  command:
    - node
    - '-e'
    - 'process.stdout.write(JSON.stringify({ tasks: 42 }))'
  interval: 5m
  change-detection:
    strategy: json-diff
    collection:
      path: tasks
      key: id
urgency: normal
---
When the command output changes, review it.
`;

  // file-fingerprint baselines silently on its first tick: a genuine no-change.
  const noChangeMonitorBody = `---
name: Genuine no-change
watch:
  type: file-fingerprint
  globs:
    - watched.txt
urgency: normal
---
When files change, review them.
`;

  // schedule fires on every observe(); cron '* * * * *' is due every tick, so a
  // single `daemon once` emits exactly one event from it.
  const emittingMonitorBody = `---
name: Emits every tick
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`;

  function writeMonitor(
    monitorsRoot: string,
    monitorId: string,
    body: string,
  ): void {
    const monitorDir = path.join(monitorsRoot, monitorId);
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');
  }

  // Acceptance criterion 1: a monitor whose observe() throws → `daemon once`
  // names the errored monitor + message, NOT a bare `emitted 0`.
  // Regression: pre-fix `daemon once` printed only `…emitted 0 event(s).`,
  // so the `errored:` line and the monitor id below are absent → this fails.
  it('names the errored monitor and its message instead of a bare "emitted 0"', () => {
    const dir = path.join(tempDir, 'once-error-only');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeMonitor(monitorsRoot, 'breaks-on-observe', erroringMonitorBody);

    const result = run(['daemon', 'once', monitorsRoot, '--workspace', dir]);
    expect(result.exitCode).toBe(0);

    // It must report exactly 1 errored, name the monitor, and include the
    // collection-path error message — the not-a-bug `emitted 0` alone is a lie.
    expect(result.stdout).toContain('1 errored:');
    expect(result.stdout).toContain('breaks-on-observe:');
    expect(result.stdout).toContain('must select an array');
    expect(result.stdout).toContain('emitted 0 event(s)');
  });

  // Acceptance criterion 2: a genuine no-change still reports `emitted 0` with
  // NO error line (don't cry wolf).
  it('keeps a genuine no-change clean (emitted 0, no errored line)', () => {
    const dir = path.join(tempDir, 'once-no-change');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'watched.txt'), 'hello', 'utf-8');
    writeMonitor(monitorsRoot, 'quiet', noChangeMonitorBody);

    const result = run(['daemon', 'once', monitorsRoot, '--workspace', dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('emitted 0 event(s).');
    expect(result.stdout).not.toContain('errored');
  });

  // Acceptance criterion 3: a mix (one errors, one emits, one no-change) is
  // reported truthfully in one summary.
  it('reports a mix of errored, emitted, and no-change truthfully', () => {
    const dir = path.join(tempDir, 'once-mixed');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'watched.txt'), 'hello', 'utf-8');
    writeMonitor(monitorsRoot, 'breaks-on-observe', erroringMonitorBody);
    writeMonitor(monitorsRoot, 'quiet', noChangeMonitorBody);
    writeMonitor(monitorsRoot, 'fires', emittingMonitorBody);

    const result = run(['daemon', 'once', monitorsRoot, '--workspace', dir]);
    expect(result.exitCode).toBe(0);
    // emitted exactly 1 (the schedule monitor), 1 errored (command-poll), and
    // the no-change monitor contributes nothing to either count.
    expect(result.stdout).toContain('emitted 1 event(s)');
    expect(result.stdout).toContain('1 errored:');
    expect(result.stdout).toContain('breaks-on-observe:');
    expect(result.stdout).not.toContain('quiet:');
  });
});

/**
 * Regression for issue #152: `daemon once` printed `Evaluated 0 monitor(s),
 * emitted 0 event(s).` both when (a) no monitors were found AND (b) monitors
 * existed but were skipped because their `interval` had not elapsed. The
 * identical output made it impossible to distinguish the two cases.
 *
 * These tests drive two sequential `daemon once` invocations against the same
 * real (file-backed) SQLite database so the second run sees persisted state
 * from the first and skips the monitor as "not yet due".
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/152
 */
describe('daemon once skipped-not-due visibility (issue #152)', () => {
  // file-fingerprint with a 5-minute interval: the first tick establishes a
  // baseline; the second tick immediately after must skip it (not yet due).
  const longIntervalMonitorBody = `---
name: Long interval monitor
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  interval: 5m
urgency: normal
---
When the file changes, review it.
`;

  function writeMonitor(
    monitorsRoot: string,
    monitorId: string,
    body: string,
  ): void {
    const monitorDir = path.join(monitorsRoot, monitorId);
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');
  }

  // Acceptance criterion (issue #152): a second `daemon once` run within a
  // monitor's interval reports the monitor as skipped (not due), NOT a bare
  // "Evaluated 0 monitor(s)". The skipped suffix must include the count and
  // a next-due hint.
  //
  // Regression: pre-fix both runs printed an identical summary; the second run
  // was indistinguishable from "no monitors found".
  it('reports skipped-not-due monitors on second run instead of bare "Evaluated 0"', () => {
    const dir = path.join(tempDir, 'once-skipped-not-due');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'watched.txt'), 'initial', 'utf-8');
    writeMonitor(monitorsRoot, 'slow-monitor', longIntervalMonitorBody);

    // Use a real file-backed DB so state persists between CLI invocations.
    const dbPath = path.join(dir, 'agentmon.db');
    const env = { AGENTMONITORS_DB: dbPath };

    // First run: monitor has no prior state → it is evaluated and baselines.
    const firstRun = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
    );
    expect(firstRun.exitCode).toBe(0);
    expect(firstRun.stdout).toContain('Evaluated 1 monitor(s)');
    expect(firstRun.stdout).not.toContain('skipped');

    // Second run immediately after: interval has not elapsed → skipped.
    const secondRun = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
    );
    expect(secondRun.exitCode).toBe(0);
    // Must report the skipped count and a next-due hint so the author can
    // distinguish this from "no monitors found" (the ambiguous pre-fix output).
    expect(secondRun.stdout).toContain('1 not yet due');
    expect(secondRun.stdout).toContain('next due in');
    // Must still report 0 evaluated (the monitor was not run this tick).
    expect(secondRun.stdout).toContain('Evaluated 0 monitor(s)');
  });

  // The genuinely empty/no-monitors path must remain distinct: it prints the
  // existing "Evaluated 0 monitor(s), emitted 0 event(s)." without a skipped
  // suffix (because no monitors were found to skip).
  it('does not add a skipped suffix when no monitors are found (empty dir)', () => {
    const dir = path.join(tempDir, 'once-empty-monitors');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsRoot, { recursive: true }); // Exists but empty.

    const dbPath = path.join(dir, 'agentmon.db');
    const env = { AGENTMONITORS_DB: dbPath };

    const result = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
    );
    expect(result.exitCode).toBe(0);
    // The no-monitors path ends with a plain period — no skipped suffix.
    expect(result.stdout).toContain(
      'Evaluated 0 monitor(s), emitted 0 event(s).',
    );
    expect(result.stdout).not.toContain('skipped');
  });

  // When skipped monitors coexist with evaluated monitors (one monitor is
  // due and another is not), the output reports both accurately.
  it('reports both evaluated and skipped counts when mixed', () => {
    const dir = path.join(tempDir, 'once-mixed-skipped');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(dir, { recursive: true });
    // Match the glob in longIntervalMonitorBody ('watched.txt').
    writeFileSync(path.join(dir, 'watched.txt'), 'initial-slow', 'utf-8');
    writeFileSync(path.join(dir, 'watched-fast.txt'), 'initial-fast', 'utf-8');
    // Long-interval monitor: will be skipped on the second run.
    writeMonitor(monitorsRoot, 'slow-monitor', longIntervalMonitorBody);
    // Zero-interval monitor (0s): always due — elapsed >= 0 is always true.
    writeMonitor(
      monitorsRoot,
      'fast-monitor',
      `---
name: Zero interval monitor
watch:
  type: file-fingerprint
  globs:
    - watched-fast.txt
  interval: 0s
urgency: normal
---
When the file changes, review it.
`,
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const env = { AGENTMONITORS_DB: dbPath };

    // First run: both monitors are evaluated (no prior state).
    const firstRun = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
    );
    expect(firstRun.exitCode).toBe(0);
    expect(firstRun.stdout).toContain('Evaluated 2 monitor(s)');

    // Second run immediately after: slow-monitor is skipped (5m not elapsed);
    // fast-monitor is evaluated again (interval: 0s, always due).
    const secondRun = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
    );
    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stdout).toContain('Evaluated 1 monitor(s)');
    expect(secondRun.stdout).toContain('1 not yet due');
    expect(secondRun.stdout).toContain('next due in');
  });
});

describe('runtime flow', () => {
  it('opens a session, detects file changes through the daemon, claims a hook delivery, and acknowledges events', async () => {
    const dir = path.join(tempDir, 'runtime-flow');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });
    const watchedFile = path.join(dir, 'watched.txt');
    writeFileSync(watchedFile, 'hello', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Watch files
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
urgency: normal
---
When files change, review them.
`,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(
      path.join(dir, '.claude', 'monitors'),
      dir,
      env,
      socketPath,
    );

    try {
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'claude-runtime-flow',
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(sessionOpen.exitCode).toBe(0);
      const session = JSON.parse(sessionOpen.stdout) as { id: string };

      const status = runWithEnv(
        ['daemon', 'status', '--format', 'json'],
        env,
        dir,
      );
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout).running).toBe(true);

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      writeFileSync(watchedFile, 'hello world', 'utf-8');

      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            session.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          dir,
        );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length === 1) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      expect(unread().exitCode).toBe(0);
      const unreadEvents = JSON.parse(unread().stdout) as { id: string }[];
      expect(unreadEvents).toHaveLength(1);

      const claim = runWithEnv(
        [
          'hook',
          'claim',
          '--session',
          session.id,
          '--lifecycle',
          'turn-interruptible',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(claim.exitCode).toBe(0);
      const claimPayload = JSON.parse(claim.stdout) as {
        urgency: string;
        mode: string;
      };
      expect(claimPayload.mode).toBe('delivery');
      expect(claimPayload.urgency).toBe('normal');

      const ack = runWithEnv(
        ['events', 'ack', '--session', session.id],
        env,
        dir,
      );
      expect(ack.exitCode).toBe(0);

      const unreadAfterAck = runWithEnv(
        [
          'events',
          'list',
          '--session',
          session.id,
          '--unread',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(unreadAfterAck.exitCode).toBe(0);
      expect(JSON.parse(unreadAfterAck.stdout)).toHaveLength(0);

      const stop = runWithEnv(['daemon', 'stop'], env, dir);
      expect(stop.exitCode).toBe(0);
      await daemon.waitForExit();
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 15_000);

  it('projects events only to the lead session when a subagent session exists', async () => {
    const dir = path.join(tempDir, 'lead-only-projection');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });
    const watchedFile = path.join(dir, 'watched.txt');
    writeFileSync(watchedFile, 'hello', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Watch files
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
urgency: normal
---
When files change, review them.
`,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(
      path.join(dir, '.claude', 'monitors'),
      dir,
      env,
      socketPath,
    );

    try {
      const leadSession = JSON.parse(
        runWithEnv(
          [
            'session',
            'open',
            '--host-session-id',
            'claude-lead',
            '--workspace',
            dir,
            '--format',
            'json',
          ],
          env,
          dir,
        ).stdout,
      ) as { id: string };
      const subagentSession = JSON.parse(
        runWithEnv(
          [
            'session',
            'open',
            '--host-session-id',
            'claude-subagent',
            '--workspace',
            dir,
            '--role',
            'subagent',
            '--format',
            'json',
          ],
          env,
          dir,
        ).stdout,
      ) as { id: string };

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      writeFileSync(watchedFile, 'hello lead session', 'utf-8');

      const leadUnread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            leadSession.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          dir,
        );
      await (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = leadUnread();
          if (result.exitCode === 0 && JSON.parse(result.stdout).length === 1) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          'Timed out waiting for the lead session to receive an unread event.',
        );
      })();

      expect(JSON.parse(leadUnread().stdout)).toHaveLength(1);

      const subagentUnread = runWithEnv(
        [
          'events',
          'list',
          '--session',
          subagentSession.id,
          '--unread',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(subagentUnread.exitCode).toBe(0);
      expect(JSON.parse(subagentUnread.stdout)).toHaveLength(0);

      const stop = runWithEnv(['daemon', 'stop'], env, dir);
      expect(stop.exitCode).toBe(0);
      await daemon.waitForExit();
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 15_000);
});

describe('schema generate', () => {
  it('emits a watch.type-discriminated monitor JSON schema', () => {
    const result = run(['schema', 'generate']);
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout) as {
      properties?: {
        watch?: {
          properties?: { type?: { enum?: string[] } };
        };
        // issue #109 / 001 §3.2: urgency is now a bare level OR a `lo..hi` band,
        // so the JSON Schema uses `pattern` (shape-only) rather than `enum`.
        urgency?: { type?: string; pattern?: string };
      };
    };
    expect(schema.properties?.watch?.properties?.type?.enum).toEqual(
      expect.arrayContaining(['file-fingerprint', 'api-poll', 'schedule']),
    );
    // issue #109 / 001 §3.2: editor-hint schema uses pattern, not enum, so that
    // both bare levels (`normal`) and bands (`normal..high`) are accepted.
    // `low` is first-class (PP5). All three bare levels and the `..` band
    // separator must be covered by the pattern.
    // Copilot thread 3410689135: the pattern must also tolerate the same
    // leading/trailing whitespace the Zod parser accepts (`.trim()` before
    // validating bounds), so `\s*` anchors are required at both ends.
    const urgencySchema = schema.properties?.urgency;
    expect(urgencySchema?.type).toBe('string');
    expect(urgencySchema?.pattern).toContain('low');
    expect(urgencySchema?.pattern).toContain('normal');
    expect(urgencySchema?.pattern).toContain('high');
    // `..` band separator: the JSON schema stores the regex-escaped form `\.\.`
    // (two regex-literal-dot assertions), so the pattern string contains `\\.`
    expect(urgencySchema?.pattern).toContain('\\.');
    // Leading/trailing whitespace tolerance: `\s*` anchors at both ends.
    expect(urgencySchema?.pattern).toContain('\\s*');
  });

  it('writes the schema to a file with -o', () => {
    const out = path.join(tempDir, 'generated-schema.json');
    const result = run(['schema', 'generate', '-o', out]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Schema written to');
    const written = JSON.parse(readFileSync(out, 'utf-8')) as {
      properties?: unknown;
    };
    expect(written.properties).toBeDefined();
  });
});

describe('session list and close', () => {
  it('lists an open session and marks it dormant on close', async () => {
    const dir = path.join(tempDir, 'session-lifecycle');
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-sess-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(monitorsDir, dir, env, socketPath);

    try {
      const open = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'sess-lifecycle',
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(open.exitCode).toBe(0);
      const session = JSON.parse(open.stdout) as { id: string };

      const list = runWithEnv(
        ['session', 'list', '--format', 'json'],
        env,
        dir,
      );
      expect(list.exitCode).toBe(0);
      const sessions = JSON.parse(list.stdout) as {
        id: string;
        status: string;
      }[];
      expect(sessions.find((s) => s.id === session.id)?.status).toBe('active');

      const close = runWithEnv(
        ['session', 'close', session.id, '--format', 'json'],
        env,
        dir,
      );
      expect(close.exitCode).toBe(0);
      expect((JSON.parse(close.stdout) as { status: string }).status).toBe(
        'dormant',
      );

      const listAfter = runWithEnv(
        ['session', 'list', '--format', 'json'],
        env,
        dir,
      );
      expect(listAfter.exitCode).toBe(0);
      const after = JSON.parse(listAfter.stdout) as {
        id: string;
        status: string;
      }[];
      expect(after.find((s) => s.id === session.id)?.status).toBe('dormant');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});

describe('manual daemon socket commands', () => {
  it('session list uses the enabled project local socket when no socket override is present', async () => {
    const { ws, socket, db, hostSessionId } = bootLazyWorkspace(5_000);
    const env = { CLAUDE_PROJECT_DIR: ws, AGENTMONITORS_DB: db };

    try {
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(await daemonAvailable(socket)).toBe(true);

      const list = runWithCleanEnv(
        ['session', 'list', '--format', 'json'],
        env,
        ws,
      );
      expect(list.exitCode).toBe(0);
      const sessions = JSON.parse(list.stdout) as {
        id: string;
        hostSessionId: string;
      }[];
      const startedSession = sessions.find(
        (s) => s.hostSessionId === hostSessionId,
      );
      expect(startedSession).toBeDefined();
      if (!startedSession) {
        throw new Error('Expected session start to register a session');
      }

      const opened = runWithCleanEnv(
        [
          'session',
          'open',
          '--host-session-id',
          `${hostSessionId}-manual`,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(opened.exitCode).toBe(0);

      const events = runWithCleanEnv(
        ['events', 'list', '--session', startedSession.id, '--format', 'json'],
        env,
        ws,
      );
      expect(events.exitCode).toBe(0);
      expect(JSON.parse(events.stdout)).toEqual([]);

      const claim = runWithCleanEnv(
        [
          'hook',
          'claim',
          '--session',
          startedSession.id,
          '--lifecycle',
          'turn-interruptible',
        ],
        env,
        ws,
      );
      expect(claim.exitCode).toBe(0);
      expect(JSON.parse(claim.stdout)).toBeNull();

      const close = runWithCleanEnv(
        ['session', 'close', startedSession.id, '--format', 'json'],
        env,
        ws,
      );
      expect(close.exitCode).toBe(0);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped or never started — ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('explicit socket inputs take precedence over the enabled project local socket', async () => {
    const primary = bootLazyWorkspace(5_000);
    const override = bootLazyWorkspace(5_000);
    const primaryHostSessionId = `${primary.hostSessionId}-primary`;
    const overrideHostSessionId = `${override.hostSessionId}-override`;
    const primaryEnv = {
      CLAUDE_PROJECT_DIR: primary.ws,
      AGENTMONITORS_DB: primary.db,
    };
    const overrideEnv = {
      CLAUDE_PROJECT_DIR: override.ws,
      AGENTMONITORS_DB: override.db,
    };

    const expectOverrideSessionOnly = (result: RunResult) => {
      expect(result.exitCode).toBe(0);
      const sessions = JSON.parse(result.stdout) as { hostSessionId: string }[];
      expect(
        sessions.some((s) => s.hostSessionId === overrideHostSessionId),
      ).toBe(true);
      expect(
        sessions.some((s) => s.hostSessionId === primaryHostSessionId),
      ).toBe(false);
    };

    try {
      const primaryStart = runWithStdin(
        ['session', 'start'],
        primaryEnv,
        sessionStartPayload(primaryHostSessionId, primary.ws),
        primary.ws,
      );
      expect(primaryStart.exitCode).toBe(0);

      const overrideStart = runWithStdin(
        ['session', 'start'],
        overrideEnv,
        sessionStartPayload(overrideHostSessionId, override.ws),
        override.ws,
      );
      expect(overrideStart.exitCode).toBe(0);
      expect(await daemonAvailable(primary.socket)).toBe(true);
      expect(await daemonAvailable(override.socket)).toBe(true);

      expectOverrideSessionOnly(
        runWithCleanEnv(
          ['session', 'list', '--format', 'json'],
          {
            ...primaryEnv,
            AGENTMONITORS_SOCKET: override.socket,
          },
          primary.ws,
        ),
      );

      expectOverrideSessionOnly(
        runWithCleanEnv(
          ['session', 'list', '--socket', override.socket, '--format', 'json'],
          primaryEnv,
          primary.ws,
        ),
      );

      expectOverrideSessionOnly(
        runWithCleanEnv(
          ['session', 'list', '--socket', override.socket, '--format', 'json'],
          {
            ...primaryEnv,
            AGENTMONITORS_SOCKET: primary.socket,
          },
          primary.ws,
        ),
      );
    } finally {
      for (const socket of [primary.socket, override.socket]) {
        try {
          await callDaemon('stop', {}, { socketPath: socket });
        } catch {
          // already stopped or never started — ignore
        }
      }
      rmSync(primary.ws, { recursive: true, force: true });
      rmSync(override.ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('manual socket commands report an actionable no-daemon message without a stack trace', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manual-down-'));
    const socket = path.join(
      '/tmp',
      `agentmon-down-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'manual-down.db');
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 5_000 });
    const env = { CLAUDE_PROJECT_DIR: ws, AGENTMONITORS_DB: db };

    try {
      for (const args of [
        ['session', 'open', '--host-session-id', 'missing-host'],
        ['session', 'close', 'missing-session'],
        ['session', 'list'],
        ['events', 'list', '--session', 'missing-session'],
        ['events', 'ack', '--session', 'missing-session'],
        [
          'hook',
          'claim',
          '--session',
          'missing-session',
          '--lifecycle',
          'turn-interruptible',
        ],
      ]) {
        const result = runWithCleanEnv(args, env, ws);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No daemon running for this workspace');
        expect(result.stderr).toContain('agentmonitors daemon run');
        expect(result.stderr).not.toContain('DaemonConnectionError');
        expect(result.stderr).not.toContain('at ');
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('monitor history', () => {
  it('records observation outcomes and lists them through the daemon', async () => {
    const dir = path.join(tempDir, 'history-flow');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });
    const watchedFile = path.join(dir, 'watched.txt');
    writeFileSync(watchedFile, 'hello', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Watch files
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
urgency: normal
---
When files change, review them.
`,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-hist-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };
    const daemon = await startDaemon(
      path.join(dir, '.claude', 'monitors'),
      dir,
      env,
      socketPath,
    );

    try {
      // Let the daemon establish a baseline tick, then change the watched file.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed', 'utf-8');

      let records: { result: string; monitorId: string }[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = runWithEnv(
          ['monitor', 'history', '--format', 'json'],
          env,
          dir,
        );
        if (result.exitCode === 0) {
          records = JSON.parse(result.stdout) as typeof records;
          if (records.some((r) => r.result === 'triggered')) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }

      expect(records.length).toBeGreaterThan(0);
      expect(records.some((r) => r.result === 'triggered')).toBe(true);
      expect(records.every((r) => r.monitorId === 'watch-files')).toBe(true);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});

// Issue #150: `monitor explain` / `monitor history` must read persisted SQLite
// directly when no daemon is reachable (PM decision (a)), clearly labeled, and
// must NOT report a false "✗ Scheduling: failure" for a monitor that actually
// fired. When the daemon is down AND nothing is persisted, they emit an
// actionable remediation line instead of a raw `connect ENOENT …` (decision
// (b)(i)). These tests pin a FILE-backed DB so state survives across CLI
// invocations (the in-process fallback reads the same file `daemon once` wrote).
describe('monitor explain / history without a live daemon (issue #150)', () => {
  // A schedule monitor with cron '* * * * *' is due every tick, so a single
  // `daemon once` materializes exactly one event into the DB — giving the
  // in-process explain real persisted state to diagnose.
  const FIRING_MONITOR = `---
name: Emits every tick
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`;

  function deadSocketPath(label: string): string {
    return path.join(
      '/tmp',
      `agentmon-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
  }

  it('reads persisted state after `daemon once` and shows the real diagnosis (no false "Scheduling failure"), with the no-daemon banner', () => {
    const dir = path.join(tempDir, 'explain-nodaemon-persisted');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'fires');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = deadSocketPath('explain-persisted');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    // Materialize an event into the file DB in-process (no daemon, no socket).
    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);
    expect(once.stdout).toContain('emitted 1 event(s)');

    // Now explain with NO daemon running (the socket points at a dead path).
    const result = runWithEnv(
      [
        'monitor',
        'explain',
        'fires',
        '--dir',
        monitorsRoot,
        '--workspace',
        dir,
        '--socket',
        socketPath,
        '--format',
        'text',
      ],
      env,
      dir,
    );

    expect(result.exitCode).toBe(0);
    // The persisted-state banner is present...
    expect(result.stdout).toContain(
      'No daemon running — showing persisted state from the last tick.',
    );
    // ...and it does NOT print a false scheduling failure for a fired monitor.
    expect(result.stdout).not.toContain('✗ Scheduling');
    expect(result.stdout).not.toContain('Verdict: failure at Scheduling');
    // The real diagnosis ran: definition is valid and the monitor materialized
    // an event, so materialization is reported as OK (a real per-stage result).
    expect(result.stdout).toContain('Monitor fires');
    expect(result.stdout).toMatch(/Materialization:.*monitor_events row/);
  });

  it('reads persisted state in --format json (no false scheduling failure) and annotates the no-daemon notice', () => {
    const dir = path.join(tempDir, 'explain-nodaemon-json');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'fires');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = deadSocketPath('explain-json');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);

    const result = runWithEnv(
      [
        'monitor',
        'explain',
        'fires',
        '--dir',
        monitorsRoot,
        '--workspace',
        dir,
        '--socket',
        socketPath,
        '--format',
        'json',
      ],
      env,
      dir,
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      notice: string;
      verdict: { stage: string; status: string };
      stages: { id: string; status: string }[];
      events: unknown[];
    };
    expect(report.notice).toContain('No daemon running');
    // The fired monitor must NOT be reported as failing at Scheduling.
    expect(report.verdict.stage).not.toBe('scheduling');
    expect(
      report.stages.find((stage) => stage.id === 'scheduling'),
    ).not.toEqual(expect.objectContaining({ status: 'failure' }));
    expect(report.events.length).toBeGreaterThan(0);
  });

  it('explain with the daemon down and NOTHING persisted emits an actionable remediation, not a raw ENOENT (definition ok, case C)', () => {
    const dir = path.join(tempDir, 'explain-nodaemon-empty');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'fires');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    // Fresh DB path that no tick ever wrote to → no persisted rows.
    const dbPath = path.join(dir, 'empty.db');
    const socketPath = deadSocketPath('explain-empty');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const result = runWithEnv(
      [
        'monitor',
        'explain',
        'fires',
        '--dir',
        monitorsRoot,
        '--workspace',
        dir,
        '--socket',
        socketPath,
      ],
      env,
      dir,
    );

    expect(result.exitCode).toBe(1);
    // Actionable remediation, not a raw Node connect error.
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
    // The remediation (not the no-daemon banner) is what appears.
    expect(result.stdout).not.toContain(
      'No daemon running — showing persisted state',
    );
  });

  it('explain with the daemon down surfaces a definition failure directly (no banner, no remediation) when the monitor is not found (case A, Copilot review id=3415776081)', () => {
    // Regression: the pre-fix "no persisted state → remediation" heuristic also
    // fired when the definition stage was `failure` (parse error, monitor not
    // found, duplicate ID), swallowing the actionable definition error. A
    // definition-stage failure must surface the in-process report directly —
    // no no-daemon banner (there is no persisted state involved; the definition
    // failure IS the diagnosis) and no remediation message.
    const dir = path.join(tempDir, 'explain-nodaemon-notfound');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    // Create the monitors directory but NOT the 'missing' sub-dir / MONITOR.md.
    mkdirSync(monitorsRoot, { recursive: true });

    const dbPath = path.join(dir, 'empty.db');
    const socketPath = deadSocketPath('explain-notfound');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const result = runWithEnv(
      [
        'monitor',
        'explain',
        'missing', // monitor that doesn't exist
        '--dir',
        monitorsRoot,
        '--workspace',
        dir,
        '--socket',
        socketPath,
        '--format',
        'text',
      ],
      env,
      dir,
    );

    // Definition failure → report is shown, exits 0 (mirrors the daemon path).
    expect(result.exitCode).toBe(0);
    // The definition failure reason must appear in the output.
    expect(result.stdout).toContain('Verdict:');
    expect(result.stdout).toMatch(/Definition:.*not found/i);
    // No no-daemon banner (nothing persisted; the report IS the diagnosis).
    expect(result.stdout).not.toContain(
      'No daemon running — showing persisted state',
    );
    // No generic remediation (would hide the definition error).
    expect(result.stderr).not.toContain('agentmonitors daemon run');
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('history reads persisted observation rows in-process when the daemon is down (not an ENOENT error)', () => {
    const dir = path.join(tempDir, 'history-nodaemon-persisted');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'fires');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = deadSocketPath('history-persisted');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);

    // Text form: banner + the persisted row, NOT an ENOENT error.
    const text = runWithEnv(
      [
        'monitor',
        'history',
        'fires',
        '--socket',
        socketPath,
        '--format',
        'text',
      ],
      env,
      dir,
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      'No daemon running — showing persisted state from the last tick.',
    );
    expect(text.stdout).toContain('fires');
    expect(text.stderr).not.toContain('ENOENT');

    // JSON form still works through the in-process path.
    const json = runWithEnv(
      [
        'monitor',
        'history',
        'fires',
        '--socket',
        socketPath,
        '--format',
        'json',
      ],
      env,
      dir,
    );
    expect(json.exitCode).toBe(0);
    const rows = JSON.parse(json.stdout) as { monitorId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.monitorId === 'fires')).toBe(true);
  });

  it('history with the daemon down and NOTHING persisted emits an actionable remediation, not a raw ENOENT', () => {
    const dir = path.join(tempDir, 'history-nodaemon-empty');
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'empty.db');
    const socketPath = deadSocketPath('history-empty');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const result = runWithEnv(
      ['monitor', 'history', '--socket', socketPath],
      env,
      dir,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
  });
});

describe('monitor explain', () => {
  it('surfaces a daemon-side application error instead of masking it as "daemon not running" (issue #94 review)', async () => {
    // Regression for comment 3408123745: when the daemon answers `monitor.explain`
    // with an application error (the daemon IS running and reachable), the CLI must
    // surface that error — NOT fall back to the "daemon unavailable / scheduling
    // failed" diagnosis, which would hide the real failure.
    const dir = path.join(tempDir, 'explain-app-error');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Watch files
watch:
  type: file-fingerprint
  globs:
    - watched.txt
urgency: normal
---
When files change, review them.
`,
      'utf-8',
    );

    const socketPath = path.join(
      '/tmp',
      `agentmon-explain-apperr-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );

    // A fake daemon that is reachable but answers every request with an
    // application error (the `error` field of the daemon response protocol). It
    // MUST run in a separate process: the CLI is driven via the synchronous
    // `execFileSync` (runWithEnv), which blocks this process's event loop — an
    // in-process server could never respond while the CLI is connecting.
    const fakeDaemonScript = path.join(dir, 'fake-daemon.cjs');
    writeFileSync(
      fakeDaemonScript,
      `const net = require('node:net');
const socketPath = process.argv[2];
const server = net.createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf-8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const nl = buffer.indexOf('\\n');
    if (nl === -1) return;
    const id = (JSON.parse(buffer.slice(0, nl)).id) || 'unknown';
    socket.end(JSON.stringify({ id, error: 'explain blew up inside the daemon' }) + '\\n');
  });
});
server.listen(socketPath, () => { process.stdout.write('FAKE_DAEMON_LISTENING\\n'); });
`,
      'utf-8',
    );

    const fakeDaemon = spawn('node', [fakeDaemonScript, socketPath], {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fakeStdout = '';
    fakeDaemon.stdout.setEncoding('utf-8');
    fakeDaemon.stdout.on('data', (chunk: string) => {
      fakeStdout += chunk;
    });

    // Wait for the fake daemon to be listening on the socket.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (
        existsSync(socketPath) &&
        fakeStdout.includes('FAKE_DAEMON_LISTENING')
      ) {
        break;
      }
      if (fakeDaemon.exitCode !== null) {
        throw new Error(
          `Fake daemon exited early (code ${fakeDaemon.exitCode}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      const result = runWithEnv(
        [
          'monitor',
          'explain',
          'watch-files',
          '--dir',
          path.join(dir, '.claude', 'monitors'),
          '--socket',
          socketPath,
          '--format',
          'json',
        ],
        { AGENTMONITORS_SOCKET: socketPath },
        dir,
      );

      // The real application error must be surfaced (exit 1), not masked.
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { error: string };
      expect(payload.error).toContain('explain blew up inside the daemon');
      // It must NOT have produced the daemon-unavailable diagnosis.
      expect(result.stdout).not.toContain('daemon is not running');
    } finally {
      fakeDaemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (fakeDaemon.exitCode !== null) {
          resolve();
          return;
        }
        fakeDaemon.once('exit', () => {
          resolve();
        });
      });
    }
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
    writeFileSync(
      path.join(path.dirname(monitorFile), 'index.ts'),
      'export const value = 1;\n',
    );
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
    writeFileSync(
      path.join(path.dirname(monitorFile), 'index.ts'),
      'export const value = 1;\n',
    );
    const result = run(['monitor', 'test', monitorFile, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.monitor).toBe('My monitor');
    expect(parsed.source).toBe('file-fingerprint');
    expect(parsed.baseline).toBe(true);
    expect(parsed).toHaveProperty('observations');
  });

  it('reports zero-match file-fingerprint scopes without establishing a baseline', () => {
    const dir = path.join(tempDir, 'monitor-test-no-files');
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'fp-empty', '--dir', monitorsDir], dir);

    const monitorFile = path.join(monitorsDir, 'fp-empty', 'MONITOR.md');
    const result = run(['monitor', 'test', monitorFile], '/tmp');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No files matched');
    expect(result.stderr).toContain('globs');
    expect(result.stdout).not.toContain('Baseline established');
  });

  it('reports zero-match file-fingerprint scopes as structured JSON', () => {
    const dir = path.join(tempDir, 'monitor-test-no-files-json');
    const monitorsDir = path.join(dir, '.codex', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'fp-empty-json', '--dir', monitorsDir], dir);

    const monitorFile = path.join(monitorsDir, 'fp-empty-json', 'MONITOR.md');
    const result = run(
      ['monitor', 'test', monitorFile, '--format', 'json'],
      '/tmp',
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      monitor: 'My monitor',
      source: 'file-fingerprint',
      baseline: false,
      outcome: 'no-files-matched',
      observations: [],
    });
    expect(parsed.error).toContain('watch.globs');
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

  // Issues #219 / #220: `monitor test` exercises the api-poll source against a
  // REAL HTTP endpoint, proving end-to-end that a non-2xx status surfaces as an
  // errored observation, and that json-diff on a non-JSON body surfaces the
  // steering warning. The endpoint MUST run out-of-process: `run` uses the
  // blocking `execFileSync`, which freezes this test process's event loop, so an
  // in-test `http.Server` could never serve a request while the CLI is polling.
  // We spawn a tiny standalone server as a child process and discover its port
  // from the line it prints.
  describe('api-poll over a real endpoint (#219, #220)', () => {
    function writeApiPollMonitor(
      dir: string,
      url: string,
      strategy: string,
    ): string {
      const monitorDir = path.join(dir, 'ap');
      mkdirSync(monitorDir, { recursive: true });
      const monitorFile = path.join(monitorDir, 'MONITOR.md');
      writeFileSync(
        monitorFile,
        [
          '---',
          'name: AP test',
          'watch:',
          '  type: api-poll',
          `  url: '${url}'`,
          '  change-detection:',
          `    strategy: ${strategy}`,
          'urgency: normal',
          '---',
          '',
          'Body.',
          '',
        ].join('\n'),
        'utf-8',
      );
      return monitorFile;
    }

    /**
     * Start a fixed-response HTTP server in a separate process and resolve its
     * base URL. The server replies with `status`/`body` to every request and
     * sends `Connection: close` so undici opens a fresh connection per poll.
     */
    async function startServer(
      status: number,
      body: string,
    ): Promise<{ url: string; stop: () => void }> {
      const serverDir = mkdtempSync(path.join(tmpdir(), 'ap-server-'));
      const serverScript = path.join(serverDir, 'server.cjs');
      writeFileSync(
        serverScript,
        [
          "const http = require('node:http');",
          `const status = ${String(status)};`,
          `const body = ${JSON.stringify(body)};`,
          'const server = http.createServer((_req, res) => {',
          "  res.setHeader('Connection', 'close');",
          '  res.statusCode = status;',
          '  res.end(body);',
          '});',
          "server.listen(0, '127.0.0.1', () => {",
          '  const addr = server.address();',
          "  process.stdout.write('PORT ' + addr.port + '\\n');",
          '});',
        ].join('\n'),
        'utf-8',
      );

      const child = spawn('node', [serverScript], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const url = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(
          () => reject(new Error('server did not report a port in time')),
          5000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf-8');
          const match = /PORT (\d+)/.exec(buf);
          if (match) {
            clearTimeout(timer);
            resolve(`http://127.0.0.1:${match[1]}/`);
          }
        });
        child.on('error', reject);
      });

      return {
        url,
        stop: () => {
          child.kill();
          rmSync(serverDir, { recursive: true, force: true });
        },
      };
    }

    it('AC #220: a 401 endpoint produces an errored observation with the HTTP status (text)', async () => {
      const dir = path.join(tempDir, 'ap-401');
      const { url, stop } = await startServer(401, 'Unauthorized');
      try {
        const monitorFile = writeApiPollMonitor(dir, url, 'text-diff');
        const result = run(['monitor', 'test', monitorFile]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Observation failed');
        expect(result.stderr).toContain('HTTP 401');
        expect(result.stdout).not.toContain('Baseline established');
      } finally {
        stop();
      }
    });

    it('AC #220: a 500 endpoint errors as JSON with the HTTP status', async () => {
      const dir = path.join(tempDir, 'ap-500');
      const { url, stop } = await startServer(500, '<html>error</html>');
      try {
        const monitorFile = writeApiPollMonitor(dir, url, 'json-diff');
        const result = run([
          'monitor',
          'test',
          monitorFile,
          '--format',
          'json',
        ]);
        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toContain('HTTP 500');
      } finally {
        stop();
      }
    });

    it('AC #220: a 200 endpoint baselines (no regression)', async () => {
      const dir = path.join(tempDir, 'ap-200');
      const { url, stop } = await startServer(200, '{"ok":true}');
      try {
        const monitorFile = writeApiPollMonitor(dir, url, 'json-diff');
        const result = run(['monitor', 'test', monitorFile]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Baseline established');
        expect(result.stdout).toContain('HTTP 200');
      } finally {
        stop();
      }
    });

    it('AC #219: json-diff against an HTML body surfaces the steering warning (JSON output)', async () => {
      const dir = path.join(tempDir, 'ap-warn');
      const { url, stop } = await startServer(
        200,
        '<!DOCTYPE html><html><body>status</body></html>',
      );
      try {
        const monitorFile = writeApiPollMonitor(dir, url, 'json-diff');
        const result = run([
          'monitor',
          'test',
          monitorFile,
          '--format',
          'json',
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.warnings).toBeDefined();
        expect(parsed.warnings[0]).toContain('json-diff');
        expect(parsed.warnings[0]).toContain('text-diff');
      } finally {
        stop();
      }
    });

    it('AC #219: json-diff against a JSON body emits no warning', async () => {
      const dir = path.join(tempDir, 'ap-nowarn');
      const { url, stop } = await startServer(200, '{"status":"ok"}');
      try {
        const monitorFile = writeApiPollMonitor(dir, url, 'json-diff');
        const result = run([
          'monitor',
          'test',
          monitorFile,
          '--format',
          'json',
        ]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.warnings ?? []).toHaveLength(0);
      } finally {
        stop();
      }
    });
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

// ---------------------------------------------------------------------------
// Dogfood UAT: incoming-changes runtime flow
// Acceptance proof for https://github.com/mike-north/AgentMonitors/issues/40
//
// This test proves end-to-end that a commit advancing `main` under the watched
// paths (`docs/specs/**`, `docs/standard/**`) surfaces a delivered signal in a
// session via the hook claim path — with no manual polling or diffing.
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();

/** Run a git command in the given directory with deterministic identity config. */
function gitIn(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2024-01-15T10:30:00+0000',
      GIT_COMMITTER_DATE: '2024-01-15T10:30:00+0000',
    },
  });
}

describe.skipIf(!gitAvailable)('incoming-changes runtime flow', () => {
  // Acceptance proof for https://github.com/mike-north/AgentMonitors/issues/40
  // Proves the daemon → observe → deliver → claim path is wired and a claim is
  // available; literal in-session rendering of the prompt is covered by the
  // channel/hook transport tests, not here.
  it('detects a spec-file commit on main and delivers a hook claim to the session', async () => {
    // -----------------------------------------------------------------------
    // 1. Create a temp git repo seeded with docs/specs/001.md on branch main.
    // -----------------------------------------------------------------------
    const repo = path.join(tempDir, 'incoming-changes-flow');
    mkdirSync(repo, { recursive: true });

    // git init with -b main; fall back to init + checkout if git is older
    try {
      gitIn(repo, ['init', '-b', 'main']);
    } catch {
      gitIn(repo, ['init']);
      gitIn(repo, ['checkout', '-b', 'main']);
    }
    gitIn(repo, ['config', 'user.email', 'test@example.com']);
    gitIn(repo, ['config', 'user.name', 'Test']);

    // Seed the watched spec file (baseline commit on main)
    const specFile = path.join(repo, 'docs', 'specs', '001.md');
    mkdirSync(path.dirname(specFile), { recursive: true });
    writeFileSync(specFile, '# Spec 001\n\nInitial content.\n', 'utf-8');
    gitIn(repo, ['add', '.']);
    gitIn(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--message',
      'chore: seed docs/specs/001.md',
    ]);

    // -----------------------------------------------------------------------
    // 2. Write the test monitor into the repo's monitors dir.
    //    cwd is set explicitly to the temp repo so the daemon's process.cwd()
    //    doesn't affect git resolution.
    // -----------------------------------------------------------------------
    const monitorsDir = path.join(repo, '.claude', 'monitors', 'spec-changes');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Spec & standard changes from upstream
watch:
  type: incoming-changes
  paths:
    - 'docs/specs/**'
    - 'docs/standard/**'
  branch: main
  cwd: ${JSON.stringify(repo)}
  interval: '1s'
urgency: normal
---
Summarize what changed in the spec/standard docs and whether it affects current work.
`,
      'utf-8',
    );

    // -----------------------------------------------------------------------
    // 3. Start the daemon with a dedicated DB and socket path.
    // -----------------------------------------------------------------------
    const dbPath = path.join(repo, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-ic-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(
      path.join(repo, '.claude', 'monitors'),
      repo,
      env,
      socketPath,
    );

    try {
      // -----------------------------------------------------------------------
      // 4. Open a session for this workspace.
      // -----------------------------------------------------------------------
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'claude-incoming-changes-uat',
          '--workspace',
          repo,
          '--format',
          'json',
        ],
        env,
        repo,
      );
      expect(sessionOpen.exitCode).toBe(0);
      const session = JSON.parse(sessionOpen.stdout) as { id: string };

      // -----------------------------------------------------------------------
      // 5. Wait DETERMINISTICALLY for the first tick to establish the baseline.
      //    incoming-changes records the current HEAD SHA on its first observe()
      //    and emits nothing. We must not commit the change until that baseline
      //    observe has run — otherwise the source would record the POST-commit
      //    HEAD as its baseline and emit no event (a race a fixed sleep can lose
      //    under slow/loaded CI). Poll the observation-history audit: the first
      //    tick writes a `no-change` row for `spec-changes`, which is proof the
      //    baseline observe() completed.
      // -----------------------------------------------------------------------
      const historyRows = () =>
        runWithEnv(
          ['monitor', 'history', 'spec-changes', '--format', 'json'],
          env,
          repo,
        );
      const baselineDeadline = Date.now() + 10_000;
      while (Date.now() < baselineDeadline) {
        const result = historyRows();
        if (
          result.exitCode === 0 &&
          (JSON.parse(result.stdout) as unknown[]).length >= 1
        ) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const baseline = historyRows();
      expect(baseline.exitCode).toBe(0);
      const baselineHistory = JSON.parse(baseline.stdout) as {
        result: string;
      }[];
      // The baseline observe ran and emitted nothing.
      expect(baselineHistory.length).toBeGreaterThanOrEqual(1);
      expect(baselineHistory.every((r) => r.result === 'no-change')).toBe(true);

      // And no events have been delivered yet (baseline only).
      const noEvents = runWithEnv(
        [
          'events',
          'list',
          '--session',
          session.id,
          '--unread',
          '--format',
          'json',
        ],
        env,
        repo,
      );
      expect(noEvents.exitCode).toBe(0);
      expect(JSON.parse(noEvents.stdout)).toHaveLength(0);

      // -----------------------------------------------------------------------
      // 6. Advance main: commit a change to docs/specs/001.md.
      //    This simulates a `git pull` bringing in upstream spec changes.
      // -----------------------------------------------------------------------
      writeFileSync(
        specFile,
        '# Spec 001\n\nUpdated content — new invariant added.\n',
        'utf-8',
      );
      gitIn(repo, ['add', '.']);
      gitIn(repo, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--message',
        'spec: add new invariant to 001',
      ]);

      // -----------------------------------------------------------------------
      // 7. Poll events until exactly 1 unread event appears (deadline: 10s).
      // -----------------------------------------------------------------------
      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            session.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          repo,
        );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length === 1) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }

      // -----------------------------------------------------------------------
      // 8. Assert: 1 unread event, claim returns delivery with urgency normal.
      // -----------------------------------------------------------------------
      const unreadResult = unread();
      expect(unreadResult.exitCode).toBe(0);
      const unreadEvents = JSON.parse(unreadResult.stdout) as {
        id: string;
        title: string;
        monitorId: string;
      }[];
      expect(unreadEvents).toHaveLength(1);

      // Acceptance: the delivered signal must be concrete and actionable —
      // it names the changed spec file and the nature of the change, not just
      // "something changed". incoming-changes emits a per-path observation
      // titled `Incoming change: <path> (<changeKind>)`.
      const [event] = unreadEvents;
      expect(event?.monitorId).toBe('spec-changes');
      expect(event?.title).toContain('docs/specs/001.md');
      expect(event?.title).toContain('modified');

      const claim = runWithEnv(
        [
          'hook',
          'claim',
          '--session',
          session.id,
          '--lifecycle',
          'turn-interruptible',
          '--format',
          'json',
        ],
        env,
        repo,
      );
      expect(claim.exitCode).toBe(0);
      const claimPayload = JSON.parse(claim.stdout) as {
        mode: string;
        urgency: string;
      };
      // A commit advancing the watched paths must produce a delivered signal.
      expect(claimPayload.mode).toBe('delivery');
      expect(claimPayload.urgency).toBe('normal');

      // Acknowledge all events, confirm the queue is drained.
      const ack = runWithEnv(
        ['events', 'ack', '--session', session.id],
        env,
        repo,
      );
      expect(ack.exitCode).toBe(0);

      const unreadAfterAck = unread();
      expect(unreadAfterAck.exitCode).toBe(0);
      expect(JSON.parse(unreadAfterAck.stdout)).toHaveLength(0);

      // -----------------------------------------------------------------------
      // Phase 2 — Regression guard: `**` in a git pathspec crosses `/` and
      // matches files nested arbitrarily deep.  The dogfood monitor relies on
      // `docs/specs/**` catching new files under ANY subdirectory (e.g. a newly
      // created `docs/specs/design/nested.md`).  This second phase commits such
      // a file and asserts it surfaces a delivered event, locking in the
      // git-pathspec recursion semantics permanently.
      // -----------------------------------------------------------------------
      const nestedSpecFile = path.join(
        repo,
        'docs',
        'specs',
        'design',
        'nested.md',
      );
      mkdirSync(path.dirname(nestedSpecFile), { recursive: true });
      writeFileSync(
        nestedSpecFile,
        '# Nested design doc\n\nNew content.\n',
        'utf-8',
      );
      gitIn(repo, ['add', '.']);
      gitIn(repo, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--message',
        'spec: add nested design doc',
      ]);

      const deadline2 = Date.now() + 10_000;
      while (Date.now() < deadline2) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length === 1) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }

      const nestedUnreadResult = unread();
      expect(nestedUnreadResult.exitCode).toBe(0);
      const nestedEvents = JSON.parse(nestedUnreadResult.stdout) as {
        id: string;
        title: string;
        monitorId: string;
      }[];
      expect(nestedEvents).toHaveLength(1);
      // The event must name the deeply-nested path, not just a top-level file.
      // incoming-changes titles: `Incoming change: <path> (<changeKind>)`
      expect(nestedEvents[0]?.title).toContain('docs/specs/design/nested.md');
      expect(nestedEvents[0]?.title).toContain('created');
      expect(nestedEvents[0]?.monitorId).toBe('spec-changes');

      // Leave the session clean.
      const ack2 = runWithEnv(
        ['events', 'ack', '--session', session.id],
        env,
        repo,
      );
      expect(ack2.exitCode).toBe(0);

      const stop = runWithEnv(['daemon', 'stop'], env, repo);
      expect(stop.exitCode).toBe(0);
      await daemon.waitForExit();
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Lazy-daemon lifecycle: session start / session end
// ---------------------------------------------------------------------------

// The daemon spawned by `session start` uses pollMs=1000 (hardcoded in session.ts).
// This constant drives the reap-deadline formula so it matches the actual timer.
const LAZY_DAEMON_POLL_MS = 1000;

/**
 * Scaffold a temp workspace with a file-fingerprint monitor and a
 * `.claude/agentmonitors.local.md` coordination file. Returns everything
 * the tests need to call `session start` / `session end`.
 *
 * Pass a short `reapAfterMs` (a few seconds) so any escaped daemon
 * self-cleans quickly even if the `finally` stop fails — defence in depth.
 */
function bootLazyWorkspace(reapAfterMs: number): {
  ws: string;
  socket: string;
  db: string;
  env: Record<string, string>;
  hostSessionId: string;
} {
  const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-lazy-'));
  const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
  mkdirSync(monitorsDir, { recursive: true });

  writeFileSync(
    path.join(monitorsDir, 'MONITOR.md'),
    [
      '---',
      'name: Watch files',
      'watch:',
      '  type: file-fingerprint',
      '  globs:',
      '    - "*.txt"',
      `  cwd: ${JSON.stringify(ws)}`,
      'urgency: normal',
      '---',
      'When files change, review them.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const socket = path.join(
    '/tmp',
    `agentmon-lazy-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
  );
  const db = path.join(ws, 'lazy.db');

  writeLocalState(ws, { enabled: true, socket, db, reapAfterMs });

  const hostSessionId = `lazy-test-${Date.now()}`;
  // NOTE: no CLAUDE_CODE_SESSION_ID — that env var does not exist in a real
  // Claude Code hook. `session start` / `session end` read the host session id
  // from the hook stdin payload (`session_id`), so these tests feed it that way.
  const env = {
    CLAUDE_PROJECT_DIR: ws,
    AGENTMONITORS_DB: db,
    AGENTMONITORS_SOCKET: socket,
  };

  return { ws, socket, db, env, hostSessionId };
}

/** A Claude-Code-style SessionStart hook payload (delivered on stdin). */
function sessionStartPayload(hostSessionId: string, ws: string): string {
  return JSON.stringify({
    session_id: hostSessionId,
    hook_event_name: 'SessionStart',
    cwd: ws,
  });
}

/** A Claude-Code-style SessionEnd hook payload (delivered on stdin). */
function sessionEndPayload(hostSessionId: string, ws: string): string {
  return JSON.stringify({
    session_id: hostSessionId,
    hook_event_name: 'SessionEnd',
    cwd: ws,
  });
}

describe('lazy daemon lifecycle', () => {
  it('session start boots a per-workspace daemon and registers the session', async () => {
    // Use a short reapAfterMs so an escaped daemon self-cleans (defence-in-depth).
    const { ws, socket, env, hostSessionId } = bootLazyWorkspace(5_000);

    try {
      // session start should lazy-boot the daemon and open the session. The
      // host session id arrives ONLY via the stdin payload (`session_id`) — the
      // production code no longer reads CLAUDE_CODE_SESSION_ID, so this would
      // fail against the old env-reading implementation.
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);

      // daemon is up on the per-workspace socket
      expect(await daemonAvailable(socket)).toBe(true);

      // the session is registered
      const list = runWithEnv(
        ['session', 'list', '--socket', socket, '--format', 'json'],
        env,
        ws,
      );
      expect(list.exitCode).toBe(0);
      const sessions = JSON.parse(list.stdout) as {
        hostSessionId: string;
        workspacePath?: string;
      }[];
      expect(sessions.some((s) => s.hostSessionId === hostSessionId)).toBe(
        true,
      );

      // session end deregisters the session
      const end = runWithStdin(
        ['session', 'end'],
        env,
        sessionEndPayload(hostSessionId, ws),
        ws,
      );
      expect(end.exitCode).toBe(0);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped or never started — ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('the daemon idle-reaps itself after the last session ends', async () => {
    // reapAfterMs = 1500 ms, daemon pollMs = 1000 ms (hardcoded in session.ts)
    // latest reap fires at: reapAfterMs + 1 poll = 1500 + 1000 = 2500 ms
    // deadline = reapAfterMs + 4 * daemonPollMs + 2000 ms headroom = 7500 ms
    const reapAfterMs = 1500;
    const { ws, socket, env, hostSessionId } = bootLazyWorkspace(reapAfterMs);

    // bootLazyWorkspace already wrote local state with the explicit socket/db.
    // No overwrite needed — the reapAfterMs is already in the state.

    try {
      // Boot + register (host session id via the stdin hook payload).
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(await daemonAvailable(socket)).toBe(true);

      // End the session — daemon should become idle
      const end = runWithStdin(
        ['session', 'end'],
        env,
        sessionEndPayload(hostSessionId, ws),
        ws,
      );
      expect(end.exitCode).toBe(0);

      // Poll until unavailable — deadline = reapAfterMs + 4 * daemon_pollMs + headroom
      const deadline =
        Date.now() + reapAfterMs + 4 * LAZY_DAEMON_POLL_MS + 2_000;
      let down = false;
      while (Date.now() < deadline) {
        if (!(await daemonAvailable(socket))) {
          down = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(down).toBe(true);
      // Stronger assertion: the server cleanup unlinks the socket file.
      expect(existsSync(socket)).toBe(false);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped — ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 15_000);

  it('two workspaces get distinct daemons and isolated session lists', async () => {
    // Use workspacePaths() derivation — do NOT pass explicit sockets — so this
    // test exercises the real hash-based path derivation path.
    // We create two real temp dirs and let workspacePaths() compute their sockets.
    const { workspacePaths } = await import('../workspace-paths.js');

    const wsA = mkdtempSync(path.join(tmpdir(), 'agentmon-wsA-'));
    const wsB = mkdtempSync(path.join(tmpdir(), 'agentmon-wsB-'));

    const pathsA = workspacePaths(wsA);
    const pathsB = workspacePaths(wsB);

    // Confirm the derivation yields distinct sockets (the acceptance criterion).
    expect(pathsA.socket).not.toBe(pathsB.socket);

    // Scaffold monitors in both workspaces
    for (const ws of [wsA, wsB]) {
      const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
      mkdirSync(monitorsDir, { recursive: true });
      writeFileSync(
        path.join(monitorsDir, 'MONITOR.md'),
        [
          '---',
          'name: Watch files',
          'watch:',
          '  type: file-fingerprint',
          '  globs:',
          '    - "*.txt"',
          `  cwd: ${JSON.stringify(ws)}`,
          'urgency: normal',
          '---',
          'When files change, review them.',
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    // Write local state using the DERIVED paths (no explicit socket override).
    // Short reapAfterMs for fast self-cleanup of any escaped daemon.
    const reapAfterMs = 5_000;
    writeLocalState(wsA, {
      enabled: true,
      reapAfterMs,
      // omit socket/db — let session start derive them via workspacePaths()
    });
    writeLocalState(wsB, {
      enabled: true,
      reapAfterMs,
    });

    const hostIdA = `cross-ws-A-${Date.now()}`;
    const hostIdB = `cross-ws-B-${Date.now()}`;
    // No CLAUDE_CODE_SESSION_ID — the host id is fed via the stdin payload.
    const envA = {
      CLAUDE_PROJECT_DIR: wsA,
    };
    const envB = {
      CLAUDE_PROJECT_DIR: wsB,
    };

    try {
      // Start both sessions — each gets its own daemon. Host id via stdin.
      const startA = runWithStdin(
        ['session', 'start'],
        envA,
        sessionStartPayload(hostIdA, wsA),
        wsA,
      );
      expect(startA.exitCode).toBe(0);
      const startB = runWithStdin(
        ['session', 'start'],
        envB,
        sessionStartPayload(hostIdB, wsB),
        wsB,
      );
      expect(startB.exitCode).toBe(0);

      // Both daemons must be simultaneously reachable on their derived sockets
      expect(await daemonAvailable(pathsA.socket)).toBe(true);
      expect(await daemonAvailable(pathsB.socket)).toBe(true);

      // A's session list contains A's session, NOT B's
      const listA = runWithEnv(
        ['session', 'list', '--socket', pathsA.socket, '--format', 'json'],
        envA,
        wsA,
      );
      expect(listA.exitCode).toBe(0);
      const sessionsA = JSON.parse(listA.stdout) as {
        hostSessionId: string;
      }[];
      expect(sessionsA.some((s) => s.hostSessionId === hostIdA)).toBe(true);
      expect(sessionsA.some((s) => s.hostSessionId === hostIdB)).toBe(false);

      // B's session list contains B's session, NOT A's
      const listB = runWithEnv(
        ['session', 'list', '--socket', pathsB.socket, '--format', 'json'],
        envB,
        wsB,
      );
      expect(listB.exitCode).toBe(0);
      const sessionsB = JSON.parse(listB.stdout) as {
        hostSessionId: string;
      }[];
      expect(sessionsB.some((s) => s.hostSessionId === hostIdB)).toBe(true);
      expect(sessionsB.some((s) => s.hostSessionId === hostIdA)).toBe(false);

      // Clean up both sessions
      runWithStdin(
        ['session', 'end'],
        envA,
        sessionEndPayload(hostIdA, wsA),
        wsA,
      );
      runWithStdin(
        ['session', 'end'],
        envB,
        sessionEndPayload(hostIdB, wsB),
        wsB,
      );
    } finally {
      for (const socket of [pathsA.socket, pathsB.socket]) {
        try {
          await callDaemon('stop', {}, { socketPath: socket });
        } catch {
          // already stopped — ignore
        }
      }
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Steel-thread UAT (Plan D Task 4) — the campaign's "done" gate.
  //
  // This is the end-to-end proof of the whole activation loop, driven EXACTLY
  // as the plugin's hooks drive it in a real Claude Code session: every host
  // interaction (session start, hook deliver, session end) feeds a CC-style
  // JSON payload on STDIN — the real contract — NOT env vars. A dropped monitor
  // + a watched-file change must end with the agent being handed THAT monitor's
  // own body-instruction as additionalContext at the next turn boundary.
  //
  // We use HIGH urgency so the monitor body is included in the claim's events[]
  // (and thus the rendered additionalContext). At `turn-interruptible`, normal
  // urgency returns events:[] (reminder only), which would not carry the body.
  // The price is the ~15s high-urgency settle window before the event
  // materializes — accepted here exactly like the `hook deliver` test above.
  // -------------------------------------------------------------------------
  // Regression for the PR #83 blocking review: the plugin runs SessionStart as a
  // SINGLE shell command (`agentmonitors session start`). `session start` reads
  // the hook payload from stdin; a separately chained `agentmonitors hook deliver`
  // would see an already-consumed stdin (one hook invocation = one stdin stream),
  // parse `{}`, and silently no-op — killing the post-compact recap. So
  // `session start` MUST register AND surface the recap itself, from the one
  // payload it reads. This test drives the ACTUAL shipped command form: one
  // subprocess, one stdin stream, and asserts the recap reaches additionalContext.
  it('SessionStart delivers the post-compact recap from a single stdin payload (the real shipped hook form)', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ss-recap-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-src');
    mkdirSync(monitorsDir, { recursive: true });

    const RECAP_BODY = 'Recap: the watched file changed since you were away.';
    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch src',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // Normal urgency emits immediately (no 15s high-urgency debounce), so the
        // event materializes fast. The post-compact recap delivers ANY unread
        // event (not just settled-high), so normal urgency exercises this path.
        'urgency: normal',
        '---',
        RECAP_BODY,
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-ssrecap-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'ssrecap.db');
    const hostSessionId = 'ss-recap-session';
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 60_000 });
    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };
    const ssPayload = JSON.stringify({
      session_id: hostSessionId,
      hook_event_name: 'SessionStart',
      cwd: ws,
    });

    try {
      // 1. First SessionStart: lazy-boot + register. Nothing pending yet, so the
      //    single command prints no recap.
      const first = runWithStdin(['session', 'start'], env, ssPayload, ws);
      expect(first.exitCode).toBe(0);
      expect(first.stdout.trim()).toBe('');
      expect(await daemonAvailable(socket)).toBe(true);

      const registered = (
        JSON.parse(
          runWithEnv(
            ['session', 'list', '--socket', socket, '--format', 'json'],
            env,
            ws,
          ).stdout,
        ) as { id: string; hostSessionId: string }[]
      ).find((s) => s.hostSessionId === hostSessionId);
      expect(registered).toBeDefined();
      const sessionId = registered?.id ?? '';

      // 2. The watched file changes; poll until the daemon materializes + projects
      //    the unread event (post-compact recap needs only unread, not the settle).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed: added eval()', 'utf-8');
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const r = runWithEnv(
          [
            'events',
            'list',
            '--session',
            sessionId,
            '--unread',
            '--format',
            'json',
            '--socket',
            socket,
          ],
          env,
          ws,
        );
        if (
          r.exitCode === 0 &&
          (JSON.parse(r.stdout) as unknown[]).length >= 1
        ) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }

      // 3. Second SessionStart (a compact-resume) with ONE stdin payload: the
      //    single `session start` command must itself emit the recap — proving
      //    start-then-deliver works from a single stdin stream.
      const resume = runWithStdin(['session', 'start'], env, ssPayload, ws);
      expect(resume.exitCode).toBe(0);
      const out = JSON.parse(resume.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.hookSpecificOutput.additionalContext).toContain(RECAP_BODY);

      runWithStdin(
        ['session', 'end'],
        env,
        sessionEndPayload(hostSessionId, ws),
        ws,
      );
    } finally {
      runWithEnv(['daemon', 'stop', '--socket', socket], env, ws);
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  it('steel thread: drop a monitor, session start boots the daemon, a watched-file change is delivered as the monitor body at the next turn', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-steel-thread-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-src');
    mkdirSync(monitorsDir, { recursive: true });

    // The distinctive body-instruction that MUST reach the agent verbatim.
    const BODY_INSTRUCTION =
      'Review the changed file and flag risky edits before continuing.';

    // 1. Scaffold the workspace: a watched file + a file-fingerprint monitor.
    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch src',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        'urgency: high',
        '---',
        BODY_INSTRUCTION,
        '',
      ].join('\n'),
      'utf-8',
    );

    // Per-workspace socket + db; enable monitoring via .claude/agentmonitors.local.md.
    const socket = path.join(
      '/tmp',
      `agentmon-steel-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'steel-thread.db');
    const hostSessionId = 'steel-thread-session';
    // Short reap window so any escaped daemon self-cleans (defence-in-depth);
    // long enough not to reap mid-test before session end.
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 60_000 });

    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    try {
      // 2. `session start` with a SessionStart payload on STDIN — lazy-boots the
      //    daemon and registers the session. No CLAUDE_CODE_SESSION_ID.
      const start = runWithStdin(
        ['session', 'start'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'SessionStart',
          cwd: ws,
        }),
        ws,
      );
      expect(start.exitCode).toBe(0);

      // The daemon lazy-booted on the per-workspace socket...
      expect(await daemonAvailable(socket)).toBe(true);

      // ...and the session is registered.
      const list = runWithEnv(
        ['session', 'list', '--socket', socket, '--format', 'json'],
        env,
        ws,
      );
      expect(list.exitCode).toBe(0);
      const sessions = JSON.parse(list.stdout) as {
        id: string;
        hostSessionId: string;
      }[];
      const registered = sessions.find(
        (s) => s.hostSessionId === hostSessionId,
      );
      expect(registered).toBeDefined();
      const sessionId = registered?.id ?? '';

      // 3. Let the baseline tick run, then mutate the watched file.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed content', 'utf-8');

      // Poll until the high-urgency event materializes past the 15s settle.
      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            sessionId,
            '--unread',
            '--format',
            'json',
          ],
          env,
          ws,
        );
      const eventDeadline = Date.now() + 20_000;
      while (Date.now() < eventDeadline) {
        const r = unread();
        if (r.exitCode === 0 && JSON.parse(r.stdout).length >= 1) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // 4. `hook deliver` with a UserPromptSubmit payload on STDIN. THIS is the
      //    steel-thread assertion: the dropped monitor's own body-instruction is
      //    handed to the agent as additionalContext at the turn boundary.
      const deliver = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );
      expect(deliver.exitCode).toBe(0);
      expect(deliver.stdout.trim()).not.toBe('');
      const output = JSON.parse(deliver.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      // The monitor id and its distinctive body must both appear in the context.
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'watch-src',
      );
      expect(output.hookSpecificOutput.additionalContext).toContain(
        BODY_INSTRUCTION,
      );

      // 5. `session end` with a SessionEnd payload on STDIN — deregisters.
      const end = runWithStdin(
        ['session', 'end'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'SessionEnd',
          cwd: ws,
        }),
        ws,
      );
      expect(end.exitCode).toBe(0);

      // The session is deregistered (marked dormant).
      const listAfter = runWithEnv(
        ['session', 'list', '--socket', socket, '--format', 'json'],
        env,
        ws,
      );
      expect(listAfter.exitCode).toBe(0);
      const after = JSON.parse(listAfter.stdout) as {
        id: string;
        status: string;
      }[];
      expect(after.find((s) => s.id === sessionId)?.status).toBe('dormant');
    } finally {
      // No orphan daemons: stop the per-workspace daemon explicitly.
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped — ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000); // high-urgency settle = 15s + baseline + detection + headroom
});

// ---------------------------------------------------------------------------
// Plugin hooks.json config-drift UAT (issue #89)
//
// The steel-thread UAT above drives ['session','start'] / ['hook','deliver']
// as ARGV directly with hand-built stdin. That proves the CLI's stdin contract
// but skips the exact layer the #83 bug lived in: the seam between the plugin's
// hooks.json command STRINGS and that contract (the now-removed vestigial
// `&& agentmonitors hook deliver` chain was dead precisely because the first
// command had already consumed stdin — invisible to an argv-level test).
//
// This suite parses the REAL agent-plugins/agentmonitors/hooks/hooks.json at
// test time (no copies) and runs each configured command VERBATIM through
// `/bin/sh -c`, with an `agentmonitors` shim on PATH satisfying the commands'
// own `command -v agentmonitors` guard. It therefore fails if a command string
// drifts incompatibly (a flag re-added, the binary renamed, the chain broken),
// if the stdin contract regresses, or if the missing-CLI fallback emits invalid
// JSON.
// ---------------------------------------------------------------------------

interface PluginHooksJson {
  hooks: Record<
    string,
    { matcher: string; hooks: { type: string; command: string }[] }[]
  >;
}

/**
 * Read the literal command string the plugin wires for `eventName` from the
 * real hooks.json. Throws if absent so a renamed/removed event surfaces as a
 * test failure rather than a silently skipped assertion.
 */
function pluginHookCommand(eventName: string): string {
  const config = JSON.parse(
    readFileSync(PLUGIN_HOOKS_JSON_PATH, 'utf-8'),
  ) as PluginHooksJson;
  const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`hooks.json has no command for ${eventName}`);
  }
  return command;
}

/**
 * Run a plugin hook command string exactly as Claude Code does: `/bin/sh -c
 * '<command>'` with the CC-style JSON payload on stdin. `/bin/sh` is invoked by
 * absolute path so the command resolves even when `env.PATH` is restricted (the
 * fallback test deliberately empties PATH); `agentmonitors` itself is resolved
 * via `env.PATH` by the command's own `command -v` guard.
 */
function runPluginHookCommand(
  command: string,
  env: Record<string, string>,
  input: string,
  cwd: string,
): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
    input,
  };
  try {
    const stdout = execFileSync('/bin/sh', ['-c', command], opts) as string;
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

/**
 * Create a temp dir holding an executable `agentmonitors` that execs the built
 * CLI. Prepending this dir to PATH satisfies the hooks' `command -v
 * agentmonitors` guard and routes the literal command to dist/index.cjs — the
 * same indirection a real `npm i -g @agentmonitors/cli` install provides.
 */
function makeAgentmonitorsShimDir(): string {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'agentmon-shim-'));
  const shim = path.join(shimDir, 'agentmonitors');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec node ${JSON.stringify(CLI_PATH)} "$@"\n`,
    'utf-8',
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

describe('plugin hooks.json config-drift UAT', () => {
  it("drives the plugin's literal hooks.json command strings end to end (boot, deliver body, deregister)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hooksjson-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-src');
    mkdirSync(monitorsDir, { recursive: true });

    // The distinctive body-instruction that MUST reach the agent verbatim.
    const BODY_INSTRUCTION =
      'Review the changed file and flag risky edits before continuing.';
    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch src',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // High urgency so the body is carried in the claim's events[] at the
        // UserPromptSubmit lifecycle (normal urgency is reminder-only there).
        // Price: the ~15s high-urgency settle before the event materializes.
        'urgency: high',
        '---',
        BODY_INSTRUCTION,
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hj-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hooksjson.db');
    const hostSessionId = 'hooksjson-session';
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 60_000 });

    const shimDir = makeAgentmonitorsShimDir();
    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
      // Shim first so `command -v agentmonitors` resolves to the built CLI;
      // the system PATH tail keeps `node` (and the shell's tools) reachable.
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    // Read the literal command strings ONCE, up front — drift in hooks.json is
    // what this test is here to catch.
    const startCmd = pluginHookCommand('SessionStart');
    const deliverCmd = pluginHookCommand('UserPromptSubmit');
    const endCmd = pluginHookCommand('SessionEnd');

    try {
      // 1. SessionStart command string → lazy-boot the daemon + register.
      const start = runPluginHookCommand(
        startCmd,
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'SessionStart',
          cwd: ws,
        }),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(await daemonAvailable(socket)).toBe(true);

      const sessions = JSON.parse(
        runWithEnv(
          ['session', 'list', '--socket', socket, '--format', 'json'],
          env,
          ws,
        ).stdout,
      ) as { id: string; hostSessionId: string }[];
      const registered = sessions.find(
        (s) => s.hostSessionId === hostSessionId,
      );
      expect(registered).toBeDefined();
      const sessionId = registered?.id ?? '';

      // 2. Mutate the watched file; wait for the high-urgency event to settle.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed content', 'utf-8');
      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            sessionId,
            '--unread',
            '--format',
            'json',
            '--socket',
            socket,
          ],
          env,
          ws,
        );
      const eventDeadline = Date.now() + 20_000;
      while (Date.now() < eventDeadline) {
        const r = unread();
        if (r.exitCode === 0 && (JSON.parse(r.stdout) as unknown[]).length >= 1)
          break;
        await new Promise((res) => setTimeout(res, 500));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // 3. UserPromptSubmit command string → the monitor body reaches the agent
      //    as additionalContext. THIS is the config-drift assertion: if the
      //    command were changed to drop/rename `agentmonitors hook deliver`, the
      //    body would not arrive and this fails.
      const deliver = runPluginHookCommand(
        deliverCmd,
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );
      expect(deliver.exitCode).toBe(0);
      expect(deliver.stdout.trim()).not.toBe('');
      const output = JSON.parse(deliver.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'watch-src',
      );
      expect(output.hookSpecificOutput.additionalContext).toContain(
        BODY_INSTRUCTION,
      );

      // 4. SessionEnd command string → deregister (session marked dormant).
      const end = runPluginHookCommand(
        endCmd,
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'SessionEnd',
          cwd: ws,
        }),
        ws,
      );
      expect(end.exitCode).toBe(0);
      const after = JSON.parse(
        runWithEnv(
          ['session', 'list', '--socket', socket, '--format', 'json'],
          env,
          ws,
        ).stdout,
      ) as { id: string; status: string }[];
      expect(after.find((s) => s.id === sessionId)?.status).toBe('dormant');
    } finally {
      // No orphan daemons: stop the per-workspace daemon explicitly.
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped — ignore
      }
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000); // high-urgency settle = 15s + baseline + detection + headroom

  it('SessionStart command falls back to the install-hint JSON when agentmonitors is not on PATH', () => {
    // The missing-CLI branch: `command -v agentmonitors` fails, so the command
    // must print VALID fallback JSON carrying the install hint. `command` and
    // `printf` are POSIX shell builtins, so they still run with an empty PATH.
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hooksjson-nocli-'));
    const emptyPathDir = mkdtempSync(
      path.join(tmpdir(), 'agentmon-empty-path-'),
    );
    try {
      const startCmd = pluginHookCommand('SessionStart');
      const result = runPluginHookCommand(
        startCmd,
        { PATH: emptyPathDir },
        JSON.stringify({
          session_id: 'no-cli-session',
          hook_event_name: 'SessionStart',
          cwd: ws,
        }),
        ws,
      );
      expect(result.exitCode).toBe(0);
      // Must be parseable JSON of the SessionStart additionalContext shape...
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      // ...and carry the actionable install hint.
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'npm i -g @agentmonitors/cli',
      );
    } finally {
      rmSync(emptyPathDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hook deliver: advisory turn-boundary delivery
// ---------------------------------------------------------------------------

describe('hook deliver', () => {
  it('hook deliver emits the pending monitor body as advisory context', async () => {
    // Scaffold a workspace with a file-fingerprint monitor that has a
    // distinctive body text we can assert on.
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hook-deliver-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch files',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // Use high urgency: `turn-interruptible` surfaces high events after
        // the 15s settle window (DEFAULT_HIGH_URGENCY_SETTLE_MS).  The body
        // is included in the claim's events[] array only for high urgency at
        // this lifecycle; normal returns events:[] (reminder only).
        'urgency: high',
        '---',
        'When files change, review the diff and flag risky changes.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hd-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hook-deliver.db');
    const hostSessionId = `hook-deliver-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    const env: Record<string, string> = {
      CLAUDE_CODE_SESSION_ID: hostSessionId,
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(
      path.join(ws, '.claude', 'monitors'),
      ws,
      env,
      socket,
    );

    try {
      // Open a session via the daemon (the low-level session open, not lazy start).
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(sessionOpen.exitCode).toBe(0);

      // Wait for the first baseline tick to complete (so the next file change
      // will be detected as a delta rather than silently ignored).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);

      // Trigger a file change so a monitor event is generated.
      writeFileSync(watchedFile, 'changed content', 'utf-8');

      // Poll until an unread event appears (deadline: 10 s).
      const session = JSON.parse(sessionOpen.stdout) as { id: string };
      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            session.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          ws,
        );

      // For high-urgency events the runtime holds observations in a 15 s
      // debounce window before materializing them into monitor_events rows.
      // Poll for the unread event with a deadline that covers the settle
      // window (15 s) plus two tick intervals (2 s) plus headroom (3 s = 20 s).
      const eventDeadline = Date.now() + 20_000;
      while (Date.now() < eventDeadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // Once the event is materialized (after the debounce expires), hook
      // deliver can claim it immediately — the settle check in claimDelivery
      // compares event.createdAt against now, and the event's createdAt is
      // set at materialization time (after the debounce), so the settle
      // window is already satisfied when the event first becomes visible.
      //
      // The hook payload is fed via STDIN (as Claude Code does); the lifecycle
      // is DERIVED from the `hook_event_name` (PostToolUse → turn-interruptible),
      // proving the command no longer depends on an env var or a flag.
      const deliverResult = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );

      expect(deliverResult.exitCode).toBe(0);
      expect(deliverResult.stdout.trim()).not.toBe('');

      const output = JSON.parse(deliverResult.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.continue).toBe(true);
      // The echoed event name matches the firing event from the stdin payload.
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      // The monitor body must appear in the injected context.
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'watch-files',
      );
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'When files change, review the diff and flag risky changes.',
      );
      // Advisory only — no permissionDecision
      expect(output).not.toHaveProperty('permissionDecision');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000); // high-urgency settle = 15s + baseline + detection + headroom

  // Issue #198 (AC1, AC6): a DEFAULT `normal`-urgency monitor must produce a
  // visible mid-turn signal. `hook deliver` with a `UserPromptSubmit`
  // (turn-interruptible) payload must emit a non-empty reminder line in
  // `additionalContext` — NOT silence — and claiming it must leave the event
  // unread (claimed ≠ acknowledged, BP2/SP4), so it stays re-discoverable via
  // `events list --unread`.
  it('hook deliver emits a reminder line for a pending normal-urgency change (and leaves it unread)', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-normal-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch files',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // DEFAULT urgency. normal turn-interruptible claims return events:[]
        // with only a reminder message — the case this issue fixes.
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hdn-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-normal.db');
    const hostSessionId = `hd-normal-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    const env: Record<string, string> = {
      CLAUDE_CODE_SESSION_ID: hostSessionId,
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(
      path.join(ws, '.claude', 'monitors'),
      ws,
      env,
      socket,
    );

    try {
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(sessionOpen.exitCode).toBe(0);
      const session = JSON.parse(sessionOpen.stdout) as { id: string };

      // Let the baseline tick complete, then change the file.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed content', 'utf-8');

      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            session.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          ws,
        );

      // normal urgency materializes without the 15s high-urgency settle window.
      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      const deliverResult = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(deliverResult.exitCode).toBe(0);
      // The core defect: this used to be empty for normal urgency.
      expect(deliverResult.stdout.trim()).not.toBe('');

      const output = JSON.parse(deliverResult.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      // A non-empty advisory reminder line is injected.
      expect(output.hookSpecificOutput.additionalContext.trim()).not.toBe('');
      // Reminder only — NO per-event body block is injected for normal urgency.
      expect(output.hookSpecificOutput.additionalContext).not.toContain('### ');
      expect(output).not.toHaveProperty('permissionDecision');

      // AC6: claiming via hook deliver marks the row claimed but NOT
      // acknowledged — the event is still listed by events list --unread.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('hook deliver exits 0 and prints nothing when there is nothing pending', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-empty-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch files',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "*.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hd2-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-empty.db');
    const hostSessionId = `hd-empty-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 10_000 });

    const env: Record<string, string> = {
      CLAUDE_CODE_SESSION_ID: hostSessionId,
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(
      path.join(ws, '.claude', 'monitors'),
      ws,
      env,
      socket,
    );

    try {
      // Open a session — no events yet
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(sessionOpen.exitCode).toBe(0);

      // No file change — nothing is pending. Feed the payload via STDIN; the
      // lifecycle is derived from the event name.
      const deliverResult = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );

      expect(deliverResult.exitCode).toBe(0);
      expect(deliverResult.stdout.trim()).toBe('');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('hook deliver exits 0 and prints nothing when the stdin payload has no session_id', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-nosess-'));

    try {
      // A payload missing session_id → not a tracked Claude session → no-op.
      const result = runWithStdin(
        ['hook', 'deliver'],
        { CLAUDE_PROJECT_DIR: ws },
        JSON.stringify({ hook_event_name: 'PostToolUse', cwd: ws }),
        ws,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('hook deliver exits 0 and prints nothing with an empty stdin payload (does not hang)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-empty-stdin-'));

    try {
      // Empty stdin (no JSON at all) → treated as {} → no session_id → no-op.
      // This also proves the stdin read does not block when nothing is piped.
      const result = runWithStdin(
        ['hook', 'deliver'],
        { CLAUDE_PROJECT_DIR: ws },
        '',
        ws,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('hook deliver emits nothing for an event that does not honor additionalContext (PreToolUse)', async () => {
    // Even with pending high-urgency events, PreToolUse (uses permissionDecision,
    // not additionalContext) must map to NO lifecycle → quiet no-op. This proves
    // the event→lifecycle mapping suppresses useless injection.
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-pretool-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-files');
    mkdirSync(monitorsDir, { recursive: true });

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch files',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "*.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hd-pt-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-pretool.db');
    const hostSessionId = `hd-pretool-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 10_000 });

    const env: Record<string, string> = {
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(
      path.join(ws, '.claude', 'monitors'),
      ws,
      env,
      socket,
    );

    try {
      runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );

      // PreToolUse is NOT a context event → no lifecycle → quiet no-op,
      // regardless of whether anything is pending.
      const result = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PreToolUse',
          cwd: ws,
        }),
        ws,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  // No-event-loss proof: with two settled high-urgency events whose combined
  // rendered body exceeds the 4000-char cap, `hook deliver` truncates the visible
  // additionalContext (claiming all the events) but — because claiming ≠ acking
  // (unreadEventsForSession filters on acknowledgedAt IS NULL only) — the
  // truncated-away event(s) MUST still be re-discoverable via
  // `events list --unread`. This proves truncation never drops a durable event.
  it('hook deliver truncates over-cap context but the truncated-away events stay unread', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-trunc-'));

    // Two monitors, each with a >4000-char body and watching a distinct file,
    // so two distinct high-urgency events materialize. The first block alone
    // overruns the 4000-char cap, so the second event's body is truncated away
    // from the rendered context — but the event row remains unread.
    const bigBody = 'BODYCONTENT '.repeat(450); // ~5400 chars per monitor body
    for (const [name, file] of [
      ['mon-a', 'a.txt'],
      ['mon-b', 'b.txt'],
    ] as const) {
      const dir = path.join(ws, '.claude', 'monitors', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(ws, file), 'initial', 'utf-8');
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        [
          '---',
          `name: ${name}`,
          'watch:',
          '  type: file-fingerprint',
          '  globs:',
          `    - "${file}"`,
          `  cwd: ${JSON.stringify(ws)}`,
          '  interval: "1s"',
          'urgency: high',
          '---',
          bigBody,
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    const socket = path.join(
      '/tmp',
      `agentmon-hd-tr-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-trunc.db');
    const hostSessionId = `hd-trunc-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    const env: Record<string, string> = {
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(
      path.join(ws, '.claude', 'monitors'),
      ws,
      env,
      socket,
    );

    try {
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          ws,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(sessionOpen.exitCode).toBe(0);
      const session = JSON.parse(sessionOpen.stdout) as { id: string };

      // Let the baseline tick run, then change both watched files.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(path.join(ws, 'a.txt'), 'changed a', 'utf-8');
      writeFileSync(path.join(ws, 'b.txt'), 'changed b', 'utf-8');

      const unread = () =>
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            session.id,
            '--unread',
            '--format',
            'json',
          ],
          env,
          ws,
        );

      // Wait for BOTH high-urgency events to materialize past the 15s settle.
      const eventDeadline = Date.now() + 25_000;
      while (Date.now() < eventDeadline) {
        const r = unread();
        if (r.exitCode === 0 && JSON.parse(r.stdout).length >= 2) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      const beforeDeliver = JSON.parse(unread().stdout) as { id: string }[];
      expect(beforeDeliver.length).toBe(2);

      // Deliver: this claims BOTH events and renders a truncated context.
      const deliverResult = runWithStdin(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );
      expect(deliverResult.exitCode).toBe(0);
      const output = JSON.parse(deliverResult.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      const ctx = output.hookSpecificOutput.additionalContext;
      // The visible context is capped and signposted as truncated.
      expect(ctx.length).toBeLessThanOrEqual(4000);
      expect(ctx).toContain('[truncated');

      // No-event-loss: BOTH events remain unread after the claim (claiming ≠
      // acking). The truncated-away event is still re-discoverable here, so it
      // will re-deliver via the next context event.
      const afterDeliver = JSON.parse(unread().stdout) as { id: string }[];
      expect(afterDeliver.length).toBe(2);
      // The exact same durable event ids are still present (nothing dropped).
      expect(new Set(afterDeliver.map((e) => e.id))).toEqual(
        new Set(beforeDeliver.map((e) => e.id)),
      );
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);
});
