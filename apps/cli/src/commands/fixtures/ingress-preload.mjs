/**
 * Explicit Node --import instrumentation for the ingress process tests. Nothing
 * in the published executable imports this file or reads its controls. The load
 * hook taps local classes before command dispatch; it preserves the actual CLI,
 * runtime, source observation and SQLite transaction implementations.
 * Direct SQL in a traced lifecycle must be a plain read-only statement or an
 * allowlisted read-only PRAGMA. Database-file changes, including statistics and
 * maintenance, need an interruption point or a named exclusion; driver readonly
 * metadata alone does not prove the absence of durable effects. The allowlist
 * is the first line of admission; byte-for-byte main/WAL equality around each
 * admitted synchronous execution is the file-effect guarantee. WAL statistics
 * and maintenance writes change frames even if the main file or WAL size stays
 * fixed. Shared-memory lock/read-mark changes are deliberately not data effects.
 *
 * These fixtures own fresh private database paths, with one writable runtime
 * connection. Sources receive input paths/URLs, never the database path; IPC
 * uses that same connection. Parent assertions only issue reads at completed
 * command barriers or after reaping the writer. They cannot append/checkpoint a
 * live writer's WAL. No await separates either file sample from native execution,
 * so another tick/watch/IPC callback on this process cannot interleave a write.
 * A separate-process read regression covers WAL reader locks without false
 * positives. This guarantee requires that ownership: arbitrary external writers
 * to the private fixture database are outside the harness contract.
 * Work invoked through an explicitly external AsyncResource is outside this
 * lifecycle ownership boundary, as are unexecuted source/plugin branches.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, watch } from 'node:fs';
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

/** Discover prepared execution, even for handles created before lifecycle entry. */
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  const db = statement.database;
  if (statement.readonly) {
    for (const method of ['run', 'get', 'all', 'iterate']) {
      const execute = statement[method];
      statement[method] = function (...args) {
        const site = callSite();
        guardDirectSql(db, sql, site);
        if (method !== 'iterate')
          return observeRead(db, sql, site, () => execute.apply(this, args));
        const iterator = observeRead(db, sql, site, () =>
          execute.apply(this, args),
        );
        // Sampling each synchronous advance/finalization avoids attributing
        // unrelated work between yielded rows to a deferred read. It also guards
        // iterators created outside ownership but advanced within a lifecycle.
        const finish = iterator.return;
        for (const advance of ['next', 'return', 'throw']) {
          if (typeof iterator[advance] !== 'function') continue;
          const original = iterator[advance];
          iterator[advance] = function (...values) {
            const site = callSite();
            try {
              guardDirectSql(db, sql, site);
              return observeRead(db, sql, site, () =>
                original.apply(this, values),
              );
            } catch (error) {
              // A refused row must release the native cursor just as a consumer
              // breaking its loop would; otherwise the connection stays busy.
              if (finish)
                observeRead(db, sql, site, () => finish.call(iterator));
              throw error;
            }
          };
        }
        return iterator;
      };
    }
    return statement;
  }
  // Iteration defers execution until next(); treating iterate() as the write
  // would park a kill before durability. Ownership must be checked on creation
  // and every advance/finalization, since a cursor can predate the lifecycle.
  const iterate = statement.iterate;
  statement.iterate = function (...args) {
    guardDeferredWrite(sql);
    const iterator = iterate.apply(this, args);
    for (const method of ['next', 'return', 'throw']) {
      if (typeof iterator[method] !== 'function') continue;
      const execute = iterator[method];
      iterator[method] = function (...values) {
        guardDeferredWrite(sql);
        return execute.apply(this, values);
      };
    }
    return iterator;
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

/** Deferred writers have no safe kill point; refuse before any native cursor effect. */
function guardDeferredWrite(sql) {
  if (!lifecycle.getStore()) return;
  const site = callSite();
  const message = `Unclassified ingress write: ${sql}\n${site}`;
  process.send?.({ kind: 'unclassified-write', message, sql, site });
  // Unlike read cursors, even finalizing a writer can commit. Leave it untouched
  // on refusal; cleanup outside lifecycle ownership remains the caller's task.
  throw new Error(message);
}

/**
 * Query-only PRAGMAs admitted by the direct-SQL boundary. Keep this list explicit:
 * SQLite can label optimize and other state-changing PRAGMAs as readonly. These
 * names inspect schema, versions, page counts or connection settings; assignment
 * syntax is never admitted, including the parenthesized form of setting writes.
 */
const readOnlyPragmas = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'integrity_check',
  'user_version',
  'schema_version',
  'data_version',
  'application_id',
  'page_count',
  'freelist_count',
  'page_size',
  'foreign_keys',
  'busy_timeout',
  'legacy_alter_table',
  'recursive_triggers',
]);
/** Only schema-inspection queries take an object-name argument, never a setting value. */
const objectQueryPragmas = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
]);

/**
 * Recognize only the small admitted PRAGMA grammar, preserving quoted tokens so
 * comments, schema qualifiers and quoted names cannot disguise maintenance or
 * assignments. SQLite still validates the complete single statement separately.
 */
function permitsDirectSql(sql) {
  const tokens = (
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_]\w*|[^\s]/gi,
    ) ?? []
  ).filter((token) => !token.startsWith('--') && !token.startsWith('/*'));
  // Table-valued PRAGMAs run inside an outer SELECT whose readonly metadata
  // does not describe their effects. Inspect identifiers, including quoted table
  // names, rather than relying on the outer verb. String values are not names
  // unless SQLite accepts them as a FROM/JOIN table identifier.
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token.startsWith("'") &&
      !/^(from|join|\.)$/i.test(tokens[index - 1] ?? '') &&
      tokens[index + 1] !== '('
    )
      continue;
    const name = token.replace(/^["'`[]|["'`\]]$/g, '').toLowerCase();
    if (name.startsWith('pragma_') && !readOnlyPragmas.has(name.slice(7)))
      return false;
  }
  // SQLite accepts leading empty statements before the one executable statement.
  while (tokens[0] === ';') tokens.shift();
  const verb = tokens.shift()?.toLowerCase();
  if (['analyze', 'vacuum', 'reindex', 'attach', 'detach'].includes(verb))
    return false;
  if (verb !== 'pragma') return true;
  let name = tokens.shift();
  if (tokens[0] === '.') {
    tokens.shift();
    name = tokens.shift();
  }
  // SQLite accepts identifier quoting for PRAGMA names, including single quotes.
  name = name?.replace(/^["'`[]|["'`\]]$/g, '').toLowerCase();
  if (!readOnlyPragmas.has(name)) return false;
  if (tokens.at(-1) === ';') tokens.pop();
  return (
    tokens.length === 0 ||
    (objectQueryPragmas.has(name) &&
      tokens.length === 3 &&
      tokens[0] === '(' &&
      tokens[1] !== '=' &&
      tokens[2] === ')')
  );
}

/**
 * Direct execution has no per-write interruption boundary. Require both the
 * explicit query policy and driver readonly metadata; refuse unpreparable SQL,
 * including programs whose readable prefix could conceal a later write.
 */
function guardDirectSql(db, sql, site = callSite()) {
  if (!lifecycle.getStore()) return;
  let readonly = false;
  try {
    readonly = permitsDirectSql(sql) && prepare.call(db, sql).readonly;
  } catch {
    // No statement means no proof of read-only execution. Fail closed below.
  }
  if (readonly) return;
  const message = `Unclassified ingress write: ${sql}\n${site}`;
  process.send?.({ kind: 'unclassified-write', message, sql, site });
  throw new Error(message);
}

/**
 * Full bytes catch growth, truncation, main-header changes and same-size WAL
 * frame reuse; sizes/change counters alone miss valid WAL maintenance effects.
 * Absence is part of the signal. Ignore only ENOENT; unreadable files fail closed.
 */
function fileBytes(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Every admitted read must preserve both durable files, even when it throws. */
function observeRead(db, sql, site, execute) {
  if (!lifecycle.getStore()) return execute();
  const files = [db.name, `${db.name}-wal`];
  const before = files.map(fileBytes);
  let result;
  let failure;
  try {
    result = execute();
  } catch (error) {
    // Preserve the driver's error unless file effects prove an unclassified
    // write; throwing must not let a side effect escape the post-execution bar.
    failure = { error };
  }
  if (
    files.some((file, index) => {
      const after = fileBytes(file);
      return before[index] === undefined
        ? after !== undefined
        : after === undefined || !before[index].equals(after);
    })
  ) {
    const message = `Unclassified ingress write: ${sql} (database file effect)\n${site}`;
    process.send?.({ kind: 'unclassified-write', message, sql, site });
    throw new Error(message);
  }
  if (failure) throw failure.error;
  return result;
}

/** exec accepts whole SQL programs, so only a proven read-only statement passes. */
const exec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  const site = callSite();
  guardDirectSql(this, sql, site);
  return observeRead(this, sql, site, () => exec.call(this, sql));
};

/** pragma prepares through the native handle, bypassing the public prepare hook. */
const pragma = Database.prototype.pragma;
Database.prototype.pragma = function (source, options) {
  const sql = `PRAGMA ${source}`;
  const site = callSite();
  guardDirectSql(this, sql, site);
  return observeRead(this, sql, site, () => pragma.call(this, source, options));
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
