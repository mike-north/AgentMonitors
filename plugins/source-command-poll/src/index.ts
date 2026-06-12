import { execFile } from 'node:child_process';
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
    throw new Error(
      'scope.command must be a non-empty array of strings (argv form, e.g. ["git", "status"])',
    );
  }

  const cd = config['change-detection'] as { strategy?: string } | undefined;
  const rawStrategy = cd?.strategy;
  const strategy: ChangeStrategy =
    rawStrategy === 'json-diff' || rawStrategy === 'exit-code'
      ? rawStrategy
      : 'text-diff';

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

  return { command, cwd, env, timeoutMs, objectKey, strategy, collection };
}

/**
 * Spawn `command` directly (never a shell — `execFile` with `shell: false`), capturing
 * stdout (capped at 1 MiB) and the exit code, enforcing `timeout` with a SIGTERM→SIGKILL
 * escalation (003 §11.2). A nonzero exit code with output is a **result**, not a failure
 * (003 §11.2/§11.5); spawn failure and timeout are failures.
 */
async function runCommand(scope: ScopeConfig): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    const [file, ...args] = scope.command;
    // `file` is guaranteed defined: parseScopeConfig rejects an empty command.
    const child = execFile(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      file!,
      args,
      {
        cwd: scope.cwd,
        // `env` is merged over the inherited daemon environment (003 §11.1).
        env: scope.env ? { ...process.env, ...scope.env } : process.env,
        // We enforce the timeout ourselves (SIGTERM→SIGKILL) rather than relying on
        // execFile's `timeout`, so the grace escalation matches the spec exactly.
        shell: false,
        // Bound stdout capture at the 1 MiB cap (003 §11.2). When the child overruns,
        // execFile kills it and reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER with the
        // captured-so-far bytes — we treat that as a truncated result, not a failure.
        maxBuffer: STDOUT_CAP_BYTES,
        encoding: 'buffer',
      },
      (error, stdoutBuf, stderrBuf) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(graceTimer);

        const stderrFull =
          stderrBuf instanceof Buffer ? stderrBuf.toString('utf8') : '';
        const stderrTail = stderrFull.slice(-STDERR_TAIL_CHARS);

        // `error.code` is a string (ENOENT, EACCES, ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
        // …) for spawn/runtime errors and a number for a nonzero exit code.
        const err = error as (Error & { code?: string | number }) | null;
        const overflowed = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

        if (timedOut) {
          resolve({
            kind: 'failure',
            error: `Command timed out after ${String(scope.timeoutMs)}ms`,
            stderrTail,
          });
          return;
        }

        // A string `code` other than the maxBuffer overflow marks a real spawn/runtime
        // failure (no usable result produced) — §11.5.
        if (err !== null && typeof err.code === 'string' && !overflowed) {
          resolve({
            kind: 'failure',
            error: err.message,
            stderrTail,
          });
          return;
        }

        // A real result — including a nonzero exit code (003 §11.2) and a stdout
        // overflow (a truncated result, which still diffs stably on the capped slice).
        // `encoding: 'buffer'` guarantees a Buffer at runtime; the union is only a
        // type-level artifact of execFile's overloaded callback.
        const buf: Buffer = Buffer.isBuffer(stdoutBuf)
          ? stdoutBuf
          : Buffer.from(String(stdoutBuf), 'utf8');
        const { text, truncated } = capStdout(buf, overflowed);
        const exitCode =
          err != null && typeof err.code === 'number' ? err.code : 0;
        resolve({
          kind: 'result',
          result: { stdout: text, exitCode, truncated },
        });
      },
    );

    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Wall-clock timeout: SIGTERM, then SIGKILL after a 5s grace (003 §11.2). This
    // guarantees no orphaned child survives the grace window.
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
      // graceTimer must not keep the event loop alive on its own.
      graceTimer.unref();
    }, scope.timeoutMs);
    killTimer.unref();
  });
}

/**
 * Cap a stdout buffer at 1 MiB, marking `truncated` on overflow (003 §11.2). The
 * captured slice is always the same leading `STDOUT_CAP_BYTES` bytes, so two
 * truncated captures of identical leading content diff as unchanged. `overflowed`
 * is set when execFile's maxBuffer guard fired (the child produced more than the cap).
 */
function capStdout(
  stdout: Buffer,
  overflowed: boolean,
): { text: string; truncated: boolean } {
  const truncated = overflowed || stdout.length > STDOUT_CAP_BYTES;
  const slice =
    stdout.length > STDOUT_CAP_BYTES
      ? stdout.subarray(0, STDOUT_CAP_BYTES)
      : stdout;
  return { text: slice.toString('utf8'), truncated };
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

/**
 * Whether the result changed versus the prior baseline under `strategy` (003 §11.3).
 * `json-diff` falls back to raw text comparison when either side fails to parse,
 * identical to `api-poll`. `stderr` is never compared.
 */
function hasChanged(
  strategy: ChangeStrategy,
  prev: { stdout: string; exitCode: number },
  curr: { stdout: string; exitCode: number },
): boolean {
  switch (strategy) {
    case 'exit-code':
      return prev.exitCode !== curr.exitCode;
    case 'json-diff':
      try {
        const prevJson = JSON.stringify(sortKeys(JSON.parse(prev.stdout)));
        const currJson = JSON.stringify(sortKeys(JSON.parse(curr.stdout)));
        return prevJson !== currJson;
      } catch {
        return prev.stdout !== curr.stdout;
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
        'Argv array; command[0] is the executable (resolved via PATH). Spawned directly, never via a shell.',
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
                'Dotted $.-path to the array within the parsed JSON (e.g. "$.tasks")',
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
                'Dotted $.-paths (relative to each element) removed before comparison',
            },
          },
          required: ['path', 'key'],
        },
      },
      // BP3: change-detection.collection requires strategy: json-diff. Under any
      // other strategy (or the defaulted text-diff), presence of `collection` is an
      // authoring-time error.
      if: { required: ['collection'] },
      then: {
        properties: { strategy: { const: 'json-diff' } },
        required: ['strategy'],
      },
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
      hasChanged(scope.strategy, prev, result)
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
