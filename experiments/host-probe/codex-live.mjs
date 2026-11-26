/** Delivery boundary and identity redaction for a single live probe run. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stable within and across artifacts without disclosing the original identity. */
export function redactId(id) {
  return `sha256:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** Retain only a known marker and its observed presence, never model-generated prose. */
export function markerReceipt(marker, turnId, messages) {
  return { marker, present: messages.some(message => typeof message === 'string' && message.includes(marker)), turnId: redactId(turnId) };
}

/** A fresh directory prevents accidental use of existing project settings or files. */
export function validateWorkspace(physicalPath, entries) {
  if (!physicalPath.startsWith('/private/tmp/') || entries.length !== 0) {
    throw new Error('The delivery workspace must be an empty directory under /tmp');
  }
}

/** Only a successful thread/start response can authorize a later delivery in this client. */
export function createBoundClient(rpc) {
  const created = new Set();
  const deliveries = new Set(['turn/start', 'turn/steer', 'thread/inject_items']);
  return {
    async startThread(params) {
      const result = await rpc('thread/start', params);
      const id = result?.thread?.id;
      if (typeof id !== 'string' || !id) throw new Error('Invalid created thread identity');
      created.add(id);
      return result;
    },
    async call(method, params) {
      if (!deliveries.has(method) || !created.has(params?.threadId)) {
        throw new Error('Delivery requires a thread created by this probe');
      }
      return rpc(method, params);
    },
  };
}

/** Record field presence and comparable identities without preserving private payloads. */
export function hookSighting(payload, mode, env = {}) {
  const hash = value => typeof value === 'string' && value ? redactId(value) : null;
  const common = ['Stop', 'PreCompact', 'PostCompact', 'SessionEnd'].includes(payload.hook_event_name);
  const outputType = common ? (mode === 'context' ? 'common-json-system-message' : 'common-json-continue') : (mode === 'context' ? 'hook-specific-additional-context-json' : 'plain-text');
  return { event: payload.hook_event_name ?? null, mode, outputType, keys: Object.keys(payload).sort(), sessionId: hash(payload.session_id), turnId: hash(payload.turn_id), codexEnvKeys: Object.keys(env).filter(key => key.startsWith('CODEX_')).sort() };
}

/** Supply distinct markers where the hook protocol accepts context; use valid common output elsewhere. */
export function hookOutput(event, mode, runNonce = '682') {
  const marker = `PROBE_${event.toUpperCase()}_${mode.toUpperCase()}_${runNonce}`;
  if (['Stop', 'PreCompact', 'PostCompact', 'SessionEnd'].includes(event)) {
    return JSON.stringify(mode === 'context' ? { continue: true, systemMessage: marker } : { continue: true });
  }
  return mode === 'plain' ? marker : JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: marker } });
}

/** Hook entry point: capture only a redacted sighting, never arbitrary stdin or environment. */
function recordHook(out, mode, runNonce) {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  appendFileSync(out, `${JSON.stringify(hookSighting(payload, mode, process.env))}\n`);
  process.stdout.write(hookOutput(payload.hook_event_name, mode, runNonce));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { recordHook(process.argv[2], process.argv[3], process.argv[4]); }
  catch { process.stdout.write('{"continue":true}'); }
}
