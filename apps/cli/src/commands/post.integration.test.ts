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
import type {
  DeliveryClaim,
  MonitorEventRecord,
  PostMessageInput,
} from '@agentmonitors/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { expect, it, vi } from 'vitest';
import { callDaemon, createDaemonServer } from '../daemon-ipc.js';
import {
  registerChannelToolHandlers,
  runChannelDeliveryCycle,
} from './channel.js';
import {
  reserveRenderAndCommitHookDelivery,
  writeAndCommitHookDelivery,
} from './hook.js';

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
  const open = (runtime: AgentMonitorRuntime, hostSessionId: string) =>
    runtime.openSession({
      adapter: 'claude-code',
      hostSessionId,
      agentIdentity: hostSessionId,
      hookStatePath: path.join(root, `${hostSessionId}.json`),
      workspacePath: root,
    }).id;

  // Exercise the real socket without paying process startup for each clock step.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  let runtime = runtimeForDb();
  let server = createDaemonServer({ runtime, socketPath });
  try {
    const session = open(runtime, 'recipient');
    const sibling = open(runtime, 'sibling');
    await server.listen();
    const post = async (input: Omit<PostMessageInput, 'sessionId'>) =>
      (
        await callDaemon<{ eventId: string }>(
          'messages.post',
          { sessionId: session, ...input },
          { socketPath },
        )
      ).eventId;
    const claim = (id = session, lifecycle = 'turn-interruptible') =>
      callDaemon<DeliveryClaim | null>(
        'hook.claim',
        { sessionId: id, lifecycle },
        { socketPath },
      );
    const list = () =>
      callDaemon<MonitorEventRecord[]>(
        'events.list',
        { sessionId: session },
        { socketPath },
      );
    const policy = {
      requireAck: true,
      resurfaceAfterMs: 100,
      maxResurfaces: 1,
    };

    await expect(
      post({ body: 'invalid', resurfaceAfterMs: 100 }),
    ).rejects.toThrow('Resurfacing options require acknowledgement');
    const unanswered = await post({ body: 'Check the release.', ...policy });
    const answered = await post({ body: 'Review the notes.', ...policy });
    const coreAnswered = await post({ body: 'Check the build.', ...policy });
    const channelAnswered = await post({
      body: 'Review the changes.',
      ...policy,
    });
    const informational = await post({ body: 'The build passed.' });
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
    await callDaemon(
      'events.ack',
      { sessionId: session, eventIds: [answered] },
      { socketPath },
    );

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
}, 5000);

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

it('rejects a workspace key already used for a different post', async () => {
  await withPostSession(async ({ root, runtime, sessionId, socketPath }) => {
    const sibling = runtime.openSession({
      adapter: 'claude-code',
      hostSessionId: 'sibling',
      agentIdentity: 'sibling',
      hookStatePath: path.join(root, 'sibling.json'),
      workspacePath: root,
    }).id;
    const post = (recipient: string, body: string) =>
      callDaemon(
        'messages.postScoped',
        {
          sessionId: recipient,
          body,
          workspacePath: root,
          key: 'shared',
        },
        { socketPath },
      );
    const original = await post(sessionId, 'For the recipient');
    await expect(post(sibling, 'For the sibling')).rejects.toThrow(
      /key.*different post/i,
    );
    await expect(post(sessionId, 'Different content')).rejects.toThrow(
      /key.*different post/i,
    );
    await expect(post(sessionId, 'For the recipient')).resolves.toEqual(
      original,
    );
    expect(runtime.listEvents({ sessionId: sibling })).toEqual([]);
  });
});

it.each(['hook', 'channel'])(
  'never repeats a presented offer after a lost %s commit and post replay',
  async (transport) => {
    await withPostSession(async ({ root, runtime, sessionId, socketPath }) => {
      const input = {
        sessionId,
        body: 'Offer once',
        workspacePath: root,
        key: 'replay',
        requireAck: true,
        resurfaceAfterMs: 100,
        maxResurfaces: 1,
      };
      const start = Date.UTC(2026, 0, 1);
      vi.setSystemTime(start);
      const post = (endpoint: string) =>
        callDaemon<{ eventId: string }>('messages.postScoped', input, {
          socketPath: endpoint,
        });
      const { eventId } = await post(socketPath);

      vi.spyOn(runtime, 'commitDelivery').mockReturnValueOnce(null);
      if (transport === 'hook') {
        const flow = await reserveRenderAndCommitHookDelivery(
          sessionId,
          'turn-interruptible',
          socketPath,
          'UserPromptSubmit',
        );
        if (!flow) throw new Error('Expected a hook delivery.');
        const write = vi.fn((output: NonNullable<typeof flow.output>) => {
          expect(output.hookSpecificOutput.additionalContext).toContain(
            eventId,
          );
        });
        await writeAndCommitHookDelivery(flow, write);
        expect(write).toHaveBeenCalledTimes(1);
      } else {
        const push = vi.fn((claim: DeliveryClaim) => {
          expect(claim.events).toMatchObject([{ eventId }]);
          return Promise.resolve();
        });
        await expect(
          runChannelDeliveryCycle(sessionId, socketPath, push),
        ).resolves.toBe('surfaced-uncommitted');
        expect(push).toHaveBeenCalledTimes(1);
      }

      const restarted = new AgentMonitorRuntime(
        new RuntimeStore(createDb(path.join(root, 'runtime.db'))),
        new SourceRegistry(),
      );
      const restartedSocket = path.join(root, 'restarted.sock');
      const server = createDaemonServer({
        runtime: restarted,
        socketPath: restartedSocket,
      });
      const claim = () =>
        callDaemon<DeliveryClaim | null>(
          'hook.claim',
          { sessionId, lifecycle: 'turn-interruptible' },
          { socketPath: restartedSocket },
        );
      try {
        await server.listen();
        await expect(post(restartedSocket)).resolves.toEqual({ eventId });
        await expect(claim()).resolves.toBeNull();
        vi.setSystemTime(start + 100);
        expect((await claim())?.events).toMatchObject([
          { eventId, title: expect.stringContaining('resurfaced') },
        ]);
      } finally {
        await server.close();
      }
    });
  },
);

it('leaves a monitor omitted by the recap character limit pending', async () => {
  await withPostSession(
    async ({ root, store, runtime, sessionId, socketPath }) => {
      runtime.postMessage({ sessionId, body: 'P'.repeat(8000) });
      const monitor = store.insertEvent({
        workspacePath: root,
        monitorId: 'release',
        sourceName: 'schedule',
        urgency: 'normal',
        title: 'Monitor',
        body: 'Check release',
        summary: 'Check release',
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
      const flow = await reserveRenderAndCommitHookDelivery(
        sessionId,
        'post-compact',
        socketPath,
        'SessionStart',
      );
      if (!flow) throw new Error('Expected a recap.');
      await writeAndCommitHookDelivery(flow, (output) => {
        expect(output.hookSpecificOutput.additionalContext).not.toContain(
          monitor.id,
        );
      });
      expect(runtime.listEvents({ sessionId })).toContainEqual(
        expect.objectContaining({ id: monitor.id, deliveryState: 'unread' }),
      );
      expect(
        runtime.claimDelivery(sessionId, 'turn-interruptible')?.urgency,
      ).toBe('normal');
    },
  );
});

it.each([50, 8000])(
  'reoffers an unread %i-character required-ack post after a failed hook write',
  async (length) => {
    await withPostSession(async ({ root, sessionId, runtime, socketPath }) => {
      const start = Date.UTC(2026, 0, 1);
      vi.setSystemTime(start);
      const body = 'P'.repeat(length);
      const { eventId } = runtime.postMessage({
        sessionId,
        body,
        requireAck: true,
        resurfaceAfterMs: 100,
        maxResurfaces: 1,
      });
      const flow = await reserveRenderAndCommitHookDelivery(
        sessionId,
        'turn-interruptible',
        socketPath,
        'UserPromptSubmit',
      );
      if (!flow) throw new Error('Expected a hook delivery.');
      const writeError = new Error('Hook output failed.');
      const write = vi.fn(() => {
        throw writeError;
      });
      await expect(writeAndCommitHookDelivery(flow, write)).rejects.toBe(
        writeError,
      );
      expect(write).toHaveBeenCalledTimes(1);

      const restarted = new AgentMonitorRuntime(
        new RuntimeStore(createDb(path.join(root, 'runtime.db'))),
        new SourceRegistry(),
      );
      const restartedSocket = path.join(root, 'restarted.sock');
      const server = createDaemonServer({
        runtime: restarted,
        socketPath: restartedSocket,
      });
      const claim = () =>
        callDaemon<DeliveryClaim | null>(
          'hook.claim',
          { sessionId, lifecycle: 'turn-interruptible' },
          { socketPath: restartedSocket },
        );
      try {
        await server.listen();
        expect(
          restarted.listEvents({ sessionId, unreadOnly: true }),
        ).toContainEqual(
          expect.objectContaining({
            id: eventId,
            body,
            deliveryState: 'claimed',
          }),
        );
        await expect(claim()).resolves.toBeNull();
        vi.setSystemTime(start + 100);
        expect((await claim())?.events).toMatchObject([
          { eventId, title: expect.stringContaining('resurfaced') },
        ]);
      } finally {
        await server.close();
      }
    });
  },
);

it('ends resurfacing after presenting a truncated required-ack post', async () => {
  await withPostSession(async ({ sessionId, runtime, socketPath }) => {
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { eventId } = runtime.postMessage({
      sessionId,
      body: 'P'.repeat(8000),
      requireAck: true,
      resurfaceAfterMs: 100,
      maxResurfaces: 1,
    });
    const flow = await reserveRenderAndCommitHookDelivery(
      sessionId,
      'turn-interruptible',
      socketPath,
      'UserPromptSubmit',
    );
    if (!flow) throw new Error('Expected a hook delivery.');
    await writeAndCommitHookDelivery(flow, (output) => {
      expect(output.hookSpecificOutput.additionalContext).toContain(eventId);
      expect(
        output.hookSpecificOutput.additionalContext.length,
      ).toBeLessThanOrEqual(4000);
    });
    vi.setSystemTime(start + 100);
    expect(runtime.claimDelivery(sessionId, 'turn-interruptible')).toBeNull();
    expect(runtime.listEvents({ sessionId })).toContainEqual(
      expect.objectContaining({ id: eventId, messageState: 'delivered' }),
    );
  });
});

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

it('recovers the original post when the recipient changes workspace before the retry', async () => {
  await withPostSession(
    async ({ root, runtime, sessionId, hookStatePath, post }) => {
      const commit = runtime.postMessage.bind(runtime);
      let committedId: string | undefined;
      const requests = vi
        .spyOn(runtime, 'postMessage')
        .mockImplementationOnce((input) => {
          const result = commit(input);
          committedId = result.eventId;
          runtime.openSession({
            adapter: 'claude-code',
            hostSessionId: 'recipient',
            agentIdentity: 'recipient',
            hookStatePath,
            workspacePath: path.join(root, 'moved'),
          });
          return {
            ...result,
            then() {
              // The post is durable even though the reply never arrives.
            },
          };
        });

      expect((await post('Only one durable post')).stdout.trim()).toBe(
        committedId,
      );
      expect(runtime.listSessions()).toContainEqual(
        expect.objectContaining({
          id: sessionId,
          workspacePath: path.join(root, 'moved'),
        }),
      );
      const key = requests.mock.calls[0]?.[0].key;
      if (!key) throw new Error('Missing request key.');
      expect(requests.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ key, workspacePath: root }),
        expect.objectContaining({ key, workspacePath: root }),
      ]);
      expect(runtime.listEvents({ sessionId }).map(({ id }) => id)).toEqual([
        committedId,
      ]);

      const replay = await post(
        'Only one durable post',
        '--key',
        key,
        '--workspace',
        root,
      );
      expect(replay.stdout.trim()).toBe(committedId);
      await expect(
        post('Invalid workspace', '--key', 'unused-key', '--workspace', root),
      ).rejects.toThrow(
        'The recipient is no longer registered in the selected workspace.',
      );
      const independent = await post(
        'A post in the new workspace',
        '--key',
        key,
      );
      expect(independent.stdout.trim()).not.toBe(committedId);
      expect(runtime.listEvents({ sessionId })).toHaveLength(2);
    },
  );
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
