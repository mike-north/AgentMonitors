/**
 * Independent snapshot writer for durable ordering tests. Each process primes
 * its genuine module-local ULID factory in a private database, then waits for
 * its parent to choose commit order. No generated IDs or production rows are
 * replaced. Equal clocks make the ordering proof independent of wall time.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
const sourcePrefix = pathToFileURL(`${sourceRoot}${path.sep}`).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourcePrefix) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const candidate = new URL(
        `${specifier.slice(0, -3)}.ts`,
        context.parentURL,
      );
      if (
        candidate.href.startsWith(sourcePrefix) &&
        existsSync(fileURLToPath(candidate))
      ) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const [dbPath, mode, epoch] = process.argv.slice(2);
const timestamp = Number(epoch);
const NativeDate = Date;
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) {
    return Reflect.construct(target, args.length ? args : [timestamp]);
  },
  get(target, key, receiver) {
    return key === 'now' ? () => timestamp : Reflect.get(target, key, receiver);
  },
});
const { createDb } = await import(`${sourcePrefix}inbox/db.ts`);
const { RuntimeStore } = await import(`${sourcePrefix}runtime/store.ts`);

/** Read from a newly opened connection after all preceding writers committed. */
function read() {
  const db = createDb(dbPath);
  try {
    return new RuntimeStore(db).latestSnapshot(
      'monitor',
      'object',
      '/workspace',
    );
  } finally {
    db.$client.close();
  }
}

if (mode === 'read') {
  process.stdout.write(JSON.stringify(read()));
} else {
  // This private row exposes the factory's random starting point. Incrementing
  // both factories once more preserves their relative order in the shared DB.
  const scratch = createDb(`${dbPath}.${String(process.pid)}.scratch`);
  let primedId;
  try {
    new RuntimeStore(scratch).saveSnapshot({
      workspacePath: '/workspace',
      monitorId: 'monitor',
      objectKey: 'object',
      eventId: 'prime',
      content: 'prime',
    });
    primedId = scratch.$client
      .prepare('SELECT id FROM monitor_snapshots')
      .get().id;
  } finally {
    scratch.$client.close();
  }
  process.send({ kind: 'ready', id: primedId });
  process.once('message', (message) => {
    const db = createDb(dbPath);
    try {
      const store = new RuntimeStore(db);
      const before = store.latestSnapshot('monitor', 'object', '/workspace');
      db.$client
        .transaction(() => {
          store.saveSnapshot({
            workspacePath: '/workspace',
            monitorId: 'monitor',
            objectKey: 'object',
            eventId: message.content,
            content: message.content,
          });
        })
        .immediate();
      const row = db.$client
        .prepare('SELECT id FROM monitor_snapshots WHERE content = ?')
        .get(message.content);
      process.send({ kind: 'committed', id: row.id, before }, () => {
        process.disconnect();
      });
    } finally {
      db.$client.close();
    }
  });
}
