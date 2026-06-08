/**
 * Incoming-changes observation source for Agent Monitors.
 *
 * Reports per-file diffs when a `git pull` / ref-advance brings in changes
 * touching configured path prefixes or globs.
 *
 * **Resumption token**: the last-seen commit SHA, persisted as `nextState`
 * (`{ ref: '<sha>' }`). The runtime hands it back as `context.previousState`.
 * On wake after downtime the diff spans however many pulls happened while the
 * daemon was offline — the net change is still correct.
 *
 * **v1 scope boundary**: this source fires on *any* ref advance touching the
 * configured `paths` — a pull, merge, fast-forward, or your own commit.
 * Filtering to "only others' changes / only on fetch-merge" is a deliberate
 * later refinement. A non-fast-forward advance (rebase/force-push) yields a
 * meaningful net `git diff <prev>..<current>` and will not crash; the diff may
 * include unexpected files in that case.
 */

import { execFileSync } from 'node:child_process';
import type {
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@mike-north/core';

// ---------------------------------------------------------------------------
// Scope config parsing
// ---------------------------------------------------------------------------

interface ScopeConfig {
  paths: string[];
  branch: string | undefined;
  cwd: string;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const paths = config['paths'];
  if (
    !Array.isArray(paths) ||
    !paths.every((p): p is string => typeof p === 'string')
  ) {
    throw new Error('scope.paths must be an array of strings');
  }
  const branch =
    typeof config['branch'] === 'string' ? config['branch'] : undefined;
  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : process.cwd();
  return { paths, branch, cwd };
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface IncomingChangesState {
  ref: string;
}

function isIncomingChangesState(value: unknown): value is IncomingChangesState {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['ref'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Git helpers — all use execFileSync with an args array (no shell injection)
// ---------------------------------------------------------------------------

/**
 * Resolve the current commit SHA for the given branch (or HEAD).
 * Scopes every git call to `cwd`.
 */
function resolveCurrentRef(cwd: string, branch: string | undefined): string {
  const ref = branch ?? 'HEAD';
  const sha = execFileSync('git', ['rev-parse', ref], {
    cwd,
    encoding: 'utf-8',
  }).trim();
  return sha;
}

// git diff --name-status status codes: A=added, M=modified, D=deleted,
// R=renamed, C=copied, T=type-change, X=unknown, etc.
type GitStatusLetter = string;

interface DiffEntry {
  status: GitStatusLetter;
  path: string;
}

/**
 * Return the list of changed files between two refs, filtered to `paths`.
 * Uses `--name-status` so we get the change type alongside each path.
 */
function getDiffEntries(
  cwd: string,
  fromRef: string,
  toRef: string,
  paths: string[],
): DiffEntry[] {
  // git diff --name-status <from>..<to> -- <path1> <path2> ...
  const args = [
    'diff',
    '--name-status',
    `${fromRef}..${toRef}`,
    '--',
    ...paths,
  ];
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  const entries: DiffEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Lines are tab-separated: "<status>\t<path>" or "<R100>\t<old>\t<new>"
    const parts = trimmed.split('\t');
    const rawStatus = parts[0] ?? '';
    // Rename/copy: status is like "R100" or "C95"; the new path is in column 2
    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      const newPath = parts[2] ?? parts[1] ?? '';
      if (newPath) entries.push({ status: 'R', path: newPath });
    } else {
      const filePath = parts[1] ?? '';
      if (filePath) entries.push({ status: rawStatus, path: filePath });
    }
  }
  return entries;
}

/**
 * Fetch the current file content at the given ref via `git show`.
 * Returns `undefined` for binary files (contains a NUL byte) or on error.
 */
function getFileContent(
  cwd: string,
  ref: string,
  filePath: string,
): string | undefined {
  try {
    const content = execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd,
      encoding: 'buffer',
    });
    // Omit snapshot text for binary files
    if (content.includes(0)) return undefined;
    return content.toString('utf-8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// changeKind mapping
// ---------------------------------------------------------------------------

type MappedChangeKind = 'created' | 'modified' | 'deleted';

function mapStatusToChangeKind(status: GitStatusLetter): MappedChangeKind {
  if (status === 'A') return 'created';
  if (status === 'D') return 'deleted';
  // M, R, C, T (type change), X (unknown) — treat as modified
  return 'modified';
}

// ---------------------------------------------------------------------------
// Observation builder
// ---------------------------------------------------------------------------

function buildObservation(
  entry: DiffEntry,
  fromRef: string,
  toRef: string,
  cwd: string,
): Observation {
  const changeKind = mapStatusToChangeKind(entry.status);
  const title = `Incoming change: ${entry.path} (${changeKind})`;
  const summary = title;

  const observation: Observation = {
    title,
    summary,
    changeKind,
    objectKey: entry.path,
    queryScope: { path: entry.path },
    payload: {
      path: entry.path,
      status: entry.status,
      fromRef,
      toRef,
    },
  };

  if (changeKind === 'created' || changeKind === 'modified') {
    const content = getFileContent(cwd, toRef, entry.path);
    if (content !== undefined) {
      observation.snapshotText = content;
    }
  }

  return observation;
}

// ---------------------------------------------------------------------------
// scopeSchema (JSON Schema draft-07)
// ---------------------------------------------------------------------------

const scopeSchema: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Path prefixes or globs to filter the diff',
    },
    branch: {
      type: 'string',
      description: 'Branch ref to track (default: current HEAD)',
    },
    cwd: {
      type: 'string',
      description: 'Repository working directory for git resolution',
    },
  },
  required: ['paths'],
};

// ---------------------------------------------------------------------------
// ObservationSource implementation
// ---------------------------------------------------------------------------

const source: ObservationSource = {
  name: 'incoming-changes',
  stateful: true,
  scopeSchema,

  observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    // Wrap the entire body so synchronous throws (e.g. config validation) are
    // converted to rejected promises, matching the ObservationSource contract.
    try {
      const { paths, branch, cwd } = parseScopeConfig(config);

      const currentRef = resolveCurrentRef(cwd, branch);

      // Baseline run: no valid prior state — record the current SHA and return
      // no observations. We do NOT report the whole tree as changed.
      if (!isIncomingChangesState(context.previousState)) {
        return Promise.resolve({
          observations: [],
          nextState: { ref: currentRef },
        });
      }

      const previousRef = context.previousState.ref;

      // No advance — nothing to report
      if (currentRef === previousRef) {
        return Promise.resolve({
          observations: [],
          nextState: { ref: currentRef },
        });
      }

      const entries = getDiffEntries(cwd, previousRef, currentRef, paths);
      const observations: Observation[] = entries.map((entry) =>
        buildObservation(entry, previousRef, currentRef, cwd),
      );

      return Promise.resolve({
        observations,
        nextState: { ref: currentRef },
      });
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  },
};

export default source;
