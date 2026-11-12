/**
 * Held-work flush worker for process-death tests (issue #558). Opens an
 * existing runtime database, registers a source whose every observe() rejects,
 * and runs one tick at a frozen clock. Its Interpret adapter runs only after a
 * flush has committed: it prints `interpreting` and never settles, so the
 * parent can SIGKILL a real process between the flush commit and the tick's
 * post-commit audit writes.
 *
 * Usage: node held-flush-worker.mjs <dbPath> <monitorsDir> <workspacePath> <epochMs>
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

const [dbPath, monitorsDir, workspacePath, epoch] = process.argv.slice(2);
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
const { SourceRegistry } = await import(
  `${sourcePrefix}observation/registry.ts`
);
const { AgentMonitorRuntime } = await import(
  `${sourcePrefix}runtime/service.ts`
);
const { claudeCodeAdapter } = await import(`${sourcePrefix}adapter/claude.ts`);

const registry = new SourceRegistry();
registry.register({
  name: 'controlled',
  stateful: true,
  scopeSchema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      interval: { type: 'string' },
      cron: { type: 'string' },
    },
  },
  observe: (config) =>
    Promise.reject(
      new Error(`repository unavailable for ${String(config.label)}`),
    ),
});
const hangingInterpret = {
  name: 'hanging-interpret',
  interpret() {
    process.stdout.write('interpreting\n');
    // Keep the process alive until the parent kills it.
    globalThis.setInterval(() => undefined, 1_000);
    return new Promise(() => undefined);
  },
};
const runtime = new AgentMonitorRuntime(
  new RuntimeStore(createDb(dbPath)),
  registry,
  [claudeCodeAdapter],
  hangingInterpret,
);
await runtime.tick(monitorsDir, workspacePath);
process.stdout.write('tick-finished-without-interpret\n');
