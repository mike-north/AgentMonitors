import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentMonitorRuntime,
  createDb,
  RuntimeStore,
  SourceRegistry,
} from '@agentmonitors/core';
import { expect, it, vi } from 'vitest';
import { createDaemonServer } from '../daemon-ipc.js';

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
        { eventId: informational, body: 'The build passed.' },
      ],
    });
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unanswered, messageState: 'delivered' }),
      ]),
    );
    await run('events', 'ack', '--session', session, '--event-ids', answered);

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
