/**
 * Numeric options are a CLI admission boundary: malformed input must fail before
 * monitor discovery, daemon contact, or durable state creation. These cases drive
 * the built executable so Commander parsing and output routing are covered too.
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_PATH = path.resolve(import.meta.dirname, '../../dist/index.cjs');
/** A rejected command must exit unaided within the existing CLI startup budget. */
const EXIT_BUDGET_MS = 15_000;

/** The public ranges and defaults specified in 005, independent of implementation. */
const OPTIONS = [
  {
    command: ['daemon', 'run'],
    flag: '--poll-ms',
    min: 1,
    max: 2147483647,
    default: '30000',
    formats: ['text'],
  },
  {
    command: ['daemon', 'run'],
    flag: '--reap-after-ms',
    min: 0,
    max: 2147483647,
    default: '300000',
    formats: ['text'],
  },
  {
    command: ['verify'],
    flag: '--timeout-ms',
    min: 1,
    max: 2147483647,
    default: undefined,
    formats: ['text', 'json'],
  },
  {
    command: ['monitor', 'explain', 'missing'],
    flag: '--history-limit',
    min: 1,
    max: 1000,
    default: '10',
    formats: ['text', 'toon', 'json'],
  },
  {
    command: ['monitor', 'explain', 'missing'],
    flag: '--event-limit',
    min: 1,
    max: 1000,
    default: '10',
    formats: ['text', 'toon', 'json'],
  },
  {
    command: ['monitor', 'history'],
    flag: '--limit',
    min: 1,
    max: 1000,
    default: '50',
    formats: ['text', 'toon', 'json'],
  },
];

let root: string;
let socketPath: string;
let server: net.Server;
let connections: number;
/** Requests admitted by the fake peer, used to verify default query limits. */
let requests: unknown[];

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'am-numeric-'));
  socketPath = path.join(root, 's.sock');
  connections = 0;
  requests = [];
  // A valid reply makes accepted daemon options exit without starting a daemon.
  server = net.createServer((socket) => {
    connections += 1;
    socket.on('data', (data: Buffer) => {
      const request: unknown = JSON.parse(data.toString());
      requests.push(request);
      if (typeof request === 'object' && request !== null && 'id' in request) {
        const result =
          'method' in request && request.method === 'monitor.explain'
            ? { stages: [] }
            : [];
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  // Existing coordination bytes must survive rejection unchanged. A missing
  // monitor also makes premature verification discovery visible in its error.
  writeFileSync(
    path.join(root, '.claude/agentmonitors.local.md'),
    '---\nenabled: true\nclaim-ttl-ms: invalid\n---\n',
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Capture names and regular-file bytes without trying to read the peer socket. */
function filesystemSnapshot() {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).map(
    (name) => {
      const file = path.join(root, name);
      return [
        name,
        statSync(file).isFile() ? readFileSync(file, 'base64') : undefined,
      ];
    },
  );
}

/** Capture both streams until close; kill only this child if it fails to exit. */
async function invoke(args: string[]) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: path.join(root, 'data'),
        AGENTMONITORS_DB: path.join(root, 'state.db'),
        AGENTMONITORS_SOCKET: socketPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, EXIT_BUDGET_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('bounded numeric CLI options', () => {
  for (const option of OPTIONS) {
    describe(`${option.command.join(' ')} ${option.flag}`, () => {
      for (const format of option.formats) {
        it.each([
          '1.5',
          '1junk',
          String(option.min - 1),
          String(option.max + 1),
        ])(
          `rejects %s in ${format} before resolving state`,
          async (raw) => {
            const before = filesystemSnapshot();
            const result = await invoke([
              ...option.command,
              option.flag,
              raw,
              ...(option.command[0] === 'daemon' && format === 'text'
                ? []
                : ['--format', format]),
            ]);
            const message = `${option.flag} must be a whole number from ${String(option.min)} to ${String(option.max)} (got ${JSON.stringify(raw)}).`;
            expect(result).toEqual({
              code: 1,
              stdout:
                format === 'json'
                  ? `${JSON.stringify({ error: message })}\n`
                  : '',
              stderr: format === 'json' ? '' : `Error: ${message}\n`,
            });
            expect(connections).toBe(0);
            expect(filesystemSnapshot()).toEqual(before);
          },
          EXIT_BUDGET_MS + 5_000,
        );
      }
      if (option.default !== undefined) {
        it('retains the documented omitted default', async () => {
          const result = await invoke([
            ...option.command.slice(
              0,
              option.command[1] === 'explain' ? 2 : undefined,
            ),
            '--help',
          ]);
          expect(result.code).toBe(0);
          expect(result.stdout.replace(/\s+/g, ' ')).toContain(
            `(default: "${option.default}")`,
          );
          if (option.command[0] === 'daemon') {
            // Numeric validation must preserve the daemon's existing CLI surface.
            expect(result.stdout).not.toContain('--format');
          }
        });
      }
    });
  }

  it.each([
    {
      command: ['monitor', 'explain', 'missing'],
      params: { historyLimit: 10, eventLimit: 10 },
    },
    { command: ['monitor', 'history'], params: { limit: 50 } },
  ])(
    'passes omitted query defaults to the daemon: $command',
    async ({ command, params }) => {
      const result = await invoke([
        ...command,
        '--socket',
        socketPath,
        '--format',
        'json',
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(requests).toEqual([
        expect.objectContaining({ params: expect.objectContaining(params) }),
      ]);
    },
  );

  it.each([
    ['--reap-after-ms', '0'],
    ['--poll-ms', '2147483647'],
  ])(
    'accepts boundary %s %s and proceeds to daemon availability',
    async (flag, raw) => {
      const result = await invoke([
        'daemon',
        'run',
        flag,
        raw,
        '--socket',
        socketPath,
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `Error: AgentMon daemon is already running at ${socketPath}.\n`,
      );
      expect(connections).toBe(1);
    },
  );
});
