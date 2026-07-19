// Guards the workspace's `clean` script contract (issue #443): every
// package with its own api-extractor config pair must remove BOTH `dist`
// and the api-extractor scratch dir `temp` (not just `dist`), and the root
// `clean` script must fan that out across every project via
// `nx run-many --target=clean` (excluding the workspace root project
// itself, which has no `clean` target) and then reset the Nx cache/daemon
// via `nx reset` — with `NX_TUI=false` scoped to EACH invocation
// individually, not shared across the chain.
//
// Before this guard existed, nothing in CI ever invoked `pnpm clean` (it
// has no build/test/type-check side effect, so it can't be caught by any
// other check), so the clean contract had zero regression protection: a
// future package could add its own `dist`-only clean script, or the root
// script could silently regress to `rm -rf dist` shapes or lose its
// `nx reset` step, and CI would stay green.
//
// `findApiExtractorPackageDirs` discovers qualifying packages by walking
// the real filesystem for the `api-extractor.build.json` +
// `api-extractor.report.json` pair — deliberately NOT a hardcoded list of
// package names — so a newly added package automatically falls under this
// guard the moment it gains an api-extractor config, with no separate
// "remember to add it here" step.

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo root, derived the same way as every other path this module exports. */
export const REPO_ROOT = join(scriptDir, '..');

/** Absolute path to the real, on-disk root `package.json` this module guards. */
export const ROOT_PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');

/**
 * The workspace root project's Nx name (see root `package.json#name`). It
 * has no `clean` target of its own — its `dist`-having descendants are
 * cleaned via `nx run-many`, so the root `clean` script must exclude it
 * from that fan-out (an `nx run-many --target=clean` that tried to include
 * it would fail: there is no such target on that project).
 */
export const WORKSPACE_ROOT_PROJECT_NAME = 'agentmonitors-workspace';

/** Directory names never worth descending into while discovering packages. */
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.nx',
  '.claude',
  '.turbo',
  'dist',
  'temp',
  '.next',
]);

/**
 * Walk the real, on-disk repo tree and return every directory (relative to
 * `root`) that has its own `api-extractor.build.json` AND
 * `api-extractor.report.json` — the config pair that marks a published
 * package with a curated, rolled-up public API (see
 * `scripts/api-report-ci-wiring.mjs`'s `hasApiExtractorConfigs`, which this
 * mirrors but reaches by filesystem discovery instead of an existing
 * curated package list, so this guard has no dependency on that list
 * staying in sync).
 *
 * The repo root itself also carries both files (the shared base config
 * every package's own config `extends`), but is deliberately excluded: it
 * has no `check:api-report`/`build` scripts of its own, and its `clean`
 * script is the aggregate one validated by
 * `assertRootCleanRunsWorkspaceCleanAndReset`, not a per-package one.
 *
 * @param {string} [root]
 * @returns {string[]} relative paths, sorted
 */
export function findApiExtractorPackageDirs(root = REPO_ROOT) {
  const found = [];

  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (
      dir !== root &&
      entries.some(
        (entry) => entry.isFile() && entry.name === 'api-extractor.build.json',
      ) &&
      entries.some(
        (entry) => entry.isFile() && entry.name === 'api-extractor.report.json',
      )
    ) {
      found.push(relative(root, dir));
      // Don't descend further — a package directory's own nested content
      // (e.g. a vendored fixture) is never itself a second package.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walk(join(dir, entry.name));
    }
  };

  walk(root);
  return found.sort();
}

/**
 * Split a shell script string into its individual chained commands (on
 * `&&`, `||`, `;`, or a newline). Mirrors
 * `api-report-ci-wiring.mjs`'s `splitChainedCommands` — kept local so this
 * module has no import-time dependency on that one's internals.
 *
 * @param {string} script
 * @returns {string[]}
 */
function splitChainedCommands(script) {
  return script
    .split(/&&|\|\||;|\n/)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

/**
 * @typedef {{ scripts?: Record<string, string> }} PackageJson
 */

/**
 * Validate that a single package's `clean` script removes BOTH `dist` and
 * the api-extractor scratch dir `temp` — not just `dist` (the pre-#443
 * shape, restored to a `rm -rf dist`-only script, silently reopens the gap
 * this fix closed: `check:api-report`/`fix:api-report`'s `temp/` scratch
 * dir accumulates forever and agents fall back to hand-running a raw
 * `rm -rf dist temp`, forcing a permission prompt every time).
 *
 * @param {PackageJson} pkg
 * @param {string} label - identifies the package in thrown errors (e.g. its package.json path)
 */
export function assertPackageCleanRemovesDistAndTemp(pkg, label) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error(`${label} has no top-level "scripts" section`);
  }

  const clean = scripts.clean;
  if (typeof clean !== 'string') {
    throw new Error(`${label} is missing a "clean" script`);
  }

  const rmCommands = splitChainedCommands(clean).filter((command) =>
    /^rm\s+-rf\b/.test(command),
  );
  if (rmCommands.length === 0) {
    throw new Error(
      `${label} "clean" script must run \`rm -rf\` — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }

  const removedTargets = new Set(
    rmCommands.flatMap((command) => command.split(/\s+/).slice(2)),
  );

  if (!removedTargets.has('dist')) {
    throw new Error(
      `${label} "clean" script must remove "dist" — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  if (!removedTargets.has('temp')) {
    throw new Error(
      `${label} "clean" script must also remove "temp" (the api-extractor ` +
        `check:api-report/fix:api-report scratch dir), not just "dist" — ` +
        `got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
}

/**
 * Validate that the root `clean` script (1) fans a `clean` target out
 * across every project via `nx run-many --target=clean`, excluding the
 * workspace root project (which has no `clean` target of its own), and (2)
 * afterwards resets the Nx cache/daemon via `nx reset` — with
 * `NX_TUI=false` scoped to EACH of those two invocations individually,
 * rather than a single shared `NX_TUI=false` prefix that only actually
 * covers the first command in the chain. A shared prefix looks identical
 * in a shell (`NX_TUI=false nx run-many ... && nx reset` still runs both
 * commands), but leaves `nx reset` unscoped the moment anyone reorders or
 * lifts the second command out of that exact chain (e.g. into its own npm
 * script), silently reintroducing the Nx TUI on that invocation.
 *
 * @param {PackageJson} pkg
 */
export function assertRootCleanRunsWorkspaceCleanAndReset(pkg) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error('root package.json has no top-level "scripts" section');
  }

  const clean = scripts.clean;
  if (typeof clean !== 'string') {
    throw new Error('root package.json is missing a "clean" script');
  }

  const commands = splitChainedCommands(clean);

  const runManyIndex = commands.findIndex((command) =>
    /nx run-many\s+--target=clean\b/.test(command),
  );
  if (runManyIndex === -1) {
    throw new Error(
      'root "clean" script must invoke `nx run-many --target=clean` to ' +
        `fan the per-project clean out across the workspace — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const runManyCommand = commands[runManyIndex];

  const excludePattern = new RegExp(
    `--exclude=\\S*\\b${WORKSPACE_ROOT_PROJECT_NAME}\\b`,
  );
  if (!excludePattern.test(runManyCommand)) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` must exclude ' +
        `"${WORKSPACE_ROOT_PROJECT_NAME}" (the workspace root project has no ` +
        `"clean" target of its own) — got: ${JSON.stringify(runManyCommand)} (issue #443)`,
    );
  }
  if (!/^NX_TUI=false\s+nx run-many\b/.test(runManyCommand)) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` invocation must ' +
        `itself be scoped with "NX_TUI=false" — got: ${JSON.stringify(runManyCommand)} (issue #443)`,
    );
  }

  const resetIndex = commands.findIndex((command) =>
    /\bnx reset\b/.test(command),
  );
  if (resetIndex === -1) {
    throw new Error(
      'root "clean" script must also run `nx reset` after the per-project ' +
        `clean, to reset the Nx cache/daemon — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const resetCommand = commands[resetIndex];

  if (resetIndex < runManyIndex) {
    throw new Error(
      'root "clean" script must run `nx reset` AFTER `nx run-many ' +
        `--target=clean\`, not before — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }

  if (!/^NX_TUI=false\s+nx reset\b/.test(resetCommand)) {
    throw new Error(
      'root "clean" script\'s `nx reset` invocation must itself be scoped ' +
        'with "NX_TUI=false" — a shared prefix earlier in the chain does ' +
        `not count once the commands are reordered or split — got: ${JSON.stringify(resetCommand)} (issue #443)`,
    );
  }
}
