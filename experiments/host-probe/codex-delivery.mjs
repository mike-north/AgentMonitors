/** Bounded live delivery experiment against a local control socket and a newly created thread. */
import { writeFileSync } from 'node:fs';
import { realpathSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createBoundClient, redactId, redactReceipt, validateWorkspace } from './codex-live.mjs';

const [socketPath, workspace, outputPath] = process.argv.slice(2);
if (!socketPath?.startsWith('/') || !workspace || !outputPath) {
  throw new Error('Supply an absolute control socket, a disposable /tmp workspace and an output path');
}
validateWorkspace(realpathSync(workspace), readdirSync(workspace));

// A socket-scoped client is the only holder of the transport. The mutating surface
// exposed to the experiment is restricted to IDs returned by its own thread/start.
async function run() {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = new Map(), notifications = [];
  let serial = 0;
  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method && !Object.hasOwn(msg, 'id')) notifications.push(msg);
  });
  ws.on('error', () => {});
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, msg => msg.error ? reject(new Error(`RPC ${method} failed`)) : resolve(msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const deadline = setTimeout(() => { ws.terminate(); process.exitCode = 1; }, 60000);
  const until = async predicate => {
    for (let i = 0; i < 500; i++) {
      const found = notifications.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Notification deadline exceeded');
  };
  const input = text => [{ type: 'text', text }];
  const steerNonce = `STEER_${randomBytes(8).toString('hex').toUpperCase()}`;
  const injectNonce = `INJECT_${randomBytes(8).toString('hex').toUpperCase()}`;
  try {
    await rpc('initialize', { clientInfo: { name: 'host_probe', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    const client = createBoundClient(rpc);
    const created = await client.startThread({ cwd: workspace, model: 'gpt-6.1-terra', approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = created.thread.id;
    const initialParams = { threadId, input: input('Wait briefly, then say done.'), model: 'gpt-6.1-terra' };
    const started = await client.call('turn/start', initialParams);
    const turnId = started.turn.id;
    const steerParams = { threadId, expectedTurnId: turnId, input: input(`Say ${steerNonce} in your next answer.`) };
    const steered = await client.call('turn/steer', steerParams);
    const completed = await until(m => m.method === 'turn/completed' && m.params?.turn?.id === turnId);
    const beforeInject = notifications.length;
    const injectParams = { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Remember ${injectNonce} for the next answer.` }] }] };
    const injected = await client.call('thread/inject_items', injectParams);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const unsolicitedTurn = notifications.slice(beforeInject).some(m => m.method === 'turn/started' && m.params?.threadId === threadId);
    const nextParams = { threadId, input: input('Echo the remembered marker.'), model: 'gpt-6.1-terra' };
    const next = await client.call('turn/start', nextParams);
    const nextCompleted = await until(m => m.method === 'turn/completed' && m.params?.turn?.id === next.turn.id);
    const usage = notifications.filter(m => m.method === 'thread/tokenUsage/updated' && m.params?.threadId === threadId && m.params?.turnId === turnId).at(-1)?.params?.tokenUsage ?? null;
    const messages = turn => turn.params.turn.items.filter(item => item.type === 'agentMessage').map(item => item.text);
    const record = {
      threadId: redactId(threadId),
      turnStart: { request: { method: 'turn/start', params: redactReceipt(initialParams) }, response: redactReceipt(started), completed: completed.params.turn.status, usage },
      steer: { request: { method: 'turn/steer', params: redactReceipt(steerParams) }, response: redactReceipt(steered), output: messages(completed), reflected: messages(completed).some(text => text.includes(steerNonce)) },
      inject: { request: { method: 'thread/inject_items', params: redactReceipt(injectParams) }, response: redactReceipt(injected), startedTurnDuringObservation: unsolicitedTurn, observationMs: 1500, nextStartResponse: redactReceipt(next), output: messages(nextCompleted), reflected: messages(nextCompleted).some(text => text.includes(injectNonce)) },
    };
    writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  } finally { clearTimeout(deadline); ws.close(); }
}
await run();
