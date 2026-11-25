import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentMonitorRuntime,
  createDb,
  RuntimeStore,
  SourceRegistry,
} from '@agentmonitors/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { expect, it, vi } from 'vitest';
import { callDaemon, createDaemonServer } from '../daemon-ipc.js';
import { registerChannelToolHandlers } from './channel.js';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../../dist/index.cjs');

it('surfaces unacknowledged posts on schedule and stops after needs-attention', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'am-post-'));
  const socketPath = path.join(root, 'daemon.sock');
  const dbPath = path.join(root, 'runtime.db');
  const start = Date.UTC(2026, 0, 1);
  const runtimeForDb = () =>
    new AgentMonitorRuntime(
      new RuntimeStore(createDb(dbPath)),
      new SourceRegistry(),
    );
  const run = async (...args: string[]) =>
    (
      await exec(process.execPath, [cli, ...args, '--socket', socketPath], {
        timeout: 5000,
      })
    ).stdout.trim();
  const open = (runtime: AgentMonitorRuntime, hostSessionId: string) =>
    runtime.openSession({
      adapter: 'claude-code',
      hostSessionId,
      agentIdentity: hostSessionId,
      hookStatePath: path.join(root, `${hostSessionId}.json`),
      workspacePath: root,
    }).id;

  vi.setSystemTime(start);
  let runtime = runtimeForDb();
  let server = createDaemonServer({ runtime, socketPath });
  try {
    const session = open(runtime, 'recipient');
    const sibling = open(runtime, 'sibling');
    await server.listen();
    const post = (body: string) =>
      run(
        'post',
        body,
        '--session',
        session,
        '--require-ack',
        '--resurface-after-ms',
        '100',
        '--max-resurfaces',
        '1',
      );
    const claim = async (
      id = session,
      lifecycle = 'turn-interruptible',
    ): Promise<unknown> =>
      JSON.parse(
        await run('hook', 'claim', '--session', id, '--lifecycle', lifecycle),
      ) as unknown;
    const list = async (): Promise<unknown> =>
      JSON.parse(
        await run('events', 'list', '--session', session, '--format', 'json'),
      ) as unknown;

    await expect(
      run(
        'post',
        'invalid',
        '--session',
        session,
        '--resurface-after-ms',
        '100',
      ),
    ).rejects.toThrow('Resurfacing options require acknowledgement');
    const unanswered = await post('Check the release.');
    const answered = await post('Review the notes.');
    const coreAnswered = await post('Check the build.');
    const channelAnswered = await post('Review the changes.');
    const informational = await run(
      'post',
      'The build passed.',
      '--session',
      session,
    );
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unanswered, messageState: 'pending' }),
      ]),
    );
    expect(runtime.listEvents()).toEqual([]);
    expect(await claim(sibling)).toBeNull();
    runtime.acknowledgeSession(sibling, [unanswered]);
    expect(await claim()).toMatchObject({
      events: [
        { eventId: unanswered, body: 'Check the release.' },
        { eventId: answered, body: 'Review the notes.' },
        { eventId: coreAnswered },
        { eventId: channelAnswered },
        { eventId: informational, body: 'The build passed.' },
      ],
    });
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unanswered, messageState: 'delivered' }),
      ]),
    );
    await run('events', 'ack', '--session', session, '--event-ids', answered);

    runtime.acknowledgeSession(session, [coreAnswered]);
    const channel = new Server(
      { name: 'post-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    registerChannelToolHandlers(channel, {
      resolveSession: () => Promise.resolve(session),
      socketPath,
    });
    const client = new Client({ name: 'post-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        channel.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: 'agentmon_ack',
        arguments: { event_ids: [channelAnswered] },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await channel.close();
    }
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: coreAnswered, messageState: 'acked' }),
        expect.objectContaining({ id: channelAnswered, messageState: 'acked' }),
      ]),
    );

    vi.setSystemTime(start + 99);
    expect(await claim(session, 'post-compact')).toBeNull();
    await server.close();
    runtime = runtimeForDb();
    server = createDaemonServer({ runtime, socketPath });
    await server.listen();

    vi.setSystemTime(start + 100);
    // A failed transport attempt returns the offer without spending its budget.
    const reservation = runtime.reserveDelivery(session, 'turn-interruptible');
    expect(reservation).not.toBeNull();
    expect(await claim(session, 'post-compact')).toBeNull();
    if (!reservation) throw new Error('Expected a delivery reservation.');
    runtime.releaseDelivery(reservation.reservationId);
    expect(await claim()).toMatchObject({
      events: [
        {
          eventId: unanswered,
          title: 'Message resurfaced (acknowledgement required)',
        },
      ],
    });
    expect(await claim(session, 'post-compact')).toBeNull();
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unanswered, messageState: 'resurfaced' }),
        expect.objectContaining({ id: answered, messageState: 'acked' }),
        expect.objectContaining({
          id: informational,
          messageState: 'delivered',
        }),
      ]),
    );

    vi.setSystemTime(start + 200);
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unanswered,
          messageState: 'needs-attention',
        }),
      ]),
    );
    expect(await claim()).toMatchObject({
      events: [
        {
          eventId: unanswered,
          title: 'Message needs-attention (acknowledgement required)',
        },
      ],
    });

    vi.setSystemTime(start + 1000);
    expect(await claim()).toBeNull();
    expect(await claim(session, 'post-compact')).toBeNull();
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unanswered,
          messageState: 'needs-attention',
        }),
        expect.objectContaining({ id: answered, messageState: 'acked' }),
      ]),
    );
    runtime.acknowledgeSession(session, [unanswered]);
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unanswered, messageState: 'acked' }),
      ]),
    );
  } finally {
    await server.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

async function withPostSession(
  test: (fixture: {
    root: string;
    socketPath: string;
    hookStatePath: string;
    sessionId: string;
    runtime: AgentMonitorRuntime;
    post: (
      body: string,
      ...options: string[]
    ) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'am-post-'));
  const socketPath = path.join(root, 'daemon.sock');
  const hookStatePath = path.join(root, 'hook.json');
  const runtime = new AgentMonitorRuntime(
    new RuntimeStore(createDb(path.join(root, 'runtime.db'))),
    new SourceRegistry(),
  );
  const server = createDaemonServer({ runtime, socketPath });

  try {
    const { id: sessionId } = runtime.openSession({
      adapter: 'claude-code',
      hostSessionId: 'recipient',
      agentIdentity: 'recipient',
      hookStatePath,
      workspacePath: root,
    });
    await server.listen();
    const post = (body: string, ...options: string[]) =>
      exec(
        process.execPath,
        [
          cli,
          'post',
          body,
          '--session',
          sessionId,
          '--socket',
          socketPath,
          ...options,
        ],
        { timeout: 5000 },
      );
    await test({ root, socketPath, hookStatePath, sessionId, runtime, post });
  } finally {
    await server.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(['initial', 'final'])(
  'preserves a %s post offer omitted from a bounded recap',
  async (offer) => {
    await withPostSession(
      async ({ root, socketPath, runtime, sessionId, post }) => {
        mkdirSync(path.join(root, '.claude'));
        writeFileSync(
          path.join(root, '.claude/agentmonitors.local.md'),
          '---\nenabled: true\n---\n',
        );
        const recap = async () => {
          const child = exec(
            process.execPath,
            [
              cli,
              'hook',
              'deliver',
              '--socket',
              socketPath,
              '--format',
              'text',
            ],
            { timeout: 5000 },
          );
          child.child.stdin?.end(
            JSON.stringify({
              session_id: 'recipient',
              hook_event_name: 'SessionStart',
              cwd: root,
            }),
          );
          return (await child).stdout.trim();
        };
        const start = Date.UTC(2026, 0, 1);
        vi.setSystemTime(start);
        const options =
          offer === 'final'
            ? [
                '--require-ack',
                '--resurface-after-ms',
                '100',
                '--max-resurfaces',
                '0',
              ]
            : [];
        const long = await post('L'.repeat(8000), ...options);
        const short = await post('Short recap message', ...options);
        if (offer === 'final') {
          expect(
            runtime.claimDelivery(sessionId, 'turn-interruptible')?.events,
          ).toMatchObject([
            { eventId: long.stdout.trim() },
            { eventId: short.stdout.trim() },
          ]);
          vi.setSystemTime(start + 100);
        }
        const first = await recap();
        expect(first.length).toBeLessThanOrEqual(4000);
        expect(first).toContain(long.stdout.trim());
        expect(first).not.toContain(short.stdout.trim());
        const second = await recap();
        expect(second).toContain('Short recap message');
        if (offer === 'final') expect(second).toContain('needs-attention');
        expect(await recap()).toBe('');
      },
    );
  },
  30_000,
);

it('returns the committed post ID when hook-state refresh fails', async () => {
  await withPostSession(
    async ({ hookStatePath, sessionId, socketPath, post }) => {
      rmSync(hookStatePath);
      mkdirSync(hookStatePath);
      const result = await post('Durable despite refresh failure');
      const eventId = result.stdout.trim();
      expect(eventId).not.toBe('');
      expect(result.stderr).toContain(
        'Warning: post committed, but hook-state refresh failed',
      );
      const ipcResult = await callDaemon<{
        eventId: string;
        hookStateRefreshError?: string;
      }>(
        'messages.post',
        { sessionId, body: 'Check refresh error field' },
        { socketPath },
      );
      expect(ipcResult.hookStateRefreshError).toMatch(/EISDIR/);
      const events = await callDaemon<{ id: string; body: string }[]>(
        'events.list',
        { sessionId },
        { socketPath },
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: eventId,
            body: 'Durable despite refresh failure',
          }),
          expect.objectContaining({
            id: ipcResult.eventId,
            body: 'Check refresh error field',
          }),
        ]),
      );
    },
  );
}, 30_000);
