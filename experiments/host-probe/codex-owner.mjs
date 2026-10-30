/**
 * Read-only evidence for an explicitly supplied Codex App Server control socket.
 * No endpoint discovery, process startup, session loading, or delivery belongs here.
 * Ownership is a momentary server claim, not a lease or proof of desktop support.
 */
import { connect } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Bound memory and elapsed time even if a peer streams unrelated notifications indefinitely. */
const MAX_BYTES = 1024 * 1024;
const READ_METHODS = new Set([
  'initialize',
  'thread/loaded/list',
  'thread/read',
]);

/** @internal Inspect an existing owner without requesting turn history or mutating its sessions. */
export async function probeCodexOwner({
  socketPath,
  threadId,
  timeoutMs = 5000,
} = {}) {
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  ) {
    throw new Error(
      'Invalid options: supply an absolute socket, a thread id, and a 1–60000ms timeout',
    );
  }
  const client = readClient(socketPath, timeoutMs);
  try {
    const initialized = await client.rpc('initialize', {
      clientInfo: { name: 'agentmonitors_owner_probe', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    // This is the server's own version in its initialization user-agent, not the clientInfo version.
    const version =
      typeof initialized?.userAgent === 'string'
        ? /^\S+\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?)\s/.exec(
            initialized.userAgent,
          )?.[1]
        : undefined;
    if (!version) throw new Error('Missing or malformed App Server version');
    client.initialized();
    await requireLoaded(client, threadId);
    const result = await client.rpc('thread/read', {
      threadId,
      includeTurns: false,
    });
    if (
      result?.thread?.id !== threadId ||
      typeof result.thread.cwd !== 'string' ||
      !isAbsolute(result.thread.cwd) ||
      result.thread.cwd.includes('\0')
    ) {
      throw new Error('Invalid thread identity or workspace metadata');
    }
    // A persisted thread/read alone is not ownership. Recheck after reading metadata too.
    await requireLoaded(client, threadId);
    // Promise resolution cannot revoke a response when another frame in the same
    // parsing turn fails. Inspect the accumulated connection state after that turn
    // and its read continuations, immediately before committing snapshot evidence.
    client.assertHealthy();
    return {
      status: 'owner-observed',
      host: 'codex',
      surface: 'unverified',
      hostVersion: version,
      versionSignal: 'initialize.userAgent',
      threadId,
      sessionIdentitySignal: 'thread/loaded/list + thread/read.id',
      workspacePath: result.thread.cwd,
      workspaceBindingSignal: 'thread/read.cwd',
      readCapabilities: ['initialize', 'thread/loaded/list', 'thread/read'],
      deliveryCapability: 'unverified',
      lifecycleHookPointsFired: [],
    };
  } finally {
    client.close();
  }
}

/** A paginated, live in-memory listing is required; persisted history is never loaded as a fallback. */
async function requireLoaded(client, threadId) {
  let cursor;
  const cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await client.rpc(
      'thread/loaded/list',
      cursor ? { cursor } : {},
    );
    if (
      !Array.isArray(response?.data) ||
      response.data.some((id) => typeof id !== 'string' || !id.trim()) ||
      (response.nextCursor != null &&
        (typeof response.nextCursor !== 'string' || !response.nextCursor))
    ) {
      throw new Error('Invalid loaded-thread listing');
    }
    if (response.data.includes(threadId)) return;
    cursor = response.nextCursor;
    if (cursor == null)
      throw new Error('Target thread is not loaded on the supplied server');
    if (cursors.has(cursor)) throw new Error('Repeated loaded-thread cursor');
    cursors.add(cursor);
  }
  throw new Error('Loaded-thread page limit exceeded');
}

/**
 * Narrow JSON-line client for the documented local control socket transport. The closed method
 * allowlist prevents accidental receiver writes; peer requests terminate without granting approval.
 * One deadline and a total byte budget cover connection setup, all pages, and notifications.
 */
function readClient(socketPath, timeoutMs) {
  const socket = connect({ path: socketPath });
  let pending;
  let failure;
  let nextId = 0;
  let buffer = '';
  let bytes = 0;
  const timer = setTimeout(
    () => fail(new Error('Owner probe timed out')),
    timeoutMs,
  );
  function fail(error) {
    failure ??= error;
    clearTimeout(timer);
    pending?.reject(failure);
    pending = undefined;
    socket.destroy();
  }
  socket.on('error', () =>
    fail(new Error('Cannot connect to or read supplied App Server socket')),
  );
  socket.on('close', () => fail(new Error('App Server connection closed')));
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BYTES)
      return fail(new Error('App Server response budget exceeded'));
    buffer += chunk;
    while (buffer.includes('\n') && !failure) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return fail(new Error('Malformed App Server JSON'));
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return fail(new Error('Malformed App Server message'));
      }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id'))
          return fail(
            new Error('Unexpected App Server request; no approval granted'),
          );
        continue; // Notifications are not evidence of ownership or delivery and are never retained.
      }
      if (
        !pending ||
        message.id !== pending.id ||
        !Object.hasOwn(message, 'result') ||
        Object.hasOwn(message, 'error')
      ) {
        return fail(new Error('Invalid or failed App Server response'));
      }
      const entry = pending;
      pending = undefined;
      entry.resolve(message.result);
    }
  });
  return {
    /** Refuse any failure already observed in this snapshot's connection interval. */
    assertHealthy() {
      if (failure) throw failure;
    },
    rpc(method, params) {
      return new Promise((resolveResult, reject) => {
        if (failure) return reject(failure);
        if (!READ_METHODS.has(method) || pending)
          return reject(new Error('Probe permits sequential reads only'));
        const id = ++nextId;
        pending = { id, resolve: resolveResult, reject };
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    initialized() {
      if (failure) throw failure;
      socket.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    },
    close() {
      fail(new Error('Owner probe closed'));
    },
  };
}

/** Explicit command arguments prevent ambient environment/config from choosing a receiver. */
async function main(args) {
  const options = {};
  const flags = {
    '--socket': 'socketPath',
    '--thread': 'threadId',
    '--timeout-ms': 'timeoutMs',
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = Object.hasOwn(flags, args[i]) ? flags[args[i]] : undefined;
    if (!key || Object.hasOwn(options, key) || !args[i + 1])
      throw new Error(
        'Usage: node codex-owner.mjs --socket /absolute/control.sock --thread EXISTING_ID [--timeout-ms 5000]',
      );
    options[key] = key === 'timeoutMs' ? Number(args[i + 1]) : args[i + 1];
  }
  console.log(JSON.stringify(await probeCodexOwner(options), null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: 'refused', reason: error.message }));
    process.exitCode = 1;
  });
}
