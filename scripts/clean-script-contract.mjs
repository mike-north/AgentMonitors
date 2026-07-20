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
 * @typedef {{ command: string, guaranteed: boolean }} ChainedCommand
 */

/**
 * Split a shell script string into its individual chained commands (on
 * `&&`, `||`, `;`, or a newline), each tagged with whether it is
 * `guaranteed` to run.
 *
 * A command joined by `;` or a newline always runs, regardless of the
 * previous command's exit status — `guaranteed: true`. A command joined by
 * `&&` only runs if the previous command SUCCEEDED, which every command
 * this guard cares about (`rm -rf`, `nx run-many`, `nx reset`) does in
 * practice, so it's also treated as `guaranteed: true` (this mirrors how
 * the rest of this module already accepted `&&`-chained commands before
 * this fix). A command joined by `||` only runs if the previous command
 * FAILED — `guaranteed: false` — so e.g. `rm -rf dist || rm -rf temp` must
 * NOT be accepted as removing both `dist` and `temp`: a successful first
 * `rm -rf dist` skips the second command entirely. Earlier versions of
 * this guard flattened `&&` and `||` identically, silently accepting that
 * shape (issue #443 post-merge review).
 *
 * This intentionally does not special-case a standalone background `&`
 * (as opposed to `&&`): none of this repo's real `clean` scripts use it,
 * and a backgrounded `rm -rf`/`nx` step wouldn't reliably complete before
 * `clean` returns anyway, so it's out of scope for a synchronous
 * before/after contract like this one — if it appears, the surrounding
 * text simply won't match any of the exact-token checks below and the
 * script is rejected by default, which is the safe outcome.
 *
 * Mirrors the split delimiters (though not the guaranteed/unguaranteed
 * distinction) in `api-report-ci-wiring.mjs`'s `splitChainedCommands` —
 * kept local so this module has no import-time dependency on that one's
 * internals.
 *
 * @param {string} script
 * @returns {ChainedCommand[]}
 */
function splitChainedCommands(script) {
  const commands = [];
  /** @type {string | undefined} */
  let precedingOperator;

  for (const token of script.split(/(&&|\|\||;|\n)/)) {
    if (token === '&&' || token === '||' || token === ';' || token === '\n') {
      // Only record a NEW pending operator if there isn't already one
      // awaiting a real command — an empty segment between two operator
      // tokens (e.g. the newline right after `||` in `dist ||\ntemp`)
      // must not let a weaker/different operator overwrite an already
      // `||`-gated pending operator. The empty segment is a no-op in a
      // real shell; the operator that actually gates the next command is
      // whichever one appeared FIRST since the last real command.
      precedingOperator ??= token;
      continue;
    }
    const command = token.trim();
    if (command.length === 0) {
      continue;
    }
    commands.push({ command, guaranteed: precedingOperator !== '||' });
    precedingOperator = undefined;
  }

  return commands;
}

/**
 * Split a single shell command into its whitespace-separated tokens.
 *
 * @param {string} command
 * @returns {string[]}
 */
function tokenize(command) {
  return command.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Extract the raw values of EVERY exact `--flagName=value` token in a
 * command's tokens (a repeatable flag like `nx run-many --exclude=` may
 * legitimately appear more than once — `--exclude=a --exclude=b` excludes
 * BOTH `a` and `b`). Exact flag-name match only — deliberately not a
 * `\b`-bounded regex, which matches a word boundary right before a hyphen
 * and so would wrongly treat `--target=clean-old` as satisfying a check for
 * `--target=clean` (issue #443 post-merge review).
 *
 * @param {string[]} tokens
 * @param {string} flagName
 * @returns {string[]} raw values, one per occurrence, in token order
 */
function findFlagValues(tokens, flagName) {
  const prefix = `--${flagName}=`;
  return tokens
    .filter((candidate) => candidate.startsWith(prefix))
    .map((token) => token.slice(prefix.length));
}

/**
 * Every comma-separated member across ALL occurrences of a `--flagName=`
 * token, flattened into a single set — e.g. two `--exclude=a --exclude=b`
 * tokens, or one `--target=clean,other` token, both yield the full
 * membership the flag actually carries. A single occurrence's own value is
 * ALSO comma-split, since a real `nx` flag like `--target=` accepts a
 * comma-joined list in one token (issue #443 post-merge review: an earlier
 * exact-equality check against a single occurrence's raw value false-
 * rejected `--target=clean,other` and never merged repeated `--exclude=`
 * occurrences at all).
 *
 * @param {string[]} tokens
 * @param {string} flagName
 * @returns {Set<string>}
 */
function findFlagValueSet(tokens, flagName) {
  return new Set(
    findFlagValues(tokens, flagName).flatMap((value) => value.split(',')),
  );
}

/**
 * Whether a command's tokens begin with exactly the given token sequence,
 * e.g. `startsWithTokens('NX_TUI=false nx reset', 'NX_TUI=false', 'nx',
 * 'reset')`. Exact per-token comparison, not a `\b`-bounded regex, so a
 * `reset-old` token can never satisfy a check for the `reset` token.
 *
 * @param {string} command
 * @param {...string} expectedTokens
 * @returns {boolean}
 */
function startsWithTokens(command, ...expectedTokens) {
  const tokens = tokenize(command);
  return expectedTokens.every((expected, index) => tokens[index] === expected);
}

/**
 * Whether a command contains the given token sequence contiguously
 * anywhere within it (not just at the start) — e.g. `containsTokens('NX_TUI=false nx reset', 'nx', 'reset')`.
 * Exact per-token comparison for the same reason as {@link startsWithTokens}.
 *
 * @param {string} command
 * @param {...string} expectedTokens
 * @returns {boolean}
 */
function containsTokens(command, ...expectedTokens) {
  const tokens = tokenize(command);
  for (let start = 0; start + expectedTokens.length <= tokens.length; start++) {
    if (
      expectedTokens.every(
        (expected, offset) => tokens[start + offset] === expected,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a command is an `nx run-many --target=clean` invocation, using
 * exact token/flag-value matching (see {@link findFlagValueSet}) rather
 * than a `\b`-bounded regex. `--target=` accepts a comma-joined list
 * (`--target=clean,other`), so this checks `clean` is a MEMBER of that set,
 * not that the raw value is exactly `"clean"`.
 *
 * @param {string} command
 * @returns {boolean}
 */
function isNxRunManyCleanCommand(command) {
  return (
    containsTokens(command, 'nx', 'run-many') &&
    findFlagValueSet(tokenize(command), 'target').has('clean')
  );
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

  // Only commands `guaranteed` to run count toward the contract — a
  // `rm -rf temp` reachable only via `rm -rf dist || rm -rf temp` does NOT
  // reliably remove `temp`, since a successful `rm -rf dist` (the normal
  // case) skips it entirely.
  const rmCommands = splitChainedCommands(clean)
    .filter((entry) => entry.guaranteed && /^rm\s+-rf\b/.test(entry.command))
    .map((entry) => entry.command);
  if (rmCommands.length === 0) {
    throw new Error(
      `${label} "clean" script must run \`rm -rf\` unconditionally (not only ` +
        `after a prior command fails via \`||\`) — got: ${JSON.stringify(clean)} (issue #443)`,
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

  // Only `guaranteed` commands count — `nx run-many ... || nx reset` does
  // NOT reliably reset the cache, since a successful run-many (the normal
  // case) skips the `nx reset` entirely.
  const commands = splitChainedCommands(clean).filter(
    (entry) => entry.guaranteed,
  );

  const runManyIndex = commands.findIndex((entry) =>
    isNxRunManyCleanCommand(entry.command),
  );
  if (runManyIndex === -1) {
    throw new Error(
      'root "clean" script must invoke `nx run-many --target=clean` ' +
        'unconditionally (not only after a prior command fails via `||`) to ' +
        `fan the per-project clean out across the workspace — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const runManyCommand = commands[runManyIndex].command;
  const runManyTokens = tokenize(runManyCommand);

  const excludedProjects = findFlagValueSet(runManyTokens, 'exclude');
  if (!excludedProjects.has(WORKSPACE_ROOT_PROJECT_NAME)) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` must exclude ' +
        `"${WORKSPACE_ROOT_PROJECT_NAME}" (the workspace root project has no ` +
        `"clean" target of its own) — got: ${JSON.stringify(runManyCommand)} (issue #443)`,
    );
  }
  if (!startsWithTokens(runManyCommand, 'NX_TUI=false', 'nx', 'run-many')) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` invocation must ' +
        `itself be scoped with "NX_TUI=false" — got: ${JSON.stringify(runManyCommand)} (issue #443)`,
    );
  }

  const resetIndex = commands.findIndex((entry) =>
    containsTokens(entry.command, 'nx', 'reset'),
  );
  if (resetIndex === -1) {
    throw new Error(
      'root "clean" script must also run `nx reset` unconditionally (not ' +
        'only after a prior command fails via `||`) after the per-project ' +
        `clean, to reset the Nx cache/daemon — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const resetCommand = commands[resetIndex].command;

  if (resetIndex < runManyIndex) {
    throw new Error(
      'root "clean" script must run `nx reset` AFTER `nx run-many ' +
        `--target=clean\`, not before — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }

  if (!startsWithTokens(resetCommand, 'NX_TUI=false', 'nx', 'reset')) {
    throw new Error(
      'root "clean" script\'s `nx reset` invocation must itself be scoped ' +
        'with "NX_TUI=false" — a shared prefix earlier in the chain does ' +
        `not count once the commands are reordered or split — got: ${JSON.stringify(resetCommand)} (issue #443)`,
    );
  }
}
