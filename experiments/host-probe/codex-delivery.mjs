/** Capture bounded, allowlisted delivery evidence on threads created by this process. */
import { writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createBoundClient, markerReceipt, redactId, validateWorkspace } from './codex-live.mjs';

const [socketPath, workspace, outputPath] = process.argv.slice(2);
if (!socketPath?.startsWith('/') || !workspace || !outputPath) throw new Error('Supply socket, disposable workspace, and output');
validateWorkspace(realpathSync(workspace), readdirSync(workspace));

/** Unknown status values are not allowed to become arbitrary receipt text. */
function safeStatus(value) {
  return ['notLoaded', 'idle', 'active', 'systemError', 'inProgress', 'completed', 'interrupted', 'failed'].includes(value) ? value : 'other';
}

/** Only protocol counters needed to interpret usage may leave this process. */
function usageReceipt(usage) {
  const counters = value => Object.fromEntries(['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'].filter(key => typeof value?.[key] === 'number').map(key => [key, value[key]]));
  return { total: counters(usage?.total), last: counters(usage?.last), ...(typeof usage?.modelContextWindow === 'number' ? { modelContextWindow: usage.modelContextWindow } : {}) };
}

/** Only structural request fields and known markers are evidence; never persist arbitrary input. */
function requestReceipt(id, method, params) {
  const safe = {};
  if (params.threadId) safe.threadId = redactId(params.threadId);
  if (params.expectedTurnId) safe.expectedTurnId = redactId(params.expectedTurnId);
  if (params.cwd) safe.cwd = '<tmp-workspace>';
  if (params.model) safe.model = params.model;
  if (params.input) safe.input = params.input.map(item => ({ type: item.type }));
  if (params.items) safe.items = params.items.map(item => ({ type: item.type, role: item.role }));
  return { id, method, params: safe };
}

/** Responses retain correlation and identity/status, not arbitrary peer-provided text. */
function responseReceipt(message) {
  const result = message.result ?? {};
  const safe = {};
  if (result.thread?.id) safe.thread = { id: redactId(result.thread.id) };
  if (result.turn?.id) safe.turn = { id: redactId(result.turn.id), status: safeStatus(result.turn.status) };
  if (result.turnId) safe.turnId = redactId(result.turnId);
  return { id: message.id, result: safe };
}

/** Filter lifecycle notifications to the identities, state, and numeric usage under study. */
function lifecycleReceipt(message) {
  const p = message.params;
  const out = { method: message.method, threadId: redactId(p.threadId) };
  const turnId = p.turnId ?? p.turn?.id;
  if (turnId) out.turnId = redactId(turnId);
  if (message.method === 'turn/started' || message.method === 'turn/completed') out.status = safeStatus(p.turn.status);
  if (message.method === 'thread/status/changed') out.status = safeStatus(p.status?.type);
  if (message.method === 'thread/tokenUsage/updated') out.usage = usageReceipt(p.tokenUsage);
  return out;
}

/** The connection is private to this run; only the bound client can issue delivery calls. */
async function run() {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = new Map(), notifications = [], exchanges = [];
  let serial = 0, failure;
  const fail = () => {
    failure ??= new Error('Control connection closed');
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  };
  ws.on('close', fail);
  ws.on('error', fail);
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { fail(); ws.terminate(); return; }
    if (pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error || !Object.hasOwn(msg, 'result')) { entry.reject(new Error('RPC failed')); return; }
      const exchange = { request: entry.request, response: responseReceipt(msg) };
      exchanges.push(exchange);
      entry.resolve(msg.result);
    } else if (msg.method && !Object.hasOwn(msg, 'id')) notifications.push(msg);
    else if (msg.method) { fail(); ws.terminate(); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++serial;
    pending.set(id, { resolve, reject, request: requestReceipt(id, method, params) });
    ws.send(JSON.stringify({ id, method, params }), error => { if (error) { fail(); ws.terminate(); } });
  });
  const timer = setTimeout(() => { fail(); ws.terminate(); }, 60000);
  const until = async predicate => {
    for (let i = 0; i < 500; i++) {
      if (failure) throw failure;
      const found = notifications.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Notification deadline exceeded');
  };
  const input = text => [{ type: 'text', text }];
  const exchange = (method, index = 0) => exchanges.filter(e => e.request.method === method)[index];
  const messages = turn => (turn.params.turn.items ?? []).filter(item => item.type === 'agentMessage').map(item => item.text);
  try {
    await rpc('initialize', { clientInfo: { name: 'host_probe', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    const client = createBoundClient(rpc);
    const wakeThread = (await client.startThread({ cwd: workspace, model: 'gpt-6.1-terra', approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
    const wakeTurn = (await client.call('turn/start', { threadId: wakeThread, input: input('Say done.'), model: 'gpt-6.1-terra' })).turn.id;
    const wakeDone = await until(m => m.method === 'turn/completed' && m.params?.threadId === wakeThread && m.params?.turn?.id === wakeTurn);
    const threadId = (await client.startThread({ cwd: workspace, model: 'gpt-6.1-terra', approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
    const turnId = (await client.call('turn/start', { threadId, input: input('Wait briefly, then say done.'), model: 'gpt-6.1-terra' })).turn.id;
    const steerMarker = `STEER_${randomBytes(8).toString('hex').toUpperCase()}`;
    await client.call('turn/steer', { threadId, expectedTurnId: turnId, input: input(`Say ${steerMarker} in your next answer.`) });
    const done = await until(m => m.method === 'turn/completed' && m.params?.threadId === threadId && m.params?.turn?.id === turnId);
    const injectMarker = `INJECT_${randomBytes(8).toString('hex').toUpperCase()}`;
    const beforeInject = notifications.length;
    await client.call('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Remember ${injectMarker} for the next answer.` }] }] });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const startedDuringObservation = notifications.slice(beforeInject).some(m => m.method === 'turn/started' && m.params?.threadId === threadId);
    const nextId = (await client.call('turn/start', { threadId, input: input('Echo the remembered marker.'), model: 'gpt-6.1-terra' })).turn.id;
    const nextDone = await until(m => m.method === 'turn/completed' && m.params?.threadId === threadId && m.params?.turn?.id === nextId);
    const owned = new Set([wakeThread, threadId]);
    const lifecycle = notifications.filter(m => ['thread/status/changed', 'turn/started', 'turn/completed', 'thread/tokenUsage/updated'].includes(m.method) && owned.has(m.params?.threadId)).map(lifecycleReceipt);
    const usage = id => lifecycle.filter(m => m.method === 'thread/tokenUsage/updated' && m.turnId === redactId(id)).at(-1)?.usage ?? null;
    const record = {
      wake: { threadId: redactId(wakeThread), threadStart: exchange('thread/start', 0), ...exchange('turn/start', 0), completed: safeStatus(wakeDone.params.turn.status), usage: usage(wakeTurn), usageScope: 'unsteered turn' },
      combined: { threadId: redactId(threadId), threadStart: exchange('thread/start', 1), turnStart: exchange('turn/start', 1), steer: { ...exchange('turn/steer'), marker: markerReceipt(steerMarker, turnId, messages(done)) }, completed: safeStatus(done.params.turn.status), usage: usage(turnId), usageScope: 'turn with steering' },
      inject: { ...exchange('thread/inject_items'), startedDuringObservation, observationMs: 1500, nextTurn: exchange('turn/start', 2), marker: markerReceipt(injectMarker, nextId, messages(nextDone)) },
      lifecycle,
    };
    writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  } finally { clearTimeout(timer); ws.close(); }
}
await run();
