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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeLocalState } from '../local-state.js';
import {
  daemonAvailable,
  callDaemon,
  resolveSocketPath,
} from '../daemon-ipc.js';
import { decodeToon } from '../toon-format.js';
import { runChannelDeliveryCycle } from './channel.js';
import { claimDeliveryClient } from '../runtime-client.js';

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');
const CLI_PACKAGE_DIR = path.resolve(__dirname, '../..');
// Repo root holds the activation plugin. The config-drift UAT below reads the
// plugin's REAL hooks.json from here (no copies) so it breaks when that file
// drifts. apps/cli → ../../ is the monorepo root.
const REPO_ROOT = path.resolve(CLI_PACKAGE_DIR, '..', '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'agent-plugins', 'agentmonitors');
const PLUGIN_HOOKS_JSON_PATH = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
const PLUGIN_MANIFEST_PATH = path.join(
  PLUGIN_DIR,
  '.claude-plugin',
  'plugin.json',
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

// Ambient environment keys stripped by `cleanEnv` before a caller's own
// overrides are layered on top. Both vars can short-circuit the per-workspace
// auto-discovery this CLI resolves by default (`resolveManualDaemonSocketPath`
// / `resolveWorkspaceDbPath`) — a value inherited from the developer's shell
// would make a "no explicit overrides" test silently exercise the override
// path instead, or point a "isolated fakeHome" test at real on-disk state.
const AMBIENT_KEYS_TO_STRIP = new Set([
  'AGENTMONITORS_SOCKET',
  'AGENTMONITORS_DB',
]);

/**
 * Build a subprocess env with `AMBIENT_KEYS_TO_STRIP` removed from the
 * inherited `process.env` before `env` (the caller's explicit overrides, if
 * any) is layered on top. A caller that wants one of those keys set can still
 * do so via `env` — only the *ambient/inherited* value is stripped.
 */
function cleanEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined && !AMBIENT_KEYS_TO_STRIP.has(key),
      ) as [string, string][],
    ),
    ...env,
  };
}

function runWithCleanEnv(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): RunResult {
  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: cleanEnv(env),
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

/**
 * Like {@link runWithStdin} but captures STDERR on a SUCCESSFUL (exit 0) run
 * too. `execFileSync`-based helpers above only surface stderr when the child
 * throws (non-zero exit) — its return value on success is stdout alone — so
 * they cannot see `hook deliver --debug`'s diagnosis, which is written to
 * stderr on an always-exit-0 command. `spawnSync` captures both streams
 * unconditionally, at the cost of not throwing on a non-zero exit (fine here:
 * `hook deliver` always exits 0 by contract, and callers assert exitCode).
 */
function runWithStdinCapture(
  args: string[],
  env: Record<string, string>,
  input: string,
  cwd?: string,
): RunResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
    input,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
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

/**
 * Stands in for an OLD daemon build that predates a method the CLI now sends
 * (e.g. `doctor.report`, issue #382): its own request schema rejects the
 * request, so it can only reply with the legacy unparseable-request sentinel
 * `{ id: 'invalid', error: 'Invalid JSON request.' }` for EVERY request,
 * regardless of what was actually sent. Used to prove `doctor` falls back to
 * reading persisted state instead of crashing on this exact string.
 */
function startLegacyUnsupportedDaemon(socketPath: string): {
  close: () => Promise<void>;
} {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end(
        `${JSON.stringify({ id: 'invalid', error: 'Invalid JSON request.' })}\n`,
      );
    });
  });
  server.listen(socketPath);
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
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

// Issue #338 item 2: `session open` requires `--host-session-id`, but
// `--help` didn't mark it required, unlike commands' other required options.
// The other `session`/`events` (and the sibling `hook claim`) commands with a
// `.requiredOption`/mandatory `Option` had the same gap.
describe('CLI --help marks required options as required (issue #338 item 2)', () => {
  // Commander wraps a long option description onto a continuation line, so
  // "(required)" can land on its own line under the flag rather than right
  // after it. Collapse whitespace runs (including newlines) to a single
  // space before matching so the assertion is robust to that wrapping.
  function normalizeHelp(stdout: string): string {
    return stdout.replace(/\s+/g, ' ');
  }

  it('session open --help marks --host-session-id as required', () => {
    const result = run(['session', 'open', '--help']);
    expect(result.exitCode).toBe(0);
    expect(normalizeHelp(result.stdout)).toContain(
      '--host-session-id <id> Host session id from the integrating runtime (required)',
    );
  });

  it('events list --help marks --session as required', () => {
    const result = run(['events', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(normalizeHelp(result.stdout)).toContain(
      '--session <id> AgentMon session id (required)',
    );
  });

  it('events ack --help marks --session as required', () => {
    const result = run(['events', 'ack', '--help']);
    expect(result.exitCode).toBe(0);
    expect(normalizeHelp(result.stdout)).toContain(
      '--session <id> AgentMon session id (required)',
    );
  });

  it('hook claim --help marks --session and --lifecycle as required', () => {
    const result = run(['hook', 'claim', '--help']);
    expect(result.exitCode).toBe(0);
    const normalized = normalizeHelp(result.stdout);
    expect(normalized).toContain(
      '--session <id> AgentMon session id (required)',
    );
    expect(normalized).toContain(
      '--lifecycle <lifecycle> Lifecycle point (required)',
    );
  });
});

// Issue #420 P2: `events list`/`events ack` require --session, but the bare
// commander error gives a manual/no-docs user no way to discover an id. The
// error now appends a pointer to `session list`, and --help repeats it. The
// default error line and non-zero exit are unchanged (additive only).
describe('events --session discovery hint (issue #420 P2)', () => {
  const HINT = 'Run `agentmonitors session list` to find a session id.';

  it('events list without --session: error line unchanged, hint appended, exit 1', () => {
    const result = run(['events', 'list']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "error: required option '--session <id>' not specified",
    );
    expect(result.stderr).toContain(HINT);
  });

  it('events ack without --session: error line unchanged, hint appended, exit 1', () => {
    const result = run(['events', 'ack']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "error: required option '--session <id>' not specified",
    );
    expect(result.stderr).toContain(HINT);
  });

  it('events list --help documents how to find a session id', () => {
    const result = run(['events', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(HINT);
  });

  it('events ack --help documents how to find a session id', () => {
    const result = run(['events', 'ack', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(HINT);
  });
});

// Issue #420 P5: `monitor history` scopes by --workspace, not --dir (which
// means the monitors directory elsewhere). Rather than silently alias --dir to
// --workspace (wrong-workspace resolution), the unknown-option error points at
// the right flag. Additive: the default error and exit code are unchanged.
describe('monitor history --dir remediation hint (issue #420 P5)', () => {
  it('unknown --dir: commander error unchanged, hint appended, exit 1', () => {
    const result = run(['monitor', 'history', '--dir', 'foo']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: unknown option '--dir'");
    expect(result.stderr).toContain(
      'monitor history scopes by --workspace (the project directory), not --dir.',
    );
  });

  it('a valid --workspace flag is still accepted (does not trigger the hint)', () => {
    // No daemon and an empty/absent store → the command reports "No observation
    // history." or a no-daemon remediation, but never the --dir hint.
    const result = run([
      'monitor',
      'history',
      '--workspace',
      tempDir,
      '--format',
      'json',
    ]);
    expect(result.stderr).not.toContain('not --dir');
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

  // Issue #408: the named-scaffold path used to leave the user with no
  // verify guidance at all. It must now route to `agentmonitors verify`, the
  // CLI's own real command, with a monitor id and --dir that actually work.
  // file-fingerprint can auto-trigger a change, so --manual is not suggested.
  it('points the named-scaffold summary at `agentmonitors verify` (auto-trigger, no --manual)', () => {
    const dir = path.join(tempDir, 'init-verify-guidance-ff');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const result = run(['init', 'watch-docs', '--dir', monitorsDir], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `agentmonitors verify watch-docs --dir ${monitorsDir}`,
    );
    expect(result.stdout).not.toContain('--manual');
  });

  // Issue #408 AC2: `verify` can only auto-trigger a file-fingerprint change
  // today (its `buildAutoTrigger` only reads `watch.globs`) — every other
  // scaffolded type must point at `--manual` instead of silently omitting it.
  it('points the named-scaffold summary at `agentmonitors verify --manual` for a command-poll monitor', () => {
    const dir = path.join(tempDir, 'init-verify-guidance-cmd');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const result = run(
      ['init', 'cmd-watch', '--dir', monitorsDir, '--type', 'command-poll'],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `agentmonitors verify cmd-watch --dir ${monitorsDir} --manual`,
    );
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

    // Issue #244: the default command-poll scaffold should be safe for
    // upstream-branch watching. `ls-remote` asks the remote directly, so it is
    // always current — no prior fetch needed.
    const monitor = readFileSync(
      path.join(monitorsDir, 'cmd-watch', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain('git');
    expect(monitor).toContain('ls-remote');
    expect(monitor).toContain('origin');
    expect(monitor).toContain('refs/heads/main');
    // Scope the "not git status" check to the actual `command:` argv array —
    // issue #375 intentionally names "git status --porcelain" inside the
    // explanatory comment (contrasting it with the remote-ref caveat), so a
    // whole-file substring check would false-positive on that comment.
    const commandBlockMatch = /command:\n(?:( +)- .*\n)+/.exec(monitor);
    expect(commandBlockMatch).not.toBeNull();
    const commandBlock = commandBlockMatch?.[0] ?? '';
    expect(commandBlock).not.toContain('- status');
    expect(commandBlock).not.toContain('--porcelain');
  });

  // Issue #375 AC2: the command-poll scaffold's inline comment previously
  // warned that local commands "such as \"git status\"" can stay stale until
  // a fetch — backwards advice that contradicts skill.md's own recommended
  // minimal command-poll example (`git status --porcelain`, Phase 3). The
  // fetch-staleness caveat applies ONLY to a local read of a remote-tracking
  // ref (e.g. `git rev-parse origin/main`); the scaffold's own `git ls-remote`
  // queries the remote live and is always current, and a local working-tree
  // command like `git status --porcelain` has no fetch lag either.
  it('command-poll scaffold comment describes ls-remote as live and scopes the staleness caveat to local remote-tracking refs (AC2, AC3)', () => {
    const dir = path.join(tempDir, 'init-command-poll-comment');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', 'cmd-comment', '--dir', monitorsDir, '--type', 'command-poll'],
      dir,
    );
    expect(created.exitCode).toBe(0);

    const monitor = readFileSync(
      path.join(monitorsDir, 'cmd-comment', 'MONITOR.md'),
      'utf-8',
    );
    // The old, self-contradicting wording must be gone entirely.
    expect(monitor).not.toContain('local commands such as "git status"');
    expect(monitor).not.toContain('can stay stale until you fetch');
    // ls-remote must be described as live/always-current, NOT fetch-stale
    // (the earlier fix attempt wrongly grouped it with rev-parse as lagging).
    expect(monitor).toContain('always current');
    expect(monitor).not.toMatch(/ls-remote[^\n]*lag/);
    // The staleness caveat must still exist, scoped to the local remote-ref read.
    expect(monitor).toContain('git rev-parse origin/main');
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

  // AC4 (issue #268): the named `init <name> --type ...` scaffold output must be
  // unchanged by the bare-init bootstrap work. The expected string below is
  // written by hand from 005 §2's documented output (spec-owned-expected-string
  // matching, not a captured snapshot of program output), so any drift (an
  // added line, a reworded hint) fails here.
  //
  // Updated for issue #331 criterion 1: the closing output now also names
  // `agentmonitors doctor` as the health-check next step (005 §2's documented
  // output was updated in lockstep — see the added line below).
  //
  // Renamed from "...is byte-for-byte unchanged..." (PR #341 review, issue
  // #338 item 8): the old title implied a gold-master/snapshot comparison,
  // but `expected` is hand-derived from the spec, not from a prior run — the
  // `doctor` line was an intentional addition, not preserved legacy output.
  //
  // Updated for issue #408: the output now also recommends `agentmonitors
  // verify` (no `--manual`, since `file-fingerprint` can auto-trigger) as the
  // real, CLI-only proof that the monitor delivers end-to-end.
  it('init <name> --type output matches the spec-documented next-steps text (AC4 regression)', () => {
    const dir = path.join(tempDir, 'init-byte-for-byte');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const result = run(
      ['init', 'my-mon', '--dir', monitorsDir, '--type', 'file-fingerprint'],
      dir,
    );
    expect(result.exitCode).toBe(0);
    const monitorDir = path.join(monitorsDir, 'my-mon');
    const expected =
      `Created monitor: ${monitorDir}/MONITOR.md\n` +
      `\n` +
      `Edit the file to configure your monitor, then run:\n` +
      `  agentmonitors validate ${monitorsDir}\n` +
      `  agentmonitors doctor\n` +
      `\n` +
      `Prove it delivers end-to-end:  agentmonitors verify my-mon --dir ${monitorsDir}\n`;
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe('');
  });

  // Issue #330 AC1: each --type's watch block is a correct, minimal,
  // source-appropriate example (per skill.md Phase 3's per-source table) with
  // no cross-type leftovers — e.g. a command-poll scaffold must not carry a
  // file-fingerprint-era `globs:` block.
  it.each([
    { type: 'file-fingerprint', ownMarker: 'globs:' },
    { type: 'api-poll', ownMarker: 'url:' },
    { type: 'command-poll', ownMarker: 'command:' },
    { type: 'schedule', ownMarker: 'cron:' },
    { type: 'incoming-changes', ownMarker: 'paths:' },
  ])(
    '$type scaffold carries only its own marker field, not other types’ (AC1)',
    ({ type, ownMarker }) => {
      const otherMarkers = [
        'globs:',
        'url:',
        'command:',
        'cron:',
        'paths:',
      ].filter((marker) => marker !== ownMarker);
      const dir = path.join(tempDir, `init-ac1-${type}`);
      mkdirSync(dir, { recursive: true });
      const monitorsDir = path.join(dir, 'monitors');
      const created = run(
        ['init', 'ac1-mon', '--dir', monitorsDir, '--type', type],
        dir,
      );
      expect(created.exitCode).toBe(0);
      const monitor = readFileSync(
        path.join(monitorsDir, 'ac1-mon', 'MONITOR.md'),
        'utf-8',
      );
      expect(monitor).toContain(ownMarker);
      for (const otherMarker of otherMarkers) {
        expect(monitor).not.toContain(otherMarker);
      }

      const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
      expect(validated.exitCode).toBe(0);
      const parsed = JSON.parse(validated.stdout) as {
        valid: number;
        invalid: number;
      };
      expect(parsed.valid).toBe(1);
      expect(parsed.invalid).toBe(0);
    },
  );

  // Issue #330 AC2: --glob seeds watch.globs verbatim for file-fingerprint,
  // and the seeded scaffold still passes validate.
  it('--glob seeds watch.globs verbatim for file-fingerprint (AC2)', () => {
    const dir = path.join(tempDir, 'init-glob-ff');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'glob-mon',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
        '--glob',
        'src/**/*.ts',
        '--glob',
        'test/**/*.ts',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'glob-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("    - 'src/**/*.ts'");
    expect(monitor).toContain("    - 'test/**/*.ts'");
    // The stock '**/*.ts' example must be replaced, not appended alongside.
    expect(monitor).not.toContain("    - '**/*.ts'");

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
  });

  // Issue #330 AC2: --glob seeds watch.paths verbatim for incoming-changes
  // (a different underlying frontmatter field than file-fingerprint's
  // `globs:`, per spec 001 §2 / spec 003 §6), and still passes validate.
  it('--glob seeds watch.paths verbatim for incoming-changes (AC2)', () => {
    const dir = path.join(tempDir, 'init-glob-incoming');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'glob-inc-mon',
        '--dir',
        monitorsDir,
        '--type',
        'incoming-changes',
        '--glob',
        'docs/**',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'glob-inc-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("    - 'docs/**'");
    expect(monitor).not.toContain("    - 'docs/specs/**'");

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
  });

  // Issue #330 AC2: --glob has nowhere to go for a type with no path-pattern
  // list (e.g. command-poll's `command:` is an argv array, not globs) — this
  // must fail loudly with a clear message, not silently drop the flag.
  it('--glob is rejected with a clear error for a type with no path-pattern list (AC2)', () => {
    const dir = path.join(tempDir, 'init-glob-unsupported');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const result = run(
      [
        'init',
        'bad-glob-mon',
        '--dir',
        monitorsDir,
        '--type',
        'command-poll',
        '--glob',
        'src/**',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '--glob is not supported for --type command-poll',
    );
    expect(existsSync(path.join(monitorsDir, 'bad-glob-mon'))).toBe(false);
  });

  // Regression (PR #343 review): a multi-line seed value would emit an
  // invalid single-quoted YAML scalar spanning lines — reject it loudly
  // instead of scaffolding a monitor that fails its own validate step.
  it('rejects a --name containing a newline instead of emitting invalid YAML', () => {
    const dir = path.join(tempDir, 'init-newline-name');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'newline-mon',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
        '--name',
        'first line\nsecond line',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must be single-line');
    expect(existsSync(path.join(monitorsDir, 'newline-mon'))).toBe(false);
  });

  // Issue #375 AC1: without --name, the scaffolded name: must derive from
  // the positional <name> ("watch-docs" -> "Watch docs"), never survive as
  // the template's literal placeholder ("My monitor") — a rushed author
  // could otherwise commit a monitor that's never renamed.
  it('derives the frontmatter name: from the positional <name> when --name is omitted (AC1)', () => {
    const dir = path.join(tempDir, 'init-name-derived');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'watch-docs',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'watch-docs', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("name: 'Watch docs'");
    expect(monitor).not.toContain('name: My monitor');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      monitors: { name: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.monitors[0]?.name).toBe('Watch docs');
  });

  // Issue #375 AC1 edge case: a separator-free positional is still capitalized
  // (a single word), matching deriveNameFromPositional's documented behavior —
  // it is NOT returned verbatim (only empty/separators-only inputs are).
  it('capitalizes a separator-free positional <name> (watchdocs -> Watchdocs) (AC1)', () => {
    const dir = path.join(tempDir, 'init-name-single-word');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', 'watchdocs', '--dir', monitorsDir, '--type', 'file-fingerprint'],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'watchdocs', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("name: 'Watchdocs'");
    expect(monitor).not.toContain('name: My monitor');
  });

  // Regression (PR #379 follow-up): an empty positional <name> has no words
  // to capitalize, so deriveNameFromPositional's separators-only fallback
  // must not emit the empty string verbatim as the seeded name — that would
  // scaffold `name: ''`, which fails monitorFrontmatterSchema's .min(1) on
  // `validate` (a regression versus pre-#375, when the template's own
  // non-empty placeholder always survived untouched). Leaving the name seed
  // unset instead falls through to the template's own default name.
  //
  // An empty `name` also makes `path.join(dir, name)` resolve to `dir`
  // itself, so the scaffolded MONITOR.md lands at depth-0 under `monitorsDir`
  // — which scanMonitors deliberately never treats as a monitor (folder id
  // must come from an actual parent directory, per scan-monitors.ts). That
  // placement quirk is unrelated to this bug and out of scope here, so
  // `validate` is run one level up (`dir`, the parent of `monitorsDir`),
  // putting the file at depth-1 (`monitors/MONITOR.md`) like every other
  // scaffolded monitor in this suite.
  it('falls back to the template default name for an empty positional <name>', () => {
    const dir = path.join(tempDir, 'init-name-empty-positional');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', '', '--dir', monitorsDir, '--type', 'file-fingerprint'],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(path.join(monitorsDir, 'MONITOR.md'), 'utf-8');
    expect(monitor).toContain('name: My monitor');

    const validated = run(['validate', dir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      monitors: { name: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.monitors[0]?.name).toBe('My monitor');
  });

  // Regression sibling: a positional consisting solely of separators (e.g.
  // `---`) hits the same "no words" branch as an empty positional and must
  // behave identically — fall back to the template default, not
  // `name: '---'` (the pre-fix verbatim behavior) or `name: ''`. `--` must
  // come after the options (and before the dash-leading positional) so
  // Commander treats `---` as the literal positional value rather than an
  // unknown option or, if `--` led the whole arg list, swallowing `--dir`/
  // `--type` as positionals too.
  it('falls back to the template default name for a separators-only positional <name>', () => {
    const dir = path.join(tempDir, 'init-name-separators-only');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', '--dir', monitorsDir, '--type', 'file-fingerprint', '--', '---'],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, '---', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain('name: My monitor');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      monitors: { name: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.monitors[0]?.name).toBe('My monitor');
  });

  // Issue #330 AC2: --name seeds the frontmatter name: field verbatim,
  // including a value that needs YAML single-quote escaping, and the result
  // still passes validate (proving the escaping round-trips correctly).
  it('--name seeds the frontmatter name field verbatim, including quote-escaping (AC2)', () => {
    const dir = path.join(tempDir, 'init-name-seed');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'name-mon',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
        '--name',
        "Mike's monitor",
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'name-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("name: 'Mike''s monitor'");

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { name: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.monitors[0]?.name).toBe("Mike's monitor");
  });

  // Issue #330 AC2: --urgency seeds the frontmatter urgency: field verbatim
  // and still passes validate; an out-of-band value is rejected by
  // Commander's --choices before scaffolding runs.
  it('--urgency seeds the frontmatter urgency field verbatim (AC2)', () => {
    const dir = path.join(tempDir, 'init-urgency-seed');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'urgency-mon',
        '--dir',
        monitorsDir,
        '--type',
        'schedule',
        '--urgency',
        'high',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'urgency-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain('urgency: high');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
    };
    expect(parsed.valid).toBe(1);
  });

  it('rejects an invalid --urgency value', () => {
    const dir = path.join(tempDir, 'init-urgency-invalid');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'bad-urgency-mon',
        '--dir',
        path.join(dir, 'monitors'),
        '--urgency',
        'urgent',
      ],
      dir,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'urgent'");
  });

  // Issue #330 AC2: all three seed flags combine cleanly on a single
  // scaffold.
  it('combines --glob, --name, and --urgency on a single scaffold (AC2)', () => {
    const dir = path.join(tempDir, 'init-seed-combo');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'combo-mon',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
        '--glob',
        'lib/**/*.ts',
        '--name',
        'TS source watcher',
        '--urgency',
        'low',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'combo-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("name: 'TS source watcher'");
    expect(monitor).toContain("    - 'lib/**/*.ts'");
    expect(monitor).toContain('urgency: low');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { name: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.monitors[0]?.name).toBe('TS source watcher');
  });

  // Issue #388 AC (a): --command seeds watch.command verbatim for command-poll,
  // one argv token per flag (including a leading-dash token like --porcelain,
  // which the collector must preserve, not swallow as another flag). The seeded
  // scaffold still validates and, being the author's intended command rather
  // than the untouched default, emits no soft warning.
  it('--command seeds watch.command verbatim for command-poll (AC a)', () => {
    const dir = path.join(tempDir, 'init-command-seed');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'dirty-worktree',
        '--dir',
        monitorsDir,
        '--type',
        'command-poll',
        '--command',
        'git',
        '--command',
        'status',
        '--command',
        '--porcelain',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'dirty-worktree', 'MONITOR.md'),
      'utf-8',
    );
    // The whole seeded argv is emitted as single-quoted YAML scalars, in order.
    expect(monitor).toContain(
      "  command:\n    - 'git'\n    - 'status'\n    - '--porcelain'\n",
    );
    // The stock ls-remote default must be replaced, not appended alongside.
    expect(monitor).not.toContain('    - ls-remote');
    expect(monitor).not.toContain('    - refs/heads/main');
    // The comment's source-contract clause survives seeding, but its
    // example-specific narrative (which described the untouched ls-remote
    // default, not the seeded git-status command) must not.
    expect(monitor).toContain(
      '  # command is an argv array, run directly (no shell).\n',
    );
    expect(monitor).not.toContain('This example watches the');

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { id: string; source: string }[];
      warnings: { id: string; warning: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.monitors[0]?.source).toBe('command-poll');
    // The author supplied their own command, so no untouched-default warning.
    expect(parsed.warnings).toEqual([]);
  });

  // Issue #388: --command has nowhere to go for a type with no command: argv
  // array (only command-poll has one) — it must fail loudly with a clear
  // message and leave no partial directory behind, mirroring --glob's guard.
  it('--command is rejected with a clear error for a non-command-poll type', () => {
    const dir = path.join(tempDir, 'init-command-unsupported');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const result = run(
      [
        'init',
        'bad-command-mon',
        '--dir',
        monitorsDir,
        '--type',
        'file-fingerprint',
        '--command',
        'git',
        '--command',
        'status',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '--command is not supported for --type file-fingerprint',
    );
    expect(existsSync(path.join(monitorsDir, 'bad-command-mon'))).toBe(false);
  });

  // Issue #388: a --command token containing a literal single quote must be
  // emitted as the doubled-quote YAML escape ('it''s'), mirroring --name's
  // quote-escaping coverage above (AC2/AC803), and the escaped scaffold must
  // still round-trip through validate.
  it('--command seeds a token with a single quote using doubled-quote YAML escaping (hostile input)', () => {
    const dir = path.join(tempDir, 'init-command-quote');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'quote-command-mon',
        '--dir',
        monitorsDir,
        '--type',
        'command-poll',
        '--command',
        'echo',
        '--command',
        "it's",
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'quote-command-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain("    - 'it''s'");

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
  });

  // Issue #388: --command tokens containing YAML-significant characters
  // (#, :, an embedded space) must round-trip verbatim through the
  // single-quoted scalar form (none of these require escaping inside single
  // quotes — only a literal `'` does), and the scaffold must still validate.
  it('--command seeds tokens with #, :, and an embedded space verbatim (hostile input)', () => {
    const dir = path.join(tempDir, 'init-command-special-chars');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      [
        'init',
        'special-chars-command-mon',
        '--dir',
        monitorsDir,
        '--type',
        'command-poll',
        '--command',
        'echo',
        '--command',
        'a#b',
        '--command',
        'a:b',
        '--command',
        'a b',
      ],
      dir,
    );
    expect(created.exitCode).toBe(0);
    const monitor = readFileSync(
      path.join(monitorsDir, 'special-chars-command-mon', 'MONITOR.md'),
      'utf-8',
    );
    expect(monitor).toContain(
      "  command:\n    - 'echo'\n    - 'a#b'\n    - 'a:b'\n    - 'a b'\n",
    );

    const validated = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(validated.exitCode).toBe(0);
    const parsed = JSON.parse(validated.stdout) as {
      valid: number;
      invalid: number;
      monitors: { id: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.monitors[0]?.id).toBe('special-chars-command-mon');
  });

  // Issue #388: a --command token containing a newline cannot be represented
  // as a single-quoted YAML scalar (mirrors --name's newline rejection at
  // "rejects a --name containing a newline" above) — it must fail loudly with
  // exit 1 and the same "single-line" message, and leave no partial directory
  // behind.
  it('rejects a --command containing a newline instead of emitting invalid YAML', () => {
    const dir = path.join(tempDir, 'init-command-newline');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(dir, { recursive: true });
    const result = run(
      [
        'init',
        'newline-command-mon',
        '--dir',
        monitorsDir,
        '--type',
        'command-poll',
        '--command',
        'echo',
        '--command',
        'first line\nsecond line',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must be single-line');
    expect(existsSync(path.join(monitorsDir, 'newline-command-mon'))).toBe(
      false,
    );
  });
});

// Issue #268: bare `agentmonitors init` (no name) is a one-shot project
// bootstrap — enable the project, fix `.gitignore`, offer a first monitor,
// validate, and print a next-steps summary. `init <name>` scaffolding is
// covered above and must stay unchanged.
//
// @see https://github.com/mike-north/AgentMonitors/issues/268
// @see docs/specs/005-cli-reference.md §2
// @see agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md
describe('init bootstrap (bare init)', () => {
  const LOCAL_STATE_REL = path.join('.claude', 'agentmonitors.local.md');
  const GITIGNORE_LINE = '.claude/*.local.*';
  // Issue #336: the undocumented `.agentmonitors/` runtime-state directory
  // (per-session hook-state) must be gitignored by the same bootstrap step,
  // not just the local-coordination file.
  const RUNTIME_DIR_GITIGNORE_LINE = '/.agentmonitors/';

  // The exact minimal enable-file shape from the setup-monitors skill's
  // "Enable The Project" section (`agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md`)
  // and 005 §2. Written by hand from that doc, not derived from program
  // output, so drift in either the skill doc or the implementation fails here.
  const EXPECTED_LOCAL_STATE_CONTENTS =
    '---\n' +
    'enabled: true\n' +
    '---\n' +
    '\n' +
    '> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).\n';

  // AC1 + AC5: fresh dir → bare init (non-interactive via --yes) → enabled +
  // gitignore correct + a valid scaffolded monitor + a validate that passed.
  it('bootstraps a fresh project: enable + gitignore + valid monitor + validate (--yes)', () => {
    const dir = path.join(tempDir, 'bootstrap-yes');
    mkdirSync(dir, { recursive: true });

    const result = run(['init', '--yes'], dir);
    expect(result.exitCode).toBe(0);

    // Step 1 — enable file matches the setup-monitors skill's exact minimal
    // shape byte-for-byte (not just a substring match on `enabled: true`).
    const localState = readFileSync(path.join(dir, LOCAL_STATE_REL), 'utf-8');
    expect(localState).toBe(EXPECTED_LOCAL_STATE_CONTENTS);

    // Step 2 — `.gitignore` ignores the local coordination file and the
    // `.agentmonitors/` runtime directory (issue #336).
    const gitignoreLines = readFileSync(
      path.join(dir, '.gitignore'),
      'utf-8',
    ).split('\n');
    expect(gitignoreLines).toContain(GITIGNORE_LINE);
    expect(gitignoreLines).toContain(RUNTIME_DIR_GITIGNORE_LINE);

    // Step 3 — a starter monitor was scaffolded under the default dir.
    expect(
      existsSync(
        path.join(dir, '.claude', 'monitors', 'my-monitor', 'MONITOR.md'),
      ),
    ).toBe(true);

    // Step 4 — `validate` ran on the result and reported the monitor valid.
    expect(result.stdout).toContain('Valid monitors: 1');

    // Step 5 — the summary points at how to verify the monitor fires.
    expect(result.stdout).toContain('Verify the monitor fires');
    expect(result.stdout).toContain('monitor test');

    // Issue #408: the CLI-only path must route to the real `agentmonitors
    // verify` command (not dead-end at an unavailable "setup-monitors
    // skill"). The default scaffold is file-fingerprint, which can
    // auto-trigger a change, so no --manual is suggested here.
    expect(result.stdout).toContain(
      'agentmonitors verify my-monitor --dir .claude/monitors',
    );
    expect(result.stdout).not.toContain(
      'Full fire-and-deliver recipe: see the setup-monitors skill',
    );
    // The setup-monitors skill reference is kept only as a clearly-labeled,
    // plugin-only supplement alongside `verify` — never the sole pointer.
    expect(result.stdout).toContain('AgentMon Claude Code plugin');
    expect(result.stdout).toContain('setup-monitors skill');

    // Criterion 1 (issue #331): the closing summary also points at
    // `agentmonitors doctor` as the health-check next step.
    expect(result.stdout).toContain('agentmonitors doctor');
  });

  // Issue #338 item 3: the bootstrap's "What happens next" summary used to
  // assert "Monitoring starts automatically when you open a Claude Code
  // session" unconditionally — an overpromise for a project bootstrapped
  // outside Claude Code (e.g. Codex, or a bare terminal with no host plugin).
  // The reworded summary conditions the automatic-start claim on the Claude
  // Code plugin and states the manual `daemon run` alternative on the very
  // next line.
  it('the bootstrap summary conditions automatic startup on the Claude Code plugin and offers a manual daemon run alternative', () => {
    const dir = path.join(tempDir, 'bootstrap-next-steps-wording');
    mkdirSync(dir, { recursive: true });

    const result = run(['init', '--yes'], dir);
    expect(result.exitCode).toBe(0);

    expect(result.stdout).not.toContain(
      'Monitoring starts automatically when you open a Claude Code session',
    );
    expect(result.stdout).toContain(
      "If you're using the AgentMon Claude Code plugin, monitoring starts automatically",
    );
    expect(result.stdout).toContain('agentmonitors daemon run');
    expect(result.stdout).toContain('agentmonitors daemon once');
  });

  // AC2: `--enable-only` performs steps 1–2 only — no monitor, no prompts, exit 0.
  it('--enable-only enables + fixes gitignore but scaffolds no monitor', () => {
    const dir = path.join(tempDir, 'bootstrap-enable-only');
    mkdirSync(dir, { recursive: true });

    const result = run(['init', '--enable-only'], dir);
    expect(result.exitCode).toBe(0);

    expect(readFileSync(path.join(dir, LOCAL_STATE_REL), 'utf-8')).toBe(
      EXPECTED_LOCAL_STATE_CONTENTS,
    );
    const enableOnlyGitignoreLines = readFileSync(
      path.join(dir, '.gitignore'),
      'utf-8',
    ).split('\n');
    expect(enableOnlyGitignoreLines).toContain(GITIGNORE_LINE);
    expect(enableOnlyGitignoreLines).toContain(RUNTIME_DIR_GITIGNORE_LINE);
    // No monitor scaffolding in enable-only mode.
    expect(existsSync(path.join(dir, '.claude', 'monitors'))).toBe(false);
  });

  // AC3: re-running on an already-enabled project changes nothing and says so.
  it('is idempotent: re-running --enable-only changes nothing and says so', () => {
    const dir = path.join(tempDir, 'bootstrap-idempotent');
    mkdirSync(dir, { recursive: true });

    const first = run(['init', '--enable-only'], dir);
    expect(first.exitCode).toBe(0);

    const localPath = path.join(dir, LOCAL_STATE_REL);
    const gitignorePath = path.join(dir, '.gitignore');
    const localBefore = readFileSync(localPath, 'utf-8');
    const gitignoreBefore = readFileSync(gitignorePath, 'utf-8');

    const second = run(['init', '--enable-only'], dir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toLowerCase()).toContain('already set up');
    // Criterion 1 (issue #331): the "nothing to change" closing summary also
    // points at `agentmonitors doctor`.
    expect(second.stdout).toContain('agentmonitors doctor');

    // "changes nothing": both files are byte-identical after the re-run.
    expect(readFileSync(localPath, 'utf-8')).toBe(localBefore);
    expect(readFileSync(gitignorePath, 'utf-8')).toBe(gitignoreBefore);
  });

  // AC3 (monitor path): a `--yes` re-run must not error on the existing monitor
  // nor rewrite it — it reports "already set up" and leaves the file untouched.
  it('is idempotent: re-running --yes leaves an existing monitor unchanged', () => {
    const dir = path.join(tempDir, 'bootstrap-idempotent-yes');
    mkdirSync(dir, { recursive: true });

    const first = run(['init', '--yes'], dir);
    expect(first.exitCode).toBe(0);

    const monitorPath = path.join(
      dir,
      '.claude',
      'monitors',
      'my-monitor',
      'MONITOR.md',
    );
    const before = readFileSync(monitorPath, 'utf-8');

    const second = run(['init', '--yes'], dir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toLowerCase()).toContain('already set up');
    expect(readFileSync(monitorPath, 'utf-8')).toBe(before);
  });

  // AC1: `.gitignore` handling appends without clobbering existing content and
  // never duplicates the ignore line across runs.
  it('appends the ignore line to a pre-existing .gitignore without clobbering it', () => {
    const dir = path.join(tempDir, 'bootstrap-gitignore-append');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.gitignore'),
      'node_modules\ndist\n',
      'utf-8',
    );

    expect(run(['init', '--enable-only'], dir).exitCode).toBe(0);

    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
    expect(gitignore.split('\n')).toContain(GITIGNORE_LINE);
    expect(gitignore.split('\n')).toContain(RUNTIME_DIR_GITIGNORE_LINE);

    // Re-running must not add a second copy of either line.
    expect(run(['init', '--enable-only'], dir).exitCode).toBe(0);
    const after = readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    const afterLines = after.split('\n');
    expect(
      afterLines.filter((line) => line.trim() === GITIGNORE_LINE),
    ).toHaveLength(1);
    expect(
      afterLines.filter((line) => line.trim() === RUNTIME_DIR_GITIGNORE_LINE),
    ).toHaveLength(1);
  });

  // AC1 (issue #336): a `.gitignore` that already ignores the local
  // coordination file but predates the `.agentmonitors/` fix must get only
  // the missing line appended — the append-if-missing check is per-line, not
  // all-or-nothing.
  it('appends only the missing .agentmonitors/ line when .gitignore already has the local-state line', () => {
    const dir = path.join(tempDir, 'bootstrap-gitignore-partial');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.gitignore'), `${GITIGNORE_LINE}\n`, 'utf-8');

    expect(run(['init', '--enable-only'], dir).exitCode).toBe(0);

    const gitignoreLines = readFileSync(
      path.join(dir, '.gitignore'),
      'utf-8',
    ).split('\n');
    expect(
      gitignoreLines.filter((line) => line.trim() === GITIGNORE_LINE),
    ).toHaveLength(1);
    expect(gitignoreLines).toContain(RUNTIME_DIR_GITIGNORE_LINE);
  });

  // AC2 (agents/scripts): a non-interactive bare init (closed, non-TTY stdin)
  // must not prompt or hang — it enables the project, scaffolds no monitor, and
  // tells the caller how to opt into a starter monitor.
  it('non-interactive bare init (no flags) enables without prompting or scaffolding', () => {
    const dir = path.join(tempDir, 'bootstrap-noninteractive');
    mkdirSync(dir, { recursive: true });

    // Empty stdin makes the child's stdin a closed pipe (never a TTY), so the
    // command takes the non-interactive path deterministically instead of
    // blocking on a prompt.
    const result = runWithStdin(
      ['init'],
      { AGENTMONITORS_DB: ':memory:' },
      '',
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(dir, LOCAL_STATE_REL))).toBe(true);
    expect(existsSync(path.join(dir, '.claude', 'monitors'))).toBe(false);
    expect(result.stdout).toContain('--yes');
  });

  // Regression (PR #310 review): `readLocalState`'s minimal frontmatter parser
  // only recognizes a bare `---` as the block delimiter, so a BOM-prefixed
  // `.claude/agentmonitors.local.md` (a literal U+FEFF before `---`, which
  // some editors/tools write) was misdetected as disabled, causing bare `init`
  // to clobber the file — losing any `socket`/`db` fields a prior
  // `session start` had persisted. `ensureEnabled` must fall back to a
  // raw-text check for `enabled: true` (BOM stripped) before writing.
  it('does not clobber a BOM-prefixed already-enabled local-state file (byte-identical)', () => {
    const dir = path.join(tempDir, 'bootstrap-bom-enabled');
    mkdirSync(path.join(dir, '.claude'), { recursive: true });

    // A realistic already-enabled file with socket/db fields a prior
    // `session start` persisted, prefixed with a UTF-8 BOM.
    const localStatePath = path.join(dir, LOCAL_STATE_REL);
    const bomPrefixedContents =
      '\uFEFF' +
      '---\n' +
      'enabled: true\n' +
      'socket: /custom/path/agentmonitors.sock\n' +
      'db: /custom/path/agentmonitors.db\n' +
      'reap-after-ms: 300000\n' +
      '---\n' +
      '\n' +
      '> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).\n';
    writeFileSync(localStatePath, bomPrefixedContents, 'utf-8');

    const result = run(['init', '--enable-only'], dir);
    expect(result.exitCode).toBe(0);

    // Byte-identical: bare init must not have rewritten the file at all.
    expect(readFileSync(localStatePath, 'utf-8')).toBe(bomPrefixedContents);
  });

  // Regression (PR #310 review): `ensureGitignore` used to treat ANY
  // `readFileSync` failure as "file absent" and create/overwrite it, which
  // would silently clobber a `.gitignore` that exists but can't be read for
  // some other reason (e.g. `EISDIR` when it's actually a directory, or
  // `EACCES` on an unreadable file). Only `ENOENT` may be treated as absent;
  // any other error must be rethrown so the command fails loudly instead of
  // overwriting something it shouldn't.
  it('fails loudly and does not overwrite when .gitignore is a directory (non-ENOENT read error)', () => {
    const dir = path.join(tempDir, 'bootstrap-gitignore-is-dir');
    mkdirSync(dir, { recursive: true });
    const gitignorePath = path.join(dir, '.gitignore');
    mkdirSync(gitignorePath);

    const result = run(['init', '--enable-only'], dir);

    expect(result.exitCode).not.toBe(0);
    // Nothing overwritten: `.gitignore` is still a directory, not replaced by
    // a regular file.
    expect(statSync(gitignorePath).isDirectory()).toBe(true);
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

  // Issue #297: a schedule monitor's invalid IANA timezone must be rejected at
  // authoring time by `validate`, with the sibling valid monitor still passing.
  it('rejects a schedule monitor with an invalid IANA timezone, alongside a valid sibling', () => {
    const dir = path.join(tempDir, 'validate-bad-timezone');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(path.join(monitorsDir, 'bad-tz'), { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'bad-tz', 'MONITOR.md'),
      `---
name: Bad timezone
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
      'utf-8',
    );
    run(['init', 'good-monitor', '--dir', monitorsDir], dir);

    const result = run(['validate', monitorsDir, '--format', 'json']);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      valid: number;
      invalid: number;
      errors: { filePath: string; error: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(1);
    const badTzError = parsed.errors.find((e) => e.filePath === 'bad-tz');
    expect(badTzError?.error).toContain('Not/AZone');
    expect(badTzError?.error).toContain('valid IANA time zone name');
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

  // Issue #338 item 6: `validate` takes a directory; passing a single
  // MONITOR.md file must redirect to the symmetric command (`monitor test`)
  // instead of a generic error.
  it('redirects to `monitor test` when given a single file instead of a directory', () => {
    const dir = path.join(tempDir, 'validate-on-file');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'file-target', '--dir', monitorsDir], dir);
    const monitorFile = path.join(monitorsDir, 'file-target', 'MONITOR.md');

    const result = run(['validate', monitorFile]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is a file, not a directory');
    expect(result.stderr).toContain('agentmonitors monitor test');
    expect(result.stderr).toContain(monitorFile);

    const jsonResult = run(['validate', monitorFile, '--format', 'json']);
    expect(jsonResult.exitCode).toBe(1);
    const parsed = JSON.parse(jsonResult.stdout) as { error: string };
    expect(parsed.error).toContain('agentmonitors monitor test');
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

  // Issue #388 AC (b)/(c): a command-poll monitor scaffolded WITHOUT --command
  // is left at the untouched `init` default (`git ls-remote origin
  // refs/heads/main`). It still validates and runs, so before this fix it
  // silently passed as if configured for the author's actual intent. It must now
  // emit a soft, non-fatal warning (exit 0, still counted valid) so a
  // wrong-intent ship is caught. Scaffolded via `init` so the template and the
  // validator's sentinel cannot silently drift apart.
  it('warns (soft, non-fatal) when a command-poll scaffold is left at the untouched default (AC b/c)', () => {
    const dir = path.join(tempDir, 'validate-command-poll-untouched');
    mkdirSync(dir, { recursive: true });
    const monitorsDir = path.join(dir, 'monitors');
    const created = run(
      ['init', 'upstream', '--dir', monitorsDir, '--type', 'command-poll'],
      dir,
    );
    expect(created.exitCode).toBe(0);

    // Text: warning surfaces but the monitor stays valid and the exit is 0.
    const text = run(['validate', monitorsDir], dir);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Valid monitors: 1');
    expect(text.stdout).toContain('Warnings: 1');
    expect(text.stdout).toContain('watch.command is still the untouched');

    // JSON: the additive `warnings` array carries the advisory; `valid`/`invalid`
    // are unchanged (the monitor is not marked invalid).
    const json = run(['validate', monitorsDir, '--format', 'json'], dir);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      valid: number;
      invalid: number;
      warnings: { id: string; warning: string }[];
    };
    expect(parsed.valid).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.id).toBe('upstream');
    expect(parsed.warnings[0]?.warning).toContain(
      'git ls-remote origin refs/heads/main',
    );
  });

  // Issue #388: the warning is scoped precisely to the untouched default — a
  // command-poll monitor whose `command:` has been edited to the author's real
  // intent must NOT be flagged (no false positives).
  it('does not warn when the command-poll command has been edited', () => {
    const dir = path.join(tempDir, 'validate-command-poll-edited');
    const monitorDir = path.join(dir, 'monitors', 'edited-cmd');
    mkdirSync(monitorDir, { recursive: true });
    const body = [
      '---',
      'name: Dirty worktree',
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

    const text = run(['validate', path.join(dir, 'monitors')], dir);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Valid monitors: 1');
    expect(text.stdout).not.toContain('Warnings:');

    const json = run(
      ['validate', path.join(dir, 'monitors'), '--format', 'json'],
      dir,
    );
    const parsed = JSON.parse(json.stdout) as {
      warnings: { id: string; warning: string }[];
    };
    expect(parsed.warnings).toEqual([]);
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

  // Issue #420 P4: exit code must be meaningful for `scan && <next-step>`.
  it('exits 0 for a clean scan (valid monitors, no errors/duplicates)', () => {
    const dir = path.join(tempDir, 'scan-clean-exit');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'clean-mon', '--dir', monitorsDir], dir);
    const result = run(['scan', monitorsDir, '--format', 'json']);
    const parsed = JSON.parse(result.stdout) as {
      errors: unknown[];
      duplicateIds: unknown[];
    };
    expect(parsed.errors).toEqual([]);
    expect(parsed.duplicateIds).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 for an empty (but valid) monitors directory', () => {
    const emptyDir = path.join(tempDir, 'scan-empty-exit');
    mkdirSync(emptyDir, { recursive: true });
    const result = run(['scan', emptyDir, '--format', 'json']);
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 when a MONITOR.md fails to parse (errors non-empty)', () => {
    const monitorsDir = path.join(tempDir, 'scan-parse-error', 'broken');
    mkdirSync(monitorsDir, { recursive: true });
    // Invalid YAML frontmatter → scanMonitors records a parse error.
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      ['---', 'watch: {{{', 'not: valid', '---', '# broken', ''].join('\n'),
      'utf-8',
    );
    const result = run([
      'scan',
      path.join(tempDir, 'scan-parse-error'),
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(result.stdout) as { errors: unknown[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  it('exits 1 when two monitors share a duplicate id (duplicateIds non-empty)', () => {
    const root = path.join(tempDir, 'scan-dup', 'monitors');
    // Same leaf folder name in two subtrees → duplicate monitor id (the id is
    // the parent directory name, 001 §4).
    for (const grp of ['grp1', 'grp2']) {
      const dir = path.join(root, grp, 'dupe');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'MONITOR.md'),
        [
          '---',
          'watch:',
          '  type: schedule',
          '  every: 1h',
          'urgency: normal',
          '---',
          '# dup',
          '',
        ].join('\n'),
        'utf-8',
      );
    }
    const result = run(['scan', root, '--format', 'json']);
    const parsed = JSON.parse(result.stdout) as { duplicateIds: unknown[] };
    expect(parsed.duplicateIds.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
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
    expect(fileFingerprint.fieldDescriptions['cwd']).toContain(
      'workspace/config root',
    );
    expect(fileFingerprint.fieldDescriptions['cwd']).toContain(
      'project directory containing .claude',
    );
    expect(fileFingerprint.fieldDescriptions['cwd']).toContain('process cwd');
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
 * Issue #337 (DX study S4 F3): an explicit `--socket` path that exceeds the
 * AF_UNIX `sun_path` length limit was silently replaced with a hashed `/tmp`
 * path — the daemon bound and reported a DIFFERENT socket than the one the
 * caller asked for, with no indication anything had been substituted.
 *
 * This reproduces the study's exact repro shape (`daemon run --socket
 * <over-limit path>`) against the real CLI subprocess.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/337
 */
describe('daemon run — explicit --socket over the AF_UNIX limit (issue #337)', () => {
  it('warns on stderr with the requested path, the limit, and the substituted socket, while stdout keeps reporting the socket it actually bound', async () => {
    const dir = path.join(tempDir, 'socket-over-limit');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsRoot, { recursive: true });

    // A unique-per-run, deeply-nested path guaranteed to exceed the
    // ~100-char AF_UNIX limit, mirroring the study's deep sandbox path.
    const requestedSocketPath = path.join(
      dir,
      `run-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
      'x'.repeat(120),
      'agentmon.sock',
    );
    expect(requestedSocketPath.length).toBeGreaterThan(100);

    const child = spawn(
      'node',
      [
        CLI_PATH,
        'daemon',
        'run',
        monitorsRoot,
        '--workspace',
        dir,
        '--poll-ms',
        '5000',
        '--reap-after-ms',
        '0',
        '--socket',
        requestedSocketPath,
      ],
      {
        cwd: dir,
        env: { ...process.env, AGENTMONITORS_DB: ':memory:' },
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

    try {
      const deadline = Date.now() + 15_000;
      while (
        Date.now() < deadline &&
        !stdout.includes('AgentMon daemon listening')
      ) {
        if (child.exitCode !== null) {
          throw new Error(
            `Daemon exited early with code ${child.exitCode}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          );
        }
        // eslint-disable-next-line no-await-in-loop -- polling loop, not a batch
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stdout).toContain('AgentMon daemon listening');

      // Give the (already-written, synchronous-before-listen) stderr warning
      // a moment to land in our buffer before asserting on it.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const listeningLine = stdout
        .split('\n')
        .find((line) => line.includes('AgentMon daemon listening'));
      expect(listeningLine).toBeDefined();
      const substitutedSocketPath = (listeningLine ?? '')
        .replace('AgentMon daemon listening on ', '')
        .trim();

      // Criterion 2: the startup line (spec 002 §10.2) is unchanged — the
      // daemon still reports whatever it actually bound (the substituted,
      // hash-derived path), never the requested one.
      expect(substitutedSocketPath).not.toBe(requestedSocketPath);
      // The substituted socket lives inside an owner-only per-uid directory,
      // never a predictable /tmp/*.sock a peer could connect to (issue #292).
      expect(substitutedSocketPath).toMatch(
        /^\/tmp\/agentmonitors-\d+\/agentmonitors-[0-9a-f]{16}\.sock$/,
      );

      // Criterion 1 (regression): pre-fix, `resolveSocketPath` had no concept
      // of an explicit caller-typed --socket and never wrote anything to
      // stderr about the substitution — this assertion set fails against that
      // code (stderr was empty).
      expect(stderr).toContain(requestedSocketPath);
      expect(stderr).toContain('100');
      expect(stderr).toContain(substitutedSocketPath);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not warn when --socket is within the limit (no false positives)', async () => {
    const socketPath = path.join(tempDir, 'socket-within-limit.sock');
    const result = runWithEnv(
      ['daemon', 'status', '--socket', socketPath, '--format', 'json'],
      { AGENTMONITORS_DB: ':memory:' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('substitutes silently (no stderr) when the over-limit socket is derived from AGENTMONITORS_SOCKET rather than an explicit --socket flag (criterion 4)', () => {
    const overLimitSocketPath = path.join(
      tempDir,
      `env-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
      'y'.repeat(120),
      'agentmon.sock',
    );
    expect(overLimitSocketPath.length).toBeGreaterThan(100);

    const result = runWithEnv(['daemon', 'status', '--format', 'json'], {
      AGENTMONITORS_DB: ':memory:',
      AGENTMONITORS_SOCKET: overLimitSocketPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { socketPath: string };
    expect(parsed.socketPath).not.toBe(overLimitSocketPath);
    // Owner-only per-uid fallback directory, not a shared /tmp/*.sock (issue #292).
    expect(parsed.socketPath).toMatch(
      /^\/tmp\/agentmonitors-\d+\/agentmonitors-[0-9a-f]{16}\.sock$/,
    );
  });
});

/**
 * Issue #303: `command-poll` timeout must terminate the entire process tree,
 * not just the direct child — and the daemon's own shutdown must never leave
 * a live descendant behind either.
 * `plugins/source-command-poll/src/index.test.ts` proves the per-call fix in
 * isolation (unit level, same `sh -c 'sleep … & wait'` repro shape as the
 * issue); this exercises the same guarantee through a real `daemon run`
 * subprocess and a real `daemon stop`, matching the no-orphan-daemon
 * discipline already used throughout this file.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/303
 */
describe('daemon run: command-poll timeout leaves no descendant after shutdown (issue #303)', () => {
  /**
   * POSIX liveness check by exact PID (`kill(pid, 0)` sends no signal), not
   * process-tree membership — an orphan is reparented away from this test
   * process the moment its true parent dies, so a tree-walk (`pgrep -P`)
   * would miss it even before we get a chance to look.
   */
  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ESRCH: no such process — genuinely dead. Any other error (e.g.
      // EPERM, meaning it exists but we lack permission to signal it) means
      // it is still alive.
      return err.code !== 'ESRCH';
    }
  }

  async function pollUntil(
    predicate: () => boolean,
    deadlineMs: number,
    intervalMs = 100,
  ): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return predicate();
  }

  it('a live daemon kills a backgrounded sh -c descendant on tick timeout, and shutdown leaves it dead', async () => {
    if (process.platform === 'win32') return;

    const dir = path.join(tempDir, 'daemon-303-no-orphan');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsRoot, 'hung-cmd');
    mkdirSync(monitorDir, { recursive: true });
    const pidFile = path.join(dir, 'child.pid');

    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Backgrounds a descendant
watch:
  type: command-poll
  command:
    - sh
    - '-c'
    - "sleep 30 & echo $! > ${pidFile}; wait"
  timeout: 1s
  interval: 5s
urgency: normal
---
When the command output changes, review it.
`,
      'utf-8',
    );

    const socketPath = path.join(dir, 'agentmon.sock');
    const child = spawn(
      'node',
      [
        CLI_PATH,
        'daemon',
        'run',
        monitorsRoot,
        '--workspace',
        dir,
        '--poll-ms',
        '300',
        '--reap-after-ms',
        '0',
        '--socket',
        socketPath,
      ],
      {
        cwd: dir,
        env: { ...process.env, AGENTMONITORS_DB: ':memory:' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      const listenDeadline = Date.now() + 15_000;
      while (
        Date.now() < listenDeadline &&
        !stdout.includes('AgentMon daemon listening')
      ) {
        if (child.exitCode !== null) {
          throw new Error(
            `Daemon exited early with code ${String(child.exitCode)}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stdout).toContain('AgentMon daemon listening');

      // Wait for the pid file the backgrounded `sleep` writes on its way up
      // — proves the monitor's command actually ran under the live daemon.
      const pidFileDeadline = Date.now() + 10_000;
      while (Date.now() < pidFileDeadline && !existsSync(pidFile)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);

      // Give the per-observe timeout (1s) + grace (5s) time to land BEFORE
      // shutdown, so this proves cleanup happens on the tick's own timeout
      // — not merely as an accidental side effect of killing the daemon
      // process itself below.
      const preShutdownDead = await pollUntil(
        () => !isProcessAlive(grandchildPid),
        10_000,
      );
      expect(preShutdownDead).toBe(true);

      // Now stop the daemon the normal way and confirm the descendant is
      // (still) gone once the daemon has fully exited — the no-orphan-daemon
      // discipline extended to command-poll's own children (issue #303).
      await callDaemon('stop', {}, { socketPath });
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
      expect(isProcessAlive(grandchildPid)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
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

  // Issue #297: a schedule monitor with an invalid IANA timezone made
  // Intl.DateTimeFormat throw OUTSIDE the per-monitor observe/ingest try/catches
  // — aborting the whole tick before any other monitor ran. This proves the
  // fix at the `daemon once` surface: the bad monitor is isolated (errored, not
  // a crash) and a sibling schedule monitor with a valid timezone still fires.
  it('isolates an invalid schedule timezone instead of aborting the whole tick, so a sibling monitor still emits', () => {
    const dir = path.join(tempDir, 'once-bad-timezone');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeMonitor(
      monitorsRoot,
      'aaa-bad-timezone',
      `---
name: Bad timezone
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
    );
    writeMonitor(monitorsRoot, 'zzz-fires', emittingMonitorBody);

    const result = run(['daemon', 'once', monitorsRoot, '--workspace', dir]);
    expect(result.exitCode).toBe(0);
    // The valid sibling still fires — the tick was NOT aborted.
    expect(result.stdout).toContain('emitted 1 event(s)');
    expect(result.stdout).toContain('1 errored:');
    expect(result.stdout).toContain('aaa-bad-timezone:');
    expect(result.stdout).toContain('Not/AZone');
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
      const unreadEvents = JSON.parse(unread().stdout) as {
        id: string;
        deliveryState?: string;
      }[];
      expect(unreadEvents).toHaveLength(1);
      // Issue #338 item 1: before any claim, the event's deliveryState is
      // 'unread' -- the never-surfaced case --unread is meant to catch.
      expect(unreadEvents[0]?.deliveryState).toBe('unread');

      // The text format also surfaces deliveryState as a visible column, so a
      // human reading `events list --unread` output can tell a never-surfaced
      // event from a claimed-but-unacknowledged one at a glance.
      const unreadText = runWithEnv(
        [
          'events',
          'list',
          '--session',
          session.id,
          '--unread',
          '--format',
          'text',
        ],
        env,
        dir,
      );
      expect(unreadText.exitCode).toBe(0);
      expect(unreadText.stdout).toContain('unread');

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

      // Issue #338 item 1 (the core of this papercut): claiming does NOT
      // acknowledge -- the event is still surfaced by --unread (it matches
      // "unacknowledged", not "never seen"), but its deliveryState is now
      // 'claimed' so a caller reading --unread output can tell the two apart.
      const afterClaim = unread();
      expect(afterClaim.exitCode).toBe(0);
      const claimedEvents = JSON.parse(afterClaim.stdout) as {
        id: string;
        deliveryState?: string;
      }[];
      expect(claimedEvents).toHaveLength(1);
      expect(claimedEvents[0]?.deliveryState).toBe('claimed');

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

      // An unfiltered query (no --unread) still returns the event, now
      // reporting deliveryState 'acknowledged'.
      const allAfterAck = runWithEnv(
        ['events', 'list', '--session', session.id, '--format', 'json'],
        env,
        dir,
      );
      expect(allAfterAck.exitCode).toBe(0);
      const acknowledgedEvents = JSON.parse(allAfterAck.stdout) as {
        deliveryState?: string;
      }[];
      expect(acknowledgedEvents).toHaveLength(1);
      expect(acknowledgedEvents[0]?.deliveryState).toBe('acknowledged');

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

// Issue #338 item 4: `session open --format id` prints just the bare session
// id, so verification recipes no longer need a hand-rolled node one-liner to
// pull `.id` out of the `--format json` payload.
describe('session open --format id (issue #338 item 4)', () => {
  it('prints only the bare session id, matching the id from --format json', async () => {
    const dir = path.join(tempDir, 'session-open-format-id');
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `agentmon-fmtid-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(monitorsDir, dir, env, socketPath);

    try {
      const idResult = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'sess-format-id',
          '--workspace',
          dir,
          '--format',
          'id',
        ],
        env,
        dir,
      );
      expect(idResult.exitCode).toBe(0);
      // Bare id: no surrounding JSON, no "Opened session:" prefix, no trailing
      // content besides the newline console.log adds.
      const printedId = idResult.stdout.trim();
      expect(printedId).not.toContain('{');
      expect(printedId).not.toContain('Opened session');

      const jsonResult = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'sess-format-id',
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(jsonResult.exitCode).toBe(0);
      const session = JSON.parse(jsonResult.stdout) as { id: string };
      // Same host-session-id resumes the same AgentMon session, so both
      // formats must report the identical id.
      expect(printedId).toBe(session.id);
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

  // Criterion 2 (issue #331): the shared daemon-unreachable message across
  // session/events/hook commands also points at `agentmonitors doctor` for
  // the full picture, alongside the `daemon run` fix-it command.
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
        expect(result.stderr).toContain('agentmonitors doctor');
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

  // Issue #297: `monitor explain` MUST NOT crash for a monitor whose schedule
  // timezone is invalid — it must render the failure as an actionable
  // observation-stage diagnostic instead of a raw thrown RangeError.
  it('explains an invalid schedule timezone as an observation-stage failure instead of crashing', () => {
    const dir = path.join(tempDir, 'explain-bad-timezone');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'bad-tz');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Bad timezone
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
      'utf-8',
    );

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = deadSocketPath('explain-bad-timezone');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const result = runWithEnv(
      [
        'monitor',
        'explain',
        'bad-tz',
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
    expect(result.stdout).toContain('✗ Observation:');
    expect(result.stdout).toContain('Verdict: failure at Observation');
    // The message must name the true cause (scheduling/timezone), not imply a
    // source observation ran and errored — text output only renders `reason`,
    // so the bad value must be inline (PR #433 review, discussion_r3608549689).
    expect(result.stdout).toContain('schedule could not be evaluated');
    expect(result.stdout).toContain('Not/AZone');
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
    // Actionable remediation, not a raw Node connect error. `dir` is never
    // enabled (no `.claude/agentmonitors.local.md`), so
    // `resolveManualDaemonSocketPath` never derived a workspace-scoped
    // socket — the neutral "default socket" wording is the accurate one here
    // (issue #374 review follow-up); see the sibling "IS enabled" test below
    // for the "for this workspace" wording.
    expect(result.stderr).toContain('No daemon running at the default socket');
    expect(result.stderr).not.toContain('No daemon running for this workspace');
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    // Names --socket as the override for a socket mismatch (issue #374).
    expect(result.stderr).toContain('--socket');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
    // The remediation (not the no-daemon banner) is what appears.
    expect(result.stdout).not.toContain(
      'No daemon running — showing persisted state',
    );
  });

  it('explain with the daemon down and NOTHING persisted names the workspace when it IS enabled (case C, issue #374 review follow-up)', () => {
    const dir = path.join(tempDir, 'explain-nodaemon-empty-enabled');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, 'fires');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    const dbPath = path.join(dir, 'empty.db');
    const socketPath = deadSocketPath('explain-empty-enabled');
    // Enable the workspace and let its persisted socket be used FLAGLESS (no
    // --socket flag) — this is the one case where
    // `resolveManualDaemonSocketPath` really did derive a workspace-scoped
    // socket, so "for this workspace" is accurate.
    writeLocalState(dir, {
      enabled: true,
      socket: socketPath,
      db: dbPath,
      reapAfterMs: 5_000,
    });
    const env = { AGENTMONITORS_DB: dbPath };

    const result = runWithCleanEnv(
      [
        'monitor',
        'explain',
        'fires',
        '--dir',
        monitorsRoot,
        '--workspace',
        dir,
      ],
      env,
      dir,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No daemon running for this workspace');
    expect(result.stderr).not.toContain(
      'No daemon running at the default socket',
    );
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    expect(result.stderr).toContain('--socket');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
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
    // `dir` is never enabled (no `.claude/agentmonitors.local.md`), so the
    // neutral "default socket" wording is accurate here (issue #374 review
    // follow-up); see the sibling "IS enabled" test below for the
    // "for this workspace" wording.
    expect(result.stderr).toContain('No daemon running at the default socket');
    expect(result.stderr).not.toContain('No daemon running for this workspace');
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    // Names --socket as the override for a socket mismatch (issue #374).
    expect(result.stderr).toContain('--socket');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
  });

  it('history with the daemon down and NOTHING persisted names the workspace when it IS enabled (issue #374 review follow-up)', () => {
    const dir = path.join(tempDir, 'history-nodaemon-empty-enabled');
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'empty.db');
    const socketPath = deadSocketPath('history-empty-enabled');
    // Enable the workspace and let its persisted socket be used FLAGLESS (no
    // --socket flag) — the one case where `resolveManualDaemonSocketPath`
    // really did derive a workspace-scoped socket.
    writeLocalState(dir, {
      enabled: true,
      socket: socketPath,
      db: dbPath,
      reapAfterMs: 5_000,
    });
    const env = { AGENTMONITORS_DB: dbPath };

    const result = runWithCleanEnv(
      ['monitor', 'history', '--workspace', dir],
      env,
      dir,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No daemon running for this workspace');
    expect(result.stderr).not.toContain(
      'No daemon running at the default socket',
    );
    expect(result.stderr).toContain('agentmonitors daemon run');
    expect(result.stderr).toContain('monitor test');
    expect(result.stderr).toContain('--socket');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('.sock');
  });

  // Issue #374 review follow-up: every fallback test above sets
  // AGENTMONITORS_DB, which resolveWorkspaceDbPath short-circuits on before
  // ever consulting workspace state (workspace-db-path.ts) — so none of them
  // would fail if the workspace-resolved dbPath argument threaded into
  // explainMonitorInProcess/listObservationHistoryInProcess were reverted to
  // the bare global default. This test enables the workspace WITHOUT an
  // explicit `db:`, persists real state into the DERIVED per-workspace db via
  // `daemon once`, kills any daemon, and reads it back with NO
  // AGENTMONITORS_DB anywhere — which only succeeds if the fallback resolves
  // dbPath from the workspace.
  it('history and explain fallback reads the WORKSPACE-resolved db (not the bare global default) with no AGENTMONITORS_DB set', () => {
    const dir = path.join(tempDir, 'fallback-workspace-db-threading');
    const monitorId = 'fires';
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorsDir = path.join(monitorsRoot, monitorId);
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      FIRING_MONITOR,
      'utf-8',
    );

    // Isolated fake HOME + pinned XDG_DATA_HOME (workspacePaths() prefers it
    // over HOME) so the derived per-workspace db lands under a directory this
    // test controls and cleans up, never the developer's real data dir.
    const fakeHome = mkdtempSync(
      path.join(tmpdir(), 'agentmon-374-fallback-home-'),
    );
    const xdgDataHome = path.join(fakeHome, '.local', 'share');
    // Enabled, but deliberately NO `db:` value — resolveWorkspaceDbPath must
    // fall to the DERIVED per-workspace db (workspacePaths(dir).db), the exact
    // path this test proves the fallback actually reads.
    const socketPath = deadSocketPath('fallback-workspace-db');
    writeLocalState(dir, {
      enabled: true,
      socket: socketPath,
      reapAfterMs: 5_000,
    });
    // Deliberately NO AGENTMONITORS_DB anywhere below — resolveWorkspaceDbPath
    // short-circuits on it before ever consulting workspace state, which is
    // exactly what let the bug this test guards against hide behind every
    // other fallback test.
    const env = { HOME: fakeHome, XDG_DATA_HOME: xdgDataHome };

    try {
      // Persist real state into the workspace-derived db via `daemon once`,
      // which resolves its own dbPath the identical way (daemon.ts).
      const once = runWithCleanEnv(
        ['daemon', 'once', monitorsRoot, '--workspace', dir],
        env,
        dir,
      );
      expect(once.exitCode).toBe(0);
      expect(once.stdout).toContain('emitted 1 event(s)');

      // `socketPath` above was never bound to anything — no live daemon.
      const historyResult = runWithCleanEnv(
        [
          'monitor',
          'history',
          monitorId,
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(historyResult.exitCode).toBe(0);
      expect(historyResult.stderr).not.toContain('No daemon running');
      const rows = JSON.parse(historyResult.stdout) as { monitorId: string }[];
      expect(rows.some((r) => r.monitorId === monitorId)).toBe(true);

      const explainResult = runWithCleanEnv(
        [
          'monitor',
          'explain',
          monitorId,
          '--dir',
          monitorsRoot,
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(explainResult.exitCode).toBe(0);
      const report = JSON.parse(explainResult.stdout) as {
        notice?: string;
        events: unknown[];
      };
      // The persisted-state fallback banner, not the "nothing persisted"
      // remediation — proves it found the real event `daemon once` recorded.
      expect(report.notice).toContain('No daemon running');
      expect(report.events.length).toBeGreaterThan(0);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// Issue #267: `agentmonitors doctor` — one unified health surface. Each negative
// test drives one failure mode and asserts the check name, the remediation text,
// and the exit code (acceptance criterion 3). Tests use the existing CLI harness
// with the no-orphan-daemon discipline (every started daemon is stopped in a
// finally). doctor reads persisted state in-process, so most cases need no daemon.
// @see docs/specs/005-cli-reference.md §"doctor"
describe('doctor (issue #267)', () => {
  const VALID_FILE_MONITOR = `---
name: Watch source
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
urgency: normal
---
When source files change, review them.
`;

  // Issue #338 item 5: the doctor banner used to read "AgentMon doctor" —
  // inconsistent with the SAME command's own remediation text, which already
  // names the real invocation (`agentmonitors init --enable-only`). The
  // binary is `agentmonitors`; "AgentMon" is a prose-only product name, never
  // a command reference.
  it('text output banner names the real invocation, not the "AgentMon" prose name', () => {
    const dir = path.join(tempDir, 'doctor-banner');
    mkdirSync(dir, { recursive: true });

    const result = runWithEnv(
      ['doctor', '--workspace', dir],
      {
        AGENTMONITORS_DB: ':memory:',
        AGENTMONITORS_SOCKET: path.join(
          '/tmp',
          `agentmon-doctor-banner-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
        ),
      },
      dir,
    );

    expect(result.stdout.split('\n')[0]).toBe('agentmonitors doctor');
    expect(result.stdout).not.toContain('AgentMon doctor');
  });

  // cron '* * * * *' is due every tick, so a single `daemon once` records an
  // observation and materializes an event — giving doctor real persisted state.
  const FIRING_SCHEDULE = `---
name: Heartbeat
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`;

  // cron '0 0 1 1 *' (00:00 on Jan 1) is effectively never due, so the daemon
  // ticks but never observes it — it stays "never observed" even with a live
  // daemon and a lead session, isolating the never-observed failure mode.
  const NEVER_DUE_SCHEDULE = `---
name: New year
watch:
  type: schedule
  cron: '0 0 1 1 *'
  timezone: UTC
urgency: normal
---
This monitor is essentially never due.
`;

  const INVALID_MONITOR = `---
name: Mystery
watch:
  type: not-a-real-source
  foo: bar
urgency: normal
---
Handle it.
`;

  function doctorSocket(label: string): string {
    return path.join(
      '/tmp',
      `agentmon-doctor-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
  }

  function writeDoctorMonitor(root: string, id: string, body: string): void {
    const monitorDir = path.join(root, id);
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), body, 'utf-8');
  }

  // --- Negative: project not enabled ----------------------------------------
  it('fails project-enabled with the enable-step remediation when the project is not enabled', () => {
    const dir = path.join(tempDir, 'doctor-not-enabled');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'watch-src', VALID_FILE_MONITOR);
    // No .claude/agentmonitors.local.md → the project is not enabled.

    const result = runWithEnv(
      ['doctor', '--workspace', dir],
      {
        AGENTMONITORS_DB: ':memory:',
        AGENTMONITORS_SOCKET: doctorSocket('not-enabled'),
      },
      dir,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('project-enabled');
    // Leads with the one-shot bootstrap (#268) and names the SAME manual
    // enable step as the session-start disabled advisory (#269) so all
    // opt-in surfaces agree.
    expect(result.stdout).toContain('agentmonitors init --enable-only');
    expect(result.stdout).toContain('`.claude/agentmonitors.local.md`');
    expect(result.stdout).toContain('`enabled: true`');
  });

  // --- Negative: an invalid monitor -----------------------------------------
  it('fails monitors-valid and names `validate` as the remediation for an invalid monitor', () => {
    const dir = path.join(tempDir, 'doctor-invalid-monitor');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'mystery', INVALID_MONITOR);
    writeLocalState(dir, { enabled: true });

    const result = runWithEnv(
      ['doctor', '--workspace', dir],
      {
        AGENTMONITORS_DB: ':memory:',
        AGENTMONITORS_SOCKET: doctorSocket('invalid'),
      },
      dir,
    );

    expect(result.exitCode).toBe(1);
    // project-enabled passes; monitors-valid is the failing check we assert.
    expect(result.stdout).toContain('✓ project-enabled');
    expect(result.stdout).toContain('monitors-valid');
    expect(result.stdout).toMatch(/monitors-valid.*failed validation/);
    expect(result.stdout).toContain('agentmonitors validate');
  });

  // --- Negative: daemon down (still works from persisted state) --------------
  it('marks daemon-reachable idle (exit 0) but still shows the per-monitor rollup from persisted state when the daemon is down', () => {
    const dir = path.join(tempDir, 'doctor-daemon-down');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const deadSocket = doctorSocket('daemon-down');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: deadSocket };

    // Materialize an observation + event into the file DB in-process (no daemon).
    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);
    expect(once.stdout).toContain('emitted 1 event(s)');

    const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

    // Issue #373 criterion 2: daemon-reachable and lead-session are the ONLY
    // failing checks here, and both are expected-when-idle — doctor must exit
    // 0, not treat "no agent session currently open" as a broken setup.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('◇ daemon-reachable');
    expect(result.stdout).not.toContain('✗ daemon-reachable');
    // States the daemon is down and that the data came from persisted state.
    expect(result.stdout).toContain('showing persisted state');
    expect(result.stdout).toContain('agentmonitors daemon run');
    // Criterion 2 (issues #331, #373): the idle line still names the
    // expected-state context — no live agent session open is a normal reason
    // for this, not evidence of a broken setup.
    expect(result.stdout).toContain(
      'expected when no agent session is currently open',
    );
    // The rollup is still shown from the last tick — last-observed is real, not
    // "never", proving diagnosis survives a down daemon (like `monitor explain`).
    expect(result.stdout).toContain('monitor:heartbeat');
    expect(result.stdout).toContain('source=schedule');
    expect(result.stdout).not.toContain('last-observed=never');
    expect(result.stdout).toMatch(
      /Summary: \d+ passed, 0 failed, 0 skipped, 2 idle\./,
    );
  });

  // --- Negative: version-skew daemon (issue #382) ---------------------------
  // A still-running OLDER daemon build predates `doctor.report` (or any method
  // added after it shipped): its own request schema rejects the request, so it
  // can only ever answer with the legacy unparseable-request sentinel
  // (`{ id: 'invalid', error: 'Invalid JSON request.' }`). Pre-fix, `doctor`
  // rethrew that string as a fatal crash instead of falling back to reading
  // persisted state — this proves the fallback now works and the raw sentinel
  // text never reaches the user.
  it('falls back to persisted state without crashing when the daemon rejects doctor.report as unsupported (version skew)', async () => {
    const dir = path.join(tempDir, 'doctor-version-skew');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('version-skew');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    // Materialize an observation + event into the file DB in-process, exactly
    // like the "daemon down" test above — this is the persisted state the
    // fallback must read once it gives up on the (fake, old) live daemon.
    const once = runWithEnv(
      ['daemon', 'once', monitorsRoot, '--workspace', dir],
      env,
      dir,
    );
    expect(once.exitCode).toBe(0);

    const legacyDaemon = startLegacyUnsupportedDaemon(socketPath);
    try {
      const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

      // The literal string a pre-fix `doctor` crashed with must never reach
      // the user — it must be caught and classified, not rethrown verbatim.
      expect(result.stdout).not.toContain('Invalid JSON request.');
      expect(result.stderr).not.toContain('Invalid JSON request.');
      expect(result.exitCode).toBe(0);
      // No lead session was opened, so daemon-reachable and lead-session are
      // both `idle`, same as the "daemon down" scenario above — an old,
      // incompatible daemon is treated the same as an unreachable one.
      expect(result.stdout).toContain('◇ daemon-reachable');
      expect(result.stdout).not.toContain('✗ daemon-reachable');
      expect(result.stdout).toContain('showing persisted state');
      // The rollup is still shown from the last tick, proving the fallback
      // actually read real persisted state rather than failing silently.
      expect(result.stdout).toContain('monitor:heartbeat');
      expect(result.stdout).not.toContain('last-observed=never');
    } finally {
      await legacyDaemon.close();
    }
  });

  // --- Negative: daemon down while a lead session is registered (issue #382) -
  // A registered lead session means an agent session IS open, so "no daemon
  // reachable" here is NOT the expected idle state (unlike the plain
  // "daemon down" test above, which has no lead session) — it means the
  // daemon most likely crashed or was killed mid-session. This must be a real
  // failure (non-zero exit), not silently reported as idle.
  it('fails daemon-reachable (non-zero exit) when the daemon is down but a lead session is still registered for this workspace', async () => {
    const dir = path.join(tempDir, 'doctor-daemon-down-with-session');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('down-with-session');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    runWithEnv(['daemon', 'once', monitorsRoot, '--workspace', dir], env, dir);

    // Register a lead session while a real daemon is up, then kill the daemon
    // — leaving a lead session registered with no daemon actually serving it,
    // simulating a mid-session crash.
    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    const open = runWithEnv(
      [
        'session',
        'open',
        '--host-session-id',
        'doctor-down-with-session',
        '--role',
        'lead',
        '--workspace',
        dir,
        '--format',
        'json',
      ],
      env,
      dir,
    );
    expect(open.exitCode).toBe(0);
    daemon.stop();
    await daemon.waitForExit();

    const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('✗ daemon-reachable');
    expect(result.stdout).not.toContain('◇ daemon-reachable');
    // Names the real problem — a lead session IS registered — rather than the
    // "expected when no agent session is currently open" wording, which would
    // be false here.
    expect(result.stdout).toContain('lead session is registered');
    expect(result.stdout).not.toContain(
      'expected when no agent session is currently open',
    );
    expect(result.stdout).toContain('agentmonitors daemon run');
    // lead-session itself still passes (a session IS registered) — isolating
    // daemon-reachable as the sole failure.
    expect(result.stdout).toContain('✓ lead-session');
  });

  // --- Negative: no lead session (daemon reachable to isolate the failure) ---
  it('marks lead-session idle (exit 0) with an actionable remediation when no lead session is registered', async () => {
    const dir = path.join(tempDir, 'doctor-no-lead-session');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('no-lead-session');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    // Observe once so the monitor is not "never observed" — isolating lead-session
    // as the sole failure.
    runWithEnv(['daemon', 'once', monitorsRoot, '--workspace', dir], env, dir);

    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    try {
      const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

      // Issue #373 criterion 2: lead-session is the ONLY failing check here
      // (the daemon IS live), and it is expected-when-idle — exit 0.
      expect(result.exitCode).toBe(0);
      // daemon-reachable passes (the daemon is live), isolating the failure.
      expect(result.stdout).toContain('✓ daemon-reachable');
      expect(result.stdout).toContain('◇ lead-session');
      expect(result.stdout).not.toContain('✗ lead-session');
      expect(result.stdout).toMatch(/lead-session.*No lead session/);
      // Issue #387: the remediation points at the runnable `session start`
      // primitive, never the flag-heavy `session open` that fails without
      // `--host-session-id`.
      expect(result.stdout).toContain('agentmonitors session start');
      expect(result.stdout).not.toMatch(/session open --role lead/);
      // Criterion 2 (issues #331, #373): the idle line still names the
      // expected-state context — no live agent session open is a normal
      // reason for this, not evidence of a broken setup.
      expect(result.stdout).toContain(
        'expected when no agent session is currently open',
      );
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Issue #387: doctor's lead-session remediation must be runnable --------
  // The pre-fix hint recommended `session open --role lead --workspace <path>`,
  // which fails immediately with `error: required option '--host-session-id'
  // not specified` — a reproducible dead end reached by following doctor's own
  // advice. The fix points the hint at `session start` (the flagless lazy-boot
  // path that matches real usage) and documents the manual `manual-cli-session`
  // stdin-payload invocation. This test asserts against the real command
  // surface: (2) the exact pre-fix shape still errors, and (3) the command
  // doctor now recommends actually runs and registers a lead session.
  it('recommends a runnable lead-session command (session start), not one that fails with a missing required option', async () => {
    const dir = path.join(tempDir, 'doctor-remediation-runnable');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('remediation-runnable');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };
    // Enable with the resolved socket/db so `session start`'s lazy boot binds the
    // SAME socket doctor searches (the #335 self-diagnosing invariant).
    writeLocalState(dir, { enabled: true, socket: socketPath, db: dbPath });

    try {
      // 1. doctor's lead-session remediation recommends the runnable primitive.
      const before = runWithEnv(['doctor', '--workspace', dir], env, dir);
      expect(before.stdout).toContain('agentmonitors session start');
      expect(before.stdout).not.toMatch(/session open --role lead/);

      // 2. Regression guard: the PRE-FIX recommended shape genuinely fails with
      // the exact missing-required-option error #387 reports — proving the old
      // hint was a dead end and that the check below is meaningful.
      const preFix = runWithEnv(
        ['session', 'open', '--role', 'lead', '--workspace', dir],
        env,
        dir,
      );
      expect(preFix.exitCode).not.toBe(0);
      expect(preFix.stderr).toContain(
        "required option '--host-session-id <id>' not specified",
      );

      // 3. The command doctor now recommends, run as printed (with the documented
      // `manual-cli-session` placeholder payload on stdin), is actually runnable:
      // it does NOT fail with a missing-required-option error and exits 0.
      const start = runWithStdinCapture(
        ['session', 'start'],
        env,
        JSON.stringify({ session_id: 'manual-cli-session', cwd: dir }),
        dir,
      );
      expect(start.stderr).not.toContain('required option');
      expect(start.exitCode).toBe(0);

      // 4. Proof it did the real thing: doctor's lead-session check now passes.
      const after = runWithEnv(['doctor', '--workspace', dir], env, dir);
      expect(after.stdout).toContain('✓ lead-session');
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath });
      } catch {
        // daemon never booted or already stopped — ignore.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // --- Regression: printed remediation must be runnable even when the -------
  // --- workspace path contains a single quote --------------------------------
  // The pre-fix hint built its `echo '<payload>' | agentmonitors session start`
  // command by interpolating `JSON.stringify(...)` directly between hard-coded
  // shell single-quotes. `JSON.stringify` never escapes an embedded `'` (it's
  // not special in JSON), so a workspace path containing one — e.g. a real
  // macOS "Mike's Mac" home directory — closes the shell's quote early,
  // producing a broken command a user could copy-paste straight into a syntax
  // error. This test extracts the command doctor ACTUALLY PRINTS (not a
  // hand-rebuilt copy of the fix) and executes it verbatim through `sh -c`,
  // proving it is real, runnable shell.
  it('prints a runnable remediation command even when the workspace path contains a single quote', async () => {
    const dir = path.join(tempDir, "doctor-remediation-quote's-workspace");
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('remediation-quote');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };
    writeLocalState(dir, { enabled: true, socket: socketPath, db: dbPath });

    const shimDir = makeAgentmonitorsShimDir();
    try {
      const before = runWithEnv(['doctor', '--workspace', dir], env, dir);

      // Extract the printed `echo '...' | agentmonitors session start` span
      // verbatim from doctor's remediation text.
      const match = /`(echo .*?session start)`/.exec(before.stdout);
      expect(match).not.toBeNull();
      const printedCommand = match?.[1] ?? '';
      // Sanity: doctor really is operating on this apostrophe-containing
      // workspace — this occurrence is plain unescaped text (outside the
      // shell-quoted echo span), so `dir` appears verbatim here.
      expect(before.stdout).toContain(dir);
      // The printed command must escape the embedded `'` via the POSIX
      // close-escape-reopen idiom (`'\''`) rather than surfacing it raw and
      // breaking the shell's quoting.
      expect(printedCommand).toContain(`'\\''`);

      const shellEnv = {
        ...env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      };
      const result = runPluginHookCommand(printedCommand, shellEnv, '', dir);

      // Pre-fix, the extra unescaped `'` breaks the shell's quoting, which
      // bash/sh reports as an unterminated-quote parse error rather than
      // running `session start` at all.
      expect(result.stderr).not.toMatch(
        /unexpected EOF|unterminated quoted string/,
      );
      expect(result.exitCode).toBe(0);

      // Proof it did the real thing: doctor's lead-session check now passes.
      const after = runWithEnv(['doctor', '--workspace', dir], env, dir);
      expect(after.stdout).toContain('✓ lead-session');
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath });
      } catch {
        // daemon never booted or already stopped — ignore.
      }
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // --- Negative: a never-observed monitor (daemon + session present) --------
  it('fails the per-monitor check with a never-observed remediation for a monitor that has never been observed', async () => {
    const dir = path.join(tempDir, 'doctor-never-observed');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'newyear', NEVER_DUE_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('never-observed');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    try {
      // Register a lead session so lead-session passes and the never-observed
      // per-monitor check is the isolated failure.
      const open = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'doctor-never-observed',
          '--role',
          'lead',
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(open.exitCode).toBe(0);

      const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('✓ lead-session');
      // The never-due schedule monitor was never observed by the daemon.
      expect(result.stdout).toContain('monitor:newyear');
      expect(result.stdout).toMatch(/monitor:newyear.*never observed/);
      // Remediation points at the observation tools.
      expect(result.stdout).toContain('monitor history');
      expect(result.stdout).toContain('monitor test');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Positive: fully healthy workspace, all checks pass, exit 0 -----------
  it('reports all checks passing (exit 0) for a fully healthy workspace', async () => {
    const dir = path.join(tempDir, 'doctor-healthy');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('healthy');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    // Observe once so the monitor has real observation history + a materialized
    // event before the daemon (a not-yet-due schedule won't re-fire within 60s).
    runWithEnv(['daemon', 'once', monitorsRoot, '--workspace', dir], env, dir);

    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    try {
      const open = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'doctor-healthy',
          '--role',
          'lead',
          '--workspace',
          dir,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(open.exitCode).toBe(0);

      const result = runWithEnv(['doctor', '--workspace', dir], env, dir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ project-enabled');
      expect(result.stdout).toContain('✓ monitors-directory');
      expect(result.stdout).toContain('✓ monitors-valid');
      expect(result.stdout).toContain('✓ daemon-reachable');
      expect(result.stdout).toContain('✓ lead-session');
      expect(result.stdout).toContain('✓ monitor:heartbeat');
      expect(result.stdout).toContain('source=schedule');
      expect(result.stdout).not.toContain('never observed');
      expect(result.stdout).toMatch(/Summary: \d+ passed, 0 failed/);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  // --- Criterion 4: stable machine-readable --json shape ---------------------
  it('emits a stable --json shape documented in spec 005', () => {
    const dir = path.join(tempDir, 'doctor-json-shape');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    writeDoctorMonitor(monitorsRoot, 'heartbeat', FIRING_SCHEDULE);
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const deadSocket = doctorSocket('json-shape');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: deadSocket };

    runWithEnv(['daemon', 'once', monitorsRoot, '--workspace', dir], env, dir);

    const result = runWithEnv(
      ['doctor', '--workspace', dir, '--format', 'json'],
      env,
      dir,
    );
    // Issue #373 criterion 2: daemon-reachable and lead-session are the ONLY
    // checks that don't pass here, and both are idle (expected-when-idle) —
    // doctor exits 0, but the JSON must still be clean and stable.
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      generatedAt: string;
      workspace: string;
      monitorsDir: string;
      daemon: { running: boolean; socketPath: string };
      leadSession: boolean;
      checks: {
        name: string;
        status: string;
        detail: string;
        remediation: string | null;
      }[];
      monitors: {
        id: string;
        sourceType: string;
        urgency: string;
        valid: boolean;
        lastObservedAt: string | null;
        neverObserved: boolean;
        nextDueAt: string | null;
        cadence: string;
        lastEventAt: string | null;
        delivery: { unread: number; claimed: number; acknowledged: number };
      }[];
      summary: {
        passed: number;
        failed: number;
        skipped: number;
        idle: number;
      };
    };

    expect(report.ok).toBe(true);
    expect(report.daemon.running).toBe(false);
    expect(report.daemon.socketPath).toBe(deadSocket);
    expect(report.leadSession).toBe(false);
    // Every documented check name is present, in order.
    expect(report.checks.map((check) => check.name)).toEqual([
      'project-enabled',
      'monitors-directory',
      'monitors-valid',
      'daemon-reachable',
      'lead-session',
      'monitor:heartbeat',
    ]);
    // The daemon-reachable check is idle (not fail — issue #373) and still
    // carries a non-null remediation.
    const daemonCheck = report.checks.find(
      (check) => check.name === 'daemon-reachable',
    );
    expect(daemonCheck?.status).toBe('idle');
    expect(daemonCheck?.remediation).toContain('agentmonitors daemon run');
    expect(report.summary.idle).toBe(2);
    expect(report.summary.failed).toBe(0);

    // The per-monitor rollup shape is complete and read from persisted state.
    const monitor = report.monitors[0];
    expect(monitor?.id).toBe('heartbeat');
    expect(monitor?.sourceType).toBe('schedule');
    expect(monitor?.urgency).toBe('normal');
    expect(monitor?.valid).toBe(true);
    expect(monitor?.neverObserved).toBe(false);
    expect(monitor?.lastObservedAt).not.toBeNull();
    expect(monitor?.cadence).toBe("cron '* * * * *'");
    expect(monitor?.delivery).toEqual({
      unread: 0,
      claimed: 0,
      acknowledged: 0,
    });
    expect(report.summary.passed + report.summary.failed).toBeGreaterThan(0);
  });

  // --- Issue #373 criterion 1/3: rollup matches ground truth against a LIVE
  // daemon after a real delivery (not just the persisted-state fallback) -----
  //
  // Root cause: `doctor` used to build its report by opening a FRESH SQLite
  // connection in-process (`doctorReportInProcess`), always — even when a
  // daemon was reachable. A separate reader connection opened against the
  // same on-disk file as a live writer's connection can observe that writer's
  // commits with a lag (WAL visibility across processes is not the same
  // guarantee as same-connection reads), so the rollup would freeze at
  // whatever state existed when the reader connection was first opened, while
  // `events list`/`monitor history` — served straight from the live daemon's
  // OWN connection — already showed the current, real state. The fix routes
  // the report through the live daemon (`doctor.report` over the socket) when
  // one is reachable, falling back to the in-process read only when it is not.
  it('rollup last-observed/last-event/delivery counts equal `events list`/`monitor history` after a real delivery against a live daemon', async () => {
    const dir = path.join(tempDir, 'doctor-live-rollup-matches-ground-truth');
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const watchedFile = path.join(dir, 'watched.txt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(watchedFile, 'hello', 'utf-8');
    writeDoctorMonitor(
      monitorsRoot,
      'watch-file',
      `---
name: Watch file
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '5s'
urgency: normal
---
When the file changes, review it.
`,
    );
    writeLocalState(dir, { enabled: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = doctorSocket('live-rollup');
    const env = { AGENTMONITORS_DB: dbPath, AGENTMONITORS_SOCKET: socketPath };

    const daemon = await startDaemon(monitorsRoot, dir, env, socketPath);
    try {
      const sessionOpen = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'doctor-live-rollup',
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

      const waitForHistoryCount = (
        n: number,
      ): { id: string; createdAt: string }[] => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = runWithEnv(
            [
              'monitor',
              'history',
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
          if (result.exitCode === 0) {
            const rows = JSON.parse(result.stdout) as {
              id: string;
              createdAt: string;
            }[];
            if (rows.length >= n) return rows;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        throw new Error(
          `Timed out waiting for >= ${String(n)} monitor history row(s).`,
        );
      };

      // Baseline observation: the file already exists when the daemon starts.
      waitForHistoryCount(1);

      // Fire a REAL second change so a NEW event materializes on the live
      // daemon's own connection AFTER doctor's report source already had an
      // established baseline — the exact sequence issue #373 reported. Wait
      // past the monitor's own 5s interval (not just a short beat) so the
      // change is picked up on its own due tick rather than being coalesced
      // into the baseline, and so the trailing comparison below has a wide
      // window before the source is due again and could add a further
      // no-change re-observation (which would legitimately advance
      // `lastObservedAt` past what `history`'s newest EVENT-producing row
      // shows — a real, unrelated effect this test must not trip over).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5200);
      writeFileSync(watchedFile, 'hello world', 'utf-8');
      waitForHistoryCount(2);

      // Poll `events list` too: session projection is a separate write from
      // the observation-history row `waitForHistoryCount` confirmed, and a
      // session opened concurrently with the daemon's very first (baseline)
      // tick can race it — only events materialized AFTER the session existed
      // get a projection. At least the SECOND (real, post-session) event must
      // show up; that is the one this test's regression is about.
      const waitForEventsCount = (
        n: number,
      ): { id: string; createdAt: string }[] => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = runWithEnv(
            [
              'events',
              'list',
              '--session',
              session.id,
              '--socket',
              socketPath,
              '--format',
              'json',
            ],
            env,
            dir,
          );
          if (result.exitCode === 0) {
            const rows = JSON.parse(result.stdout) as {
              id: string;
              createdAt: string;
            }[];
            if (rows.length >= n) return rows;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        throw new Error(
          `Timed out waiting for >= ${String(n)} projected event(s).`,
        );
      };
      const events = waitForEventsCount(1);

      // Fetch `history` fresh and immediately adjacent to the `doctor` call
      // (rather than reusing the earlier `waitForHistoryCount(2)` snapshot):
      // the monitor's 5s interval means no further re-observation is due for
      // several seconds yet, so this pair of back-to-back reads is a stable,
      // tight comparison of the SAME ground truth doctor's rollup must match.
      const freshHistoryResult = runWithEnv(
        [
          'monitor',
          'history',
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
      expect(freshHistoryResult.exitCode).toBe(0);
      const history = JSON.parse(freshHistoryResult.stdout) as {
        id: string;
        createdAt: string;
      }[];

      const doctorResult = runWithEnv(
        ['doctor', '--workspace', dir, '--format', 'json'],
        env,
        dir,
      );
      expect(doctorResult.exitCode).toBe(0);
      const report = JSON.parse(doctorResult.stdout) as {
        daemon: { running: boolean };
        monitors: {
          id: string;
          lastObservedAt: string | null;
          lastEventAt: string | null;
          delivery: { unread: number; claimed: number; acknowledged: number };
        }[];
      };
      // The report was actually served by the live daemon, not the
      // persisted-state fallback.
      expect(report.daemon.running).toBe(true);
      const monitor = report.monitors.find((m) => m.id === 'watch-file');

      const newestHistoryCreatedAt = [...history]
        .map((row) => row.createdAt)
        .sort()
        .at(-1);
      const newestEventCreatedAt = [...events]
        .map((event) => event.createdAt)
        .sort()
        .at(-1);

      expect(monitor?.lastObservedAt).toBe(newestHistoryCreatedAt);
      expect(monitor?.lastEventAt).toBe(newestEventCreatedAt);
      expect(monitor?.delivery.unread).toBe(events.length);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});

// Regression for issue #335 (DX study S3 F5): a daemon started *directly* via
// `agentmonitors daemon run` — no `--socket`, no `AGENTMONITORS_DB`/
// `AGENTMONITORS_SOCKET`, exactly as the Getting Started guide instructs and
// exactly what the study did — used to bind to the bare global default
// db/socket, while `agentmonitors doctor` (an enabled workspace) independently
// derived a per-workspace-HASHED db path: a completely different SQLite file.
// `session open`/`session list`/`daemon status` all correctly showed the
// active lead session (they talk straight to the live daemon or its actual
// socket), but `doctor` read an empty database and reported no lead session —
// three commands disagreeing about the exact same durable state.
//
// This test drives the real sequence end-to-end as a user would hit it: an
// isolated fake HOME (so the "no explicit overrides" default-resolution path
// is exercised exactly like a real workstation, without touching this
// machine's actual ~/.local/share/agentmonitors) with NO AGENTMONITORS_DB/
// AGENTMONITORS_SOCKET set anywhere in the sequence.
describe('daemon run/once workspace-scoped defaulting (issue #335)', () => {
  function waitForDaemonListening(
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ child: ReturnType<typeof spawn>; socketPath: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_PATH, ...args], {
        cwd,
        env: cleanEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(
            `Timed out waiting for daemon startup.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
      }, 15_000);
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        const match = /AgentMon daemon listening on (\S+)/.exec(stdout);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolve({ child, socketPath: match[1] });
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(
            new Error(
              `Daemon exited early with code ${String(code)}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
            ),
          );
        }
      });
    });
  }

  it('doctor sees the lead session registered by a directly-invoked `daemon run` with no --socket/--db overrides (DX study S3 F5)', async () => {
    const dir = path.join(tempDir, 'issue-335-unified-defaults');
    const monitorsRoot = path.join(dir, '.claude', 'monitors', 'heartbeat');
    mkdirSync(monitorsRoot, { recursive: true });
    writeFileSync(
      path.join(monitorsRoot, 'MONITOR.md'),
      `---
name: Heartbeat
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`,
      'utf-8',
    );

    const fakeHome = mkdtempSync(path.join(tmpdir(), 'agentmon-335-home-'));
    // Deliberately NO AGENTMONITORS_DB / AGENTMONITORS_SOCKET anywhere below —
    // that is the exact condition that reproduces the study's finding. Pinning
    // XDG_DATA_HOME under fakeHome (rather than leaving it to whatever the
    // ambient shell has set, which `workspacePaths()` prefers over HOME) keeps
    // every derived path — and this cleanup — confined to fakeHome regardless
    // of the developer's real environment.
    const xdgDataHome = path.join(fakeHome, '.local', 'share');
    const env = { HOME: fakeHome, XDG_DATA_HOME: xdgDataHome };

    let daemonChild: ReturnType<typeof spawn> | undefined;
    try {
      const initResult = runWithCleanEnv(['init', '--enable-only'], env, dir);
      expect(initResult.exitCode).toBe(0);

      const { child, socketPath } = await waitForDaemonListening(
        ['daemon', 'run', path.join(dir, '.claude', 'monitors')],
        env,
        dir,
      );
      daemonChild = child;
      // The derived per-workspace socket, not the bare global default — proves
      // `daemon run` actually adopted the per-workspace convention rather than
      // merely happening to still work.
      expect(socketPath).not.toBe(
        path.join(xdgDataHome, 'agentmonitors', 'agentmonitors.sock'),
      );

      const open = runWithCleanEnv(
        [
          'session',
          'open',
          '--role',
          'lead',
          '--host-session-id',
          'issue-335-study-session',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(open.exitCode).toBe(0);
      const session = JSON.parse(open.stdout) as {
        status: string;
        hostSessionId: string;
      };
      expect(session.status).toBe('active');

      const list = runWithCleanEnv(
        ['session', 'list', '--format', 'json'],
        env,
        dir,
      );
      expect(list.exitCode).toBe(0);
      const sessions = JSON.parse(list.stdout) as {
        status: string;
        hostSessionId: string;
      }[];
      expect(
        sessions.some(
          (s) =>
            s.hostSessionId === 'issue-335-study-session' &&
            s.status === 'active',
        ),
      ).toBe(true);

      const status = runWithCleanEnv(
        ['daemon', 'status', '--format', 'json'],
        env,
        dir,
      );
      expect(status.exitCode).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as {
        running: boolean;
        activeSessions: number;
      };
      expect(statusPayload.running).toBe(true);
      expect(statusPayload.activeSessions).toBe(1);

      // The actual regression: pre-fix, this reported "No lead session is
      // registered for this workspace" despite the three commands above all
      // agreeing the session is active.
      const doctorResult = runWithCleanEnv(['doctor'], env, dir);
      expect(doctorResult.stdout).toContain('✓ lead-session');
      expect(doctorResult.stdout).not.toContain(
        'No lead session is registered',
      );
      expect(doctorResult.exitCode).toBe(0);
    } finally {
      daemonChild?.kill('SIGTERM');
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);

  // Issue #374: `monitor history` and `monitor explain` previously resolved
  // their socket via the bare global default instead of
  // `resolveManualDaemonSocketPath()`, so a daemon booted for this workspace
  // (exactly as above) was invisible to them without an explicit --socket —
  // even though `doctor`/`daemon status`/`session open` could already see it
  // flagless. This proves both commands now agree with those three.
  it('monitor history and monitor explain auto-discover the same per-workspace socket as doctor/daemon status/session open, flagless', async () => {
    const dir = path.join(tempDir, 'issue-374-unified-defaults');
    const monitorId = 'heartbeat';
    const monitorsRoot = path.join(dir, '.claude', 'monitors');
    const monitorDir = path.join(monitorsRoot, monitorId);
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Heartbeat
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`,
      'utf-8',
    );

    const fakeHome = mkdtempSync(path.join(tmpdir(), 'agentmon-374-home-'));
    // Deliberately NO AGENTMONITORS_DB / AGENTMONITORS_SOCKET / --socket
    // anywhere below — that is the exact condition the issue reports. Pinning
    // XDG_DATA_HOME under fakeHome (which `workspacePaths()` prefers over
    // HOME) and using `runWithCleanEnv`/a cleaned daemon spawn env for every
    // process keeps this test hermetic: without both, an ambient
    // AGENTMONITORS_SOCKET/AGENTMONITORS_DB or XDG_DATA_HOME in the developer's
    // own shell would be inherited by the daemon *and* every client command
    // alike, making the socket cross-check below pass via that shared
    // override without ever exercising per-workspace auto-discovery, and
    // could leak real daemon state outside fakeHome.
    const xdgDataHome = path.join(fakeHome, '.local', 'share');
    const env = { HOME: fakeHome, XDG_DATA_HOME: xdgDataHome };

    let daemonChild: ReturnType<typeof spawn> | undefined;
    try {
      const initResult = runWithCleanEnv(['init', '--enable-only'], env, dir);
      expect(initResult.exitCode).toBe(0);

      // --poll-ms speeds up the tick loop for the test; it does not affect
      // socket resolution, which is what this test is verifying.
      const { child, socketPath } = await waitForDaemonListening(
        ['daemon', 'run', monitorsRoot, '--poll-ms', '200'],
        env,
        dir,
      );
      daemonChild = child;

      // Wait for a tick to materialize observation history (cron
      // '* * * * *' is due every tick).
      let historyResult = runWithCleanEnv(
        ['monitor', 'history', '--format', 'json'],
        env,
        dir,
      );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (historyResult.exitCode === 0) {
          const rows = JSON.parse(historyResult.stdout) as {
            monitorId: string;
          }[];
          if (rows.some((r) => r.monitorId === monitorId)) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        historyResult = runWithCleanEnv(
          ['monitor', 'history', '--format', 'json'],
          env,
          dir,
        );
      }

      // The actual regression: pre-fix, this failed with "No daemon running
      // and no persisted state to show" despite `daemon status`/`doctor`
      // seeing the same live daemon from this workspace with no flags.
      expect(historyResult.exitCode).toBe(0);
      expect(historyResult.stderr).not.toContain('No daemon running');
      const records = JSON.parse(historyResult.stdout) as {
        monitorId: string;
      }[];
      expect(records.some((r) => r.monitorId === monitorId)).toBe(true);

      const explainResult = runWithCleanEnv(
        [
          'monitor',
          'explain',
          monitorId,
          '--dir',
          monitorsRoot,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(explainResult.exitCode).toBe(0);
      expect(explainResult.stderr).not.toContain('No daemon running');
      const report = JSON.parse(explainResult.stdout) as { notice?: string };
      // A live daemon answered directly through the socket — no in-process
      // fallback banner, unlike the no-daemon degraded path (issue #150).
      expect(report.notice).toBeUndefined();

      // Confirm `monitor history`/`monitor explain` are reaching the SAME
      // daemon `daemon status` sees, not merely succeeding independently.
      const statusResult = runWithCleanEnv(
        ['daemon', 'status', '--format', 'json'],
        env,
        dir,
      );
      expect(statusResult.exitCode).toBe(0);
      const status = JSON.parse(statusResult.stdout) as {
        running: boolean;
        socketPath: string;
      };
      expect(status.running).toBe(true);
      expect(status.socketPath).toBe(socketPath);
    } finally {
      daemonChild?.kill('SIGTERM');
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('daemon once (in-process) shares the same per-workspace db doctor reads, with no overrides', () => {
    const dir = path.join(tempDir, 'issue-335-once-unified-db');
    const monitorsRoot = path.join(dir, '.claude', 'monitors', 'heartbeat');
    mkdirSync(monitorsRoot, { recursive: true });
    writeFileSync(
      path.join(monitorsRoot, 'MONITOR.md'),
      `---
name: Heartbeat
watch:
  type: schedule
  cron: '* * * * *'
  timezone: UTC
urgency: normal
---
This monitor fires on a schedule.
`,
      'utf-8',
    );

    const fakeHome = mkdtempSync(
      path.join(tmpdir(), 'agentmon-335-once-home-'),
    );
    // Pin XDG_DATA_HOME under fakeHome (it takes priority over HOME in
    // `workspacePaths()`) and use `runWithCleanEnv` so an ambient
    // AGENTMONITORS_DB/AGENTMONITORS_SOCKET/XDG_DATA_HOME in the developer's
    // own shell can't be inherited by either subprocess below.
    const env = {
      HOME: fakeHome,
      XDG_DATA_HOME: path.join(fakeHome, '.local', 'share'),
    };

    try {
      const initResult = runWithCleanEnv(['init', '--enable-only'], env, dir);
      expect(initResult.exitCode).toBe(0);

      const once = runWithCleanEnv(
        ['daemon', 'once', path.join(dir, '.claude', 'monitors')],
        env,
        dir,
      );
      expect(once.exitCode).toBe(0);
      expect(once.stdout).toContain('emitted 1 event(s)');

      // `daemon once` wrote into the derived per-workspace db, not the global
      // default — confirmed via `doctor`, run as a SEPARATE subprocess with the
      // same cwd/env and no overrides either, which independently derives the
      // identical path and must see the observation `daemon once` just
      // recorded. (Comparing against a db path computed in the *test* process
      // itself would be unreliable: macOS resolves `/var` -> `/private/var`
      // for a subprocess's canonicalized `process.cwd()` but not for a raw
      // `os.tmpdir()`-derived string built in this process, so the two would
      // hash differently despite naming the same directory — doctor's own
      // subprocess is the correct oracle here, not a path built by this test.)
      const doctorResult = runWithCleanEnv(['doctor'], env, dir);
      expect(doctorResult.stdout).toContain('✓ monitor:heartbeat');
      expect(doctorResult.stdout).not.toContain('never observed');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
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

  // Issue #338 item 6: `monitor test` takes a single MONITOR.md file; passing
  // a directory used to surface a raw `EISDIR` read error. It must redirect
  // to the symmetric command (`validate`) instead, mirroring `validate`'s own
  // file-vs-directory redirect.
  it('redirects to `validate` when given a directory instead of a single file', () => {
    const dir = path.join(tempDir, 'monitor-test-on-dir');
    const monitorsDir = path.join(dir, 'monitors');
    mkdirSync(monitorsDir, { recursive: true });
    run(['init', 'dir-target', '--dir', monitorsDir], dir);

    const result = run(['monitor', 'test', monitorsDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('EISDIR');
    expect(result.stderr).toContain('is a directory, not a file');
    expect(result.stderr).toContain('agentmonitors validate');
    expect(result.stderr).toContain(monitorsDir);

    const jsonResult = run([
      'monitor',
      'test',
      monitorsDir,
      '--format',
      'json',
    ]);
    expect(jsonResult.exitCode).toBe(1);
    const parsed = JSON.parse(jsonResult.stdout) as { error: string };
    expect(parsed.error).not.toContain('EISDIR');
    expect(parsed.error).toContain('agentmonitors validate');
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
    // Issue #375: with no --name flag, the scaffolded name: derives from the
    // positional <name> ("fp-json" -> "Fp json"), not the literal template
    // placeholder "My monitor".
    expect(parsed.monitor).toBe('Fp json');
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
    // Issue #377: the message must name the configured glob so an author can
    // tell "bad glob" from "no changes" without opening MONITOR.md. The
    // scaffolded template's default pattern is `**/*.ts`.
    expect(result.stderr).toContain('**/*.ts');
    expect(result.stdout).not.toContain('Baseline established');
  });

  // Issue #297: an invalid IANA timezone on a schedule monitor's scope must be
  // rejected with an actionable diagnosis (the SAME validateWatchScope error
  // `validate`/`watch declare` give, 005 §14.4), not silently echoed back or
  // left to crash deep inside runtime cron matching.
  it('rejects a schedule monitor with an invalid IANA timezone', () => {
    const dir = path.join(tempDir, 'monitor-test-bad-timezone');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'bad-tz');
    mkdirSync(monitorsDir, { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
name: Bad timezone
watch:
  type: schedule
  cron: '* * * * *'
  timezone: Not/AZone
urgency: normal
---
This monitor has a typo'd timezone.
`,
      'utf-8',
    );

    const result = run([
      'monitor',
      'test',
      path.join(monitorsDir, 'MONITOR.md'),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid monitor scope');
    expect(result.stderr).toContain('Not/AZone');
    expect(result.stderr).toContain('valid IANA time zone name');

    const jsonResult = run([
      'monitor',
      'test',
      path.join(monitorsDir, 'MONITOR.md'),
      '--format',
      'json',
    ]);
    expect(jsonResult.exitCode).toBe(1);
    const parsed = JSON.parse(jsonResult.stdout) as { error: string };
    expect(parsed.error).toContain('Not/AZone');
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
    // Issue #375: derived from the positional <name> ("fp-empty-json" ->
    // "Fp empty json"), not the literal template placeholder "My monitor".
    expect(parsed).toMatchObject({
      monitor: 'Fp empty json',
      source: 'file-fingerprint',
      baseline: false,
      outcome: 'no-files-matched',
      observations: [],
    });
    expect(parsed.error).toContain('watch.globs');
    // Issue #377: the message must name the configured glob.
    expect(parsed.error).toContain('**/*.ts');
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
// Issue #336: the undocumented `.agentmonitors/` runtime-state directory
// (per-session hook-state, created the instant a session opens) must never
// show up as an untracked entry in `git status` when a project follows the
// documented bootstrap path exactly. Proves the fix end to end: a fresh git
// repo, `agentmonitors init --enable-only` (the documented bootstrap step),
// then a full daemon → session → file-change → hook-claim → ack cycle — the
// same recipe skill.md and the notify-when-a-file-changes guide document.
// ---------------------------------------------------------------------------
describe.skipIf(!gitAvailable)(
  'fresh project gitignore proof (issue #336)',
  () => {
    it('leaves no tool-generated untracked entries after init + a full daemon verify-cycle', async () => {
      const dir = path.join(tempDir, 'gitignore-proof');
      mkdirSync(dir, { recursive: true });
      try {
        gitIn(dir, ['init', '-b', 'main']);
      } catch {
        gitIn(dir, ['init']);
        gitIn(dir, ['checkout', '-b', 'main']);
      }
      gitIn(dir, ['config', 'user.email', 'test@example.com']);
      gitIn(dir, ['config', 'user.name', 'Test']);

      // The documented bootstrap step (skill.md Phase 2 / the setup-monitors
      // skill's "Enable The Project" section): enable the project and fix
      // `.gitignore` — nothing else.
      const bootstrap = run(['init', '--enable-only'], dir);
      expect(bootstrap.exitCode).toBe(0);

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

      // The daemon's db/socket live OUTSIDE the project dir on purpose — in
      // real usage they're rooted under the user's data dir
      // (`workspacePaths()`), never the project root, so they must not
      // factor into this proof either way.
      const dbPath = path.join(tempDir, 'gitignore-proof.db');
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
            'gitignore-proof',
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

        // Opening a session alone materializes the per-session hook-state
        // file under `.agentmonitors/sessions/<id>/hook-state.json`
        // (002 §11.3) — this is the exact directory the issue is about.
        expect(existsSync(path.join(dir, '.agentmonitors'))).toBe(true);

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
        expect(JSON.parse(unread().stdout)).toHaveLength(1);

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

        const ack = runWithEnv(
          ['events', 'ack', '--session', session.id],
          env,
          dir,
        );
        expect(ack.exitCode).toBe(0);

        const stop = runWithEnv(['daemon', 'stop'], env, dir);
        expect(stop.exitCode).toBe(0);
        await daemon.waitForExit();
      } finally {
        daemon.stop();
        await daemon.waitForExit();
      }

      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        encoding: 'utf-8',
      }) as string;
      const untrackedPaths = status
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3));

      // The point of the fix: none of the tool-generated runtime paths show
      // up as untracked. `watched.txt` and the monitor definition are real,
      // uncommitted project content and legitimately still show up — this
      // only asserts the *tool-generated* paths are gitignored.
      expect(untrackedPaths.some((p) => p.startsWith('.agentmonitors'))).toBe(
        false,
      );
      expect(
        untrackedPaths.some((p) => p.includes('agentmonitors.local.md')),
      ).toBe(false);
    }, 20_000);
  },
);

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

  // Issue #420 P3: `session start`/`session end` succeeded silently on stdout,
  // so a hand-wiring user couldn't tell registration/deregistration happened
  // without a second `session list`. They now print a one-line ack on STDERR
  // — while stdout stays wire-clean (the SessionStart recap channel), so the
  // hook wire format is unaffected.
  it('session start and session end print a one-line success ack on stderr; stdout stays wire-clean', async () => {
    const { ws, socket, env, hostSessionId } = bootLazyWorkspace(5_000);

    try {
      // A fresh start has no unread events → the recap render is null → stdout
      // MUST be byte-empty. The ack goes to stderr only.
      const start = runWithStdinCapture(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toBe('');
      // AgentMon: session <id> registered; daemon at <socket>
      expect(start.stderr).toMatch(
        /^AgentMon: session .+ registered; daemon at .+$/m,
      );
      expect(start.stderr).toContain(socket);
      expect(await daemonAvailable(socket)).toBe(true);

      // The registered AgentMon session id in the ack matches `session list`.
      const list = runWithEnv(
        ['session', 'list', '--socket', socket, '--format', 'json'],
        env,
        ws,
      );
      const sessions = JSON.parse(list.stdout) as {
        id: string;
        hostSessionId: string;
      }[];
      const registered = sessions.find(
        (s) => s.hostSessionId === hostSessionId,
      );
      expect(registered).toBeDefined();
      expect(start.stderr).toContain(`session ${registered?.id ?? ''} `);

      // session end acks on stderr too, with the SAME AgentMon session id.
      const end = runWithStdinCapture(
        ['session', 'end'],
        env,
        sessionEndPayload(hostSessionId, ws),
        ws,
      );
      expect(end.exitCode).toBe(0);
      expect(end.stdout).toBe('');
      expect(end.stderr).toContain(
        `AgentMon: session ${registered?.id ?? ''} ended`,
      );
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

    // Wrap through resolveSocketPath, the SAME transform `session start`
    // applies before binding: on hosts with a deep $HOME/XDG_DATA_HOME the raw
    // derived path can exceed the AF_UNIX length limit, in which case the
    // daemon actually binds a substituted short path. Checking availability
    // and stopping via the un-resolved raw path would target the wrong socket
    // on those hosts (leaked daemon, flake).
    const resolvedSocketA = resolveSocketPath(pathsA.socket);
    const resolvedSocketB = resolveSocketPath(pathsB.socket);

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
      expect(await daemonAvailable(resolvedSocketA)).toBe(true);
      expect(await daemonAvailable(resolvedSocketB)).toBe(true);

      // A's session list contains A's session, NOT B's
      const listA = runWithEnv(
        ['session', 'list', '--socket', resolvedSocketA, '--format', 'json'],
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
        ['session', 'list', '--socket', resolvedSocketB, '--format', 'json'],
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
      for (const socket of [resolvedSocketA, resolvedSocketB]) {
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
// `channel serve` workspace-socket resolution parity with `session start`
// (issue #358)
//
// Promotes the `experiments/channel-uat` harness pattern into the real test
// suite. Pre-fix, `channel serve` resolved its socket directly via
// `resolveSocketPath` (explicit flag -> AGENTMONITORS_SOCKET -> bare global
// default) and never consulted the enabled workspace's persisted-or-derived
// per-workspace socket the way every other workspace-aware command does
// (`resolveManualDaemonSocketPath`, issue #335). So a `channel serve` spawned
// exactly as the plugin's `.mcp.json` spawns it -- no `--socket`, no
// `AGENTMONITORS_SOCKET` -- silently talked to a socket with no daemon
// listening, for the only supported activation flow. This test drives BOTH
// halves through their real, unmodified production entry points -- the
// `SessionStart` hook's stdin contract for the daemon side, and a real MCP
// client speaking to a `channel serve` subprocess for the channel side -- and
// fails against the pre-fix code (no push ever arrives).
// ---------------------------------------------------------------------------
describe('channel serve workspace-socket resolution (issue #358)', () => {
  it('pushes a <channel> notification through the SAME per-workspace socket session start lazy-boots, with no --socket flag and no AGENTMONITORS_SOCKET env', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chan-358-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-file');
    mkdirSync(monitorsDir, { recursive: true });
    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'hello', 'utf-8');
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch file',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // Normal urgency: claimDelivery returns as soon as the event
        // materializes, with no 15s high-urgency settle window -- keeping
        // this regression test fast (matches experiments/channel-uat's
        // default `normal` run).
        'urgency: normal',
        '---',
        'watched.txt changed.',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Enabled with NO persisted socket/db -- exactly the state a fresh
    // `.claude/agentmonitors.local.md` with only `enabled: true` is in before
    // any daemon has ever bound (the issue's own repro). `session start`
    // derives (and persists) the per-workspace socket itself.
    writeLocalState(ws, { enabled: true, reapAfterMs: 60_000 });

    const { workspacePaths } = await import('../workspace-paths.js');
    // Wrap through resolveSocketPath, the SAME transform `session start`
    // applies before binding (session.ts's `resolveSocketPath(state.socket ??
    // paths.socket)`): on hosts with a deep $HOME/XDG_DATA_HOME the raw
    // derived path can exceed the AF_UNIX length limit, in which case the
    // daemon actually binds a substituted short path. Checking availability
    // and stopping via the un-resolved raw path would target the wrong
    // socket on those hosts (leaked daemon, flake).
    const derivedSocket = resolveSocketPath(workspacePaths(ws).socket);

    const hostSessionId = `chan-358-${String(Date.now())}`;
    // ONLY CLAUDE_PROJECT_DIR -- no AGENTMONITORS_SOCKET/AGENTMONITORS_DB
    // override -- so this reproduces the real activation path (the plugin's
    // hooks.json invocation), not an explicit-flag control.
    const hookEnv = { CLAUDE_PROJECT_DIR: ws };

    let client: Client | undefined;
    try {
      // 1. Lazy-boot exactly like the SessionStart hook does.
      const start = runWithStdin(
        ['session', 'start'],
        hookEnv,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(await daemonAvailable(derivedSocket)).toBe(true);

      // 2. Spawn `channel serve` EXACTLY as the plugin's `.mcp.json` spawns
      //    it: no `--socket`, no `AGENTMONITORS_SOCKET` -- only the
      //    CLAUDE_PROJECT_DIR / CLAUDE_CODE_SESSION_ID a real Claude Code
      //    MCP-server spawn provides (`experiments/channel-probe`'s
      //    confirmed contract, 006 §4.4). Inherit the rest of the real
      //    baseline env (HOME, XDG_DATA_HOME, locale, ...) rather than a
      //    hand-picked allowlist: `workspacePaths`/`resolveSocketPath` read
      //    HOME/XDG_DATA_HOME to derive the per-workspace socket, and step 1
      //    above (`session start`, via `runWithStdin`) resolves that SAME
      //    socket from the full inherited `process.env` -- an allowlisted
      //    subset here would let the two steps compute different sockets on
      //    a host with a non-default HOME/XDG_DATA_HOME, silently proving
      //    nothing. `AGENTMONITORS_SOCKET`/`AGENTMONITORS_DB` are still
      //    explicitly stripped so no ambient override can substitute for the
      //    derivation this test exists to exercise.
      let received: unknown = null;
      client = new Client(
        { name: 'channel-358-regression', version: '0.0.0' },
        { capabilities: {} },
      );
      client.fallbackNotificationHandler = (notification) => {
        if (notification.method === 'notifications/claude/channel') {
          received = notification.params;
        }
      };
      const transport = new StdioClientTransport({
        command: 'node',
        args: [CLI_PATH, 'channel', 'serve', '--poll-ms', '300'],
        cwd: ws,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key, value]) =>
                value !== undefined &&
                key !== 'AGENTMONITORS_SOCKET' &&
                key !== 'AGENTMONITORS_DB',
            ) as [string, string][],
          ),
          CLAUDE_PROJECT_DIR: ws,
          CLAUDE_CODE_SESSION_ID: hostSessionId,
        },
        stderr: 'ignore',
      });
      await client.connect(transport);

      // Let it open its bound session and take a baseline poll before the
      // watched file changes.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // 3. Mutate the watched file -- the daemon's next tick materializes a
      //    normal-urgency event and projects it into the bound session.
      writeFileSync(watchedFile, 'hello world', 'utf-8');

      // 4. Wait for the push. Pre-fix, this NEVER arrives: `channel serve`
      //    is talking to the bare global-default socket, which has no
      //    daemon listening (the derived per-workspace socket does).
      const deadline = Date.now() + 15_000;
      while (received === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(received).not.toBeNull();
      expect(
        (received as { meta?: Record<string, string> }).meta?.['lifecycle'],
      ).toBe('turn-interruptible');
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // already closed -- ignore
        }
      }
      try {
        await callDaemon('stop', {}, { socketPath: derivedSocket });
      } catch {
        // already stopped -- ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Silent opt-in dead-end fix: SessionStart advisory when monitors exist but
// the project is not enabled (issue #269)
// ---------------------------------------------------------------------------

describe('session start: monitoring-disabled advisory (issue #269)', () => {
  // Acceptance criterion 1 + 4: real hook stdin contract in, real SessionStart
  // hook wire-shape JSON out, no daemon boot.
  it('emits a one-line additionalContext advisory when monitors exist but the project is not enabled, exits 0, and boots no daemon', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-disabled-'));
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
    // Deliberately do NOT write .claude/agentmonitors.local.md — this is the
    // "authored monitors, missed the enable step" scenario from the issue.

    const { workspacePaths } = await import('../workspace-paths.js');
    const { socket } = workspacePaths(ws);
    const hostSessionId = `disabled-test-${Date.now()}`;
    // Real hook stdin payload — session_id, hook_event_name, cwd — exactly as
    // Claude Code sends it (no hand-built approximation).
    const env = { CLAUDE_PROJECT_DIR: ws };

    try {
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);

      // The real SessionStart hook wire shape (§5.1): continue + hookSpecificOutput.
      const output = JSON.parse(start.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
      const ctx = output.hookSpecificOutput.additionalContext;
      // Monitoring disabled, N monitors found, exact enable step.
      expect(ctx).toContain('disabled');
      expect(ctx).toContain('1 monitor definition found');
      expect(ctx).toContain('.claude/agentmonitors.local.md');
      expect(ctx).toContain('enabled: true');
      // Criterion 2 (issue #331): the advisory also points at
      // `agentmonitors doctor` for the full workspace-health picture.
      expect(ctx).toContain('agentmonitors doctor');

      // No daemon boot: the socket session start WOULD bind to (were it not
      // quick-exiting) is never opened.
      expect(await daemonAvailable(socket)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Acceptance criterion 2 (regression): unchanged fully-silent quick-exit
  // when the workspace has no monitor definitions at all — a user who never
  // opted in is never nagged.
  it('stays fully silent when the workspace has no monitor definitions', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-nomonitors-'));
    // No .claude/monitors dir and no .claude/agentmonitors.local.md — a
    // completely untouched workspace.
    const hostSessionId = `nomonitors-test-${Date.now()}`;
    const env = { CLAUDE_PROJECT_DIR: ws };

    try {
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toBe('');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // Acceptance criterion 3 (regression): when the project IS enabled, no
  // "monitoring disabled" advisory is ever surfaced.
  it('emits no monitoring-disabled advisory when the project is enabled', async () => {
    const { ws, socket, env, hostSessionId } = bootLazyWorkspace(5_000);

    try {
      const start = runWithStdin(
        ['session', 'start'],
        env,
        sessionStartPayload(hostSessionId, ws),
        ws,
      );
      expect(start.exitCode).toBe(0);
      // Nothing is pending on a fresh start, and the project IS enabled — the
      // disabled-project advisory must never appear here.
      expect(start.stdout).not.toContain('monitoring is disabled');

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

  // Claude Code auto-loads the conventional hooks/hooks.json, and rejects a
  // manifest `hooks` entry that resolves to that same file ("Duplicate hooks
  // file detected"), which broke plugin install. `manifest.hooks` may only
  // name ADDITIONAL hook files.
  it('manifest does not re-reference the auto-discovered hooks/hooks.json (duplicate hooks file rejected at plugin load)', () => {
    const manifest = JSON.parse(
      readFileSync(PLUGIN_MANIFEST_PATH, 'utf-8'),
    ) as { hooks?: string | string[] };
    const refs =
      manifest.hooks === undefined
        ? []
        : Array.isArray(manifest.hooks)
          ? manifest.hooks
          : [manifest.hooks];
    const resolved = refs.map((ref) => path.resolve(PLUGIN_DIR, ref));
    expect(resolved).not.toContain(PLUGIN_HOOKS_JSON_PATH);
  });
});

// ---------------------------------------------------------------------------
// hook deliver: advisory turn-boundary delivery
// ---------------------------------------------------------------------------

describe('hook deliver', () => {
  it('hook deliver help documents format and emission preconditions', () => {
    const result = run(['hook', 'deliver', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--format <format>');
    expect(result.stdout).toContain('enabled project');
    expect(result.stdout).toContain('.claude/agentmonitors.local.md');
    expect(result.stdout).toContain('reachable daemon');
    expect(result.stdout).toContain('matching tracked session');
    expect(result.stdout).toContain('Empty output means');
  });

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
      expect(deliverResult.stdout).toBe(
        JSON.stringify(JSON.parse(deliverResult.stdout)),
      );

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

      // Issue #235: ack-all means every event returned by `events list --unread`,
      // including a claimed-but-unread event, not only never-claimed rows.
      const ack = runWithEnv(
        ['events', 'ack', '--session', session.id],
        env,
        ws,
      );
      expect(ack.exitCode).toBe(0);
      expect(JSON.parse(unread().stdout)).toHaveLength(0);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('hook deliver --format json emits compact hook wire JSON when pending', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-json-'));
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
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hdj-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-json.db');
    const hostSessionId = `hd-json-${Date.now()}`;

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
        ['hook', 'deliver', '--format', 'json'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(deliverResult.exitCode).toBe(0);
      expect(deliverResult.stdout.trim()).not.toBe('');
      expect(deliverResult.stdout).toBe(
        JSON.stringify(JSON.parse(deliverResult.stdout)),
      );

      const output = JSON.parse(deliverResult.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'AgentMon messages are available.',
      );
      expect(output.hookSpecificOutput.additionalContext).not.toContain('### ');
      expect(output).not.toHaveProperty('permissionDecision');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it('hook deliver --format text emits only the rendered advisory context', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-text-'));
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
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-hdt-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hd-text.db');
    const hostSessionId = `hd-text-${Date.now()}`;

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
        ['hook', 'deliver', '--format', 'text'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(deliverResult.exitCode).toBe(0);
      expect(deliverResult.stdout.trim()).not.toBe('');
      expect(() => JSON.parse(deliverResult.stdout)).toThrow();
      expect(deliverResult.stdout).toContain(
        'AgentMon messages are available.',
      );
      expect(deliverResult.stdout).not.toContain('hookSpecificOutput');
      expect(deliverResult.stdout).not.toContain('### ');
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
        ['hook', 'deliver', '--format', 'json'],
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

  // Issue #299 — redelivery across the 4000-char cap. Two settled high-urgency
  // events whose combined rendered blocks exceed the cap must be delivered ACROSS
  // SUCCESSIVE context events, not silently lost: the first `hook deliver` renders
  // ONE event (with the truncation marker) and claims ONLY that one; the second
  // `hook deliver` — a real subsequent stdin hook payload — delivers the other.
  //
  // Pre-fix this FAILED: the claim marked BOTH events claimed before the render
  // truncated one away, so the second deliver returned nothing and the omitted
  // event never re-surfaced automatically (P1 signal loss). Both events stay
  // UNREAD throughout (claiming ≠ acking), and repeated context events surface
  // every item in order.
  it('hook deliver claims only the rendered subset; the capped-out event re-delivers at the next hook event (#299)', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hd-trunc-'));

    // Two monitors, each watching a distinct file, whose bodies each FIT under
    // the 4000-char cap individually but overrun it COMBINED — so exactly one
    // whole event block fits per context event. A unique token at the start of
    // each body lets us assert which event surfaced in each delivery.
    const TOKENS = { 'mon-a': 'AAAA_TOKEN', 'mon-b': 'BBBB_TOKEN' } as const;
    const bodyFor = (name: keyof typeof TOKENS) =>
      `${TOKENS[name]} ${'x'.repeat(2200)}`; // ~2210 chars: fits alone, not paired
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
          bodyFor(name),
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

      // Drive a `hook deliver` on a real PostToolUse (turn-interruptible) stdin
      // payload — the exact input contract a Claude Code hook feeds the command.
      const deliver = () =>
        runWithStdin(
          ['hook', 'deliver'],
          env,
          JSON.stringify({
            session_id: hostSessionId,
            hook_event_name: 'PostToolUse',
            cwd: ws,
          }),
          ws,
        );
      const contextOf = (stdout: string): string =>
        stdout.trim() === ''
          ? ''
          : (
              JSON.parse(stdout) as {
                hookSpecificOutput: { additionalContext: string };
              }
            ).hookSpecificOutput.additionalContext;
      const tokensIn = (ctx: string): string[] =>
        Object.values(TOKENS).filter((t) => ctx.includes(t));

      // Wait for BOTH high-urgency events to materialize as unread. Polling
      // `events list --unread` claims NOTHING, so it never consumes a delivery
      // (unlike `hook deliver`); once both are unread they are also settled and
      // deliverable at the next `hook deliver`.
      const eventDeadline = Date.now() + 45_000;
      while (Date.now() < eventDeadline) {
        if (JSON.parse(unread().stdout).length >= 2) break;
        await new Promise((res) => setTimeout(res, 500));
      }

      const beforeDeliver = JSON.parse(unread().stdout) as { id: string }[];
      expect(beforeDeliver.length).toBe(2);

      // First context event: renders EXACTLY ONE whole event block, capped and
      // signposted as truncated (a second event is pending), and claims ONLY
      // that event.
      const first = deliver();
      expect(first.exitCode).toBe(0);
      const ctx1 = contextOf(first.stdout);
      expect(ctx1.length).toBeLessThanOrEqual(4000);
      expect(ctx1).toContain('[truncated');
      const firstTokens = tokensIn(ctx1);
      expect(firstTokens).toHaveLength(1); // claim-set == render-set: one event

      // Both events remain UNREAD after the claim (claiming ≠ acking) — nothing
      // was dropped, and the deferred event is still pending to re-deliver.
      const afterFirst = JSON.parse(unread().stdout) as { id: string }[];
      expect(afterFirst.length).toBe(2);
      expect(new Set(afterFirst.map((e) => e.id))).toEqual(
        new Set(beforeDeliver.map((e) => e.id)),
      );

      // Second context event: delivers the OTHER event (the one capped out of the
      // first render). Pre-fix this was empty — the omitted event was claimed and
      // never re-surfaced.
      const second = deliver();
      expect(second.exitCode).toBe(0);
      const ctx2 = contextOf(second.stdout);
      const secondTokens = tokensIn(ctx2);
      expect(secondTokens).toHaveLength(1);
      expect(secondTokens[0]).not.toBe(firstTokens[0]);
      // Complete ordered delivery: across the two context events, BOTH tokens
      // were surfaced.
      expect(new Set([...firstTokens, ...secondTokens])).toEqual(
        new Set(Object.values(TOKENS)),
      );
      // Only one event remained, so the second render fits without a marker.
      expect(ctx2).not.toContain('[truncated');

      // Third context event: nothing left to deliver at turn-interruptible.
      expect(contextOf(deliver().stdout)).toBe('');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);
});

// Issue #333: reproduce/refute the blind-study S3 F2 report (normal-urgency
// event surfaced NOTHING at any lifecycle) through the REAL contract — a durable
// event materialized by a real daemon tick, then `hook claim` at
// turn-interruptible over the real IPC socket (the subject's exact command).
//
// Verdict: NOT a first-claim bug. The FIRST turn-interruptible claim DOES
// surface the coalesced normal reminder (002 §9.2). The study subject had run an
// EARLIER turn-interruptible claim (S3 phase 11) that surfaced the reminder AND
// claimed the event; the second identical claim was then correctly suppressed
// because the reminder coalesces until acknowledgment. The real defect was the
// SILENCE — no way to discover why. This test pins both: (1) the reminder
// surfaces on the first claim; (2) after a claim, the reminder is suppressed and
// `monitor explain` NAMES the reason (already-claimed / coalesced-until-ack).
describe('hook claim normal-urgency reminder + suppression diagnosis (issue #333)', () => {
  const NORMAL_INBOX_PROMPT =
    'AgentMon messages are available. Read the inbox.';

  it('first turn-interruptible claim surfaces the reminder; a prior claim suppresses it; monitor explain names why', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-333-'));
    const monitorsRoot = path.join(ws, '.claude', 'monitors');
    // The monitor folder name is the monitor id used by `monitor explain`.
    const monitorsDir = path.join(monitorsRoot, 'docs-watcher');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Docs watcher',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        // The guide's own default urgency — the study's exact case.
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-333-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'issue-333.db');
    const hostSessionId = `issue-333-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    const env: Record<string, string> = {
      CLAUDE_CODE_SESSION_ID: hostSessionId,
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    const daemon = await startDaemon(monitorsRoot, ws, env, socket);

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

      // Let the baseline tick complete, then change the watched file. A real
      // daemon tick then materializes exactly one durable, unread normal event.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed: added eval()', 'utf-8');

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

      const claimAt = (lifecycle: string) =>
        runWithEnv(
          [
            'hook',
            'claim',
            '--session',
            session.id,
            '--lifecycle',
            lifecycle,
            '--format',
            'json',
          ],
          env,
          ws,
        );

      // CRITERION 1 (refute the first-claim bug): the subject's exact command,
      // with the event unread and UNCLAIMED, surfaces the coalesced generic
      // reminder — precisely what 002 §9.2 requires. This is NOT null.
      const first = claimAt('turn-interruptible');
      expect(first.exitCode).toBe(0);
      const firstClaim = JSON.parse(first.stdout) as {
        mode: string;
        urgency: string;
        message: string;
        events: unknown[];
      } | null;
      expect(firstClaim).not.toBeNull();
      expect(firstClaim?.mode).toBe('delivery');
      expect(firstClaim?.urgency).toBe('normal');
      expect(firstClaim?.message).toBe(NORMAL_INBOX_PROMPT);
      expect(firstClaim?.events).toEqual([]); // §9.2: reminder carries no events

      // The divergent precondition from the study transcript: the first claim
      // marked the event CLAIMED (not acknowledged). A SECOND identical claim is
      // now correctly suppressed → `null`. This reproduces S3 F2's symptom.
      const second = claimAt('turn-interruptible');
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout)).toBeNull();

      // turn-idle likewise surfaces nothing (no low-urgency work), matching the
      // study's "No pending delivery." at that lifecycle.
      const idle = claimAt('turn-idle');
      expect(idle.exitCode).toBe(0);
      expect(JSON.parse(idle.stdout)).toBeNull();

      // Claiming never acknowledges (BP2 / SP4): the event is still unread and
      // re-discoverable — no signal was lost, only the reminder is paused.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // CRITERION 2: the silence is now discoverable. `monitor explain`'s
      // projection-and-delivery stage NAMES the suppression reason.
      const explain = runWithEnv(
        [
          'monitor',
          'explain',
          'docs-watcher',
          '--dir',
          monitorsRoot,
          '--workspace',
          ws,
          '--socket',
          socket,
          '--format',
          'json',
        ],
        env,
        ws,
      );
      expect(explain.exitCode).toBe(0);
      const report = JSON.parse(explain.stdout) as {
        stages: {
          id: string;
          status: string;
          reason: string;
          details?: {
            reminderSuppression?: {
              sessionId: string;
              urgency: string;
              lifecycle: string;
              reason: string;
            }[];
          };
        }[];
      };
      const delivery = report.stages.find((stage) => stage.id === 'delivery');
      expect(delivery).toBeDefined();
      // Suppression is EXPECTED behavior, not a fault.
      expect(delivery?.status).toBe('ok');
      expect(delivery?.reason).toContain('already claimed');
      expect(delivery?.reason).toContain('coalesced-until-ack');
      const findings = delivery?.details?.reminderSuppression;
      expect(findings).toHaveLength(1);
      expect(findings?.[0]).toMatchObject({
        sessionId: session.id,
        urgency: 'normal',
        lifecycle: 'turn-interruptible',
        reason: 'already-claimed',
      });
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);
});

// Issue #334: blind DX study S3 F3 (High) — `hook deliver` emits empty
// stdout + exit 0 both when nothing is pending AND when the stdin payload is
// misconfigured (bad session_id, workspace mismatch, urgency held) —
// indistinguishable failure modes. `--debug` must write a stderr diagnosis
// naming which branch was hit while leaving stdout byte-identical.
describe('hook deliver --debug diagnosis (issue #334)', () => {
  it('help documents --debug', () => {
    const result = run(['hook', 'deliver', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--debug');
    expect(result.stdout).toContain('STDOUT is byte-identical');
  });

  // Criterion 2, branch: unknown session_id. STDOUT stays empty (unchanged
  // contract); STDERR names the specific reason (no tracked session matches).
  it('unknown session_id: stdout stays empty, stderr names the unresolved session', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-334-unknown-'));
    mkdirSync(path.join(ws, '.claude', 'monitors'), { recursive: true });

    const socket = path.join(
      '/tmp',
      `agentmon-334-unk-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'unknown.db');
    const hostSessionId = `known-${Date.now()}`;

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
      // One REAL tracked session exists, but the hook payload names a
      // different, never-opened host session id.
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

      const result = runWithStdinCapture(
        ['hook', 'deliver', '--debug'],
        env,
        JSON.stringify({
          session_id: 'totally-unknown-host-session',
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      // Contract unchanged: nothing pending/resolvable → empty stdout.
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'no tracked AgentMon session matches host session_id "totally-unknown-host-session"',
      );
      expect(result.stderr).toContain('1 session(s)');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);

  // Criterion 2, branch: cwd/workspace mismatch. The hook payload's cwd
  // points at a workspace that was never enabled — stdout stays empty, stderr
  // names the workspace path and its enabled=false state.
  it('cwd mismatch (disabled workspace): stdout stays empty, stderr names the workspace and its enabled state', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-334-cwd-a-'));
    const otherWs = mkdtempSync(path.join(tmpdir(), 'agentmon-334-cwd-b-'));
    mkdirSync(path.join(ws, '.claude', 'monitors'), { recursive: true });

    const socket = path.join(
      '/tmp',
      `agentmon-334-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'cwd.db');
    const hostSessionId = `cwd-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });
    // otherWs deliberately has NO .claude/agentmonitors.local.md — the exact
    // "not enabled" symptom a real cwd/workspace mismatch produces.

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

      // A VALID session id, but the payload's cwd is the OTHER (disabled)
      // workspace — the mismatch a misconfigured hook command produces.
      const result = runWithStdinCapture(
        ['hook', 'deliver', '--debug'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: otherWs,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(otherWs);
      expect(result.stderr).toContain('is not enabled');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
      rmSync(otherWs, { recursive: true, force: true });
    }
  }, 40_000);

  // Criterion 2, branch: nothing pending. Every resolution step succeeds, but
  // there is genuinely no unread work — stdout stays empty, stderr proves the
  // silence is "correctly idle" (pending counts are all 0, no held events).
  it('nothing pending: stdout stays empty, stderr shows zero pending events and no holds', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-334-idle-'));
    mkdirSync(path.join(ws, '.claude', 'monitors'), { recursive: true });

    const socket = path.join(
      '/tmp',
      `agentmon-334-idle-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'idle.db');
    const hostSessionId = `idle-${Date.now()}`;

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

      const result = runWithStdinCapture(
        ['hook', 'deliver', '--debug'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`resolved session ${session.id}`);
      expect(result.stderr).toContain('high=0 normal=0 low=0 (total 0)');
      expect(result.stderr).toContain('no held events for this lifecycle');
      expect(result.stderr).toContain('claim: null');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);

  // Criterion 2, branch: events held by the settle window. A high-urgency
  // monitor with a short debounce (settle-for: 1s) materializes its event well
  // before the SEPARATE 15s claim-time settle window (002 §9.1) elapses — a
  // real, observable "held, not lost" state without any real-clock 15s wait.
  it('high-urgency event held by the settle window: stdout stays empty, stderr names the settle-window hold', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-334-settle-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-fast');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch fast',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        'urgency: high',
        // A short notify debounce (default high debounce is 15s — the SAME
        // duration as the claim-time settle window, so it would never be
        // observably "held" without this override; see 002 §9.1/§9.2 and the
        // CLAUDE.md note on the default high-urgency debounce).
        'notify:',
        '  strategy: debounce',
        '  settle-for: "1s"',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-334-settle-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'settle.db');
    const hostSessionId = `settle-${Date.now()}`;

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

      // Let the baseline tick complete, then change the watched file.
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

      // The 1s notify debounce materializes the event well inside a few
      // seconds — nowhere near the SEPARATE 15s claim-time settle window.
      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // Immediately diagnose — the event is materialized (unread) but its age
      // (a few seconds) is still well short of the 15s claim-time settle
      // window, so a real claim surfaces nothing this turn.
      const result = runWithStdinCapture(
        ['hook', 'deliver', '--debug'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('high=1');
      expect(result.stderr).toContain('held (high, settle-window)');
      expect(result.stderr).toContain('settle window');
      expect(result.stderr).toContain('claim: null');

      // The event is genuinely held, not lost: still unread and re-discoverable.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);

  // Criterion 1's core regression guard: --debug MUST NOT alter stdout in any
  // mode. Two independent sessions in the SAME workspace see the SAME shared
  // normal-urgency event (session isolation, 002 §6) — one claimed via a
  // plain `hook deliver`, the other via `hook deliver --debug`. Their stdout
  // must be byte-identical; only the debug run also writes to stderr.
  it('stdout is byte-identical between a plain hook deliver and hook deliver --debug for the same delivery', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-334-identical-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-shared');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch shared',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
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
      `agentmon-334-ident-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'identical.db');
    const hostA = `identical-a-${Date.now()}`;
    const hostB = `identical-b-${Date.now()}`;

    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    const env: Record<string, string> = {
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
      // Two independent LEAD sessions in the same workspace — each gets its
      // own unread/claimed projection of the same shared event (002 §6).
      for (const hostSessionId of [hostA, hostB]) {
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
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      writeFileSync(watchedFile, 'changed content', 'utf-8');

      const unreadFor = (hostSessionId: string) => {
        const sessionsResult = runWithEnv(
          ['session', 'list', '--format', 'json'],
          env,
          ws,
        );
        const sessions = JSON.parse(sessionsResult.stdout) as {
          id: string;
          hostSessionId: string;
        }[];
        const session = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!session) return [];
        const result = runWithEnv(
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
        return result.exitCode === 0 ? JSON.parse(result.stdout) : [];
      };

      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        if (unreadFor(hostA).length >= 1 && unreadFor(hostB).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(unreadFor(hostA)).toHaveLength(1);
      expect(unreadFor(hostB)).toHaveLength(1);

      const payload = (hostSessionId: string): string =>
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        });

      const plain = runWithStdinCapture(
        ['hook', 'deliver'],
        env,
        payload(hostA),
        ws,
      );
      const debugRun = runWithStdinCapture(
        ['hook', 'deliver', '--debug'],
        env,
        payload(hostB),
        ws,
      );

      expect(plain.exitCode).toBe(0);
      expect(debugRun.exitCode).toBe(0);
      // The core regression guard: stdout is byte-identical in every mode.
      expect(debugRun.stdout).toBe(plain.stdout);
      expect(plain.stdout.trim()).not.toBe('');
      expect(JSON.parse(plain.stdout)).toMatchObject({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'AgentMon messages are available. Read the inbox.',
        },
      });
      // Only the debug run writes diagnosis — to stderr, never stdout.
      expect(plain.stderr).toBe('');
      expect(debugRun.stderr).not.toBe('');
      expect(debugRun.stderr).toContain('claim: mode=delivery');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);
});

// Issue #329: an unresolvable host session_id produced empty stdout + exit 0
// — indistinguishable from the EXPECTED empty output during the ~15s
// high-urgency claim-settle window (002 §9.1). Since a bad session_id can
// never resolve (unlike the settle window, which resolves on its own), this
// ONE quiet-return branch now ALWAYS writes a one-line stderr diagnostic,
// regardless of `--debug` — while every other quiet-return branch (including
// the settle window itself) stays silent by default, exactly as before.
describe('hook deliver: always-on unknown-session stderr diagnostic (issue #329)', () => {
  it('help documents the always-on unknown-session_id stderr warning', () => {
    const result = run(['hook', 'deliver', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Always-on STDERR diagnostics');
    expect(result.stdout).toContain('even without --debug');
    expect(result.stdout).toContain(
      'hook deliver: no session registered for host session id "<id>"',
    );
  });

  // Issue #420 P1: the malformed-payload and unmapped-lifecycle branches are
  // also documented as always-on stderr diagnostics.
  it('help documents the always-on malformed-payload and unmapped-lifecycle stderr diagnostics (issue #420 P1)', () => {
    const result = run(['hook', 'deliver', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no session_id in the stdin payload');
    expect(result.stdout).toContain('does not map to a delivery lifecycle');
  });

  // Acceptance: unknown session_id -> stderr warning + empty stdout + exit 0,
  // WITHOUT --debug (the whole point: this is not gated behind the flag).
  it('unknown session_id: warns on stderr even without --debug, stdout stays empty, exit 0', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-329-unknown-'));
    mkdirSync(path.join(ws, '.claude', 'monitors'), { recursive: true });

    const socket = path.join(
      '/tmp',
      `agentmon-329-unk-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'unknown.db');
    const hostSessionId = `known-${Date.now()}`;

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
      // One REAL tracked session exists, but the hook payload names a
      // different, never-opened host session id — the exact repro from the
      // issue (a stale/mistyped session_id can never resolve).
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

      // NO --debug flag here — the whole point of #329 is that this warning
      // fires unconditionally.
      const result = runWithStdinCapture(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: 'verify-host',
          hook_event_name: 'UserPromptSubmit',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      // Contract unchanged: the Claude Code host must see byte-empty stdout.
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'hook deliver: no session registered for host session id "verify-host"\n',
      );
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);

  // Acceptance: a KNOWN session held by the (expected, self-resolving) 15s
  // high-urgency claim-settle window must NOT warn — that would defeat the
  // whole point of distinguishing "will never resolve" from "still settling".
  it('known session held by the settle window: NO stderr warning (silent, as before)', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-329-settle-'));
    const monitorsDir = path.join(ws, '.claude', 'monitors', 'watch-fast');
    mkdirSync(monitorsDir, { recursive: true });

    const watchedFile = path.join(ws, 'watched.txt');
    writeFileSync(watchedFile, 'initial content', 'utf-8');

    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      [
        '---',
        'name: Watch fast',
        'watch:',
        '  type: file-fingerprint',
        '  globs:',
        '    - "watched.txt"',
        `  cwd: ${JSON.stringify(ws)}`,
        '  interval: "1s"',
        'urgency: high',
        // Short notify debounce so the event materializes in ~1s, well
        // short of the SEPARATE 15s claim-time settle window (002 §9.1) —
        // an observably "held" state without a real-clock 15s wait.
        'notify:',
        '  strategy: debounce',
        '  settle-for: "1s"',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-329-settle-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'settle.db');
    const hostSessionId = `settle-${Date.now()}`;

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

      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // Immediately deliver (NO --debug) — the event is materialized
      // (unread) but still well short of the 15s claim-time settle window,
      // so it is genuinely held, not lost. Empty stdout here is EXPECTED and
      // must stay silent on stderr too — this is the exact ambiguity #329's
      // repro flagged, and the fix must not turn it into false-positive noise.
      const result = runWithStdinCapture(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');

      // The event is genuinely held, not lost: still unread and re-discoverable.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);

  // Acceptance: a KNOWN session with a genuinely claimable event delivers
  // exactly as before — the fix touches only the unresolved-session branch.
  it('known session with a claimable event: delivery is unchanged and produces no stderr output', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-329-claim-'));
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
        'urgency: high',
        '---',
        'When files change, review the diff and flag risky changes.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-329-claim-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'claim.db');
    const hostSessionId = `claim-${Date.now()}`;

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

      // Poll for the unread event with a deadline covering the 15s
      // high-urgency settle window plus headroom.
      const eventDeadline = Date.now() + 20_000;
      while (Date.now() < eventDeadline) {
        const result = unread();
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      const result = runWithStdinCapture(
        ['hook', 'deliver'],
        env,
        JSON.stringify({
          session_id: hostSessionId,
          hook_event_name: 'PostToolUse',
          cwd: ws,
        }),
        ws,
      );

      expect(result.exitCode).toBe(0);
      // Delivery is unaffected by the #329 fix: the body is still emitted...
      expect(result.stdout.trim()).not.toBe('');
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toContain(
        'watch-files',
      );
      // ...and a resolved session produces no stderr output whatsoever.
      expect(result.stderr).toBe('');
    } finally {
      daemon.stop();
      await daemon.waitForExit();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 40_000);
});

// Issue #420 P1: the two earliest quiet-return branches (malformed / non-hook
// payload, and an event that maps to no delivery lifecycle) previously printed
// nothing and exited 0 — indistinguishable from "nothing pending," the single
// most-repeated "looks broken, user gives up" moment on the manual path. Both
// now write ONE line to stderr, unconditionally (no --debug), while STDOUT
// stays byte-empty (hook wire compat) and the exit code stays 0. These branches
// return before any socket/daemon work, so no daemon is needed.
describe('hook deliver: always-on malformed-payload / unmapped-lifecycle stderr (issue #420 P1)', () => {
  it('malformed payload (no session_id): stderr warns, stdout stays byte-empty, exit 0', () => {
    const result = runWithStdinCapture(['hook', 'deliver'], {}, '');
    expect(result.exitCode).toBe(0);
    // STDOUT wire contract: byte-empty (the Claude Code host parses stdout).
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'hook deliver: no session_id in the stdin payload — expected a Claude Code ' +
        'hook JSON payload on stdin; nothing delivered.\n',
    );
  });

  it('empty JSON object payload also hits the malformed branch', () => {
    const result = runWithStdinCapture(['hook', 'deliver'], {}, '{}');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no session_id in the stdin payload');
  });

  it('unmapped hook_event_name: stderr names the event, stdout stays byte-empty, exit 0', () => {
    const result = runWithStdinCapture(
      ['hook', 'deliver'],
      {},
      JSON.stringify({
        session_id: 'some-host',
        hook_event_name: 'PreToolUse',
        cwd: '/tmp',
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'hook deliver: hook_event_name "PreToolUse" does not map to a delivery ' +
        'lifecycle (only UserPromptSubmit, PostToolUse, and SessionStart do); ' +
        'nothing delivered.\n',
    );
  });

  it('missing hook_event_name renders as (none), not the literal "undefined"', () => {
    const result = runWithStdinCapture(
      ['hook', 'deliver'],
      {},
      JSON.stringify({ session_id: 'some-host', cwd: '/tmp' }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('hook_event_name (none) does not map');
    expect(result.stderr).not.toContain('undefined');
  });
});

// Issue #270: prove hooks-only (no-MCP) operation is a complete, first-class
// mode — not an implementation accident. Governing spec: docs/specs/006-
// agent-integration.md, new subsection "Operating without MCP" (NP-CH). This
// is the `verified:` reference that subsection points at.
describe('hooks-only delivery parity (issue #270)', () => {
  it('daemon up, monitor fires, hook deliver claims a real stdin payload, events ack acknowledges, events list reflects it — zero MCP/channel involvement', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-hooksonly-'));
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
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-ho-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'hooks-only.db');
    const hostSessionId = `hooks-only-${Date.now()}`;
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });

    // Deliberately NO CLAUDE_CODE_SESSION_ID: that env var is the
    // channel/MCP transport's session-binding signal (006 §4.4). Every
    // command below resolves the host session id from the hook STDIN
    // payload instead (006 §5.0) — this is what makes the flow hooks-only.
    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

    try {
      // 1. Daemon up — the hook-driven lazy-boot command (`session start`),
      //    fed a real SessionStart stdin payload exactly as the plugin's
      //    hooks.json wires it (006 §5.6). Nothing in this flow spawns an
      //    MCP server or imports the channel transport (channel.ts).
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

      // 2. Monitor fires — mutate the watched file after the baseline tick,
      //    then wait for the resulting event to materialize.
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
      const eventDeadline = Date.now() + 10_000;
      while (Date.now() < eventDeadline) {
        const r = unread();
        if (
          r.exitCode === 0 &&
          (JSON.parse(r.stdout) as unknown[]).length >= 1
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const unreadEvents = JSON.parse(unread().stdout) as { id: string }[];
      expect(unreadEvents).toHaveLength(1);
      const [unreadEvent] = unreadEvents;
      if (!unreadEvent) throw new Error('expected exactly one unread event');
      const eventId = unreadEvent.id;

      // 3. Delivery claimed via `hook deliver`, fed a real UserPromptSubmit
      //    stdin payload — the same wire contract Claude Code uses (006
      //    §5.0). This is the hooks/CLI equivalent of the channel
      //    transport's outbound push (channel.ts's poll loop, which also
      //    calls claimDeliveryClient — confirmed statically in
      //    channel-hooks-ipc-parity.test.ts): same daemon IPC call
      //    (`hook.claim`), different transport.
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
      const deliverOutput = JSON.parse(deliver.stdout) as {
        continue: boolean;
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      };
      expect(deliverOutput.continue).toBe(true);
      expect(deliverOutput.hookSpecificOutput.hookEventName).toBe(
        'UserPromptSubmit',
      );
      expect(
        deliverOutput.hookSpecificOutput.additionalContext.trim(),
      ).not.toBe('');

      // Claiming is not acknowledging (BP2/SP4): the event is still unread.
      expect(JSON.parse(unread().stdout)).toHaveLength(1);

      // 4. Acknowledged via `events ack` — the CLI/hooks equivalent of the
      //    `agentmon_ack` MCP tool. The tool's entire job (channel.ts) is to
      //    route through acknowledgeEventsClient, the exact function
      //    `events ack` calls below (confirmed statically in
      //    channel-hooks-ipc-parity.test.ts) — same daemon IPC call
      //    (`events.ack`), CLI surface instead of MCP.
      const ack = runWithEnv(
        ['events', 'ack', '--session', sessionId, '--socket', socket],
        env,
        ws,
      );
      expect(ack.exitCode).toBe(0);

      // 5. `events list` shows the acknowledged state: gone from --unread,
      //    still present in the full listing (acknowledged, not deleted).
      expect(JSON.parse(unread().stdout)).toHaveLength(0);
      const all = runWithEnv(
        [
          'events',
          'list',
          '--session',
          sessionId,
          '--format',
          'json',
          '--socket',
          socket,
        ],
        env,
        ws,
      );
      expect(all.exitCode).toBe(0);
      const allEvents = JSON.parse(all.stdout) as { id: string }[];
      expect(allEvents.map((e) => e.id)).toContain(eventId);

      // Deregister, hooks-only, via the same stdin contract.
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
    } finally {
      // No orphan daemons: stop the per-workspace daemon explicitly (it was
      // lazily spawned by `session start`, so there is no `daemon` handle).
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        // already stopped — ignore
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Channel reserve → commit/release delivery cycle (issue #300)
//
// Drives the REAL channel delivery cycle (`runChannelDeliveryCycle` from
// channel.ts) against a REAL daemon over its socket, injecting only the one
// thing that cannot run in CI — the MCP `notifications/claude/channel` push
// (channels are research-preview, 006 §4/§6). Everything else is the production
// path: the daemon's `hook.reserve`/`hook.commit`/`hook.release` IPC and the
// core reserve/commit/release state machine.
//
// The bug (issue #300): the channel claimed the delivery BEFORE it knew the push
// succeeded, so a rejected/disconnected push permanently consumed the delivery —
// the hook transport then suppressed it as a cross-transport duplicate. The fix
// reserves (leases without claiming), pushes, and commits only on success; a
// failed push releases the lease so the hook path re-delivers. The
// "rejected push → hook fallback still surfaces it" test below FAILS against the
// pre-fix claim-before-push ordering (the row would already be claimed) and
// passes with the fix.
// ---------------------------------------------------------------------------
describe('channel reserve → commit/release delivery cycle (issue #300)', () => {
  interface ChannelCycleFixture {
    ws: string;
    socket: string;
    sessionId: string;
    env: Record<string, string>;
    eventId: string;
  }

  // Boot a real daemon with ONE settled normal-urgency event projected into a
  // registered lead session, ready for a `turn-interruptible` delivery. Normal
  // urgency (not high) so there is no 15s settle wait — the reserve/commit/
  // release orchestration under test is identical across urgency branches.
  async function setupChannelCycle(
    label: string,
  ): Promise<ChannelCycleFixture> {
    const ws = mkdtempSync(path.join(tmpdir(), `agentmon-chcycle-${label}-`));
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
        'urgency: normal',
        '---',
        'When files change, review them.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const socket = path.join(
      '/tmp',
      `agentmon-cc-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const db = path.join(ws, 'channel-cycle.db');
    const hostSessionId = `chcycle-${label}-${Date.now()}`;
    writeLocalState(ws, { enabled: true, socket, db, reapAfterMs: 30_000 });
    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: ws,
      AGENTMONITORS_DB: db,
      AGENTMONITORS_SOCKET: socket,
    };

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
    expect(await daemonAvailable(socket)).toBe(true);

    const sessions = JSON.parse(
      runWithEnv(
        ['session', 'list', '--socket', socket, '--format', 'json'],
        env,
        ws,
      ).stdout,
    ) as { id: string; hostSessionId: string }[];
    const sessionId =
      sessions.find((s) => s.hostSessionId === hostSessionId)?.id ?? '';
    expect(sessionId).not.toBe('');

    // Fire the monitor exactly once after the baseline tick.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    writeFileSync(watchedFile, 'changed content', 'utf-8');

    const unreadJson = () =>
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
      ).stdout;
    const deadline = Date.now() + 10_000;
    let eventId = '';
    while (Date.now() < deadline) {
      const events = JSON.parse(unreadJson()) as { id: string }[];
      if (events.length >= 1) {
        eventId = events[0]?.id ?? '';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(eventId).not.toBe('');

    return { ws, socket, sessionId, env, eventId };
  }

  function deliveryStateOf(f: ChannelCycleFixture): string | undefined {
    const events = JSON.parse(
      runWithEnv(
        [
          'events',
          'list',
          '--session',
          f.sessionId,
          '--format',
          'json',
          '--socket',
          f.socket,
        ],
        f.env,
        f.ws,
      ).stdout,
    ) as { id: string; deliveryState?: string }[];
    return events.find((e) => e.id === f.eventId)?.deliveryState;
  }

  function unreadCount(f: ChannelCycleFixture): number {
    return (
      JSON.parse(
        runWithEnv(
          [
            'events',
            'list',
            '--session',
            f.sessionId,
            '--unread',
            '--format',
            'json',
            '--socket',
            f.socket,
          ],
          f.env,
          f.ws,
        ).stdout,
      ) as unknown[]
    ).length;
  }

  async function teardown(f: ChannelCycleFixture): Promise<void> {
    try {
      await callDaemon('stop', {}, { socketPath: f.socket });
    } catch {
      // already stopped
    }
    rmSync(f.ws, { recursive: true, force: true });
  }

  it('successful push commits the claim: rows become claimed (surfaced), deduped from the hook path, still unacknowledged', async () => {
    const f = await setupChannelCycle('ok');
    try {
      let pushed: unknown;
      const outcome = await runChannelDeliveryCycle(
        f.sessionId,
        f.socket,
        (claim) => {
          pushed = claim;
          return Promise.resolve();
        },
      );

      expect(outcome).toBe('surfaced');
      expect(pushed).toBeDefined();
      // Claimed ("was surfaced"), and the hook transport now sees nothing to
      // claim (cross-transport dedup, 006 §4.5).
      expect(deliveryStateOf(f)).toBe('claimed');
      expect(
        await claimDeliveryClient(f.sessionId, 'turn-interruptible', f.socket),
      ).toBeNull();
      // Claim is never acknowledgement (BP2): still unread.
      expect(unreadCount(f)).toBe(1);
    } finally {
      await teardown(f);
    }
  }, 30_000);

  it('rejected push releases the reservation: the event stays unclaimed and the hook path still surfaces it (regression: pre-fix this was permanently consumed)', async () => {
    const f = await setupChannelCycle('reject');
    try {
      const outcome = await runChannelDeliveryCycle(f.sessionId, f.socket, () =>
        Promise.reject(new Error('MCP transport disconnected')),
      );

      expect(outcome).toBe('push-failed');
      // The row was NEVER claimed — a transient disconnect must not consume the
      // only delivery opportunity (criterion 2 + 5).
      expect(deliveryStateOf(f)).toBe('unread');
      expect(unreadCount(f)).toBe(1);

      // Fallback: the hook transport claims and surfaces it. Against the pre-fix
      // claim-before-push ordering the row would already be claimed and this
      // claim would return null — this assertion is the regression guard.
      const fallback = await claimDeliveryClient(
        f.sessionId,
        'turn-interruptible',
        f.socket,
      );
      expect(fallback).not.toBeNull();
      expect(deliveryStateOf(f)).toBe('claimed');
    } finally {
      await teardown(f);
    }
  }, 30_000);

  it('retry after a rejected push: the next cycle re-reserves and commits the same delivery', async () => {
    const f = await setupChannelCycle('retry');
    try {
      const failed = await runChannelDeliveryCycle(f.sessionId, f.socket, () =>
        Promise.reject(new Error('MCP transport disconnected')),
      );
      expect(failed).toBe('push-failed');
      expect(deliveryStateOf(f)).toBe('unread');

      const retried = await runChannelDeliveryCycle(f.sessionId, f.socket, () =>
        Promise.resolve(),
      );
      expect(retried).toBe('surfaced');
      expect(deliveryStateOf(f)).toBe('claimed');
    } finally {
      await teardown(f);
    }
  }, 30_000);

  it('hook/channel race: a concurrent hook claim during the push finds the leased row hidden (no double-surface)', async () => {
    const f = await setupChannelCycle('race');
    try {
      // Run a concurrent hook claim WHILE the reservation is held (inside the
      // push, before commit). It must find nothing — the row is leased, so the
      // two transports cannot both surface it (006 §4.5).
      let concurrentClaim: unknown = 'unset';
      const outcome = await runChannelDeliveryCycle(
        f.sessionId,
        f.socket,
        async () => {
          concurrentClaim = await claimDeliveryClient(
            f.sessionId,
            'turn-interruptible',
            f.socket,
          );
        },
      );

      expect(outcome).toBe('surfaced');
      expect(concurrentClaim).toBeNull();
      // Surfaced exactly once (by the channel), and now claimed.
      expect(deliveryStateOf(f)).toBe('claimed');
      expect(unreadCount(f)).toBe(1);
    } finally {
      await teardown(f);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Owner-only local data through the real binary (issue #292)
//
// The unit/integration suites prove each helper forces owner-only modes; this
// UAT drives the actual built `agentmonitors` binary under an explicit
// permissive umask to prove nothing in the real wiring resets the umask or
// bypasses the hardening before the database reaches disk. Uses `daemon once`
// (single in-process tick, no socket, no long-running process) so there is no
// orphan-daemon risk. `-wal`/`-shm` are checkpointed away when the one-shot
// process exits, so their owner-only modes are asserted in-process against the
// live connection in `libs/core/src/inbox/db-permissions.test.ts` instead.
// ---------------------------------------------------------------------------
describe.skipIf(process.platform === 'win32')(
  'owner-only local data via the real binary (issue #292)',
  () => {
    it('creates the database 0600 in a 0700 directory under a permissive umask', () => {
      const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-perms-uat-'));
      try {
        const dbPath = path.join(ws, 'data', 'inbox.db');
        // `sh -c 'umask 0022; exec node "$0" "$@"' <CLI> daemon once ...` sets an
        // explicit permissive umask for the child before it opens the database,
        // so a raw create would otherwise yield world-readable 0644/0755.
        const result = spawnSync(
          'sh',
          [
            '-c',
            'umask 0022; exec node "$0" "$@"',
            CLI_PATH,
            'daemon',
            'once',
            '--workspace',
            ws,
          ],
          {
            encoding: 'utf-8',
            cwd: ws,
            env: { ...process.env, AGENTMONITORS_DB: dbPath },
          },
        );
        expect(result.status).toBe(0);

        expect(existsSync(dbPath)).toBe(true);
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Inbox commands fail cleanly (not with a raw stack trace) when the database
// cannot be opened (issue #292 review). The six subcommands construct the db
// via a bare `createDb`; a failure there must reach the CLI's error handling
// and exit non-zero with a clean message, not crash with an unhandled throw.
// ---------------------------------------------------------------------------
describe('inbox commands fail cleanly on an unopenable database (issue #292)', () => {
  it('inbox list exits 1 with a clean error and no raw stack trace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-inbox-err-'));
    try {
      // A regular file sits where the db's parent directory should be, so the
      // db's directory setup fails. Previously this surfaced as an uncaught
      // throw with a raw stack; it must now be a clean `Error: …` + exit 1.
      const blocker = path.join(root, 'blocker');
      writeFileSync(blocker, 'x');
      const dbPath = path.join(blocker, 'inbox.db');

      const result = spawnSync('node', [CLI_PATH, 'inbox', 'list'], {
        encoding: 'utf-8',
        env: { ...process.env, AGENTMONITORS_DB: dbPath },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error:');
      // A clean reported error, not an unhandled exception stack trace.
      expect(result.stderr).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ephemeral monitors — `watch` verbs (007 §4 / 005 §14.4), issue #312.
//
// Drives the REAL daemon IPC and the REAL CLI contract (not a hand-built
// approximation): `session open` → `watch declare` → the daemon ticks the
// ephemeral monitor on the SAME pipeline → it materializes an event that
// projects into the DECLARING session only → hook-state + `hook claim`
// delivery surfaces it → `watch cancel` reaps it.
// ---------------------------------------------------------------------------
describe('ephemeral monitors: watch declare/list/cancel (007 §4 / 005 §14.4)', () => {
  it('declares, fires into the declaring session ONLY, delivers, and cancels', async () => {
    const dir = path.join(tempDir, 'watch-declare');
    const monitorsDir = path.join(dir, '.claude', 'monitors');
    mkdirSync(monitorsDir, { recursive: true });

    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `am-watch-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
    );
    const env = {
      AGENTMONITORS_DB: dbPath,
      AGENTMONITORS_SOCKET: socketPath,
    };
    const daemon = await startDaemon(monitorsDir, dir, env, socketPath);

    try {
      // Two lead sessions in the SAME workspace: the declaring one and a sibling.
      const openSession = (host: string) => {
        const result = runWithEnv(
          [
            'session',
            'open',
            '--host-session-id',
            host,
            '--workspace',
            dir,
            '--format',
            'json',
          ],
          env,
          dir,
        );
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout) as {
          id: string;
          hookStatePath: string;
        };
      };
      const declaring = openSession('claude-watch-declaring');
      const sibling = openSession('claude-watch-sibling');

      // Declare an ephemeral monitor bound to the declaring session. The
      // `schedule` source fires on the daemon's next due tick.
      const declare = runWithEnv(
        [
          'watch',
          'declare',
          'schedule',
          '--session',
          declaring.id,
          '--scope',
          'cron=* * * * *',
          '--instruction',
          'Ephemeral schedule tick — review it.',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(declare.exitCode).toBe(0);
      const record = JSON.parse(declare.stdout) as {
        id: string;
        status: string;
        sessionId: string;
        sourceName: string;
      };
      // Namespaced runtime identity (007 §4.3).
      expect(record.id.startsWith('ephemeral:')).toBe(true);
      expect(record.id).toContain(declaring.id);
      expect(record.status).toBe('active');
      expect(record.sessionId).toBe(declaring.id);
      expect(record.sourceName).toBe('schedule');

      // `watch list` is session-scoped (isolation): the declaring session sees
      // it; the sibling does not.
      const listDeclaring = runWithEnv(
        ['watch', 'list', '--session', declaring.id, '--format', 'json'],
        env,
        dir,
      );
      expect(listDeclaring.exitCode).toBe(0);
      expect(JSON.parse(listDeclaring.stdout)).toHaveLength(1);
      const listSibling = runWithEnv(
        ['watch', 'list', '--session', sibling.id, '--format', 'json'],
        env,
        dir,
      );
      expect(listSibling.exitCode).toBe(0);
      expect(JSON.parse(listSibling.stdout)).toHaveLength(0);

      // Wait for the daemon to tick the ephemeral monitor and materialize an
      // event for the declaring session.
      const unreadFor = (id: string) =>
        runWithEnv(
          ['events', 'list', '--session', id, '--unread', '--format', 'json'],
          env,
          dir,
        );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = unreadFor(declaring.id);
        if (result.exitCode === 0 && JSON.parse(result.stdout).length >= 1) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const declaringEvents = JSON.parse(unreadFor(declaring.id).stdout) as {
        monitorId: string;
      }[];
      expect(declaringEvents.length).toBeGreaterThanOrEqual(1);
      // The event belongs to the EPHEMERAL monitor — it flowed the identical
      // pipeline as a persistent monitor (007 §4.6).
      expect(declaringEvents[0]?.monitorId).toBe(record.id);

      // Projection isolation (007 §4.6, criterion 4): the sibling lead session in
      // the SAME workspace receives NOTHING from the ephemeral monitor.
      expect(JSON.parse(unreadFor(sibling.id).stdout)).toHaveLength(0);

      // Same transports (007 §4.6, criterion 5): the hook-state file reflects the
      // unread event for the declaring session, and NOT for the sibling.
      const declaringHookState = JSON.parse(
        readFileSync(declaring.hookStatePath, 'utf-8'),
      ) as { unread: { normal: number; total: number } };
      expect(declaringHookState.unread.total).toBeGreaterThanOrEqual(1);
      expect(declaringHookState.unread.normal).toBeGreaterThanOrEqual(1);
      const siblingHookState = JSON.parse(
        readFileSync(sibling.hookStatePath, 'utf-8'),
      ) as { unread: { total: number } };
      expect(siblingHookState.unread.total).toBe(0);

      // Delivery transport: `hook claim` surfaces the ephemeral event to the
      // declaring session (normal-urgency coalesced reminder), and returns null
      // for the sibling.
      const claimDeclaring = runWithEnv(
        [
          'hook',
          'claim',
          '--session',
          declaring.id,
          '--lifecycle',
          'turn-interruptible',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(claimDeclaring.exitCode).toBe(0);
      const claim = JSON.parse(claimDeclaring.stdout) as {
        mode: string;
        urgency: string;
      } | null;
      expect(claim?.mode).toBe('delivery');
      expect(claim?.urgency).toBe('normal');

      const claimSibling = runWithEnv(
        [
          'hook',
          'claim',
          '--session',
          sibling.id,
          '--lifecycle',
          'turn-interruptible',
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(claimSibling.exitCode).toBe(0);
      expect(JSON.parse(claimSibling.stdout)).toBeNull();

      // `watch cancel` immediately reaps the monitor (007 §4.4).
      const cancel = runWithEnv(
        [
          'watch',
          'cancel',
          record.id,
          '--session',
          declaring.id,
          '--format',
          'json',
        ],
        env,
        dir,
      );
      expect(cancel.exitCode).toBe(0);
      expect(JSON.parse(cancel.stdout).status).toBe('reaped');
      const listAfterCancel = runWithEnv(
        ['watch', 'list', '--session', declaring.id, '--format', 'json'],
        env,
        dir,
      );
      expect(JSON.parse(listAfterCancel.stdout)).toHaveLength(0);
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);

  it('rejects an invalid scope identically to `validate` (criterion 1)', async () => {
    const dir = path.join(tempDir, 'watch-scope-parity');
    const monitorsDir = path.join(dir, '.claude', 'monitors', 'bad-schedule');
    mkdirSync(monitorsDir, { recursive: true });
    // A schedule monitor missing the required `cron` — invalid scope.
    writeFileSync(
      path.join(monitorsDir, 'MONITOR.md'),
      `---
watch:
  type: schedule
  timezone: UTC
urgency: normal
---
Bad schedule scope.
`,
      'utf-8',
    );

    // Path 1: `validate` rejects the file and reports the scope error.
    const validate = run(
      ['validate', path.join(dir, '.claude', 'monitors'), '--format', 'json'],
      dir,
    );
    expect(validate.exitCode).toBe(1);
    const validateOutput = JSON.parse(validate.stdout) as {
      errors: { error: string }[];
    };
    const scopeError = validateOutput.errors[0]?.error;
    expect(scopeError).toBeTruthy();
    expect(scopeError).toContain('cron');

    // Path 2: `watch declare` rejects the SAME bad scope through the SAME
    // validateScope path — the error message contains the identical scope
    // diagnosis.
    const dbPath = path.join(dir, 'agentmon.db');
    const socketPath = path.join(
      '/tmp',
      `am-parity-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
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
      const open = runWithEnv(
        [
          'session',
          'open',
          '--host-session-id',
          'claude-parity',
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

      const declare = runWithEnv(
        [
          'watch',
          'declare',
          'schedule',
          '--session',
          session.id,
          '--scope',
          'timezone=UTC',
          '--format',
          'text',
        ],
        env,
        dir,
      );
      expect(declare.exitCode).toBe(1);
      // The SAME validateScope diagnosis surfaces in both paths.
      expect(`${declare.stdout}${declare.stderr}`).toContain(
        scopeError as string,
      );
    } finally {
      daemon.stop();
      await daemon.waitForExit();
    }
  }, 30_000);
});
