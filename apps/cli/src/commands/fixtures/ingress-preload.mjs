/**
 * Explicit Node --import instrumentation for the ingress process tests. Nothing
 * in the published executable imports this file or reads its controls. The load
 * hook taps local classes before command dispatch; it preserves the actual CLI,
 * runtime, source observation and SQLite transaction implementations.
 */
import { watch } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const RealDate = globalThis.Date;
let now = Number(process.env.INGRESS_TEST_NOW);
let control = {};
let ingressDepth = 0;
const occurrences = new Map();
/** Freeze wall time, leaving native timers and parent timeout budgets untouched. */
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
  static now() {
    return now;
  }
};
/** The acknowledgment orders a control before a real IPC tick or filesystem edit. */
process.on('message', (value) => {
  if (value.now !== undefined) now = value.now;
  if (value.stage !== undefined) occurrences.clear();
  control = { ...control, ...value };
  process.send?.({ kind: 'controlled' });
});

/** One named SQL operation, including RETURNING writes executed through get/all. */
function pointFor(sql) {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const occurrence = (occurrences.get(normalized) ?? 0) + 1;
  occurrences.set(normalized, occurrence);
  return `${control.stage} :: ${normalized} #${occurrence}`;
}
/** A fault precedes SQLite execution; a kill parks immediately after the write. */
function interrupt(point) {
  const mode = control.mode;
  control = { ...control, point: undefined };
  process.send?.({ kind: 'interrupted', point, mode });
  if (mode === 'kill') {
    // This is a bounded barrier, never a synchronization sleep or busy loop.
    // The parent kills and reaps the child; expiry makes a broken parent fail.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    process.exit(97);
  }
  throw new Error(`Injected ingress write failure: ${point}`);
}

/** Discover from executed SQL, rather than a hand-maintained write-point list. */
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (!/^\s*(insert|update|delete|replace)\b/i.test(sql)) return statement;
  for (const method of ['run', 'get', 'all']) {
    const execute = statement[method];
    statement[method] = function (...args) {
      const active = ingressDepth > 0;

      // A single real event-write failure opens the retry-admission/drain paths.
      // This seed is independent of the write selected for the actual scenario.
      if (
        active &&
        control.seedRetry &&
        /^insert into "monitor_events"/i.test(sql)
      ) {
        control = { ...control, seedRetry: false };
        throw new Error('Ingress fixture opens retry recovery');
      }
      const point = active ? pointFor(sql) : '';
      if (active && control.trace) process.send?.({ kind: 'write', point });
      if (active && control.point === point && control.mode === 'fault')
        interrupt(point);
      const result = execute.apply(this, args);
      if (active && control.point === point) interrupt(point);
      return result;
    };
  }
  return statement;
};

/**
 * Bundled file-fingerprint is observe-only today (003 §3.8). This test-only
 * wrapper adds an actual fs.watch wakeup and delegates every batch to its real
 * observe implementation, carrying the yielded checkpoint to the next pull.
 * A fixture round is one completed input write (or a state-only flush). Native
 * callbacks wake that round, but cannot sample its writer mid-truncate or turn
 * duplicate notifications into additional input. File-read races have separate
 * source-level coverage; these rounds isolate durable runtime admission.
 * It exercises runtime watch ingestion without claiming shipped source support.
 */
function fileWatcher(source, config, context) {
  return (async function* () {
    let pending = true;
    let wake;
    let previousState = context.previousState;
    let yieldedRound = -1;
    const watcher = watch(path.join(config.cwd, 'watched.txt'), () => {
      pending = true;
      wake?.();
    });
    // A completed write is an event barrier, not a debounce timer. Flushes
    // explicitly request a state-only pull without rewriting the source file.
    const written = (value) => {
      if (value.round !== undefined) pending = false;
      if (value.writtenRound !== undefined) {
        if (control.flush) pending = true;
        wake?.();
      }
    };
    process.on('message', written);
    const ready = () => {
      const round = control.round ?? 0;
      return (
        pending &&
        round !== yieldedRound &&
        round === (control.writtenRound ?? 0)
      );
    };
    const abort = () => {
      watcher.close();
      wake?.();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      while (!context.signal.aborted) {
        while (!ready() && !context.signal.aborted) {
          await new Promise((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        if (context.signal.aborted) return;
        pending = false;
        const batch = await source.observe(config, {
          ...context,
          now: new Date(),
          previousState,
        });
        const round = control.round ?? 0;
        yieldedRound = round;
        yield batch;
        previousState = batch.nextState;
        process.send?.({
          kind: 'watch-idle',
          round,
          snapshots: batch.observations.map(
            (observation) => observation.snapshotText,
          ),
        });
      }
    } finally {
      context.signal.removeEventListener('abort', abort);
      process.off('message', written);
      watcher.close();
    }
  })();
}

/** Tap original results and bound instrumentation to ingress, excluding delivery/maintenance. */
globalThis.__ingressTestAttach = (Registry, Runtime) => {
  const register = Registry.prototype.register;
  Registry.prototype.register = function (source) {
    if (
      source.name === 'file-fingerprint' &&
      process.env.INGRESS_TEST_WATCH === '1'
    ) {
      source = {
        ...source,
        watch: (config, context) => fileWatcher(source, config, context),
      };
    }
    return register.call(this, source);
  };
  for (const name of [
    'ingest',
    'flushHeldNotifyWork',
    'drainMaterializationRetries',
    'reconcileNotifyEdit',
  ]) {
    const original = Runtime.prototype[name];
    if (typeof original !== 'function')
      throw new Error(`Ingress boundary disappeared: ${name}`);
    Runtime.prototype[name] = function (...args) {
      ingressDepth++;
      try {
        const result = original.apply(this, args);
        if (result?.then)
          return result.finally(() => {
            ingressDepth--;
          });
        ingressDepth--;
        return result;
      } catch (error) {
        ingressDepth--;
        throw error;
      }
    };
  }
  const tick = Runtime.prototype.tick;
  Runtime.prototype.tick = async function (...args) {
    const result = await tick.apply(this, args);
    process.send?.({ kind: 'tick', result });
    return result;
  };
  const watchMonitors = Runtime.prototype.watchMonitors;
  Runtime.prototype.watchMonitors = function (directory, workspace, options) {
    return watchMonitors.call(this, directory, workspace, {
      ...options,
      onError: (monitorId, error) => {
        // Watch errors have their own documented callback, rather than a fabricated tick result.
        process.send?.({
          kind: 'watch-error',
          monitorId,
          message: error.message,
        });
        options?.onError?.(monitorId, error);
      },
    });
  };
};

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== pathToFileURL(process.argv[1]).href) return result;
    const source = String(result.source);
    const marker = 'program2.parseAsync()';
    if (source.split(marker).length !== 2)
      throw new Error('Built CLI dispatch seam changed');
    return {
      ...result,
      source: source.replace(
        marker,
        'globalThis.__ingressTestAttach(SourceRegistry, AgentMonitorRuntime);\n' +
          marker,
      ),
    };
  },
});
