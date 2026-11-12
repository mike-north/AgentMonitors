/**
 * Explicit Node --import instrumentation for the ingress process tests. Nothing
 * in the published executable imports this file or reads its controls. The load
 * hook taps local classes before command dispatch; it preserves the actual CLI,
 * runtime, source observation and SQLite transaction implementations.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { watch } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const RealDate = globalThis.Date;
let now = Number(process.env.INGRESS_TEST_NOW);
let control = {};
/** Async ownership prevents an idle watcher from classifying unrelated IPC writes. */
const lifecycle = new AsyncLocalStorage();
const admission = new AsyncLocalStorage();
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
  const span = lifecycle.getStore();
  if (span) span.faulted = mode === 'fault';
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

/** Capture the driver and runtime call sites even through the ORM's stack frames. */
function callSite() {
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 50;
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = previous;
  }
}

/**
 * All lifecycle writes require a classification. Setup/restart validation is
 * deliberately unarmed; fault diagnostics are checked independently by the
 * reader; the exact expired-tombstone sweep has no ingress work in these cases.
 * No table-wide or method-wide maintenance exemption admits new SQL silently.
 */
function classify(sql, args, site) {
  const span = lifecycle.getStore();
  if (!span) return undefined;
  if (control.stage === undefined) return 'setup-and-restart';
  if (admission.getStore()) return 'scenario';
  if (
    sql ===
      'delete from "object_event_suppressions" where "object_event_suppressions"."expires_at" <= ?' &&
    site.includes('.purgeExpiredObjectSuppressions (')
  )
    return 'expired-suppression-maintenance';
  if (
    span.faulted &&
    sql.startsWith('insert into "observation_history" ') &&
    args.includes('errored') &&
    site.includes('.recordObservationHistory (')
  )
    return 'injected-fault-diagnostic';
  const message = `Unclassified ingress write: ${sql}\n${site}`;
  process.send?.({ kind: 'unclassified-write', message, sql, site });
  throw new Error(message);
}

/** Discover synchronous prepared writes, including RETURNING through get/all. */
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (statement.readonly) return statement;
  // Iteration defers execution until next(); treating iterate() as the write
  // would park a kill before durability. Refuse a new deferred writer explicitly.
  const iterate = statement.iterate;
  statement.iterate = function (...args) {
    if (lifecycle.getStore()) {
      const site = callSite();
      const message = `Unclassified ingress write: ${sql}\n${site}`;
      process.send?.({ kind: 'unclassified-write', message, sql, site });
      throw new Error(message);
    }
    return iterate.apply(this, args);
  };
  for (const method of ['run', 'get', 'all']) {
    const execute = statement[method];
    statement[method] = function (...args) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      const site = callSite();
      const classification = classify(normalized, args.flat(), site);
      const active = classification === 'scenario';
      if (classification && !active && control.trace)
        process.send?.({
          kind: 'excluded-write',
          exclusion: classification,
          sql: normalized,
          site,
        });
      // A real event failure opens retry admission independently of the selected point.
      if (
        active &&
        control.seedRetry &&
        /^insert into "monitor_events"/i.test(sql)
      ) {
        control = { ...control, seedRetry: false };
        throw new Error('Ingress fixture opens retry recovery');
      }
      const point = active ? pointFor(sql) : '';
      if (active && control.trace)
        process.send?.({ kind: 'write', point, site });
      if (active && control.point === point && control.mode === 'fault')
        interrupt(point);
      const result = execute.apply(this, args);
      if (active && control.point === point) interrupt(point);
      return result;
    };
  }
  return statement;
};

/** Direct SQL cannot bypass classification by avoiding prepare(). */
const exec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  if (
    lifecycle.getStore() &&
    /\b(insert|update|delete|replace|create|drop|alter)\b/i.test(sql)
  ) {
    // Runtime ingress uses prepared statements. A new direct writer requires
    // deliberate inventory support rather than an uninterruptible multi-write point.
    const site = callSite();
    const message = `Unclassified ingress write: ${sql}\n${site}`;
    process.send?.({ kind: 'unclassified-write', message, sql, site });
    throw new Error(message);
  }
  return exec.call(this, sql);
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

/** Trace whole asynchronous tick/watch lifecycles, with nested admission classifications. */
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
      return admission.run(name, () => original.apply(this, args));
    };
  }
  for (const name of ['tick', 'consumeWatch']) {
    const original = Runtime.prototype[name];
    if (typeof original !== 'function')
      throw new Error(`Ingress lifecycle disappeared: ${name}`);
    Runtime.prototype[name] = function (...args) {
      return lifecycle.run({ name, faulted: false }, async () => {
        const result = await original.apply(this, args);
        if (name === 'tick') process.send?.({ kind: 'tick', result });
        return result;
      });
    };
  }
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
