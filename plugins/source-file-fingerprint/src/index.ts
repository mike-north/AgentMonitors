import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'glob';
import type {
  ChangeKind,
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';

interface ScopeConfig {
  globs: string[];
  ignore: string[];
  cwd: string | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const raw = config['globs'];
  // Distinguish "required field absent" from "present but wrong type" so the
  // author gets a precise message (mirrors the scope schema's `required`).
  if (raw === undefined) {
    throw new Error('scope.globs is required');
  }
  // Ergonomic shorthand: a single pattern may be written as a bare string
  // (`globs: notes.md`) instead of a one-element array (`globs: ['notes.md']`).
  // Normalize either form to the internal `string[]`.
  let globs: string[];
  if (typeof raw === 'string') {
    globs = [raw];
  } else if (
    Array.isArray(raw) &&
    raw.every((g): g is string => typeof g === 'string')
  ) {
    globs = raw;
  } else {
    throw new Error('scope.globs must be a string or an array of strings');
  }
  if (globs.length === 0 || globs.some((g) => g.trim() === '')) {
    throw new Error('scope.globs must not contain empty patterns');
  }
  const rawIgnore = config['ignore'];
  let ignore: string[] = [];
  if (rawIgnore !== undefined) {
    // Match `globs` ergonomics: a single exclude may be written as a bare string
    // and is normalized to the same internal `string[]` representation.
    if (typeof rawIgnore === 'string') {
      ignore = [rawIgnore];
    } else if (
      Array.isArray(rawIgnore) &&
      rawIgnore.every((g): g is string => typeof g === 'string')
    ) {
      ignore = rawIgnore;
    } else {
      throw new Error('scope.ignore must be a string or an array of strings');
    }
    if (ignore.some((g) => g.trim() === '')) {
      throw new Error('scope.ignore must not contain empty patterns');
    }
  }
  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : undefined;
  return { globs, ignore, cwd };
}

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Whether an error from `stat` means the path genuinely does not exist
 * (`ENOENT`/`ENOTDIR`). Other errors — `EACCES`, `EPERM`, transient IO — must
 * NOT be read as absence, or a file would be misclassified as `deleted`.
 */
export function isNotFoundError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True if the path exists, false if it is confirmed gone. Rethrows on any other
 * `stat` failure so an ambiguous error surfaces rather than silently becoming a
 * spurious `deleted` observation.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) {
      return false;
    }
    throw err;
  }
}

const CHANGE_TITLES: Record<ChangeKind, string> = {
  created: 'File created',
  modified: 'File changed',
  deleted: 'File deleted',
  descoped: 'File no longer matched by globs',
};

/**
 * Build an observation for a file that is present now (created or modified).
 * Reads the file for a textual snapshot when it is not binary.
 */
async function buildPresentObservation(
  filePath: string,
  changeKind: 'created' | 'modified',
  currentHash: string,
  previousHash?: string,
): Promise<Observation> {
  const content = await readFile(filePath);
  const summary = `${CHANGE_TITLES[changeKind]}: ${filePath}`;
  const hashes =
    previousHash !== undefined
      ? { filePath, previousHash, currentHash }
      : { filePath, currentHash };
  const observation: Observation = {
    title: summary,
    summary,
    changeKind,
    payload: hashes,
    objectKey: filePath,
    queryScope: { filePath },
    snapshot: hashes,
  };
  if (!content.includes(0)) {
    observation.snapshotText = content.toString('utf-8');
  }
  return observation;
}

/**
 * Build an observation for a file that has left the matched set: `deleted`
 * (gone from disk — information lost) or `descoped` (still on disk, no longer
 * matched by the globs). No snapshot text: there is no current content to record.
 *
 * Salience policy: a `deleted` observation carries `salience: 'high'` because
 * information is permanently lost and an agent should react promptly. A
 * `descoped` observation carries no salience, leaving the effective urgency at
 * the monitor's band floor (`band.lo`) — the file still exists, no information
 * is lost.
 *
 * @see docs/specs/003-source-plugins.md §3.4 (salience policy)
 */
function buildAbsentObservation(
  filePath: string,
  changeKind: 'deleted' | 'descoped',
  previousHash: string,
): Observation {
  const summary = `${CHANGE_TITLES[changeKind]}: ${filePath}`;
  const observation: Observation = {
    title: summary,
    summary,
    changeKind,
    payload: { filePath, previousHash },
    objectKey: filePath,
    queryScope: { filePath },
    snapshot: { filePath, previousHash },
  };
  // A deleted file's information is permanently lost; escalate salience so
  // a `normal..high` band monitor delivers at `high` urgency. `descoped`
  // carries no salience (the file still exists — no information lost).
  if (changeKind === 'deleted') {
    observation.salience = 'high';
  }
  return observation;
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    globs: {
      description:
        'Glob pattern(s) to match files. A single pattern may be written as a ' +
        'bare string (e.g. "notes.md"); multiple patterns as an array (OR-ed together).',
      oneOf: [
        // `pattern: \\S` requires at least one non-whitespace character, so a
        // blank or whitespace-only pattern is rejected at validate time — keeping
        // the schema aligned with parseScopeConfig (which rejects blank patterns).
        { type: 'string', minLength: 1, pattern: '\\S' },
        {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
        },
      ],
    },
    cwd: {
      type: 'string',
      description:
        'Working directory for glob resolution. Defaults to the workspace/config root ' +
        '(the project directory containing .claude); relative cwd values resolve against ' +
        'that root, and absolute cwd values are used as-is. If no workspace/config root ' +
        'is provided, glob resolution falls back to Node/glob process cwd behavior.',
    },
    ignore: {
      oneOf: [
        { type: 'string', minLength: 1, pattern: '\\S' },
        {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
        },
      ],
      description:
        'Optional exclude glob pattern(s). A single exclude may be written as a ' +
        'bare string. Files matched by globs and by ignore ' +
        'are omitted from baseline and change detection. Resolved against the same base as globs.',
    },
    interval: {
      type: 'string',
      default: '30s',
      pattern: '^\\d+[smhd]$',
      description:
        'Default observe interval is 30s. Set watch.interval to tune how often ' +
        'this monitor re-checks matching files; this is separate from the daemon loop wake interval.',
    },
  },
  required: ['globs'],
};

interface FingerprintState {
  fingerprints: Record<string, string>;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFingerprintState(value: unknown): value is FingerprintState {
  if (!isUnknownRecord(value)) {
    return false;
  }

  const fingerprints = value['fingerprints'];
  return isUnknownRecord(fingerprints);
}

function parsePreviousState(previousState: unknown): FingerprintState {
  if (isFingerprintState(previousState)) {
    return previousState;
  }
  return { fingerprints: {} };
}

/**
 * Resolve the base directory for relative glob patterns. Project monitor paths
 * are rooted at the runtime workspace/config root, not at the daemon process cwd.
 * Without a workspace context, fall back to Node's normal process-cwd behavior.
 */
function resolveGlobCwd(
  cwd: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  if (cwd === undefined) {
    return workspacePath;
  }
  if (path.isAbsolute(cwd)) {
    return cwd;
  }
  return workspacePath !== undefined ? path.resolve(workspacePath, cwd) : cwd;
}

/**
 * Expand a glob pattern to absolute file paths, excluding directory entries.
 *
 * A globstar like `docs/**` matches the directory `docs/` itself in addition to
 * everything under it (`glob`'s documented globstar behavior). A directory is
 * not a file to hash — `nodir: true` filters those entries out at the glob
 * layer so `docs/**` behaves as "every file under docs", matching the natural
 * reading of the pattern. Without this, the observe loop below would try to
 * `readFile` a directory and crash with `EISDIR` (issue #377).
 */
function expandGlob(pattern: string, cwd: string | undefined): string[] {
  if (path.isAbsolute(pattern)) {
    return globSync(pattern, { absolute: true, nodir: true });
  }
  return globSync(pattern, {
    ...(cwd !== undefined ? { cwd } : {}),
    absolute: true,
    nodir: true,
  });
}

const source: ObservationSource = {
  name: 'file-fingerprint',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const { globs, ignore, cwd } = parseScopeConfig(config);
    const globCwd = resolveGlobCwd(cwd, context.workspacePath);
    // A first run (no valid prior state) only establishes the baseline; it must
    // not report every matched file as `created`.
    const isBaseline = !isFingerprintState(context.previousState);
    const previous = parsePreviousState(context.previousState);
    const observations: Observation[] = [];
    const nextFingerprints: Record<string, string> = {};

    // Collect the current matches once (a path matched by multiple globs is
    // hashed and reported a single time).
    // Excluded paths never enter the baseline. That prevents a monitor action
    // that writes generated files back into a watched glob from retriggering itself.
    const ignoredFiles = new Set<string>();
    for (const pattern of ignore) {
      for (const filePath of expandGlob(pattern, globCwd)) {
        ignoredFiles.add(filePath);
      }
    }

    const currentHashes = new Map<string, string>();
    for (const pattern of globs) {
      const files = expandGlob(pattern, globCwd);
      for (const filePath of files) {
        if (ignoredFiles.has(filePath)) continue;
        if (!currentHashes.has(filePath)) {
          currentHashes.set(filePath, await hashFile(filePath));
        }
      }
    }

    // Present files: created (new since baseline) or modified (hash changed).
    for (const [filePath, hash] of currentHashes) {
      nextFingerprints[filePath] = hash;
      if (isBaseline) continue;
      const previousHash = previous.fingerprints[filePath];
      if (previousHash === undefined) {
        observations.push(
          await buildPresentObservation(filePath, 'created', hash),
        );
      } else if (previousHash !== hash) {
        observations.push(
          await buildPresentObservation(
            filePath,
            'modified',
            hash,
            previousHash,
          ),
        );
      }
    }

    // Previously-tracked files no longer matched: deleted (gone from disk) vs
    // descoped (still on disk, but the globs no longer match it).
    if (!isBaseline) {
      for (const [filePath, previousHash] of Object.entries(
        previous.fingerprints,
      )) {
        if (currentHashes.has(filePath)) continue;
        const changeKind: 'deleted' | 'descoped' = (await fileExists(filePath))
          ? 'descoped'
          : 'deleted';
        observations.push(
          buildAbsentObservation(filePath, changeKind, previousHash),
        );
      }
    }

    return {
      observations,
      nextState: { fingerprints: nextFingerprints },
      ...(currentHashes.size === 0 && observations.length === 0
        ? { outcome: 'no-files-matched' }
        : {}),
    };
  },
};

export default source;
