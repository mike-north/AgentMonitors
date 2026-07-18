import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type {
  JsonSchema,
  KeyedCollectionConfig,
  KeyedSnapshot,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';
import {
  diffKeyedCollection,
  parseDuration,
  parseKeyedCollectionConfig,
} from '@agentmonitors/core';

// Re-exported so API Extractor can resolve the default export's type — and
// the core types its interface shape transitively references — from this
// package's own entry point, instead of flagging ae-forgotten-export
// warnings in the checked-in API report.
export type {
  ChangeKind,
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
  Urgency,
} from '@agentmonitors/core';

/**
 * Change-detection strategies (003 §11.3). `text-diff` is the default; `exit-code`
 * is first-class in v1.
 */
type ChangeStrategy = 'text-diff' | 'json-diff' | 'exit-code';

/** Default wall-clock execution limit when `timeout` is not configured (003 §11.1). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Grace period between SIGTERM and SIGKILL on timeout (003 §11.2). */
const SIGKILL_GRACE_MS = 5_000;

/** Maximum captured stdout, in bytes (003 §11.2). */
const STDOUT_CAP_BYTES = 1024 * 1024;

/** Number of trailing stderr characters retained for failure diagnostics (003 §11.5). */
const STDERR_TAIL_CHARS = 2000;

interface ScopeConfig {
  command: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number;
  objectKey: string;
  strategy: ChangeStrategy;
  /**
   * Top-level `change-detection.ignore-paths` entries for plain `json-diff`
   * output comparison. Collection-specific ignores remain inside `collection`.
   */
  ignorePaths: string[];
  /** Keyed-collection config (003 §12), present only under `strategy: json-diff`. */
  collection: KeyedCollectionConfig | undefined;
}

/**
 * Persisted per-monitor state (003 §11.4–§11.5).
 *
 * `stdout`/`exitCode` hold the last **successful** result baseline; they are kept
 * untouched across failing ticks so a recovery can diff against the pre-failure
 * baseline. `health` tracks the transition edge so health observations fire only
 * on `ok ↔ failing`. `baselined` records whether a successful baseline has ever been
 * established — a failing-first-run state is `baselined: false` (no output to diff),
 * per "a failing first run establishes no baseline". `env` is never stored here
 * (003 §11.1).
 */
interface CommandState {
  stdout: string;
  exitCode: number;
  truncated: boolean;
  health: 'ok' | 'failing';
  baselined: boolean;
  /**
   * The keyed-collection snapshot from the previous successful cycle (003 §12),
   * present only when the monitor uses `change-detection.collection`. Carried
   * forward untouched across failing ticks so a recovery diffs against the
   * pre-failure keyed baseline.
   */
  keyedSnapshot?: KeyedSnapshot;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
  truncated: boolean;
}

/** Outcome of one spawn: either a result (003 §11.2) or an execution failure (003 §11.5). */
type ExecOutcome =
  | { kind: 'result'; result: ExecResult }
  | { kind: 'failure'; error: string; stderrTail: string };

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const command = config['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((c): c is string => typeof c === 'string')
  ) {
    // `command` is argv-only by design — the child is spawned with `shell: false`,
    // so there is no word-splitting/quoting/injection surface (003 §11.1). The most
    // common mistake is writing a shell pipeline as a bare string; point authors at
    // the supported inline form rather than just rejecting it.
    const shellHint =
      typeof command === 'string'
        ? ` A bare string is not run as a shell. For a pipeline or other shell operators, wrap it in argv: ["sh", "-c", ${JSON.stringify(command)}].`
        : ' For a shell pipeline, use the argv form ["sh", "-c", "<pipeline>"].';
    throw new Error(
      `scope.command must be a non-empty array of strings (argv form, e.g. ["git", "status"]).${shellHint}`,
    );
  }

  const cd = config['change-detection'] as
    | { strategy?: string; 'ignore-paths'?: unknown }
    | undefined;
  const rawStrategy = cd?.strategy;
  const strategy: ChangeStrategy =
    rawStrategy === 'json-diff' || rawStrategy === 'exit-code'
      ? rawStrategy
      : 'text-diff';
  const ignorePaths = parseTopLevelIgnorePaths(cd);
  if (ignorePaths.length > 0 && strategy !== 'json-diff') {
    throw new Error(
      'change-detection.ignore-paths requires strategy: json-diff',
    );
  }

  // Keyed-collection mode (003 §12) is only valid under `json-diff`. The generated
  // schema rejects `collection` under other strategies at authoring time (BP3); this
  // is the defence-in-depth guard for the observe path.
  const collection = parseKeyedCollectionConfig(config['change-detection']);
  if (collection && strategy !== 'json-diff') {
    throw new Error('change-detection.collection requires strategy: json-diff');
  }

  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : undefined;

  const rawEnv = config['env'];
  const env =
    rawEnv !== null &&
    typeof rawEnv === 'object' &&
    !Array.isArray(rawEnv) &&
    Object.values(rawEnv).every((v) => typeof v === 'string')
      ? (rawEnv as Record<string, string>)
      : undefined;

  const rawTimeout = config['timeout'];
  const timeoutMs =
    typeof rawTimeout === 'string'
      ? parseDuration(rawTimeout)
      : DEFAULT_TIMEOUT_MS;

  const key = config['key'];
  const objectKey =
    typeof key === 'string' && key.length > 0 ? key : command.join(' ');

  return {
    command,
    cwd,
    env,
    timeoutMs,
    objectKey,
    strategy,
    ignorePaths,
    collection,
  };
}

/**
 * Bounded wait, after the direct child's own `exit` event, for its stdio streams
 * to `close` before falling back to whatever stdout has been captured so far. A
 * descendant that inherited stdout/stderr (e.g. a backgrounded `sleep` under
 * `sh -c 'sleep 30 & wait'`) can hold those pipes open indefinitely even after the
 * direct child itself has exited — resolving on `close` alone would hang this call
 * forever in that case. This bound only matters when a descendant lingers; a normal
 * command's streams close within milliseconds of `exit`, so it never adds latency
 * in the common case (003 §11.7, issue #303).
 */
const CLOSE_FALLBACK_MS = 2_000;

/**
 * Best-effort process-tree termination for one escalation step (SIGTERM or SIGKILL).
 *
 * On POSIX, `child` was spawned as the leader of its own process group/session
 * (`detached: true`); signaling the *negative* PID targets that whole group, so a
 * command's own background jobs (`sh -c 'sleep 30 & wait'`) die with it instead of
 * surviving as orphans (003 §11.7, issue #303).
 *
 * Windows has no process-group-signal equivalent, and no reliable graceful signal
 * for a non-console-attached spawned process — `taskkill` without `/F` frequently
 * fails silently for exactly this kind of child. The documented choice (issue #303
 * AC2) is to always use `taskkill /PID <pid> /T /F`: forceful and tree-wide, on both
 * the timeout expiry and the grace follow-up. There is no softer Windows phase to
 * escalate from, so both steps do the same thing — the follow-up is a defensive
 * retry, not a genuine escalation.
 */
function killProcessTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  isWindows: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
      // Best-effort: a "not found" failure just means the tree already exited.
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group already gone — nothing left to signal.
  }
}

/**
 * Spawn `command` directly (never a shell — `spawn` with `shell: false`), capturing
 * stdout (capped at 1 MiB) and the exit code, enforcing `timeout` with a SIGTERM→SIGKILL
 * escalation targeted at the command's **entire process tree**, not just the direct
 * child (003 §11.2/§11.7, issue #303). A nonzero exit code with output is a **result**,
 * not a failure (003 §11.2/§11.5); spawn failure and timeout are failures.
 */
async function runCommand(scope: ScopeConfig): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    const [file, ...args] = scope.command;
    const isWindows = process.platform === 'win32';
    // `file` is guaranteed defined: parseScopeConfig rejects an empty command.
    const child = spawn(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      file!,
      args,
      {
        cwd: scope.cwd,
        // `env` is merged over the inherited daemon environment (003 §11.1).
        env: scope.env ? { ...process.env, ...scope.env } : process.env,
        shell: false,
        // POSIX: leader of its own process group/session, so the timeout escalation
        // can signal the whole tree at once (`killProcessTree` above) instead of only
        // the direct child (003 §11.7, issue #303). Windows has no equivalent flag;
        // its tree-kill goes through `taskkill /T` instead, which does not depend on
        // process-group membership.
        detached: !isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let settled = false;
    let timedOut = false;
    let truncated = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';

    // Bound stdout capture at the 1 MiB cap (003 §11.2): once the cap is reached,
    // further bytes are discarded but the stream is never paused, so a chatty child
    // is always drained and can never block on a full pipe buffer.
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= STDOUT_CAP_BYTES) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      const remaining = STDOUT_CAP_BYTES - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    // Captured solely for failure diagnostics (003 §11.5); bounded so a pathological
    // stderr volume can't grow this process's own memory unbounded — only the
    // trailing STDERR_TAIL_CHARS characters ever survive.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > STDERR_TAIL_CHARS * 4) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_CHARS);
      }
    });

    function clearTimers(): void {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      clearTimeout(closeFallbackTimer);
    }

    function finish(outcome: ExecOutcome): void {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(outcome);
    }

    function resolveFromExit(
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void {
      const tail = stderrTail.slice(-STDERR_TAIL_CHARS);
      if (timedOut) {
        finish({
          kind: 'failure',
          error: `Command timed out after ${String(scope.timeoutMs)}ms`,
          stderrTail: tail,
        });
        return;
      }
      if (signal !== null) {
        // Terminated by a signal we did not send ourselves (timedOut is false) — no
        // usable result was produced (003 §11.5).
        finish({
          kind: 'failure',
          error: `Command terminated by signal ${signal}`,
          stderrTail: tail,
        });
        return;
      }
      finish({
        kind: 'result',
        result: {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          exitCode: code ?? 0,
          truncated,
        },
      });
    }

    child.once('error', (error) => {
      finish({
        kind: 'failure',
        error: error.message,
        stderrTail: stderrTail.slice(-STDERR_TAIL_CHARS),
      });
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      if (timedOut) {
        // Resolve from the direct child's own exit — never wait on stdio stream
        // close here. An orphaned descendant that inherited stdout/stderr (e.g.
        // `sleep` under `sh -c 'sleep 30 & wait'`) can hold those pipes open
        // indefinitely even once the whole process group has been signaled; gating
        // resolution on `close` would hang this call forever in that case — the
        // exact bug this fixes (003 §11.7, issue #303).
        resolveFromExit(code, signal);
        return;
      }
      // Normal completion: give stdio a bounded window to `close` so a fast,
      // well-behaved command's full output is still captured (the existing accurate
      // behavior). The `close` listener below cancels this fallback the moment
      // streams actually close, which happens within milliseconds unless a
      // descendant is holding them open.
      closeFallbackTimer = setTimeout(() => {
        resolveFromExit(code, signal);
      }, CLOSE_FALLBACK_MS);
      closeFallbackTimer.unref();
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      resolveFromExit(code, signal);
    });

    // Wall-clock timeout: SIGTERM the whole process group, then SIGKILL after a 5s
    // grace (003 §11.2). Targeting the group — not just the direct child — is what
    // guarantees no orphaned descendant survives (003 §11.7, issue #303).
    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM', isWindows);
      graceTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL', isWindows);
      }, SIGKILL_GRACE_MS);
      // graceTimer must not keep the event loop alive on its own.
      graceTimer.unref();
    }, scope.timeoutMs);
    killTimer.unref();
  });
}

/** Recursively sort object keys for order-insensitive JSON comparison (mirrors api-poll). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function parseTopLevelIgnorePaths(
  changeDetection: { 'ignore-paths'?: unknown } | undefined,
): string[] {
  const rawIgnorePaths = changeDetection?.['ignore-paths'];
  if (rawIgnorePaths === undefined) return [];
  if (
    !Array.isArray(rawIgnorePaths) ||
    !rawIgnorePaths.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new Error(
      'change-detection.ignore-paths must be an array of strings',
    );
  }
  return rawIgnorePaths;
}

function normalizeJsonPath(path: string): string {
  if (path === '$' || path.startsWith('$.')) return path;
  return `$.${path}`;
}

function assertValidJsonPathSegment(path: string, segment: string): void {
  if (segment.length === 0) {
    throw new Error(
      `Invalid change-detection.ignore-paths entry "${path}": empty path segment`,
    );
  }
  if (/[.[\]*?]/.test(segment)) {
    throw new Error(
      `Invalid change-detection.ignore-paths entry "${path}": unsupported path segment "${segment}"`,
    );
  }
}

/**
 * Clone parsed JSON and remove author-requested paths before canonical sorting.
 * Paths are intentionally the same minimal dotted grammar used by keyed
 * collections: `$.duration` and bare `duration` both address a root field.
 */
function stripIgnoredJsonPaths(value: unknown, ignorePaths: string[]): unknown {
  if (ignorePaths.length === 0) return value;
  const cloned = structuredClone(value);
  for (const path of ignorePaths) {
    removeJsonPath(cloned, path);
  }
  return cloned;
}

function removeJsonPath(value: unknown, path: string): void {
  const normalizedPath = normalizeJsonPath(path);
  if (normalizedPath === '$') return;
  const segments = normalizedPath.slice(2).split('.');
  let current: unknown = value;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    assertValidJsonPathSegment(path, segment ?? '');
    if (current === null || typeof current !== 'object') return;
    if (!Object.hasOwn(current, segment ?? '')) return;
    current = (current as Record<string, unknown>)[segment ?? ''];
  }
  const last = segments.at(-1) ?? '';
  assertValidJsonPathSegment(path, last);
  if (current !== null && typeof current === 'object') {
    Reflect.deleteProperty(current, last);
  }
}

/**
 * Whether the result changed versus the prior baseline under `strategy` (003 §11.3).
 * `json-diff` falls back to raw text comparison when either side fails to parse,
 * identical to `api-poll`. `stderr` is never compared.
 */
function hasChanged(
  strategy: ChangeStrategy,
  ignorePaths: string[],
  prev: { stdout: string; exitCode: number },
  curr: { stdout: string; exitCode: number },
): boolean {
  switch (strategy) {
    case 'exit-code':
      return prev.exitCode !== curr.exitCode;
    case 'json-diff': {
      let prevParsed: unknown;
      let currParsed: unknown;
      try {
        prevParsed = JSON.parse(prev.stdout);
        currParsed = JSON.parse(curr.stdout);
      } catch {
        return prev.stdout !== curr.stdout;
      }
      return (
        JSON.stringify(
          sortKeys(stripIgnoredJsonPaths(prevParsed, ignorePaths)),
        ) !==
        JSON.stringify(sortKeys(stripIgnoredJsonPaths(currParsed, ignorePaths)))
      );
    }
    case 'text-diff':
      return prev.stdout !== curr.stdout;
  }
}

function isCommandState(value: unknown): value is CommandState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['stdout'] === 'string' &&
    typeof v['exitCode'] === 'number' &&
    typeof v['truncated'] === 'boolean' &&
    (v['health'] === 'ok' || v['health'] === 'failing') &&
    typeof v['baselined'] === 'boolean'
  );
}

/**
 * Build the output-changed observation (003 §11.4). `env` is deliberately absent
 * from every persisted field (payload/snapshot/state).
 */
function changedObservation(
  scope: ScopeConfig,
  result: ExecResult,
): Observation {
  return {
    title: `Command output changed: ${scope.objectKey}`,
    summary: `Command output changed: ${scope.objectKey}`,
    payload: {
      command: scope.command,
      exitCode: result.exitCode,
      strategy: scope.strategy,
      stdout: result.stdout,
      truncated: result.truncated,
    },
    snapshotText: result.stdout,
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    snapshot: {
      command: scope.command,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      strategy: scope.strategy,
    },
    changeKind: 'modified',
  };
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description:
        'Argv array; command[0] is the executable (resolved via PATH). Spawned directly, never via a shell. ' +
        "For a pipeline or other shell operators, spawn a shell explicitly: ['sh', '-c', 'git status -sb | grep ahead'].",
    },
    cwd: {
      type: 'string',
      description: 'Working directory for the child process',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'Literal env vars merged over the inherited daemon environment',
    },
    timeout: {
      type: 'string',
      pattern: '^\\d+[smhd]$',
      description:
        'Wall-clock limit (e.g. "30s"). Expiry is an execution failure.',
    },
    key: {
      type: 'string',
      description:
        'Overrides the observation objectKey (defaults to the joined argv)',
    },
    interval: {
      type: 'string',
      pattern: '^\\d+[smhd]$',
      description:
        'Polling interval (e.g., "5m"). Used by the scheduling engine, not by this plugin directly.',
    },
    'change-detection': {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['text-diff', 'json-diff', 'exit-code'],
        },
        // Keyed-collection mode (003 §12). The `collection` block is only valid
        // under `strategy: json-diff`; the `if/then` below enforces that at
        // authoring time (BP3).
        collection: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Dotted path to the array within the parsed JSON (e.g. "tasks" or "$.tasks")',
            },
            key: {
              type: 'string',
              description:
                'Field on each element used as the per-object identity',
            },
            'ignore-paths': {
              type: 'array',
              items: { type: 'string' },
              description:
                'Dotted paths (relative to each element, e.g. "fetchedAt" or "$.fetchedAt") removed before comparison',
            },
          },
          required: ['path', 'key'],
          additionalProperties: false,
        },
        'ignore-paths': {
          type: 'array',
          items: { type: 'string' },
          description:
            'Dotted paths removed from parsed JSON before plain json-diff comparison',
        },
      },
      additionalProperties: false,
      // BP3: change-detection.collection requires strategy: json-diff. Under any
      // other strategy (or the defaulted text-diff), presence of `collection` is an
      // authoring-time error.
      allOf: [
        {
          if: { required: ['collection'] },
          then: {
            properties: { strategy: { const: 'json-diff' } },
            required: ['strategy'],
          },
        },
        {
          if: { required: ['ignore-paths'] },
          then: {
            properties: { strategy: { const: 'json-diff' } },
            required: ['strategy'],
          },
        },
      ],
    },
  },
  required: ['command'],
};

const source: ObservationSource = {
  name: 'command-poll',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const scope = parseScopeConfig(config);
    const prev = isCommandState(context.previousState)
      ? context.previousState
      : undefined;

    const outcome = await runCommand(scope);

    // ---- Execution failure path (003 §11.5) -------------------------------------
    if (outcome.kind === 'failure') {
      // Prior state is kept (no re-baseline, no state loss). Emit only on the
      // ok → failing transition edge — including a failing first-ever run, which
      // establishes no baseline but records health so the recovery edge fires.
      const wasFailing = prev?.health === 'failing';
      const nextState: CommandState = {
        stdout: prev?.stdout ?? '',
        exitCode: prev?.exitCode ?? 0,
        truncated: prev?.truncated ?? false,
        health: 'failing',
        baselined: prev?.baselined ?? false,
        // Carry the keyed baseline forward untouched so recovery diffs against it.
        ...(prev?.keyedSnapshot ? { keyedSnapshot: prev.keyedSnapshot } : {}),
      };
      return {
        observations: wasFailing ? [] : [failingObservation(scope, outcome)],
        nextState,
      };
    }

    // ---- Successful execution path ----------------------------------------------
    const result = outcome.result;
    const recovered = prev?.health === 'failing';
    const hadBaseline = prev?.baselined ?? false;

    const observations: Observation[] = [];
    // A failing → ok edge always emits the recovery health observation (003 §11.5).
    if (recovered) {
      observations.push(recoveredObservation(scope));
    }

    // ---- Keyed-collection mode (003 §12) ----------------------------------------
    // Parse stdout as JSON and diff per keyed object. The keyed snapshot lives in the
    // same per-monitor state slot; the baseline rule is unchanged (first successful
    // run records the snapshot, emits nothing). A failing-first-run leaves no keyed
    // baseline, so the first success after it baselines silently too.
    if (scope.collection) {
      const result2 = diffKeyedCollection(
        JSON.parse(result.stdout),
        scope.collection,
        scope.objectKey,
        hadBaseline ? prev?.keyedSnapshot : undefined,
        {
          payload: { command: scope.command },
          queryScope: { command: scope.objectKey },
        },
      );
      observations.push(...result2.observations);
      const nextState: CommandState = {
        stdout: result.stdout,
        exitCode: result.exitCode,
        truncated: result.truncated,
        health: 'ok',
        baselined: true,
        keyedSnapshot: result2.snapshot,
      };
      return { observations, nextState };
    }

    const nextState: CommandState = {
      stdout: result.stdout,
      exitCode: result.exitCode,
      truncated: result.truncated,
      health: 'ok',
      baselined: true,
    };

    // The output-changed observation requires a real pre-failure/prior baseline to
    // diff against. The first-ever success — and the first success after a failing
    // first run — baselines silently (003 §11.4/§11.5).
    if (
      prev !== undefined &&
      hadBaseline &&
      hasChanged(scope.strategy, scope.ignorePaths, prev, result)
    ) {
      observations.push(changedObservation(scope, result));
    }

    return { observations, nextState };
  },
};

/** Health observation for the `ok → failing` edge (003 §11.5). Never carries `env`. */
function failingObservation(
  scope: ScopeConfig,
  outcome: Extract<ExecOutcome, { kind: 'failure' }>,
): Observation {
  return {
    title: `Command failing: ${scope.objectKey}`,
    summary: `Command failing: ${scope.objectKey}`,
    payload: {
      command: scope.command,
      error: outcome.error,
      stderrTail: outcome.stderrTail,
    },
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    changeKind: 'modified',
  };
}

/** Health observation for the `failing → ok` edge (003 §11.5). */
function recoveredObservation(scope: ScopeConfig): Observation {
  return {
    title: `Command recovered: ${scope.objectKey}`,
    summary: `Command recovered: ${scope.objectKey}`,
    payload: { command: scope.command },
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    changeKind: 'modified',
  };
}

export default source;
