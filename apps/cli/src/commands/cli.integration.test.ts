/**
 * Integration tests for the agentmonitors CLI.
 *
 * These tests spawn the built CLI as a subprocess and verify
 * stdout, stderr, and exit codes.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
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

const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');
const CLI_PACKAGE_DIR = path.resolve(__dirname, '../..');

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
    const result = run(['source', 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('file-fingerprint');
    expect(result.stdout).toContain('api-poll');
    expect(result.stdout).toContain('schedule');
    expect(result.stdout).toContain('incoming-changes');
  });

  it('lists sources in JSON format', () => {
    const result = run(['source', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(4);
    const names = parsed.map((s: { name: string }) => s.name);
    expect(names).toContain('file-fingerprint');
    expect(names).toContain('api-poll');
    expect(names).toContain('schedule');
    expect(names).toContain('incoming-changes');
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
        urgency?: { enum?: string[] };
      };
    };
    expect(schema.properties?.watch?.properties?.type?.enum).toEqual(
      expect.arrayContaining(['file-fingerprint', 'api-poll', 'schedule']),
    );
    // `low` is first-class (PP5)
    expect(schema.properties?.urgency?.enum).toEqual(
      expect.arrayContaining(['low', 'normal', 'high']),
    );
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
  const env = {
    CLAUDE_CODE_SESSION_ID: hostSessionId,
    CLAUDE_PROJECT_DIR: ws,
    AGENTMONITORS_DB: db,
    AGENTMONITORS_SOCKET: socket,
  };

  return { ws, socket, db, env, hostSessionId };
}

describe('lazy daemon lifecycle', () => {
  it('session start boots a per-workspace daemon and registers the session', async () => {
    // Use a short reapAfterMs so an escaped daemon self-cleans (defence-in-depth).
    const { ws, socket, env, hostSessionId } = bootLazyWorkspace(5_000);

    try {
      // session start should lazy-boot the daemon and open the session
      const start = runWithEnv(['session', 'start'], env, ws);
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
      const end = runWithEnv(['session', 'end'], env, ws);
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
    const { ws, socket, env } = bootLazyWorkspace(reapAfterMs);

    // bootLazyWorkspace already wrote local state with the explicit socket/db.
    // No overwrite needed — the reapAfterMs is already in the state.

    try {
      // Boot + register
      const start = runWithEnv(['session', 'start'], env, ws);
      expect(start.exitCode).toBe(0);
      expect(await daemonAvailable(socket)).toBe(true);

      // End the session — daemon should become idle
      const end = runWithEnv(['session', 'end'], env, ws);
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
    const envA = {
      CLAUDE_CODE_SESSION_ID: hostIdA,
      CLAUDE_PROJECT_DIR: wsA,
    };
    const envB = {
      CLAUDE_CODE_SESSION_ID: hostIdB,
      CLAUDE_PROJECT_DIR: wsB,
    };

    try {
      // Start both sessions — each gets its own daemon
      const startA = runWithEnv(['session', 'start'], envA, wsA);
      expect(startA.exitCode).toBe(0);
      const startB = runWithEnv(['session', 'start'], envB, wsB);
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
      runWithEnv(['session', 'end'], envA, wsA);
      runWithEnv(['session', 'end'], envB, wsB);
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
