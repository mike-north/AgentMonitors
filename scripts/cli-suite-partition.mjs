// Every tracked CLI test file must belong to exactly one Vitest suite.
// Query Vitest itself so include and exclude drift fails against real discovery.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './publish-release-packages.mjs';

export const CLI_PACKAGE_DIR = 'apps/cli';
export const CLI_VITEST_CONFIGS = [
  'vitest.config.ts',
  'vitest.serial.config.ts',
  'vitest.docker-smoke.config.ts',
];

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
 * enumeration all suites together must cover exactly once.
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
 * Report gaps, overlaps, and files outside the tracked inventory.
 *
 * @param {string[]} allFiles
 * @param {Record<string, string[]>} groups - files discovered by configuration name
 * @returns {string[]}
 */
export function partitionIssues(allFiles, groups) {
  const issues = [];
  const membership = new Map(
    allFiles.map((file) => [file, /** @type {string[]} */ ([])]),
  );

  for (const [name, files] of Object.entries(groups)) {
    const unknown = [];
    for (const file of files) {
      const suites = membership.get(file);
      if (suites) {
        suites.push(name);
      } else {
        unknown.push(file);
      }
    }
    if (unknown.length > 0) {
      issues.push(
        `${name} runs file(s) outside the tracked test-file inventory: ${unknown.join(', ')}`,
      );
    }
  }

  for (const [file, suites] of membership) {
    if (suites.length === 0) {
      issues.push(`No CLI suite runs: ${file}`);
    } else if (suites.length > 1) {
      issues.push(`Multiple CLI suites run ${file}: ${suites.join(', ')}`);
    }
  }

  return issues;
}

/**
 * Compute the partition issues for the CLI's real Vitest configurations.
 *
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function realCliSuitePartitionIssues(repoRoot = REPO_ROOT) {
  const packageAbsDir = path.join(repoRoot, CLI_PACKAGE_DIR);
  const allFiles = listTrackedTestFiles(repoRoot, CLI_PACKAGE_DIR);
  const groups = Object.fromEntries(
    CLI_VITEST_CONFIGS.map((config) => [
      config,
      listVitestFiles(packageAbsDir, config),
    ]),
  );
  return partitionIssues(allFiles, groups);
}
