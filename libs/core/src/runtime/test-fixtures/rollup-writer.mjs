/**
 * Owned-process competitor for rollup admission tests. Resolve only core source
 * .js references to their .ts originals; production modules are never rewritten.
 * Node's type transform runs the exact source without depending on shared dist.
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
      )
        return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const [mode, dbPath, monitorsDir, workspacePath, epoch] = process.argv.slice(2);
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
const {
  createDb,
  RuntimeStore,
  AgentMonitorRuntime,
  SourceRegistry,
  claudeCodeAdapter,
} = await import(pathToFileURL(path.join(sourceRoot, 'index.ts')).href);
const db = createDb(dbPath);
const store = new RuntimeStore(db);
const registry = new SourceRegistry();
const calls = [];
let finished;
const finishedWatch = new Promise((resolve) => {
  finished = resolve;
});
registry.register({
  name: 'rollup-source',
  scopeSchema: { type: 'object' },
  observe() {
    if (mode !== 'due') throw new Error('Not-due competitor must not observe');
    return Promise.resolve({
      observations: [
        {
          title: 'due-new',
          summary: 'due-new',
          objectKey: 'new',
          snapshotText: 'new',
        },
      ],
      nextState: 'due-winner',
    });
  },
  ...(mode === 'watch'
    ? {
        async *watch() {
          yield {
            observations: [
              {
                title: 'watch-new',
                summary: 'watch-new',
                objectKey: 'new',
                snapshotText: 'new',
              },
            ],
            nextState: 'watch-winner',
          };
          finished();
        },
      }
    : {}),
});
const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter], {
  name: 'child-recording',
  interpret(input) {
    calls.push(input.delta);
    return Promise.resolve({ decision: 'deliver', digest: input.delta });
  },
});
try {
  let result;
  if (mode === 'watch') {
    const handle = await runtime.watchMonitors(monitorsDir, workspacePath);
    try {
      await finishedWatch;
    } finally {
      await handle.stop();
    }
  } else {
    if (mode === 'due') {
      const state = store.getMonitorState('rollup', workspacePath);
      store.setMonitorState('rollup', workspacePath, {
        ...state,
        lastObservationAt: new Date(timestamp - 3 * 60 * 60 * 1000),
      });
    }
    result = await runtime.tick(monitorsDir, workspacePath);
  }
  process.stdout.write(
    JSON.stringify({
      result,
      calls,
      state: store.getMonitorState('rollup', workspacePath),
      ids: store.listEvents().map(({ id }) => id),
    }),
  );
} finally {
  db.$client.close();
}
