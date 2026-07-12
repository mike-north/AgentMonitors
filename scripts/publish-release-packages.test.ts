/**
 * Tests for the publish dry-run guard's release-collateral validation
 * (`validateReleaseCollateral` / `main({ dryRun: true })` in
 * publish-release-packages.mjs).
 *
 * This guards the failure class described in ENG_TEAM_INSTRUCTIONS.md rule 8
 * (and the "new publishable package checklist" it documents): a package
 * missing CHANGELOG.md, publishConfig, or a built entry point previously
 * reached release time undetected and crashed the changesets action. These
 * tests exercise the exact validation the real `--dry-run` invocation runs,
 * against on-disk fixture packages — not a hand-built approximation of the
 * check. They deliberately never reach `releaseCandidates()` (which shells
 * out to `npm view` over the network): collateral validation runs first and
 * short-circuits `main()` before any registry call, so this suite is
 * network-independent and safe to run offline.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collateralIssuesForPackage,
  main,
  validateReleaseCollateral,
} from './publish-release-packages.mjs';

interface FixtureOptions {
  changelog?: boolean;
  publishConfig?: boolean;
  builtEntry?: boolean;
}

/** Scaffolds a minimal on-disk package under `repoRoot/packageDir`. */
function writePackageFixture(
  repoRoot: string,
  packageDir: string,
  packageJson: Record<string, unknown>,
  options: FixtureOptions = {},
): void {
  const { changelog = true, publishConfig = true, builtEntry = true } = options;
  const absDir = path.join(repoRoot, packageDir);
  mkdirSync(absDir, { recursive: true });

  const finalPackageJson = { ...packageJson };
  if (publishConfig) {
    finalPackageJson.publishConfig = {
      registry: 'https://registry.npmjs.org',
      access: 'public',
    };
  }
  writeFileSync(
    path.join(absDir, 'package.json'),
    JSON.stringify(finalPackageJson, null, 2),
  );

  if (changelog) {
    const name =
      typeof packageJson.name === 'string' ? packageJson.name : 'fixture';
    writeFileSync(
      path.join(absDir, 'CHANGELOG.md'),
      `# ${name}\n\n## 0.0.1\n\n- Initial release.\n`,
    );
  }

  if (builtEntry) {
    mkdirSync(path.join(absDir, 'dist'), { recursive: true });
    writeFileSync(path.join(absDir, 'dist', 'index.js'), 'export {};\n');
  }
}

describe('validateReleaseCollateral', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot !== undefined) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function makeTmpRoot(): string {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentmonitors-collateral-'));
    return tmpRoot;
  }

  // Acceptance criterion 2: a package with CHANGELOG.md, publishConfig, and
  // a built entry point that `npm pack` would include reports no issues.
  it('reports no issues for a package with clean collateral', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(repoRoot, 'pkg-clean', {
      name: '@fixture/pkg-clean',
      version: '0.0.1',
      type: 'module',
      main: './dist/index.js',
      files: ['dist'],
    });

    const report = validateReleaseCollateral(['pkg-clean'], repoRoot);
    expect([...report.entries()]).toEqual([]);
  });

  // Acceptance criterion 3 (negative case): a package missing CHANGELOG.md
  // fails, and the failure names both the package and the missing collateral.
  it('reports a missing CHANGELOG.md by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-changelog',
      {
        name: '@fixture/pkg-no-changelog',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { changelog: false },
    );

    const report = validateReleaseCollateral(['pkg-no-changelog'], repoRoot);
    expect(report.get('@fixture/pkg-no-changelog')).toEqual([
      'missing CHANGELOG.md',
    ]);
  });

  // Acceptance criterion 3 (negative case, publishConfig variant): a package
  // missing publishConfig fails, named by package.
  it('reports a missing publishConfig by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-publish-config',
      {
        name: '@fixture/pkg-no-publish-config',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { publishConfig: false },
    );

    const report = validateReleaseCollateral(
      ['pkg-no-publish-config'],
      repoRoot,
    );
    expect(report.get('@fixture/pkg-no-publish-config')).toEqual([
      'missing "publishConfig" in package.json',
    ]);
  });

  // Acceptance criterion 2: "package builds an artifact npm pack accepts".
  // `npm pack --dry-run` exits 0 even when "files": ["dist"] matches
  // nothing, so this must be an explicit check against the packed file list,
  // not a bare exit-code check.
  it('reports an unbuilt entry point that npm pack would not include', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-unbuilt',
      {
        name: '@fixture/pkg-unbuilt',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { builtEntry: false },
    );

    const report = validateReleaseCollateral(['pkg-unbuilt'], repoRoot);
    expect(report.get('@fixture/pkg-unbuilt')).toEqual([
      'npm pack would not include built entry point(s) "dist/index.js" — was the package built before this check ran?',
    ]);
  });

  it('accumulates multiple issues for the same package', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-multi-issue',
      {
        name: '@fixture/pkg-multi-issue',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { changelog: false, publishConfig: false, builtEntry: false },
    );

    const packageAbsDir = path.join(repoRoot, 'pkg-multi-issue');
    const packageJson = JSON.parse(
      readFileSync(path.join(packageAbsDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const issues = collateralIssuesForPackage({ packageAbsDir, packageJson });

    expect(issues).toEqual([
      'missing CHANGELOG.md',
      'missing "publishConfig" in package.json',
      'npm pack would not include built entry point(s) "dist/index.js" — was the package built before this check ran?',
    ]);
  });

  // Only PACKAGE_DIRS entries actually declaring an entry point are checked
  // against `npm pack` — a package with none of main/types/exports/bin
  // (unusual, but not this validator's concern) shouldn't spuriously fail.
  it('skips the npm-pack check for a package with no declared entry point', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-entry',
      {
        name: '@fixture/pkg-no-entry',
        version: '0.0.1',
        type: 'module',
      },
      { builtEntry: false },
    );

    const report = validateReleaseCollateral(['pkg-no-entry'], repoRoot);
    expect([...report.entries()]).toEqual([]);
  });
});

describe('main({ dryRun: true })', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot !== undefined) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  // Acceptance criterion 3: the dry-run "fails loudly" — the CLI entry point
  // (not just the lower-level validator) surfaces the report through the
  // error logger and reports failure, before ever touching the network.
  it('logs the collateral report and returns { ok: false } for a broken package, without a network call', () => {
    tmpRoot = mkdtempSync(
      path.join(os.tmpdir(), 'agentmonitors-collateral-main-'),
    );
    writePackageFixture(
      tmpRoot,
      'pkg-broken',
      {
        name: '@fixture/pkg-broken',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { changelog: false },
    );

    const logged: string[] = [];
    const loggedErrors: string[] = [];

    const result = main({
      packageDirs: ['pkg-broken'],
      repoRoot: tmpRoot,
      dryRun: true,
      log: (message: string) => logged.push(message),
      logError: (message: string) => loggedErrors.push(message),
    });

    expect(result).toEqual({ ok: false });
    expect(loggedErrors).toEqual([
      'Release collateral validation failed:\n- @fixture/pkg-broken: missing CHANGELOG.md',
    ]);
    // Never reached "Would publish" or "already exists" output — proves
    // collateral validation short-circuited before releaseCandidates()
    // (and therefore before any npm view network call).
    expect(logged).toEqual([]);
  });
});
