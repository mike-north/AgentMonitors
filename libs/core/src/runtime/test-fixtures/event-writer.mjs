/**
 * Independent event writer for durable ordering tests. Each process primes
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

const [dbPath, _mode, epoch] = process.argv.slice(2);
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

/** Event payloads retain observation time separately from the frozen ID clock. */
function eventInput(
  content,
  observedAt,
  urgency = 'high',
  objectKey = 'object',
) {
  return {
    workspacePath: '/workspace',
    monitorId: 'monitor',
    sourceName: 'manual',
    urgency,
    title: content,
    body: '',
    summary: content,
    payload: {},
    snapshotMetadata: {},
    snapshotText: content,
    diffText: null,
    objectKey,
    baselineStrategy: 'net',
    queryScope: {},
    tags: [],
    createdAt: new Date(observedAt),
  };
}

const scratch = createDb(`${dbPath}.${String(process.pid)}.scratch`);
let primedId;
try {
  primedId = new RuntimeStore(scratch).insertEvent(
    eventInput('prime', timestamp),
  ).id;
} finally {
  scratch.$client.close();
}
process.send({ kind: 'ready', id: primedId });
process.once('message', (message) => {
  const db = createDb(dbPath);
  try {
    const store = new RuntimeStore(db);
    const event = store.insertEvent(
      eventInput(
        message.content,
        message.observedAt ?? timestamp,
        message.urgency,
        message.objectKey,
      ),
    );
    process.send({ kind: 'committed', id: event.id }, () =>
      process.disconnect(),
    );
  } finally {
    db.$client.close();
  }
});
