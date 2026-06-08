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

/** 64 MiB — large enough for monorepo diffs and large text files. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Resolve the current commit SHA for the given branch (or HEAD).
 *
 * Fix 1 (option injection): `--end-of-options` terminates git option parsing
 * before the user-supplied `branch` value so a value like `--help` or
 * `--git-dir=...` is treated as a ref name rather than a flag.
 *
 * Note on output format: `git rev-parse --end-of-options <ref>` echoes the
 * literal string `--end-of-options` as its first output line, followed by the
 * resolved SHA.  We therefore take the LAST non-empty line of stdout.
 *
 * Returns `undefined` if the resolution fails (not a git repo, unknown ref).
 * The caller is responsible for deciding how to handle the absence.
 */
function tryResolveCurrentRef(
  cwd: string,
  branch: string | undefined,
): string | undefined {
  const ref = branch ?? 'HEAD';
  try {
    // Fix 1: --end-of-options prevents a branch value like "--help" from being
    //        interpreted as a git flag.
    // Fix 2: maxBuffer prevents ENOBUFS on pathologically large output.
    const raw = execFileSync('git', ['rev-parse', '--end-of-options', ref], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
    });
    // Take only the last non-empty line — the echoed --end-of-options token
    // appears as an earlier line in some git versions.
    const sha = raw
      .trim()
      .split('\n')
      .filter((l) => l !== '--end-of-options')
      .at(-1)
      ?.trim();
    return sha !== undefined && sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
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
 *
 * Fix 2 (maxBuffer): explicit 64 MiB limit on all execFileSync calls.
 * Fix 3 (non-ASCII paths / spaces): use `-z` (NUL-delimited output) and
 *   `-c core.quotePath=false` so paths with non-ASCII characters, spaces, or
 *   tabs are transmitted literally rather than C-quoted. With `-z`:
 *   - Fields within a record are NUL-separated.
 *   - Records are NUL-terminated.
 *   - A rename record is:  `R<score>\0<old-path>\0<new-path>\0`
 *   - A regular record is: `<status>\0<path>\0`
 *
 * Fix 1 (option injection): `--end-of-options` before the range prevents a
 *   pathological `fromRef`/`toRef` value from acting as a git flag (in
 *   practice these are SHA values from `rev-parse`, but belt-and-suspenders).
 *
 * Returns `undefined` if the diff command fails (e.g. a gc'd prev SHA).
 */
function tryGetDiffEntries(
  cwd: string,
  fromRef: string,
  toRef: string,
  paths: string[],
): DiffEntry[] | undefined {
  // Fix 3: `-c core.quotePath=false` is a top-level git option and must come
  //   BEFORE the subcommand (`diff`).  Passing it after `diff` would make git
  //   try to parse it as a revision range and fail with "bad revision".
  // Fix 3: `-z` makes output NUL-delimited so paths with spaces, tabs, or
  //   non-ASCII characters are transmitted literally (no C-quoting).
  // Fix 1: `--end-of-options` before the range prevents a pathological SHA
  //   value from being treated as a flag (belt-and-suspenders; SHAs come from
  //   rev-parse so are safe, but defence-in-depth is cheap here).
  const args = [
    '-c',
    'core.quotePath=false',
    'diff',
    '-z',
    '--name-status',
    '--end-of-options',
    `${fromRef}..${toRef}`,
    '--',
    ...paths,
  ];
  let output: Buffer;
  try {
    // Fix 2: maxBuffer; encoding: 'buffer' so NUL bytes are preserved for
    //   the NUL-delimited parser below.
    output = execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
  } catch {
    // Fix 4: a gc'd prev SHA, a history-rewritten range, or any other git
    //   error causes a graceful re-baseline rather than a throw that would
    //   propagate up and halt the runtime tick loop.
    return undefined;
  }

  // Parse NUL-delimited output.  Each record ends with a NUL; within a
  // rename/copy record the old path and new path are also NUL-separated.
  const text = output.toString('utf-8');
  const entries: DiffEntry[] = [];

  // Split on NUL and walk the token stream.
  const tokens = text.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '') {
      i++;
      continue;
    }
    // Rename / copy: status starts with R or C and is followed by two paths
    if (token.startsWith('R') || token.startsWith('C')) {
      // tokens[i+1] = old path, tokens[i+2] = new path
      const newPath = tokens[i + 2] ?? '';
      if (newPath !== '') {
        entries.push({ status: 'R', path: newPath });
      }
      i += 3;
    } else {
      // Regular entry: status token, then path token
      const filePath = tokens[i + 1] ?? '';
      if (filePath !== '') {
        entries.push({ status: token, path: filePath });
      }
      i += 2;
    }
  }

  return entries;
}

/**
 * Fetch the current file content at the given ref via `git show`.
 * Returns `undefined` for binary files (contains a NUL byte) or on error.
 *
 * Fix 2 (maxBuffer): explicit 64 MiB limit prevents ENOBUFS on large files.
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
      maxBuffer: MAX_BUFFER,
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

      // Fix 4: if current-ref resolution fails (not a repo, unknown branch),
      // return an empty result without nextState rather than throwing.
      const currentRef = tryResolveCurrentRef(cwd, branch);
      if (currentRef === undefined) {
        return Promise.resolve({ observations: [] });
      }

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

      // Fix 4: if the diff fails (gc'd prev SHA, force-pushed history),
      // re-baseline: record the current ref and emit nothing.
      const entries = tryGetDiffEntries(cwd, previousRef, currentRef, paths);
      if (entries === undefined) {
        return Promise.resolve({
          observations: [],
          nextState: { ref: currentRef },
        });
      }

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
