/**
 * Owned-process harness shared by ingress and terminal-retry acceptance.
 * Commands advance a fixed clock; IPC barriers observe real driver execution.
 * Only child handles created here confer signal authority, and cleanup reaps
 * each child and its process group before releasing its private resources.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeTickResult } from '@agentmonitors/core';
import { callDaemon } from '../daemon-ipc.js';
// @ts-expect-error -- Shared native-JavaScript test utility has no declaration file.
import { waitForOwnedGroupTermination } from '../../../../scripts/owned-test-group.mjs';

/** A mutation probe may select a scratch copy; normal/CI execution uses the built CLI. @internal */
export const cli =
  process.env['INGRESS_TEST_CLI'] ??
  path.resolve(import.meta.dirname, '../../dist/index.cjs');
const preload = path.join(import.meta.dirname, 'fixtures/ingress-preload.mjs');
/** Fixed wall time controls scheduling; parent timeout budgets use its real clock. @internal */
export const epoch = Date.parse('2026-01-01T00:00:02Z');
/** Private instrumentation messages contain original results or observed driver writes. @internal */
export interface Message {
  kind: string;
  [key: string]: unknown;
}
/** Source acquisition path exercised by the fixture. @internal */
export type Source = 'poll' | 'watch';
/** Runtime-owned pacing retained in the source envelope. @internal */
export type Policy = 'immediate' | 'debounce' | 'rollup';
/** Only this direct-child handle confers authority to signal a test daemon. @internal */
export interface Owned {
  child: ChildProcess;
  messages: Message[];
  changed: EventEmitter;
  exit: Promise<void>;
  dead: boolean;
  signal?: NodeJS.Signals | null;
  stopped?: Promise<void>;
  output: string;
}

/** A deadline is a failure bound, never a successful synchronization signal. @internal */
export async function bounded<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded 10s`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Consume a previously observed or future message without polling or sleeps. @internal */
export async function message(
  owned: Owned,
  predicate: (value: Message) => boolean,
): Promise<Message> {
  let release: (() => void) | undefined;
  try {
    return await bounded(
      new Promise<Message>((resolve, reject) => {
        const check = () => {
          // A caught runtime error must not hide a missing inventory classification.
          const unclassified = owned.messages.find(
            (value) => value.kind === 'unclassified-write',
          );
          if (unclassified) {
            reject(new Error(String(unclassified['message'])));
            return;
          }
          const index = owned.messages.findIndex(predicate);
          if (index >= 0) {
            const found = owned.messages.splice(index, 1)[0];
            if (found) resolve(found);
          } else if (owned.dead) reject(new Error('Owned daemon exited'));
        };
        release = () => owned.changed.off('change', check);
        owned.changed.on('change', check);
        check();
      }),
      'Instrumentation message',
    );
  } catch (error) {
    throw new Error(
      `${String(error)}\n${owned.output}\n${JSON.stringify(owned.messages)}`,
      { cause: error },
    );
  } finally {
    release?.();
  }
}

/** Always reap the exact child before unlinking its socket or database. @internal */
export async function stop(owned: Owned): Promise<void> {
  owned.stopped ??= (async () => {
    if (!owned.dead) owned.child.kill('SIGKILL');
    await bounded(owned.exit, 'Owned daemon exit');
  })();
  await owned.stopped;
}

/** Real loopback HTTP, filesystem, socket, sessions and SQLite all belong to one case. @internal */
export async function fixture(source: Source, policy: Policy) {
  const root = mkdtempSync(path.join(tmpdir(), 'am-ingress-'));
  const socket = path.join(root, 'd.sock');
  const dbPath = path.join(root, 'inbox.db');
  const monitors = path.join(root, 'monitors');
  let body = 'baseline';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP address');
  mkdirSync(path.join(monitors, source), { recursive: true });
  const watched = path.join(root, 'watched.txt');
  writeFileSync(watched, body);
  const watchConfig =
    source === 'poll'
      ? `  type: api-poll\n  url: http://127.0.0.1:${String(address.port)}/\n`
      : `  type: file-fingerprint\n  globs: ['watched.txt']\n  cwd: ${JSON.stringify(root)}\n`;
  const notify =
    policy === 'immediate'
      ? ''
      : policy === 'debounce'
        ? 'notify:\n  strategy: debounce\n  settle-for: 2s\n'
        : "notify:\n  strategy: rollup\n  window: '* * * * *'\n";
  writeFileSync(
    path.join(monitors, source, 'MONITOR.md'),
    `---\nname: Ingress\nwatch:\n${watchConfig}  interval: 1s\nurgency: normal\n${notify}---\nHandle the change.\n`,
  );
  const children: Owned[] = [];
  const rpc = <T>(
    method: Parameters<typeof callDaemon>[0],
    params: Record<string, unknown> = {},
  ) => callDaemon<T>(method, params, { socketPath: socket, timeoutMs: 10_000 });
  const start = async (now = epoch) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        'daemon',
        'run',
        monitors,
        '--workspace',
        root,
        '--socket',
        socket,
        '--poll-ms',
        '3600000',
        '--reap-after-ms',
        '0',
      ],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          HOME: root,
          XDG_DATA_HOME: path.join(root, 'data'),
          NODE_PATH: path.resolve(import.meta.dirname, '../../node_modules'),
          AGENTMONITORS_DB: dbPath,
          AGENTMONITORS_SOCKET: socket,
          INGRESS_TEST_NOW: String(now),
          INGRESS_TEST_WATCH: source === 'watch' ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let resolveExit!: () => void;
    const owned: Owned = {
      child,
      messages: [],
      changed: new EventEmitter(),
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      dead: false,
      output: '',
    };
    children.push(owned);
    child.on('message', (value: Message) => {
      owned.messages.push(value);
      owned.changed.emit('change');
    });
    child.on('error', (error) => {
      owned.output += error.message;
      owned.dead = true;
      resolveExit();
      owned.changed.emit('change');
    });
    child.on('close', (_code, signal) => {
      owned.signal = signal;
      owned.dead = true;
      resolveExit();
      owned.changed.emit('change');
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        owned.output = (owned.output + chunk.toString()).slice(-65_536);
      });
    await message(owned, (value) => value.kind === 'tick');
    if (source === 'watch')
      await message(owned, (value) => value.kind === 'watch-idle');
    return owned;
  };
  const control = async (owned: Owned, command: Record<string, unknown>) => {
    owned.child.send(command);
    await message(owned, (value) => value.kind === 'controlled');
  };
  const tick = async (
    owned: Owned,
    now: number,
  ): Promise<RuntimeTickResult> => {
    await control(owned, { now });
    // callDaemon has no close rejection; the owned exit bounds an abruptly closed request.
    return bounded(
      Promise.race([
        rpc<RuntimeTickResult>('daemon.tick', {
          monitorsDir: monitors,
          workspacePath: root,
        }),
        owned.exit.then(() => {
          throw new Error('Owned daemon exited during tick');
        }),
      ]),
      'Daemon tick',
    );
  };
  const open = (name: string, role = 'lead') =>
    rpc<{ id: string }>('session.open', {
      adapter: 'claude-code',
      hostSessionId: name,
      role,
      agentIdentity: 'ingress-test',
      hookStatePath: path.join(root, `${name}.json`),
      workspacePath: root,
    });
  let round = 0;
  const observeFile = async (
    owned: Owned,
    now: number,
    flush: boolean,
    expected?: string,
  ) => {
    const currentRound = ++round;
    await control(owned, { now, flush, round: currentRound });
    // Native callbacks may arrive between truncate and write on Linux. One
    // round represents a completed input, with completion ordered by IPC;
    // flush-only rounds never manufacture another filesystem transition.
    if (!flush) writeFileSync(watched, body);
    await control(owned, { writtenRound: currentRound });
    return message(
      owned,
      (value) =>
        value.kind === 'watch-error' ||
        (value.kind === 'watch-idle' &&
          value['round'] === currentRound &&
          (expected === undefined ||
            (Array.isArray(value['snapshots']) &&
              value['snapshots'].includes(expected)))),
    );
  };
  const change = async (owned: Owned, value: string, now: number) => {
    body = value;
    if (source === 'poll') return tick(owned, now);
    return observeFile(owned, now, false, value);
  };
  const flush = (owned: Owned, now: number) =>
    source === 'poll' ? tick(owned, now) : observeFile(owned, now, true);
  return {
    root,
    monitorId: source,
    objectKey:
      source === 'poll' ? `http://127.0.0.1:${String(address.port)}/` : watched,
    dbPath,
    rpc,
    start,
    control,
    tick,
    change,
    flush,
    open,
    cleanup: async () => {
      const stopped = await Promise.allSettled(children.map(stop));
      // Direct exit is enough to restart; group confirmation is required before
      // unlinking fixtures. Check the two exclusively owned groups concurrently.
      const groups = await Promise.allSettled(
        children.map(async (owned) => {
          if (owned.child.pid && process.platform !== 'win32') {
            // Shared native-JS helper has no declaration surface; its process
            // ownership and deadline contract is covered by the script suite.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            await waitForOwnedGroupTermination(
              owned.child.pid,
              Date.now() + 5_000,
            );
          }
        }),
      );
      server.closeAllConnections();
      await bounded(
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
        'HTTP close',
      );
      const failures = [...stopped, ...groups].filter(
        (result) => result.status === 'rejected',
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          'Owned process cleanup failed; fixture retained',
        );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
