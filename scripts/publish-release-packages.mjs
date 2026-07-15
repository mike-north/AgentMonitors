import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = process.cwd();

// Authoritative list of publishable packages (single source of truth). Any
// package whose directory is added here becomes a release candidate; the
// standalone-consumer smoke test (`scripts/test-standalone-consumer.mjs`)
// imports this list to validate its own `plugins/source-*` coverage against
// it, so a new bundled source can never silently ship untested (issue #264).
export const PACKAGE_DIRS = [
  'libs/core',
  'plugins/source-api-poll',
  'plugins/source-command-poll',
  'plugins/source-file-fingerprint',
  'plugins/source-incoming-changes',
  'plugins/source-schedule',
  'apps/cli',
  'apps/agentmonitors',
];
const DRY_RUN_ARG = process.argv.includes('--dry-run');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function packageInfo(packageDir, repoRoot) {
  const packageJsonPath = path.join(repoRoot, packageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return {
    packageDir,
    packageJsonPath,
    packageAbsDir: path.dirname(packageJsonPath),
    packageJson,
    name: packageJson.name,
    version: packageJson.version,
    registry:
      packageJson.publishConfig?.registry ?? 'https://registry.npmjs.org',
  };
}

// Registry-driven candidate selection: every publishable package whose
// current version is not yet on its registry. Deliberately NOT based on a
// git diff of the head commit — that made a failed publish unretryable
// (once any other commit landed on main, the version-bump commit was no
// longer HEAD and the missed packages could never publish). The registry is
// the source of truth for "needs publishing"; alreadyPublished() makes the
// whole run idempotent.
//
// `isPublished` is injectable so the release-work gate
// (scripts/release-gate.mjs) can reuse this exact selection — deriving from
// the same authoritative PACKAGE_DIRS inventory — and so tests can exercise
// it without a network round-trip to the registry.
export function releaseCandidates(
  packageDirs,
  repoRoot,
  log = () => undefined,
  isPublished = alreadyPublished,
) {
  return packageDirs
    .map((packageDir) => packageInfo(packageDir, repoRoot))
    .filter((pkg) => {
      if (isPublished(pkg)) {
        log(`Skipping ${pkg.name}@${pkg.version}; version already exists.`);
        return false;
      }
      return true;
    });
}

/** Coerce a child-process stdout/stderr field (string | Buffer | undefined) to a string. */
function toUtf8(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : '';
}

/** All text an npm child-process error carries — message plus captured stdio. */
function npmErrorText(error) {
  return [error?.message, toUtf8(error?.stdout), toUtf8(error?.stderr)]
    .filter(Boolean)
    .join('\n');
}

/** A concise one-line description of an npm failure, for logs and thrown errors. */
function npmErrorSummary(error) {
  return toUtf8(error?.stderr).trim() || error?.message || String(error);
}

/**
 * npm reports a genuinely-absent package/version with `code E404`. Any other
 * failure (registry 5xx, rate limit, DNS/network, auth) is NOT a definitive
 * "not published" — we can't tell, so callers treat it as indeterminate.
 */
function isDefinitiveNotFound(error) {
  return /\bE404\b/.test(npmErrorText(error));
}

/** Raw `npm view <name>@<version> version` probe; throws on any npm failure. */
function runNpmView(pkg) {
  return run(
    'npm',
    [
      'view',
      `${pkg.name}@${pkg.version}`,
      'version',
      '--registry',
      pkg.registry,
    ],
    { env: process.env },
  );
}

/**
 * Classify pkg's registry publication status, distinguishing a DEFINITIVE
 * not-published (npm E404 — the name/version is genuinely absent) from an
 * INDETERMINATE failure (registry 5xx, rate limit, DNS/network) where the
 * registry simply didn't answer. This distinction is what lets the release
 * gate stay default-closed under uncertainty (see alreadyPublished) while the
 * publisher refuses to act on it (see alreadyPublishedOrThrow). `view` is
 * injectable so tests can exercise every failure mode without a network call.
 *
 * @param {{name: string, version: string, registry: string}} pkg
 * @param {(pkg: object) => string} [view]
 * @returns {{status: 'published' | 'not-published'} | {status: 'indeterminate', message: string}}
 */
export function classifyPublication(pkg, view = runNpmView) {
  let publishedVersion;
  try {
    publishedVersion = view(pkg);
  } catch (error) {
    if (isDefinitiveNotFound(error)) {
      return { status: 'not-published' };
    }
    return { status: 'indeterminate', message: npmErrorSummary(error) };
  }
  return {
    status: publishedVersion === pkg.version ? 'published' : 'not-published',
  };
}

/**
 * Gate-side publish check — the default `isPublished` used by
 * releaseCandidates() and therefore by the release-work gate
 * (scripts/release-gate.mjs). DEFAULT-CLOSED ON UNCERTAINTY: a definitive
 * E404 means not-published (a real release candidate), but an INDETERMINATE
 * registry failure is treated as "published" so a flaky or unreachable
 * registry can't flip the gate open and drive repeated Release-job failures on
 * every unrelated push to main. Because the gate re-evaluates on every push
 * and the publisher is idempotent, a genuinely-unpublished package self-heals
 * on the next push once the registry answers again.
 *
 * ASYMMETRY: the publisher must NOT reuse this lenient behavior — it is about
 * to mutate the registry, so it needs certainty. See alreadyPublishedOrThrow.
 *
 * @param {{name: string, version: string, registry: string}} pkg
 * @param {{warn?: (message: string) => void, view?: (pkg: object) => string}} [options]
 * @returns {boolean}
 */
export function alreadyPublished(pkg, { warn = console.warn, view } = {}) {
  const result = classifyPublication(pkg, view);
  if (result.status === 'indeterminate') {
    warn(
      `Warning: could not determine whether ${pkg.name}@${pkg.version} is published (${result.message}); treating it as published so an unreachable registry does not trigger a release. It will be reconciled on a later push once the registry answers.`,
    );
    return true;
  }
  return result.status === 'published';
}

/**
 * Publisher-side publish check. Same E404-vs-transient distinction as
 * alreadyPublished, but FAILS LOUDLY on an indeterminate registry result
 * instead of guessing: the publisher is about to publish, so it must not
 * silently skip a package that might genuinely be unpublished, nor attempt to
 * republish one that might already exist. The certain cases (published → skip,
 * not-published → publish) behave exactly as before, so the publisher's
 * idempotency is unchanged.
 *
 * @param {{name: string, version: string, registry: string}} pkg
 * @param {{view?: (pkg: object) => string}} [options]
 * @returns {boolean}
 */
export function alreadyPublishedOrThrow(pkg, { view } = {}) {
  const result = classifyPublication(pkg, view);
  if (result.status === 'indeterminate') {
    throw new Error(
      `Cannot determine whether ${pkg.name}@${pkg.version} is already published: ${result.message}. Refusing to publish under registry uncertainty; re-run once the registry is reachable.`,
    );
  }
  return result.status === 'published';
}

function publishPackage(pkg) {
  console.log(`Publishing ${pkg.name}@${pkg.version}`);
  execFileSync(
    'pnpm',
    ['publish', '--no-git-checks', '--registry', pkg.registry],
    {
      cwd: path.dirname(pkg.packageJsonPath),
      stdio: 'inherit',
      env: process.env,
    },
  );
}

// Every string leaf reachable from package.json's "main" / "types" /
// "exports" / "bin" fields — the set of files a consumer would actually try
// to load. These are the paths that must survive into the `npm pack` file
// list, otherwise the package "builds" but ships nothing runnable.
function expectedEntryPaths(packageJson) {
  const entries = new Set();

  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) {
      entries.add(value.replace(/^\.\//, ''));
    }
  };

  add(packageJson.main);
  add(packageJson.types);

  const visitExports = (node) => {
    if (typeof node === 'string') {
      add(node);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) {
        visitExports(value);
      }
    }
  };
  visitExports(packageJson.exports);

  const bin = packageJson.bin;
  if (typeof bin === 'string') {
    add(bin);
  } else if (bin !== null && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      add(value);
    }
  }

  return entries;
}

// "Package builds an artifact npm pack accepts": run the real `npm pack
// --dry-run` (no network, no auth — it only inspects local files) and check
// that every declared entry point actually ends up in the tarball's file
// list. `npm pack` happily exits 0 for a package whose "files" glob matches
// nothing (e.g. an unbuilt "dist"), so a bare exit-code check is not enough.
function packArtifactIssues(pkg) {
  const expected = expectedEntryPaths(pkg.packageJson);
  if (expected.size === 0) return [];

  let packedEntries;
  try {
    const output = run('npm', ['pack', '--dry-run', '--json'], {
      cwd: pkg.packageAbsDir,
    });
    packedEntries = JSON.parse(output);
  } catch (error) {
    // execFileSync's stdio is ['ignore', 'pipe', 'pipe'] with encoding set,
    // so stderr is normally a string — but a spawn failure (e.g. `npm` not
    // found) can throw before encoding applies, leaving stderr as a Buffer
    // (or undefined). `toUtf8` handles both so the message is never mangled.
    const stderr = toUtf8(error.stderr);
    return [`npm pack --dry-run failed: ${stderr.trim() || error.message}`];
  }

  const packedPaths = new Set(
    (packedEntries[0]?.files ?? []).map((file) => file.path),
  );
  const missing = [...expected].filter((entry) => !packedPaths.has(entry));
  if (missing.length === 0) return [];

  return [
    `npm pack would not include built entry point(s) ${missing
      .map((entry) => `"${entry}"`)
      .join(', ')} — was the package built before this check ran?`,
  ];
}

/** True for a non-empty string; used to validate required metadata fields. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Release-collateral checks for a single package: the defect classes that
 * have previously reached release time undetected (missing CHANGELOG.md
 * crashes the changesets action; missing publishConfig or an unbuilt entry
 * point breaks `npm publish`), plus the runtime/project metadata a
 * published package needs so `npm install` gives users an actionable
 * compatibility warning instead of an opaque runtime failure, and so the
 * npm listing links back to the repo (issue #291): a declared
 * `engines.node`, consistent `repository`/`bugs`/`homepage` metadata, and a
 * README.md/LICENSE the tarball actually ships. Returns a list of
 * human-readable issue strings — empty when the package's collateral is
 * clean.
 */
export function collateralIssuesForPackage(pkg) {
  const issues = [];

  if (!existsSync(path.join(pkg.packageAbsDir, 'CHANGELOG.md'))) {
    issues.push('missing CHANGELOG.md');
  }

  if (
    pkg.packageJson.publishConfig == null ||
    typeof pkg.packageJson.publishConfig !== 'object'
  ) {
    issues.push('missing "publishConfig" in package.json');
  }

  issues.push(...packArtifactIssues(pkg));

  if (!isNonEmptyString(pkg.packageJson.engines?.node)) {
    issues.push('missing "engines.node" in package.json');
  }

  if (!isNonEmptyString(pkg.packageJson.repository?.url)) {
    issues.push('missing "repository" metadata in package.json');
  }

  if (!isNonEmptyString(pkg.packageJson.bugs?.url)) {
    issues.push('missing "bugs" metadata in package.json');
  }

  if (!isNonEmptyString(pkg.packageJson.homepage)) {
    issues.push('missing "homepage" in package.json');
  }

  if (!existsSync(path.join(pkg.packageAbsDir, 'README.md'))) {
    issues.push('missing README.md');
  }

  if (!existsSync(path.join(pkg.packageAbsDir, 'LICENSE'))) {
    issues.push('missing LICENSE');
  }

  return issues;
}

/**
 * Validates release collateral for every given package directory (default:
 * all of PACKAGE_DIRS), independent of whether that package currently needs
 * publishing. Returns a Map of package name -> issue list; empty Map means
 * every package's collateral is clean. Pure/offline aside from the local
 * `npm pack --dry-run` child process — no registry or auth interaction.
 */
export function validateReleaseCollateral(
  packageDirs = PACKAGE_DIRS,
  repoRoot = REPO_ROOT,
) {
  const report = new Map();
  for (const packageDir of packageDirs) {
    const pkg = packageInfo(packageDir, repoRoot);
    const issues = collateralIssuesForPackage(pkg);
    if (issues.length > 0) {
      report.set(pkg.name, issues);
    }
  }
  return report;
}

export function formatCollateralReport(report) {
  const lines = ['Release collateral validation failed:'];
  for (const [name, issues] of report) {
    for (const issue of issues) {
      lines.push(`- ${name}: ${issue}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} [options]
 * @param {string[]} [options.packageDirs]
 * @param {string} [options.repoRoot]
 * @param {boolean} [options.dryRun]
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.logError]
 * @returns {{ ok: boolean }}
 */
export function main({
  packageDirs = PACKAGE_DIRS,
  repoRoot = REPO_ROOT,
  dryRun = DRY_RUN_ARG,
  log = console.log,
  logError = console.error,
} = {}) {
  const collateralReport = validateReleaseCollateral(packageDirs, repoRoot);
  if (collateralReport.size > 0) {
    logError(formatCollateralReport(collateralReport));
    return { ok: false };
  }

  // Publisher path uses the STRICT check: an indeterminate registry result
  // aborts loudly rather than silently skipping (or blindly republishing) a
  // package under uncertainty. This is the deliberate asymmetry with the
  // release-work gate, which uses the lenient default `alreadyPublished`.
  const candidates = releaseCandidates(
    packageDirs,
    repoRoot,
    log,
    alreadyPublishedOrThrow,
  );
  if (candidates.length === 0) {
    log('All package versions are already published.');
    return { ok: true };
  }

  if (dryRun) {
    log('Release collateral OK for all packages.');
    for (const pkg of candidates) {
      log(`Would publish ${pkg.name}@${pkg.version}`);
    }
    return { ok: true };
  }

  for (const pkg of candidates) {
    publishPackage(pkg);
  }
  return { ok: true };
}

// Only run when invoked directly (`node scripts/publish-release-packages.mjs`),
// never as a side effect of another script importing `PACKAGE_DIRS`. `argv[1]`
// is resolved to an absolute path first: `pathToFileURL` on a relative path
// resolves against `process.cwd()` at call time rather than throwing, so an
// unresolved relative `argv[1]` could silently mismatch `import.meta.url`.
const isMainModule =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const result = main();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
