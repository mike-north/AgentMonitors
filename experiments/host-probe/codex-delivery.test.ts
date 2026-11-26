import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { redactId } from './codex-live.mjs';

// Exercise the actual executable and protocol framing without a live host.
describe('delivery entry point', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  async function fixture(closeEarly = false) {
    const root = mkdtempSync(join(realpathSync('/tmp'), 'probe-test-'));
    roots.push(root);
    const workspace = join(root, 'work');
    mkdirSync(workspace);
    const socket = join(root, 'server.sock');
    const output = join(root, 'receipt.json');
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const calls: any[] = [];
    let threads = 0, turns = 0;
    let steerMarker = '', injectMarker = '';
    wss.on('connection', peer => peer.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      if (!msg.id) return;
      calls.push(msg);
      if (closeEarly) { peer.close(); return; }
      const reply = (result: any) => peer.send(JSON.stringify({ id: msg.id, result }));
      const notify = (method: string, params: any) => peer.send(JSON.stringify({ method, params }));
      if (msg.method === 'initialize') return reply({});
      if (msg.method === 'thread/start') return reply({ thread: { id: `thread-${++threads}` } });
      const threadId = msg.params.threadId;
      if (msg.method === 'turn/start') {
        const turnId = `turn-${++turns}`;
        reply({ turn: { id: turnId, status: 'inProgress' } });
        notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
        if (turns !== 2) setTimeout(() => {
          const text = turns === 1 ? 'ok' : `incidental ${root} raw-id ${injectMarker}`;
          notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 10 } } });
          notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', text }] } });
        }, 30);
        return;
      }
      if (msg.method === 'turn/steer') {
        steerMarker = msg.params.input[0].text.match(/STEER_[A-F0-9]+/)[0];
        reply({ turnId: msg.params.expectedTurnId });
        setTimeout(() => {
          notify('thread/tokenUsage/updated', { threadId, turnId: msg.params.expectedTurnId, tokenUsage: { total: { totalTokens: 20 } } });
          notify('turn/completed', { threadId, turn: { id: msg.params.expectedTurnId, status: 'completed', items: [{ type: 'agentMessage', text: `incidental ${root} raw-id ${steerMarker}` }] } });
        }, 30);
        return;
      }
      if (msg.method === 'thread/inject_items') {
        injectMarker = msg.params.items[0].content[0].text.match(/INJECT_[A-F0-9]+/)[0];
        return reply({});
      }
      throw new Error(`Unexpected method ${msg.method}`);
    }));
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const child = spawn(process.execPath, [join(process.cwd(), 'codex-delivery.mjs'), socket, workspace, output]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    return { code, stderr, calls, output, root };
  }

  it('correlates envelopes and lifecycle evidence on newly created threads', async () => {
    const result = await fixture();
    expect(result.code).toBe(0);
    const data = JSON.parse(readFileSync(result.output, 'utf8'));
    expect(result.calls.filter(c => c.method === 'thread/start')).toHaveLength(2);
    expect(data.wake.request.id).toBe(data.wake.response.id);
    expect(data.wake.threadId).toBe(redactId('thread-1'));
    expect(data.combined.threadId).toBe(redactId('thread-2'));
    expect(data.combined.steer.request.id).toBe(data.combined.steer.response.id);
    expect(data.combined.steer.marker.present).toBe(true);
    expect(data.inject.marker.present).toBe(true);
    const wakeLifecycle = data.lifecycle.filter((event: any) => event.threadId === redactId('thread-1'));
    expect(wakeLifecycle.map((event: any) => event.method)).toEqual(['turn/started', 'thread/tokenUsage/updated', 'turn/completed']);
    for (const call of result.calls.filter(c => ['turn/start', 'turn/steer', 'thread/inject_items'].includes(c.method))) {
      expect(['thread-1', 'thread-2']).toContain(call.params.threadId);
    }
    expect(JSON.stringify(data)).not.toContain(result.root);
    expect(JSON.stringify(data)).not.toContain('raw-id');
  }, 15000);

  it('fails promptly when the socket closes with an outstanding request', async () => {
    const result = await fixture(true);
    expect(result.code).not.toBe(0);
    expect(existsSync(result.output)).toBe(false);
  }, 5000);
});
