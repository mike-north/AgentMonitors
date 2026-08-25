// Dedicated workspace-resolution regression check for better-sqlite3
// (Refs #516, #509).
//
// better-sqlite3@13.0.2 fixed a class of native-module crashes under Node 24
// where the addon called `process.abort()` during teardown instead of
// raising a catchable JS error — killing the whole daemon process outright.
// @agentmonitors/core's SQLite persistence layer, @agentmonitors/cli's
// direct dependency, and drizzle-orm's peer dependency on better-sqlite3 all
// need to land on that fix.
//
// This is deliberately its own file/mechanism, separate from the generic
// `PATCHED_MINIMUMS` lockfile-regression list in
// `check-dependency-audit.test.ts` (Refs #290): that list tracks GHSA
// security advisories, and better-sqlite3's floor here is a process-stability
// fix, not a security patch. Mixing the two would let a future edit to the
// security-advisory list silently drop this guard.
//
// Uses the real `pnpm why --json` resolution (not a hand-parsed lockfile),
// matching the precedent set by `resolvedVersions` in
// `check-dependency-audit.mjs`.
//
// @see https://github.com/mike-north/AgentMonitors/issues/516
// @see https://github.com/mike-north/AgentMonitors/issues/509
// @see https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

// The first better-sqlite3 release containing the Node 24 process-abort fix
// (Refs #516, #509). Anything older can reintroduce the crash.
export const SAFE_MINIMUM_VERSION = '13.0.2';

// The package.json-declared consumers this check requires to be present,
// and pinned to the single shared resolution above.
export const EXPECTED_CONSUMERS = [
  '@agentmonitors/core',
  '@agentmonitors/cli',
  'drizzle-orm',
];

/**
 * @typedef {{ name: string, version?: string, dependents?: PnpmWhyDependent[] }} PnpmWhyDependent
 * @typedef {{ version: string, dependents?: PnpmWhyDependent[] }} PnpmWhyEntry
 * @typedef {{ version: string, consumers: string[] }} Resolution
 */

/**
 * Recursively collects every package name appearing anywhere in a `pnpm why
 * --json` dependents tree — direct dependents (e.g. `@agentmonitors/cli`)
 * and dependents reached only through a peer (e.g. `drizzle-orm`, which is
 * itself required by `@agentmonitors/core`) alike — so the diagnostic report
 * below names the real consumer, not just the immediate parent.
 *
 * @param {PnpmWhyDependent[] | undefined} dependents
 * @returns {string[]}
 */
function collectConsumerNames(dependents) {
  if (!dependents) return [];
  /** @type {string[]} */
  const names = [];
  for (const dependent of dependents) {
    names.push(dependent.name);
    names.push(...collectConsumerNames(dependent.dependents));
  }
  return [...new Set(names)];
}

/**
 * Pure parser for `pnpm why <pkg> --json` output: one entry per distinct
 * resolved version, each carrying the flat set of package names that pulled
 * it in. Split out from `betterSqlite3Resolutions` so the assertion logic
 * can be exercised against a hand-written fixture without shelling out to
 * pnpm (see check-better-sqlite3-resolution.test.ts).
 *
 * @param {string} jsonText
 * @returns {Resolution[]}
 */
export function parseWhyOutput(jsonText) {
  /** @type {PnpmWhyEntry[]} */
  const entries = JSON.parse(jsonText);
  return entries.map((entry) => ({
    version: entry.version,
    consumers: collectConsumerNames(entry.dependents),
  }));
}

/**
 * Runs the real `pnpm why better-sqlite3 --json` against the workspace and
 * returns the parsed, per-version consumer breakdown.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {Resolution[]}
 */
export function betterSqlite3Resolutions({ cwd = REPO_ROOT } = {}) {
  const stdout = execFileSync('pnpm', ['why', 'better-sqlite3', '--json'], {
    encoding: 'utf8',
    cwd,
  });
  return parseWhyOutput(stdout);
}

/**
 * Renders a "which package resolved what" report, used both by the CLI
 * entry point below and by test failure messages.
 *
 * @param {Resolution[]} resolutions
 * @returns {string}
 */
export function formatResolutions(resolutions) {
  if (resolutions.length === 0) return '  (no resolutions found)';
  return resolutions
    .map(
      ({ version, consumers }) =>
        `  - better-sqlite3@${version} resolved via: ${
          consumers.length > 0
            ? consumers.join(', ')
            : '(no named consumers found)'
        }`,
    )
    .join('\n');
}

export function main() {
  const resolutions = betterSqlite3Resolutions();
  console.log('better-sqlite3 workspace resolution:');
  console.log(formatResolutions(resolutions));
  process.exitCode = resolutions.length === 1 ? 0 : 1;
}

// `file://${process.argv[1]}` string construction isn't portable (notably on
// Windows, where a raw path isn't a valid file-URL segment). Resolve
// `argv[1]` to an absolute path and convert it through `pathToFileURL`
// instead, matching the pattern already used in check-dependency-audit.mjs.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  main();
}
