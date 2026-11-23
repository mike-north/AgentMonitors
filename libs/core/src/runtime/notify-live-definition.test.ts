/**
 * 002 §4.6 / 001 §2: live holds and scoped identity govern admission after discovery awaits.
 *
 * The watched source yields finite batches (002 §2.4). A batch's baseline
 * (`nextState`) and observations commit together only when the batch is
 * admitted; while the gate is closed the batch waits and the source is not
 * asked for newer input.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type { Observation, ObservationResult } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Only the named filesystem location is faulted; all other I/O remains actual. */
const locationFault = vi.hoisted(
  (): {
    path?: string;
    readCode?: string;
    statCode?: string;
    looksAbsent?: boolean;
  } => ({}),
);
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  /** Faithful errno failures retain the code that a metadata classifier must inspect. */
  function failure(code: string): Error {
    return code === 'unclassified'
      ? new Error('owned unclassified metadata failure')
      : Object.assign(new Error(code + ': owned filesystem fault'), { code });
  }
  return {
    ...actual,
    // Monitor files are read only through the bounded reader's descriptor open.
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === locationFault.path && locationFault.readCode)
        throw failure(locationFault.readCode);
      return actual.openSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (args[0] === locationFault.path && locationFault.statCode)
        throw failure(locationFault.statCode);
      return actual.statSync(...args);
    },
    existsSync: (filePath: Parameters<typeof actual.existsSync>[0]) => {
      if (filePath === locationFault.path && locationFault.looksAbsent)
        return false;
      return actual.existsSync(filePath);
    },
  };
});

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    // Monitor files are read only through the bounded reader's descriptor open.
    // Repeated discovery must observe the same targeted I/O failure as the
    // synchronous admission read; otherwise a valid async read would be a duplicate.
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] === locationFault.path && locationFault.readCode) {
        throw Object.assign(
          new Error(locationFault.readCode + ': owned filesystem fault'),
          { code: locationFault.readCode },
        );
      }
      return await actual.open(...args);
    },
  };
});

/** Barriers suspend actual sources/Interpret, never runtime, store or admission implementations. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete locationFault.path;
  delete locationFault.readCode;
  delete locationFault.statCode;
  delete locationFault.looksAbsent;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
/** Filesystem callbacks and actual source iterators need real turns; only Date is frozen. */
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await turn();
  expect(predicate()).toBe(true);
}
async function settle() {
  for (let i = 0; i < 8; i++) await turn();
}
/** A yielded batch is admitted (the watcher asks for newer input) or dropped unadmitted. */
type BatchOutcome = 'admitted' | 'dropped';
/** One watched-source iterator: its owner signal, pulls, and whether the consumer closed it. */
interface WatchGeneration {
  signal: AbortSignal;
  pulls: number;
  closed: boolean;
}
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 1h\n';
type Layout = 'flat' | 'folder';
type Discovery = 'tick' | 'startup';

/** A real watcher can create its first hold after another discovery snapshots held membership. */
async function fixture(older: Discovery = 'tick', layout: Layout = 'flat') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-live-definition-'));
  const dir = path.join(root, 'monitors');
  const empty = path.join(root, 'empty');
  mkdirSync(dir);
  mkdirSync(empty);
  const dbPath = path.join(root, 'state.sqlite');
  const db = createDb(dbPath);
  // Driver access observes actual SQLite state and the final full close/reopen.
  const client = (db as unknown as { $client: Database }).$client;
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  const entered = deferred<undefined>();
  const release = deferred<undefined>();
  let blocking = false;
  let generation: WatchGeneration | undefined;
  let next: ((result: IteratorResult<ObservationResult>) => void) | undefined;
  /** Batch outcome checks rerun whenever an iterator is pulled, closed or aborted. */
  const outcomeChecks: (() => void)[] = [];
  const wake = () => {
    for (const check of outcomeChecks.splice(0)) check();
  };
  let bFactories = 0;
  let bPolls = 0;
  let cCalls = 0;
  let cFactories = 0;
  const tasks: Promise<unknown>[] = [];
  const handles: { stop(): Promise<void> }[] = [];
  const errors: string[] = [];
  let currentFile =
    layout === 'flat'
      ? path.join(dir, 'b.md')
      : path.join(dir, 'b', 'MONITOR.md');
  const originalFile = currentFile;
  /** Idle iterators keep their true watcher owner until the public stop handle aborts them. */
  function idle(signal: AbortSignal) {
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<never>> {
        return new Promise((resolve) => {
          if (signal.aborted) resolve({ done: true, value: undefined });
          else
            signal.addEventListener(
              'abort',
              () => resolve({ done: true, value: undefined }),
              { once: true },
            );
        });
      },
    };
  }
  registry.register({
    name: 'blocker',
    scopeSchema: { type: 'object' },
    async observe() {
      if (blocking && older === 'tick') {
        entered.resolve(undefined);
        await release.promise;
      }
      return {
        observations:
          older === 'startup' && !blocking
            ? [{ title: 'A', snapshotText: 'A' }]
            : [],
      };
    },
    watch(_config, ctx) {
      return idle(ctx.signal);
    },
  });
  registry.register({
    name: 'healthy',
    scopeSchema: { type: 'object' },
    async observe() {
      cCalls++;
      return { observations: [], nextState: { cursor: 77 } };
    },
    watch(_config, ctx) {
      cFactories++;
      return idle(ctx.signal);
    },
  });
  registry.register({
    name: 'watched',
    scopeSchema: { type: 'object', properties: { token: { type: 'string' } } },
    async observe() {
      bPolls++;
      return { observations: [] };
    },
    watch(_config, ctx) {
      bFactories++;
      const owner: WatchGeneration = {
        signal: ctx.signal,
        pulls: 0,
        closed: false,
      };
      generation = owner;
      ctx.signal.addEventListener('abort', wake, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<ObservationResult>> {
          return new Promise((resolve) => {
            next = resolve;
            // The consumer pulls again only after the previous batch was admitted.
            owner.pulls++;
            wake();
            if (ctx.signal.aborted) resolve({ done: true, value: undefined });
            else
              ctx.signal.addEventListener(
                'abort',
                () => resolve({ done: true, value: undefined }),
                { once: true },
              );
          });
        },
        return(): Promise<IteratorResult<ObservationResult>> {
          owner.closed = true;
          wake();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  });
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    {
      name: 'controlled-interpret',
      async interpret(input) {
        if (blocking && input.monitorId === 'a') {
          entered.resolve(undefined);
          await release.promise;
        }
        return { decision: 'deliver', digest: 'A interpreted' };
      },
    },
  );
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'owner',
      workspacePath: root,
    }),
  );
  function text(type: string, notify = '', body = 'Original handling') {
    return `---\nwatch:\n  type: ${type}\n  interval: 1h\nbaseline-strategy: incremental\n${notify}---\n${body}\n`;
  }
  function edit(
    type = 'watched',
    notify = DEBOUNCE,
    body = 'Original handling',
  ) {
    mkdirSync(path.dirname(currentFile), { recursive: true });
    writeFileSync(currentFile, text(type, notify, body));
  }
  edit();
  const state = () => store.getMonitorState('b', root);
  const heldCount = () =>
    state().notifyState.pendingDebounce?.observations.length ?? 0;
  const tick = (scanDir = dir, workspace = root) => {
    const task = runtime.tick(scanDir, workspace);
    tasks.push(task);
    return task;
  };
  const watch = async () => {
    const task = runtime.watchMonitors(dir, root, {
      onError: (_id, error) => errors.push(error.message),
    });
    tasks.push(task);
    const handle = await task;
    handles.push(handle);
    return handle;
  };
  /**
   * Yield one batch to the watcher's outstanding pull. The returned promise
   * settles once the batch is admitted, or when its watcher stops without
   * admitting it (abort, supersession or a closed iterator).
   */
  async function offer(batch: ObservationResult): Promise<BatchOutcome> {
    await until(() => next !== undefined);
    const accept = next;
    const owner = generation;
    next = undefined;
    if (!accept || !owner) throw new Error('Watcher is not requesting input');
    const pulled = owner.pulls;
    accept({ done: false, value: batch });
    return await new Promise<BatchOutcome>((resolve) => {
      const check = () => {
        if (owner.pulls > pulled) resolve('admitted');
        else if (owner.closed || owner.signal.aborted) resolve('dropped');
        else outcomeChecks.push(check);
      };
      check();
    });
  }
  const observation = (title: string): Observation => ({
    title,
    snapshotText: title,
    objectKey: 'obj',
  });
  cleanups.push(async () => {
    release.resolve(undefined);
    // Stopping first drops any batch still waiting behind a closed gate.
    for (const handle of handles.splice(0)) await handle.stop();
    await Promise.allSettled(tasks);
    for (const handle of handles.splice(0)) await handle.stop();
    if (client.open) client.close();
    rmSync(root, { recursive: true, force: true });
  });
  await watch();
  await until(() => generation !== undefined && next !== undefined);
  return {
    root,
    dir,
    empty,
    runtime,
    store,
    session,
    errors,
    text,
    edit,
    state,
    heldCount,
    tick,
    watch,
    get file() {
      return currentFile;
    },
    originalFile,
    get bFactories() {
      return bFactories;
    },
    get bPolls() {
      return bPolls;
    },
    async stop() {
      for (const handle of handles.splice(0)) await handle.stop();
      await Promise.allSettled(tasks);
    },
    get cCalls() {
      return cCalls;
    },
    get cFactories() {
      return cFactories;
    },
    rows: () => {
      const events = store.listEvents({ sessionId: session.id });
      // SQLite row order proves admission ordering; the public query is newest-first.
      const ids = client
        .prepare(
          "SELECT id FROM monitor_events WHERE workspace_path = ? AND monitor_id = 'b' ORDER BY rowid",
        )
        .pluck()
        .all(root) as string[];
      return ids.map((id) => {
        const event = events.find((item) => item.id === id);
        if (!event)
          throw new Error('Committed event is missing its owner projection');
        return event;
      });
    },
    /** Yield one observation as its own batch, without advancing the baseline. */
    async emit(title: string) {
      await until(() => next !== undefined);
      tasks.push(offer({ observations: [observation(title)] }));
      await settle();
    },
    /**
     * Yield one batch advancing the baseline to `{ cursor: 999 }`, carrying any
     * named observations; resolves with the batch's admission outcome.
     */
    checkpoint(...titles: string[]) {
      const task = offer({
        observations: titles.map(observation),
        nextState: { cursor: 999 },
      });
      tasks.push(task);
      return task;
    },
    move() {
      const destination = currentFile.endsWith('MONITOR.md')
        ? path.join(dir, 'b.md')
        : path.join(dir, 'b', 'MONITOR.md');
      mkdirSync(path.dirname(destination), { recursive: true });
      renameSync(currentFile, destination);
      currentFile = destination;
    },
    async suspend() {
      writeFileSync(
        path.join(dir, 'a.md'),
        text('blocker', older === 'startup' ? DEBOUNCE : '').replace(
          'baseline-strategy: incremental\n',
          'baseline-strategy: incremental\npayload:\n  form: prose\n',
        ),
      );
      writeFileSync(path.join(dir, 'c.md'), text('healthy'));
      if (older === 'startup') {
        await tick();
        writeFileSync(
          path.join(dir, 'a.md'),
          text('blocker').replace(
            'baseline-strategy: incremental\n',
            'baseline-strategy: incremental\npayload:\n  form: prose\n',
          ),
        );
      }
      blocking = true;
      // Capture rejection immediately, so a parent regression cannot create an unhandled promise.
      const task = (older === 'tick' ? tick() : watch()).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      return {
        finish: async () => {
          release.resolve(undefined);
          return task;
        },
      };
    },
    async reopen() {
      for (const handle of handles.splice(0)) await handle.stop();
      await Promise.allSettled(tasks);
      const expected = state();
      client.close();
      const reader = createDb(dbPath);
      const readerClient = (reader as unknown as { $client: Database }).$client;
      try {
        expect(new RuntimeStore(reader).getMonitorState('b', root)).toEqual(
          expected,
        );
      } finally {
        readerClient.close();
      }
    },
  };
}

for (const older of ['tick', 'startup'] as const) {
  it(`unknown source after first hold during ${older} await closes actual watcher work and preserves sibling progress`, async () => {
    const f = await fixture(older);
    const pending = await f.suspend();
    expect(f.heldCount()).toBe(0);
    await f.emit('Held B');
    expect(f.heldCount()).toBe(1);
    const retained = f.state();
    f.edit('absent-source');
    const old = await pending.finish();
    let settled = false;
    // One batch carries the later observation and the advanced baseline.
    const checkpoint = f.checkpoint('Later B').then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    const blocked = f.state();
    const acceptedBeforeRecovery = settled;
    const siblingProgress = older === 'tick' ? f.cCalls : f.cFactories;
    const errors =
      'result' in old && old.result && 'erroredObservations' in old.result
        ? old.result.erroredObservations.map((error) => error.message)
        : f.errors;
    // Recover before assertions so even an expected parent failure leaves no blocked fixture work.
    f.edit('watched', '', 'New handling');
    await f.tick();
    const outcome = await checkpoint;
    await until(() => f.rows().length === 2);
    expect(outcome).toBe('admitted');
    expect('error' in old).toBe(false);
    expect(
      errors.some((error) => error.includes('unknown source "absent-source"')),
    ).toBe(true);
    expect(blocked).toEqual(retained);
    expect(siblingProgress).toBeGreaterThan(0);
    expect(acceptedBeforeRecovery).toBe(false);
    expect(f.rows().map((event) => event.summary)).toEqual([
      'Held B',
      'Later B',
    ]);
    expect(f.rows().map((event) => event.body)).toEqual([
      'Original handling',
      'Original handling',
    ]);
    expect(f.bFactories).toBe(1);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    // The pre-recovery snapshot above proves the pending batch's baseline stayed unadmitted.
    expect(retained.sourceState).not.toEqual({ cursor: 999 });
    expect(settled).toBe(true);
    await f.reopen();
  });
}

for (const entry of ['tick', 'startup'] as const) {
  it(`${entry} keeps no-held unknown-source fatal behavior but closes an existing watcher gate`, async () => {
    const f = await fixture();
    f.edit('absent-source');
    const result = await (entry === 'tick' ? f.tick() : f.watch()).then(
      () => undefined,
      (error: unknown) => error,
    );
    const before = f.state();
    let settled = false;
    const checkpoint = f.checkpoint().then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    const acceptedWhileInvalid = settled;
    const blocked = f.state();
    f.edit();
    await f.tick();
    expect(await checkpoint).toBe('admitted');
    expect(String(result)).toContain('unknown source "absent-source"');
    expect(acceptedWhileInvalid).toBe(false);
    expect(blocked).toEqual(before);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    await f.reopen();
  });
}

for (const layout of ['flat', 'folder'] as const) {
  for (const older of ['tick', 'startup'] as const) {
    for (const newer of ['tick', 'startup'] as const) {
      it(`${older} old ${layout} path cannot close same-ID ${newer} relocation admission`, async () => {
        const f = await fixture(older, layout);
        const pending = await f.suspend();
        await f.emit('Held B');
        expect(f.heldCount()).toBe(1);
        f.move();
        f.edit('watched', DEBOUNCE, 'Relocated handling');
        if (newer === 'tick') await f.tick();
        else await f.watch();
        const adopted = f.state();
        const old = await pending.finish();
        let settled = false;
        const checkpoint = f.checkpoint().then((outcome) => {
          settled = true;
          return outcome;
        });
        await settle();
        const workedWithoutThirdScan = settled;
        // Parent closes the gate; unblock only after capturing the required no-third-scan outcome.
        if (!settled) await f.tick();
        expect(await checkpoint).toBe('admitted');
        await f.emit('Later B');
        expect('error' in old).toBe(false);
        expect(workedWithoutThirdScan).toBe(true);
        expect(f.errors).toEqual([]);
        expect(
          f.state().notifyState.pendingDebounce?.observations,
        ).toHaveLength(2);
        expect(
          f.state().notifyState.pendingDebounce?.observations[1]?.monitor
            .instructions,
        ).toBe('Original handling');
        expect(adopted.notifyState.pendingDebounce?.observations).toHaveLength(
          1,
        );
        expect(f.bFactories).toBe(1);
        expect(f.rows()).toEqual([]);
        await f.reopen();
      });
    }
  }
}

it('captured old path in missing-definition diagnostics cannot close the current same-ID admission', async () => {
  const f = await fixture();
  await f.emit('Held B');
  f.move();
  await f.tick();
  // An actual discovery omitting b exercises the captured-route path without replacing scan results.
  const scan = await f.tick(f.empty);
  let settled = false;
  const checkpoint = f.checkpoint().then((outcome) => {
    settled = true;
    return outcome;
  });
  await settle();
  const workedWithoutAnotherScan = settled;
  if (!settled) await f.tick();
  expect(await checkpoint).toBe('admitted');
  expect(scan.erroredObservations).toEqual([]);
  expect(workedWithoutAnotherScan).toBe(true);
  expect(f.heldCount()).toBe(1);
  await f.reopen();
});

for (const invalid of [
  'deleted',
  'invalid',
  'invalid-scope',
  'unknown',
] as const) {
  it(`relocation fallback rereads a ${invalid} current path rather than trusting cached content`, async () => {
    const f = await fixture();
    const pending = await f.suspend();
    await f.emit('Held B');
    f.move();
    await f.tick();
    const retained = f.state();
    if (invalid === 'deleted') rmSync(f.file);
    else if (invalid === 'invalid')
      writeFileSync(f.file, '---\nwatch: invalid\n---');
    else if (invalid === 'invalid-scope')
      writeFileSync(
        f.file,
        f
          .text('watched', DEBOUNCE)
          .replace('type: watched\n', 'type: watched\n  token: 42\n'),
      );
    else f.edit('absent-source');
    const old = await pending.finish();
    const missing = await f.tick(f.empty);
    let settled = false;
    const checkpoint = f.checkpoint().then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    const blocked = f.state();
    const acceptedWhileInvalid = settled;
    f.edit();
    await f.tick();
    expect(await checkpoint).toBe('admitted');
    expect('error' in old).toBe(false);
    expect(
      missing.erroredObservations.some((error) => error.monitorId === 'b'),
    ).toBe(true);
    expect(acceptedWhileInvalid).toBe(false);
    expect(blocked).toEqual(retained);
    expect(f.heldCount()).toBe(1);
    await f.reopen();
  });
}

it('two valid same-ID files remain a fatal duplicate rather than an arbitrary cached-path choice', async () => {
  const f = await fixture();
  const pending = await f.suspend();
  await f.emit('Held B');
  f.move();
  await f.tick();
  writeFileSync(
    f.originalFile,
    f.text('watched', DEBOUNCE, 'Conflicting handling'),
  );
  const old = await pending.finish();
  const current = await f.tick().then(
    () => undefined,
    (error: unknown) => error,
  );
  rmSync(f.originalFile);
  await f.tick();
  expect(await f.checkpoint()).toBe('admitted');
  expect('error' in old ? String(old.error) : '').toContain(
    'Duplicate monitor ids',
  );
  expect(String(current)).toContain('Duplicate monitor ids');
  expect(f.heldCount()).toBe(1);
  await f.reopen();
});

it('a valid same-ID foreign workspace cannot authorize a missing local definition', async () => {
  const f = await fixture();
  await f.emit('Held B');
  const foreign = path.join(f.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, 'b.md'), f.text('healthy'));
  f.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'foreign-owner',
      workspacePath: foreign,
    }),
  );
  await f.tick(foreign, foreign);
  rmSync(f.file);
  await f.tick();
  let settled = false;
  const checkpoint = f.checkpoint().then((outcome) => {
    settled = true;
    return outcome;
  });
  await settle();
  const acceptedWhileMissing = settled;
  f.edit();
  await f.tick();
  expect(await checkpoint).toBe('admitted');
  expect(acceptedWhileMissing).toBe(false);
  expect(f.store.getMonitorState('b', foreign).sourceState).toEqual({
    cursor: 77,
  });
  expect(f.state().sourceState).toEqual({ cursor: 999 });
  expect(f.heldCount()).toBe(1);
  await f.reopen();
});

for (const invalid of ['unknown', 'invalid-scope'] as const) {
  it(`captured-path diagnostics validate ${invalid} source semantics at the admitted replacement path`, async () => {
    const f = await fixture();
    await f.emit('Held B');
    f.move();
    await f.tick();
    const retained = f.state();
    if (invalid === 'unknown') f.edit('absent-source');
    else
      writeFileSync(
        f.file,
        f
          .text('watched', DEBOUNCE)
          .replace('type: watched\n', 'type: watched\n  token: 42\n'),
      );
    const scan = await f.tick(f.empty);
    let settled = false;
    const checkpoint = f.checkpoint().then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    const acceptedWhileInvalid = settled;
    const blocked = f.state();
    f.edit();
    await f.tick();
    expect(await checkpoint).toBe('admitted');
    expect(scan.erroredObservations).toHaveLength(1);
    expect(scan.erroredObservations[0]?.message).toContain(
      invalid === 'unknown'
        ? 'unknown source "absent-source"'
        : 'Invalid monitor definition:',
    );
    expect(acceptedWhileInvalid).toBe(false);
    expect(blocked).toEqual(retained);
    await f.reopen();
  });
}

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'permission-denied admitted parent cannot masquerade as deletion to admit a valid old path',
  async () => {
    const f = await fixture();
    const pending = await f.suspend();
    await f.emit('Held B');
    f.move();
    await f.tick();
    const retained = f.state();
    const admittedParent = path.dirname(f.file);
    let readCode: unknown;
    let ambiguousAbsence: boolean;
    let old: Awaited<ReturnType<typeof pending.finish>> | undefined;
    let checkpoint: Promise<BatchOutcome> | undefined;
    let settled = false;
    let acceptedWhileDenied: boolean;
    let blocked: ReturnType<typeof f.state>;
    let siblingProgress: number;
    let admittedStillExists: boolean;
    try {
      chmodSync(admittedParent, 0);
      writeFileSync(
        f.originalFile,
        f.text('watched', DEBOUNCE, 'Conflicting fallback'),
      );
      try {
        readFileSync(f.file);
      } catch (error) {
        if (error instanceof Error && 'code' in error) readCode = error.code;
      }
      ambiguousAbsence = !existsSync(f.file);
      old = await pending.finish();
      checkpoint = f.checkpoint('Later B').then((outcome) => {
        settled = true;
        return outcome;
      });
      await settle();
      acceptedWhileDenied = settled;
      blocked = f.state();
      siblingProgress = f.cCalls;
    } finally {
      // Permission restoration precedes every await/cleanup so failure cannot strand owned resources.
      chmodSync(admittedParent, 0o700);
      admittedStillExists = existsSync(f.file);
      rmSync(f.originalFile, { force: true });
      await pending.finish();
      await f.tick();
      await checkpoint;
    }
    await until(() => f.heldCount() === 2);
    expect(await checkpoint).toBe('admitted');
    expect(readCode).toBe('EACCES');
    expect(ambiguousAbsence).toBe(true);
    expect(admittedStillExists).toBe(true);
    expect(old && 'error' in old).toBe(false);
    const diagnostics =
      old &&
      'result' in old &&
      old.result &&
      'erroredObservations' in old.result
        ? old.result.erroredObservations.map((error) => error.message)
        : [];
    expect(diagnostics.some((message) => message.includes('EACCES'))).toBe(
      true,
    );
    expect(acceptedWhileDenied).toBe(false);
    expect(blocked).toEqual(retained);
    expect(siblingProgress).toBe(1);
    expect(f.rows()).toEqual([]);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    expect(f.bFactories).toBe(1);
    expect(
      f.state().notifyState.pendingDebounce?.observations[1]?.monitor
        .instructions,
    ).toBe('Original handling');
    await f.reopen();
  },
);

for (const metadataCode of [
  'EACCES',
  'EPERM',
  'EIO',
  'unclassified',
  undefined,
]) {
  it(
    'an unreadable admitted file with metadata ' +
      (metadataCode ?? 'present') +
      ' cannot authorize ambiguous fallback',
    async () => {
      const f = await fixture();
      const pending = await f.suspend();
      await f.emit('Held B');
      f.move();
      await f.tick();
      const retained = f.state();
      writeFileSync(
        f.originalFile,
        f.text('watched', DEBOUNCE, 'Conflicting fallback'),
      );
      let old: Awaited<ReturnType<typeof pending.finish>> | undefined;
      let checkpoint: Promise<BatchOutcome> | undefined;
      let settled = false;
      let acceptedWhileFaulted: boolean;
      let blocked: ReturnType<typeof f.state>;
      let siblingProgress: number;
      try {
        locationFault.path = f.file;
        locationFault.readCode = 'EIO';
        locationFault.statCode = metadataCode;
        // Like existsSync's permission/query-error result, false alone carries no absence evidence.
        locationFault.looksAbsent = true;
        old = await pending.finish();
        checkpoint = f.checkpoint('Later B').then((outcome) => {
          settled = true;
          return outcome;
        });
        await settle();
        acceptedWhileFaulted = settled;
        blocked = f.state();
        siblingProgress = f.cCalls;
      } finally {
        delete locationFault.path;
        delete locationFault.readCode;
        delete locationFault.statCode;
        delete locationFault.looksAbsent;
        rmSync(f.originalFile, { force: true });
        await pending.finish();
        await f.tick();
        await checkpoint;
      }
      await until(() => f.heldCount() === 2);
      expect(await checkpoint).toBe('admitted');
      expect(existsSync(f.file)).toBe(true);
      expect(old && 'error' in old).toBe(false);
      const diagnostics =
        old &&
        'result' in old &&
        old.result &&
        'erroredObservations' in old.result
          ? old.result.erroredObservations.map((error) => error.message)
          : [];
      expect(
        diagnostics.some((message) =>
          message.includes('EIO: owned filesystem fault'),
        ),
      ).toBe(true);
      expect(acceptedWhileFaulted).toBe(false);
      expect(blocked).toEqual(retained);
      expect(siblingProgress).toBe(1);
      expect(f.rows()).toEqual([]);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(f.bFactories).toBe(1);
      await f.reopen();
    },
  );
}

for (const missingCode of ['ENOENT', 'ENOTDIR'] as const) {
  it.skipIf(process.platform === 'win32' && missingCode === 'ENOTDIR')(
    'genuine ' +
      missingCode +
      ' at the admitted location permits legitimate moveback without a third scan',
    async () => {
      const f = await fixture();
      const pending = await f.suspend();
      await f.emit('Held B');
      f.move();
      const admitted = f.file;
      await f.tick();
      f.move();
      if (missingCode === 'ENOTDIR') {
        rmSync(path.dirname(admitted), { recursive: true });
        writeFileSync(
          path.dirname(admitted),
          'The previous parent is now a regular file.',
        );
      }
      let actualCode: unknown;
      try {
        readFileSync(admitted);
      } catch (error) {
        if (error instanceof Error && 'code' in error) actualCode = error.code;
      }
      const old = await pending.finish();
      let settled = false;
      const checkpoint = f.checkpoint().then((outcome) => {
        settled = true;
        return outcome;
      });
      await settle();
      const workedWithoutThirdScan = settled;
      if (!settled) await f.tick();
      expect(await checkpoint).toBe('admitted');
      await f.emit('Later B');
      expect(actualCode).toBe(missingCode);
      expect('error' in old).toBe(false);
      const diagnostics =
        'result' in old && old.result && 'erroredObservations' in old.result
          ? old.result.erroredObservations
          : [];
      expect(diagnostics).toEqual([]);
      expect(workedWithoutThirdScan).toBe(true);
      expect(f.heldCount()).toBe(2);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(f.bFactories).toBe(1);
      await f.reopen();
    },
  );
}

/** Read-only ownership inspection accepts the former count representation for parent negative runs. */
function liveOwnership(f: Awaited<ReturnType<typeof fixture>>) {
  const metadata = f.runtime as unknown as {
    notifyPolicyUsers: Map<
      string,
      number | { users: number; currentPath?: string }
    >;
    watchPolicies: Map<string, unknown>;
  };
  const value = metadata.notifyPolicyUsers.get(JSON.stringify([f.root, 'b']));
  return {
    users: typeof value === 'number' ? value : (value?.users ?? 0),
    currentPath: typeof value === 'object' ? value.currentPath : undefined,
    owners: metadata.notifyPolicyUsers,
    policies: metadata.watchPolicies,
  };
}

/** A discovery with no changed definition must revalidate the same current location. */
async function unchangedDiscovery(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'tick' | 'startup' | 'captured',
): Promise<string[]> {
  if (mode !== 'startup') {
    const result = await f.tick(mode === 'captured' ? f.empty : f.dir);
    return result.erroredObservations
      .filter((item) => item.monitorId === 'b')
      .map((item) => item.message);
  }
  const start = f.errors.length;
  await f.watch();
  return f.errors.slice(start);
}

for (const first of ['tick', 'startup'] as const) {
  for (const repeated of ['tick', 'startup'] as const) {
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      first +
        ' denial retains its location across unchanged ' +
        repeated +
        ' rescans',
      async () => {
        const f = await fixture(first);
        const pending = await f.suspend();
        await f.emit('Held B');
        f.move();
        await f.tick();
        const retained = f.state();
        const admitted = f.file;
        let checkpoint: Promise<BatchOutcome> | undefined;
        let settled = false;
        let initiallySettled: boolean;
        let readCode: unknown;
        const repeatedErrors: string[][] = [];
        const repeatedStates: ReturnType<typeof f.state>[] = [];
        const repeatedSettled: boolean[] = [];
        const locations: (string | undefined)[] = [];
        const counts: number[] = [];
        let firstErrors: string[];
        let healthyProgress: number;
        try {
          chmodSync(path.dirname(admitted), 0);
          writeFileSync(
            f.originalFile,
            f.text('watched', DEBOUNCE, 'Conflicting fallback'),
          );
          try {
            readFileSync(admitted);
          } catch (error) {
            if (error instanceof Error && 'code' in error)
              readCode = error.code;
          }
          const old = await pending.finish();
          firstErrors =
            'result' in old && old.result && 'erroredObservations' in old.result
              ? old.result.erroredObservations.map((item) => item.message)
              : f.errors.slice();
          checkpoint = f.checkpoint('Later B').then((outcome) => {
            settled = true;
            return outcome;
          });
          await settle();
          initiallySettled = settled;
          const initialHealthy = repeated === 'tick' ? f.cCalls : f.cFactories;
          for (let i = 0; i < 3; i++) {
            // New independent scopes prove progress without changing either b definition.
            writeFileSync(path.join(f.dir, 'd' + i + '.md'), f.text('healthy'));
            repeatedErrors.push(await unchangedDiscovery(f, repeated));
            await settle();
            repeatedStates.push(f.state());
            repeatedSettled.push(settled);
            locations.push(liveOwnership(f).currentPath);
            counts.push(liveOwnership(f).users);
          }
          healthyProgress =
            (repeated === 'tick' ? f.cCalls : f.cFactories) - initialHealthy;
        } finally {
          chmodSync(path.dirname(admitted), 0o700);
          rmSync(f.originalFile, { force: true });
          await pending.finish();
          await f.tick();
          await checkpoint;
        }
        await until(() => f.heldCount() === 2);
        expect(await checkpoint).toBe('admitted');
        expect(readCode).toBe('EACCES');
        expect(firstErrors.some((message) => message.includes('EACCES'))).toBe(
          true,
        );
        expect(initiallySettled).toBe(false);
        expect(
          repeatedErrors.every((errors) =>
            errors.some((message) => message.includes('EACCES')),
          ),
        ).toBe(true);
        expect(repeatedStates).toEqual([retained, retained, retained]);
        expect(repeatedSettled).toEqual([false, false, false]);
        expect(locations).toEqual([admitted, admitted, admitted]);
        expect(counts).toEqual([1, 1, 1]);
        expect(healthyProgress).toBeGreaterThanOrEqual(3);
        expect(f.bFactories).toBe(1);
        expect(f.bPolls).toBe(0);
        expect(f.rows()).toEqual([]);
        expect(f.state().sourceState).toEqual({ cursor: 999 });
        expect(
          f.state().notifyState.pendingDebounce?.observations[1]?.monitor
            .instructions,
        ).toBe('Original handling');
        await f.reopen();
        expect(liveOwnership(f).owners.size).toBe(0);
        expect(liveOwnership(f).policies.size).toBe(0);
      },
    );
  }
}

for (const repeated of ['tick', 'startup', 'captured'] as const) {
  it(
    'closed location survives repeated ' +
      repeated +
      ' discovery under faithful read/metadata I/O failure',
    async () => {
      const f = await fixture();
      const pending = await f.suspend();
      await f.emit('Held B');
      f.move();
      await f.tick();
      const admitted = f.file;
      const retained = f.state();
      let checkpoint: Promise<BatchOutcome> | undefined;
      let settled = false;
      let initiallySettled: boolean;
      const diagnostics: string[][] = [];
      const states: ReturnType<typeof f.state>[] = [];
      const accepted: boolean[] = [];
      const locations: (string | undefined)[] = [];
      try {
        writeFileSync(
          f.originalFile,
          f.text('watched', DEBOUNCE, 'Conflicting fallback'),
        );
        locationFault.path = admitted;
        locationFault.readCode = 'EIO';
        locationFault.statCode = 'EIO';
        locationFault.looksAbsent = true;
        await pending.finish();
        checkpoint = f.checkpoint('Later B').then((outcome) => {
          settled = true;
          return outcome;
        });
        await settle();
        initiallySettled = settled;
        for (let i = 0; i < 3; i++) {
          diagnostics.push(await unchangedDiscovery(f, repeated));
          // Captured-route-only diagnostics do not themselves open a gate; the following
          // complete discovery must still consult the same blocked location.
          if (repeated === 'captured')
            diagnostics.push(await unchangedDiscovery(f, 'tick'));
          await settle();
          states.push(f.state());
          accepted.push(settled);
          locations.push(liveOwnership(f).currentPath);
        }
      } finally {
        delete locationFault.path;
        delete locationFault.readCode;
        delete locationFault.statCode;
        delete locationFault.looksAbsent;
        rmSync(f.originalFile, { force: true });
        await pending.finish();
        await f.tick();
        await checkpoint;
      }
      await until(() => f.heldCount() === 2);
      expect(await checkpoint).toBe('admitted');
      expect(initiallySettled).toBe(false);
      expect(
        diagnostics.every((errors) =>
          errors.some((message) => message.includes('EIO')),
        ),
      ).toBe(true);
      expect(states).toEqual([retained, retained, retained]);
      expect(accepted).toEqual([false, false, false]);
      expect(locations).toEqual([admitted, admitted, admitted]);
      expect(f.bFactories).toBe(1);
      expect(f.bPolls).toBe(0);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      await f.reopen();
      expect(liveOwnership(f).owners.size).toBe(0);
    },
  );
}

it('a newly discovered unresolved location stays authoritative while blocked and sees later invalid-file edits', async () => {
  const f = await fixture();
  await f.emit('Held B');
  f.move();
  f.edit('absent-source');
  // This location has never successfully reconciled; source resolution closes its gate.
  const first = await f.tick();
  const admitted = f.file;
  const retained = f.state();
  const initiallyBlockedLocation = liveOwnership(f).currentPath;
  let checkpoint: Promise<BatchOutcome> | undefined;
  let settled = false;
  const diagnostics: string[][] = [];
  const states: ReturnType<typeof f.state>[] = [];
  const accepted: boolean[] = [];
  try {
    writeFileSync(admitted, '---\nwatch: invalid\n---');
    writeFileSync(
      f.originalFile,
      f.text('watched', DEBOUNCE, 'Conflicting fallback'),
    );
    checkpoint = f.checkpoint('Later B').then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    for (let i = 0; i < 3; i++) {
      diagnostics.push(await unchangedDiscovery(f, 'tick'));
      await settle();
      states.push(f.state());
      accepted.push(settled);
    }
  } finally {
    rmSync(f.originalFile, { force: true });
    f.edit();
    await f.tick();
    await checkpoint;
  }
  await until(() => f.heldCount() === 2);
  expect(await checkpoint).toBe('admitted');
  expect(
    first.erroredObservations.some((item) =>
      item.message.includes('unknown source'),
    ),
  ).toBe(true);
  expect(initiallyBlockedLocation).toBe(admitted);
  expect(diagnostics.every((errors) => errors.length > 0)).toBe(true);
  expect(states).toEqual([retained, retained, retained]);
  expect(accepted).toEqual([false, false, false]);
  expect(f.bFactories).toBe(1);
  expect(f.bPolls).toBe(0);
  await f.reopen();
});

for (const absence of ['ENOENT', 'ENOTDIR'] as const) {
  it.skipIf(process.platform === 'win32' && absence === 'ENOTDIR')(
    'a closed location permits genuine ' +
      absence +
      ' moveback and updates its one owned path',
    async () => {
      const f = await fixture();
      await f.emit('Held B');
      f.move();
      await f.tick();
      const admitted = f.file;
      writeFileSync(admitted, '---\nwatch: invalid\n---');
      await f.tick();
      let settled = false;
      const checkpoint = f.checkpoint('Later B').then((outcome) => {
        settled = true;
        return outcome;
      });
      await settle();
      const before = settled;
      const blockedPath = liveOwnership(f).currentPath;
      writeFileSync(
        f.originalFile,
        f.text('watched', DEBOUNCE, 'Fresh authored candidate'),
      );
      rmSync(admitted);
      if (absence === 'ENOTDIR') {
        rmSync(path.dirname(admitted), { recursive: true });
        writeFileSync(
          path.dirname(admitted),
          'The previous parent is now a file.',
        );
      }
      const recovery = await f.tick();
      expect(await checkpoint).toBe('admitted');
      await until(() => f.heldCount() === 2);
      expect(before).toBe(false);
      expect(blockedPath).toBe(admitted);
      expect(recovery.erroredObservations).toEqual([]);
      expect(liveOwnership(f).currentPath).toBe(f.originalFile);
      expect(liveOwnership(f).users).toBe(1);
      expect(f.bFactories).toBe(1);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(
        f.state().notifyState.pendingDebounce?.observations[1]?.monitor
          .instructions,
      ).toBe('Original handling');
      await f.reopen();
      expect(liveOwnership(f).owners.size).toBe(0);
    },
  );
}

it('last live owner retires closed location metadata and a later owner pins fresh authored handling', async () => {
  const f = await fixture();
  await f.emit('Held B');
  f.move();
  await f.tick();
  const retiredPath = f.file;
  writeFileSync(retiredPath, '---\nwatch: invalid\n---');
  await f.tick();
  const blockedPath = liveOwnership(f).currentPath;
  const retained = f.state();
  // The old owner's batch waits behind its closed gate until the owner stops.
  const checkpoint = f.checkpoint('Unaccepted old-owner yield');
  await settle();
  await f.stop();
  const outcome = await checkpoint;
  const retired = liveOwnership(f);
  expect(outcome).toBe('dropped');
  expect(blockedPath).toBe(retiredPath);
  expect(retired.owners.size).toBe(0);
  expect(retired.policies.size).toBe(0);
  expect(f.state()).toEqual(retained);
  expect(
    JSON.stringify([...retired.owners.values(), ...retired.policies.values()]),
  ).not.toContain(retiredPath);
  rmSync(retiredPath);
  writeFileSync(
    f.originalFile,
    f.text('watched', DEBOUNCE, 'Fresh owner handling'),
  );
  await f.watch();
  await settle();
  expect(await f.checkpoint()).toBe('admitted');
  await f.emit('Fresh B');
  expect(f.bFactories).toBe(2);
  expect(liveOwnership(f).currentPath).toBe(f.originalFile);
  expect(liveOwnership(f).users).toBe(1);
  expect(f.state().notifyState.pendingDebounce?.observations).toHaveLength(2);
  expect(
    f.state().notifyState.pendingDebounce?.observations[1]?.monitor
      .instructions,
  ).toBe('Fresh owner handling');
  await f.reopen();
  expect(liveOwnership(f).owners.size).toBe(0);
  expect(liveOwnership(f).policies.size).toBe(0);
});
