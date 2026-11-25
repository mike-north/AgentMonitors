/**
 * Real-process rollup competitor, bundled with current core source before use.
 * The parent supplies a fixed clock and a shared SQLite path so this process
 * can commit the winning window before the parent's admission transaction.
 */
import {
  createDb,
  RuntimeStore,
  AgentMonitorRuntime,
  SourceRegistry,
  claudeCodeAdapter,
} from '../../index.js';

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
