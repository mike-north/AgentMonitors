// Proves apps/cli's default and serial vitest suites partition the
// package's tracked test files without overlap or gaps (issue #288): every
// `*.test.ts` file under apps/cli must be run by EXACTLY one of the two
// suites, so a file added to, or excluded from, one suite's include/exclude
// list can never silently stop running in either suite, nor run twice.
//
// File resolution shells out to the real `vitest list --filesOnly --json`
// against each config — the actual include/exclude glob resolution vitest
// itself performs — rather than a hand-built glob matcher, so drift in
// either config's glob patterns is caught against real behavior, not an
// approximation of it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './publish-release-packages.mjs';

export const CLI_PACKAGE_DIR = 'apps/cli';
export const CLI_DEFAULT_CONFIG = 'vitest.config.ts';
export const CLI_SERIAL_CONFIG = 'vitest.serial.config.ts';

/**
 * A single `{ file: string }` entry as printed by
 * `vitest list --filesOnly --json`.
 * @typedef {{ file: string }} VitestListEntry
 */

/**
 * Run `vitest list --filesOnly --json --config <configFile>` against a
 * package directory and return the resolved, absolute test-file paths vitest
 * itself would run for that config.
 *
 * @param {string} packageAbsDir
 * @param {string} configFile
 * @returns {string[]}
 */
export function listVitestFiles(packageAbsDir, configFile) {
  const stdout = execFileSync(
    'pnpm',
    ['exec', 'vitest', 'list', '--filesOnly', '--json', '--config', configFile],
    { cwd: packageAbsDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  /** @type {VitestListEntry[]} */
  const parsed = JSON.parse(stdout);
  return parsed.map((entry) => entry.file);
}

/**
 * Every `*.test.ts` / `*.spec.ts` file git tracks under a package directory,
 * absolute-pathed to match `listVitestFiles`'s output — the independent
 * enumeration the two suites together must fully (and only) cover.
 *
 * @param {string} repoRoot
 * @param {string} packageDir - relative to `repoRoot`
 * @returns {string[]}
 */
export function listTrackedTestFiles(repoRoot, packageDir) {
  const stdout = execFileSync('git', ['ls-files', packageDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((file) => /\.(test|spec)\.tsx?$/.test(file))
    .map((file) => path.join(repoRoot, file));
}

/**
 * Pure partition check: every file in `allFiles` MUST appear in exactly one
 * of `groupA` / `groupB`. Returns a list of human-readable issues; an empty
 * list means the partition holds.
 *
 * @param {object} input
 * @param {string[]} input.allFiles - the independent, full inventory
 * @param {string[]} input.groupA
 * @param {string} input.groupAName
 * @param {string[]} input.groupB
 * @param {string} input.groupBName
 * @returns {string[]}
 */
export function partitionIssues({
  allFiles,
  groupA,
  groupAName,
  groupB,
  groupBName,
}) {
  const issues = [];
  const setA = new Set(groupA);
  const setB = new Set(groupB);

  const overlap = allFiles.filter((f) => setA.has(f) && setB.has(f));
  if (overlap.length > 0) {
    issues.push(
      `File(s) run by BOTH ${groupAName} and ${groupBName}: ${overlap.join(', ')}`,
    );
  }

  const missing = allFiles.filter((f) => !setA.has(f) && !setB.has(f));
  if (missing.length > 0) {
    issues.push(
      `File(s) run by NEITHER ${groupAName} nor ${groupBName}: ${missing.join(', ')}`,
    );
  }

  const allSet = new Set(allFiles);
  const unknownA = groupA.filter((f) => !allSet.has(f));
  const unknownB = groupB.filter((f) => !allSet.has(f));
  if (unknownA.length > 0) {
    issues.push(
      `${groupAName} runs file(s) outside the tracked test-file inventory: ${unknownA.join(', ')}`,
    );
  }
  if (unknownB.length > 0) {
    issues.push(
      `${groupBName} runs file(s) outside the tracked test-file inventory: ${unknownB.join(', ')}`,
    );
  }

  return issues;
}

/**
 * Compute the partition issues for apps/cli's real, on-disk default and
 * serial vitest suites.
 *
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function realCliSuitePartitionIssues(repoRoot = REPO_ROOT) {
  const packageAbsDir = path.join(repoRoot, CLI_PACKAGE_DIR);
  const allFiles = listTrackedTestFiles(repoRoot, CLI_PACKAGE_DIR);
  const defaultFiles = listVitestFiles(packageAbsDir, CLI_DEFAULT_CONFIG);
  const serialFiles = listVitestFiles(packageAbsDir, CLI_SERIAL_CONFIG);
  return partitionIssues({
    allFiles,
    groupA: defaultFiles,
    groupAName: `default (${CLI_DEFAULT_CONFIG})`,
    groupB: serialFiles,
    groupBName: `serial (${CLI_SERIAL_CONFIG})`,
  });
}
