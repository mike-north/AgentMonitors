import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
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
    store: RuntimeStore;
    post: (
      body: string,
      ...options: string[]
    ) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'am-post-'));
  const socketPath = path.join(root, 'daemon.sock');
  const hookStatePath = path.join(root, 'hook.json');
  const store = new RuntimeStore(createDb(path.join(root, 'runtime.db')));
  const runtime = new AgentMonitorRuntime(store, new SourceRegistry());
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
        { timeout: 8000 },
      );
    await test({
      root,
      socketPath,
      hookStatePath,
      sessionId,
      runtime,
      store,
      post,
    });
  } finally {
    await server.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}

function createRecap(root: string, socketPath: string) {
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(
    path.join(root, '.claude/agentmonitors.local.md'),
    '---\nenabled: true\n---\n',
  );
  return async () => {
    const child = exec(
      process.execPath,
      [cli, 'hook', 'deliver', '--socket', socketPath, '--format', 'text'],
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
}

it.each(['initial', 'final'])(
  'preserves a %s post offer omitted from a bounded recap',
  async (offer) => {
    await withPostSession(
      async ({ root, socketPath, runtime, sessionId, post }) => {
        const recap = createRecap(root, socketPath);
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

it.each(['character limit', 'event limit'])(
  'resurfaces a post ahead of unread monitor events at the recap %s',
  async (limit) => {
    await withPostSession(
      async ({ root, socketPath, runtime, store, sessionId, post }) => {
        const recap = createRecap(root, socketPath);
        const start = Date.UTC(2026, 0, 1);
        vi.setSystemTime(start);
        const insertMonitorEvent = (body: string) =>
          store.insertEvent({
            workspacePath: root,
            monitorId: 'release',
            sourceName: 'schedule',
            urgency: 'normal',
            title: 'Release monitor',
            body,
            summary: body,
            payload: {},
            snapshotMetadata: {},
            snapshotText: null,
            diffText: null,
            objectKey: null,
            baselineStrategy: null,
            queryScope: {},
            tags: [],
            createdAt: new Date(),
          });
        if (limit === 'character limit') insertMonitorEvent('M'.repeat(8000));
        const eventId = (
          await post(
            'Check the release.',
            '--require-ack',
            '--resurface-after-ms',
            '100',
            '--max-resurfaces',
            '1',
          )
        ).stdout.trim();
        expect(
          runtime.claimDelivery(sessionId, 'turn-interruptible')?.events,
        ).toMatchObject([{ eventId }]);
        if (limit === 'event limit') {
          for (let i = 0; i < 10; i++)
            insertMonitorEvent('Monitor is still unread.');
        }

        vi.setSystemTime(start + 99);
        expect(await recap()).not.toContain(eventId);
        vi.setSystemTime(start + 100);
        const retry = await recap();
        expect(retry).toContain(eventId);
        expect(retry).toContain('Message resurfaced');
        expect(retry.length).toBeLessThanOrEqual(4000);
        expect(await recap()).not.toContain(eventId);

        vi.setSystemTime(start + 199);
        expect(await recap()).not.toContain(eventId);
        vi.setSystemTime(start + 200);
        const final = await recap();
        expect(final).toContain(eventId);
        expect(final).toContain('Message needs-attention');
        expect(runtime.listEvents({ sessionId })).toContainEqual(
          expect.objectContaining({
            id: eventId,
            messageState: 'needs-attention',
          }),
        );
        vi.setSystemTime(start + 400);
        expect(await recap()).not.toContain(eventId);
      },
    );
  },
  30_000,
);

it('recovers the committed ID when the daemon reply misses the IPC timeout', async () => {
  await withPostSession(async ({ runtime, sessionId, post }) => {
    const commit = runtime.postMessage.bind(runtime);
    const requests = vi
      .spyOn(runtime, 'postMessage')
      .mockImplementationOnce((input) => {
        const result = commit(input);
        // The IPC dispatcher assimilates the thenable before replying.
        return {
          ...result,
          then: (resolve: (value: typeof result) => void) =>
            setTimeout(2600).then(() => resolve(result)),
        };
      });

    const first = await post('Only one durable post');
    const eventId = first.stdout.trim();
    const key = requests.mock.calls[0]?.[0].key;
    expect(key).toBeTruthy();
    if (!key) throw new Error('Missing request key.');
    expect(requests.mock.calls.map(([input]) => input.key)).toEqual([key, key]);
    expect(runtime.listEvents({ sessionId }).map(({ id }) => id)).toEqual([
      eventId,
    ]);

    const replay = await post('Only one durable post', '--key', key);
    expect(replay.stdout.trim()).toBe(eventId);
    expect(runtime.listEvents({ sessionId }).map(({ id }) => id)).toEqual([
      eventId,
    ]);
  });
}, 15_000);

it('prints the key when neither post attempt receives a reply', async () => {
  await withPostSession(async ({ runtime, sessionId, post }) => {
    const commit = runtime.postMessage.bind(runtime);
    const requests = vi
      .spyOn(runtime, 'postMessage')
      .mockImplementation((input) => ({
        ...commit(input),
        then() {
          // Leave the response pending until the client gives up.
        },
      }));
    const result = post('Recoverable post');
    await expect(result).rejects.toMatchObject({ code: 1, stdout: '' });
    const key = requests.mock.calls[0]?.[0].key;
    if (!key) throw new Error('Missing request key.');
    await expect(result).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `Retry the same command with --key '${key}'.`,
      ),
    });
    expect(requests.mock.calls.map(([input]) => input.key)).toEqual([key, key]);
    const events = runtime.listEvents({ sessionId });
    expect(events).toHaveLength(1);

    requests.mockRestore();
    const replay = await post('Recoverable post', '--key', key);
    expect(replay.stdout.trim()).toBe(events[0]?.id);
  });
}, 15_000);
