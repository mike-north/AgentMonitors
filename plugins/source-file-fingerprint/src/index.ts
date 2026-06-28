import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
  cwd: string | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const raw = config['globs'];
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
  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : undefined;
  return { globs, cwd };
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
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    cwd: {
      type: 'string',
      description: 'Working directory for glob resolution',
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

const source: ObservationSource = {
  name: 'file-fingerprint',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const { globs, cwd } = parseScopeConfig(config);
    // A first run (no valid prior state) only establishes the baseline; it must
    // not report every matched file as `created`.
    const isBaseline = !isFingerprintState(context.previousState);
    const previous = parsePreviousState(context.previousState);
    const observations: Observation[] = [];
    const nextFingerprints: Record<string, string> = {};

    // Collect the current matches once (a path matched by multiple globs is
    // hashed and reported a single time).
    const currentHashes = new Map<string, string>();
    for (const pattern of globs) {
      const files = globSync(pattern, {
        ...(cwd !== undefined ? { cwd } : {}),
        absolute: true,
      });
      for (const filePath of files) {
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
    };
  },
};

export default source;
