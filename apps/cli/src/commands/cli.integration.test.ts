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
        '--source',
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

  // Regression for G1 / SP2: two folders with the same basename derive the same
  // monitor id; validate must fail (exit 1) and name the collision.
  it('rejects duplicate monitor ids', () => {
    const dir = path.join(tempDir, 'validate-dup-test');
    const monitorsDir = path.join(dir, 'monitors');
    const body = [
      '---',
      'name: Dup',
      'source: file-fingerprint',
      'urgency: normal',
      'scope:',
      '  globs: ["*.ts"]',
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
      'source: file-fingerprint',
      'urgency: normal',
      'scope:',
      '  globs: 42',
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
      'source: not-a-real-source',
      'urgency: normal',
      'scope:',
      '  foo: bar',
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
source: file-fingerprint
urgency: normal
scope:
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
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
source: file-fingerprint
urgency: normal
scope:
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
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
  it('emits a source-discriminated monitor JSON schema', () => {
    const result = run(['schema', 'generate']);
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout) as {
      properties?: {
        source?: { enum?: string[] };
        urgency?: { enum?: string[] };
      };
    };
    expect(schema.properties?.source?.enum).toEqual(
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
source: file-fingerprint
urgency: normal
scope:
  globs:
    - watched.txt
  cwd: ${JSON.stringify(dir)}
  interval: '1s'
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
source: incoming-changes
urgency: normal
scope:
  paths:
    - 'docs/specs/**'
    - 'docs/standard/**'
  branch: main
  cwd: ${JSON.stringify(repo)}
  interval: '1s'
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
