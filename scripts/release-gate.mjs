// Release-work gate: the single decision the Release workflow's "Detect
// release work" step used to inline in bash. Factored into a script so it is
// (a) node-level testable and (b) derived from the ONE authoritative
// publishable-package inventory (`PACKAGE_DIRS` in
// publish-release-packages.mjs) instead of a second, hand-maintained list of
// manifest paths that could — and did (issue #284, omitting
// `plugins/source-command-poll`) — drift from it.
//
// The gate is true when EITHER:
//   - there are pending changesets → run so the changesets action opens/updates
//     the "Release packages" Version PR; OR
//   - at least one current workspace version is not yet on its registry → run so
//     the idempotent registry publisher (publish-release-packages.mjs) reconciles
//     it.
//
// The second arm is registry-driven, not git-diff-driven. The old gate keyed
// off `git diff HEAD^..HEAD` of specific manifests, so after a *partial*
// publish failure any later unrelated commit to main made the gate false and
// the retry-safe publisher became unreachable — the unpublished packages could
// never recover. Deriving "needs release" from the registry means every
// successful main CI run can reconcile whatever is still unpublished.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PACKAGE_DIRS,
  REPO_ROOT,
  alreadyPublished,
  releaseCandidates,
} from './publish-release-packages.mjs';

/**
 * True when `.changeset/` holds at least one pending changeset (`*.md` other
 * than `README.md`). Mirrors the changesets action's own notion of "there is
 * versioning work to do".
 *
 * @param {string} changesetDir
 * @returns {boolean}
 */
export function hasPendingChangesets(changesetDir) {
  if (!existsSync(changesetDir)) return false;
  return readdirSync(changesetDir).some(
    (file) => file.endsWith('.md') && file !== 'README.md',
  );
}

/**
 * Pure decision: given whether changesets are pending and the names of
 * packages whose current version is unpublished, decide whether release work
 * should run and why.
 *
 * @param {object} input
 * @param {boolean} input.pendingChangesets
 * @param {readonly string[]} input.unpublishedNames
 * @returns {{ shouldRun: boolean, reason: string }}
 */
export function decideReleaseWork({ pendingChangesets, unpublishedNames }) {
  if (pendingChangesets) {
    return { shouldRun: true, reason: 'pending changesets present' };
  }
  if (unpublishedNames.length > 0) {
    return {
      shouldRun: true,
      reason: `unpublished current version(s): ${unpublishedNames.join(', ')}`,
    };
  }
  return {
    shouldRun: false,
    reason: 'no pending changesets and all current versions already published',
  };
}

/**
 * Wire the real inventory + changeset detection + registry check into a
 * decision. Every dependency is injectable so the decision is unit-testable
 * without touching the network or git:
 *   - `isPublished` stubs the registry lookup;
 *   - `packageDirs` / `repoRoot` point at fixture packages;
 *   - `changesetDir` points at a fixture `.changeset`.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.packageDirs]
 * @param {string} [options.repoRoot]
 * @param {(pkg: { name: string, version: string, registry: string }) => boolean} [options.isPublished]
 * @param {string} [options.changesetDir]
 * @param {(message: string) => void} [options.log]
 * @returns {{ shouldRun: boolean, reason: string, unpublishedNames: string[] }}
 */
export function computeReleaseGate({
  packageDirs = PACKAGE_DIRS,
  repoRoot = REPO_ROOT,
  isPublished = alreadyPublished,
  changesetDir = path.join(repoRoot, '.changeset'),
  log = () => undefined,
} = {}) {
  const pendingChangesets = hasPendingChangesets(changesetDir);
  // When changesets are pending the gate is already true; skip the registry
  // round-trip entirely (it would run again inside the publisher anyway).
  const unpublishedNames = pendingChangesets
    ? []
    : releaseCandidates(packageDirs, repoRoot, log, isPublished).map(
        (pkg) => pkg.name,
      );
  return {
    ...decideReleaseWork({ pendingChangesets, unpublishedNames }),
    unpublishedNames,
  };
}

/**
 * Discover the publishable package directories actually present in the
 * workspace (every `pnpm-workspace.yaml` package glob whose `package.json` is
 * not `"private": true`). Used only by the drift-guard test to prove
 * `PACKAGE_DIRS` stays complete — so a newly added publishable package can't be
 * silently omitted from the single inventory the gate and publisher share.
 *
 * @param {string} [repoRoot]
 * @returns {string[]} sorted package directories, workspace-relative
 */
export function discoverPublishablePackageDirs(repoRoot = REPO_ROOT) {
  const workspaceYaml = readFileSync(
    path.join(repoRoot, 'pnpm-workspace.yaml'),
    'utf8',
  );
  // Match `- 'libs/*'` style list entries; the repo's globs are all the
  // simple `<parent>/*` form. (allowBuilds/onlyBuiltDependencies entries are
  // `key: value`, not `- ` bullets, so they never match.)
  const globs = [
    ...workspaceYaml.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm),
  ]
    .map((match) => match[1])
    .filter((glob) => glob.endsWith('/*'));

  const dirs = [];
  for (const glob of globs) {
    const parent = glob.slice(0, -'/*'.length);
    const parentAbs = path.join(repoRoot, parent);
    if (!existsSync(parentAbs)) continue;
    for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = path.join(parentAbs, entry.name, 'package.json');
      if (!existsSync(packageJsonPath)) continue;
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.private === true) continue;
      dirs.push(`${parent}/${entry.name}`);
    }
  }
  return dirs.sort();
}

/**
 * Entry point for the workflow step. Computes the gate against the real repo
 * and emits `should-run=<bool>` to `$GITHUB_OUTPUT` (or stdout locally); the
 * human-readable reason and any per-package skip lines go to stdout so they
 * show up in the Actions step log.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.packageDirs]
 * @param {string} [options.repoRoot]
 * @param {(pkg: { name: string, version: string, registry: string }) => boolean} [options.isPublished]
 * @param {string} [options.changesetDir]
 * @param {string | undefined} [options.githubOutput]
 * @param {(message: string) => void} [options.log]
 * @param {(line: string) => void} [options.writeOutput]
 * @returns {{ shouldRun: boolean, reason: string, unpublishedNames: string[] }}
 */
export function main({
  packageDirs = PACKAGE_DIRS,
  repoRoot = REPO_ROOT,
  isPublished = alreadyPublished,
  changesetDir = path.join(repoRoot, '.changeset'),
  githubOutput = process.env.GITHUB_OUTPUT,
  log = console.log,
  writeOutput,
} = {}) {
  const decision = computeReleaseGate({
    packageDirs,
    repoRoot,
    isPublished,
    changesetDir,
    log,
  });
  log(`Release gate: ${decision.reason} -> should-run=${decision.shouldRun}`);

  const line = `should-run=${decision.shouldRun}\n`;
  if (writeOutput) {
    writeOutput(line);
  } else if (githubOutput != null && githubOutput.length > 0) {
    appendFileSync(githubOutput, line);
  } else {
    process.stdout.write(line);
  }
  return decision;
}

// Only run when invoked directly (`node scripts/release-gate.mjs`), never as a
// side effect of a test importing the decision helpers. `argv[1]` is resolved
// to an absolute path first so a relative invocation still matches
// `import.meta.url` (see the same guard in publish-release-packages.mjs).
const isMainModule =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  main();
}
