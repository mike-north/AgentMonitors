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
  PACKAGE_DIRS,
  REPO_ROOT,
  alreadyPublished,
  alreadyPublishedOrThrow,
  classifyPublication,
  collateralIssuesForPackage,
  main,
  validateReleaseCollateral,
} from './publish-release-packages.mjs';

interface FixtureOptions {
  changelog?: boolean;
  publishConfig?: boolean;
  builtEntry?: boolean;
  engines?: boolean;
  repository?: boolean;
  bugs?: boolean;
  homepage?: boolean;
  readme?: boolean;
  licenseFile?: boolean;
}

/** Scaffolds a minimal on-disk package under `repoRoot/packageDir`. */
function writePackageFixture(
  repoRoot: string,
  packageDir: string,
  packageJson: Record<string, unknown>,
  options: FixtureOptions = {},
): void {
  const {
    changelog = true,
    publishConfig = true,
    builtEntry = true,
    engines = true,
    repository = true,
    bugs = true,
    homepage = true,
    readme = true,
    licenseFile = true,
  } = options;
  const absDir = path.join(repoRoot, packageDir);
  mkdirSync(absDir, { recursive: true });

  const finalPackageJson = { ...packageJson };
  if (publishConfig) {
    finalPackageJson.publishConfig = {
      registry: 'https://registry.npmjs.org',
      access: 'public',
    };
  }
  if (engines) {
    finalPackageJson.engines = { node: '>=24' };
  }
  if (repository) {
    finalPackageJson.repository = {
      type: 'git',
      url: 'git+https://github.com/fixture/example.git',
      directory: packageDir,
    };
  }
  if (bugs) {
    finalPackageJson.bugs = {
      url: 'https://github.com/fixture/example/issues',
    };
  }
  if (homepage) {
    finalPackageJson.homepage = `https://github.com/fixture/example/tree/main/${packageDir}#readme`;
  }
  writeFileSync(
    path.join(absDir, 'package.json'),
    JSON.stringify(finalPackageJson, null, 2),
  );

  const name =
    typeof packageJson.name === 'string' ? packageJson.name : 'fixture';

  if (changelog) {
    writeFileSync(
      path.join(absDir, 'CHANGELOG.md'),
      `# ${name}\n\n## 0.0.1\n\n- Initial release.\n`,
    );
  }

  if (readme) {
    writeFileSync(path.join(absDir, 'README.md'), `# ${name}\n`);
  }

  if (licenseFile) {
    writeFileSync(path.join(absDir, 'LICENSE'), 'MIT License fixture text\n');
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

  // Issue #291 acceptance criterion (negative case, engines.node variant): a
  // package missing `engines.node` fails, named by package — this is the
  // check that stops an unsupported-Node install from failing opaquely
  // instead of with an actionable npm compatibility warning.
  it('reports a missing "engines.node" by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-engines',
      {
        name: '@fixture/pkg-no-engines',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { engines: false },
    );

    const report = validateReleaseCollateral(['pkg-no-engines'], repoRoot);
    expect(report.get('@fixture/pkg-no-engines')).toEqual([
      'missing "engines.node" in package.json',
    ]);
  });

  // Issue #291 acceptance criterion (negative case, repository variant).
  it('reports missing "repository" metadata by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-repository',
      {
        name: '@fixture/pkg-no-repository',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { repository: false },
    );

    const report = validateReleaseCollateral(['pkg-no-repository'], repoRoot);
    expect(report.get('@fixture/pkg-no-repository')).toEqual([
      'missing "repository" metadata in package.json',
    ]);
  });

  // Issue #291 acceptance criterion (negative case, bugs variant).
  it('reports missing "bugs" metadata by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-bugs',
      {
        name: '@fixture/pkg-no-bugs',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { bugs: false },
    );

    const report = validateReleaseCollateral(['pkg-no-bugs'], repoRoot);
    expect(report.get('@fixture/pkg-no-bugs')).toEqual([
      'missing "bugs" metadata in package.json',
    ]);
  });

  // Issue #291 acceptance criterion (negative case, homepage variant).
  it('reports a missing "homepage" by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-homepage',
      {
        name: '@fixture/pkg-no-homepage',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { homepage: false },
    );

    const report = validateReleaseCollateral(['pkg-no-homepage'], repoRoot);
    expect(report.get('@fixture/pkg-no-homepage')).toEqual([
      'missing "homepage" in package.json',
    ]);
  });

  // Issue #291 acceptance criterion (negative case, README variant).
  it('reports a missing README.md by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-readme',
      {
        name: '@fixture/pkg-no-readme',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { readme: false },
    );

    const report = validateReleaseCollateral(['pkg-no-readme'], repoRoot);
    expect(report.get('@fixture/pkg-no-readme')).toEqual(['missing README.md']);
  });

  // Issue #291 acceptance criterion (negative case, LICENSE variant).
  it('reports a missing LICENSE by package name', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-license',
      {
        name: '@fixture/pkg-no-license',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      { licenseFile: false },
    );

    const report = validateReleaseCollateral(['pkg-no-license'], repoRoot);
    expect(report.get('@fixture/pkg-no-license')).toEqual(['missing LICENSE']);
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

  // Issue #291: all six new metadata/collateral checks accumulate together,
  // in the same order collateralIssuesForPackage evaluates them.
  it('accumulates every runtime/project-metadata and README/LICENSE issue for the same package', () => {
    const repoRoot = makeTmpRoot();
    writePackageFixture(
      repoRoot,
      'pkg-no-metadata',
      {
        name: '@fixture/pkg-no-metadata',
        version: '0.0.1',
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
      },
      {
        engines: false,
        repository: false,
        bugs: false,
        homepage: false,
        readme: false,
        licenseFile: false,
      },
    );

    const report = validateReleaseCollateral(['pkg-no-metadata'], repoRoot);
    expect(report.get('@fixture/pkg-no-metadata')).toEqual([
      'missing "engines.node" in package.json',
      'missing "repository" metadata in package.json',
      'missing "bugs" metadata in package.json',
      'missing "homepage" in package.json',
      'missing README.md',
      'missing LICENSE',
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

// Issue #284 (registry-outage hardening): the registry check must distinguish a
// DEFINITIVE not-published (npm E404) from an INDETERMINATE failure (registry
// 5xx, rate limit, DNS/network). Treating every `npm view` failure as "not
// published" made the release-work gate default-OPEN during an outage, flipping
// should-run true on every unrelated main push and driving repeated Release-job
// failures. These tests mock the `npm view` probe's failure modes at both call
// sites — the gate-side lenient check and the publisher-side strict check — so
// no network round-trip is needed.
//
// @see https://github.com/mike-north/AgentMonitors/issues/284
const PROBE_PKG = {
  name: '@fixture/pkg',
  version: '1.2.3',
  registry: 'https://registry.npmjs.org',
};

/** Build a child-process-style npm error whose stderr carries `text`. */
function makeNpmError(text: string): Error {
  return Object.assign(new Error('Command failed'), { stderr: text });
}

const throwing =
  (text: string): (() => string) =>
  () => {
    throw makeNpmError(text);
  };

const E404 = 'npm error code E404\nnpm error 404 Not Found - GET .../pkg';
const E503 =
  'npm error code E503\nnpm error 503 Service Unavailable - GET .../pkg';
const ETIMEDOUT =
  'npm error code ETIMEDOUT\nnpm error network request to registry failed';

describe('classifyPublication — registry probe classification', () => {
  it('is published when npm view returns the exact version', () => {
    expect(classifyPublication(PROBE_PKG, () => '1.2.3')).toEqual({
      status: 'published',
    });
  });

  it('is not-published when npm view returns a different version', () => {
    expect(classifyPublication(PROBE_PKG, () => '1.0.0')).toEqual({
      status: 'not-published',
    });
  });

  // A package that exists but not at this version: `npm view name@ver version`
  // exits 0 with empty output — a definitive not-published, not an error.
  it('is not-published when npm view returns empty output', () => {
    expect(classifyPublication(PROBE_PKG, () => '')).toEqual({
      status: 'not-published',
    });
  });

  it('is not-published on a definitive E404 (name/version genuinely absent)', () => {
    expect(classifyPublication(PROBE_PKG, throwing(E404))).toEqual({
      status: 'not-published',
    });
  });

  it('is indeterminate on a transient registry 5xx (no E404)', () => {
    const result = classifyPublication(PROBE_PKG, throwing(E503));
    expect(result.status).toBe('indeterminate');
    expect(result).toMatchObject({ status: 'indeterminate' });
    if (result.status === 'indeterminate') {
      expect(result.message).toContain('E503');
    }
  });

  it('is indeterminate on a network failure (ETIMEDOUT)', () => {
    expect(classifyPublication(PROBE_PKG, throwing(ETIMEDOUT))).toMatchObject({
      status: 'indeterminate',
    });
  });
});

describe('alreadyPublished — gate-side check (default-closed on uncertainty)', () => {
  it('returns false for a definitive E404, so the version becomes a release candidate', () => {
    expect(
      alreadyPublished(PROBE_PKG, {
        view: throwing(E404),
        warn: () => undefined,
      }),
    ).toBe(false);
  });

  it('returns true for an already-published version', () => {
    expect(
      alreadyPublished(PROBE_PKG, {
        view: () => '1.2.3',
        warn: () => undefined,
      }),
    ).toBe(true);
  });

  // The core of #284: an unreachable/flaky registry must NOT flip the gate open.
  it('treats a transient failure as published and warns, naming the package and the error', () => {
    const warnings: string[] = [];
    const result = alreadyPublished(PROBE_PKG, {
      view: throwing(E503),
      warn: (message) => warnings.push(message),
    });
    expect(result).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('@fixture/pkg@1.2.3');
    expect(warnings[0]).toContain('E503');
  });
});

describe('alreadyPublishedOrThrow — publisher-side check (fails loudly on uncertainty)', () => {
  it('returns false for a definitive E404 (publish this version)', () => {
    expect(alreadyPublishedOrThrow(PROBE_PKG, { view: throwing(E404) })).toBe(
      false,
    );
  });

  it('returns true for an already-published version (skip — preserves idempotency)', () => {
    expect(alreadyPublishedOrThrow(PROBE_PKG, { view: () => '1.2.3' })).toBe(
      true,
    );
  });

  // Publishing needs certainty: an indeterminate result must abort loudly
  // rather than silently skip (or blindly republish).
  it('throws naming the package and the error on a transient failure', () => {
    expect(() =>
      alreadyPublishedOrThrow(PROBE_PKG, { view: throwing(E503) }),
    ).toThrow(/@fixture\/pkg@1\.2\.3/);
    expect(() =>
      alreadyPublishedOrThrow(PROBE_PKG, { view: throwing(E503) }),
    ).toThrow(/E503/);
  });
});

// Issue #291 acceptance criterion: published packages declare an engines.node
// floor consistent with the Node version CI actually tests, so a user who installs on an unsupported Node
// release gets an actionable npm compatibility warning rather than an opaque
// runtime failure — and that claim can't silently drift, because both sides
// (the real `.github/workflows/ci.yml` and the real PACKAGE_DIRS
// package.jsons) are read from disk here, not hand-built approximations.
describe('published package engines.node vs CI-tested Node version (real repo)', () => {
  it('declares engines.node matching the Node version CI tests, for every PACKAGE_DIRS package', () => {
    const ciWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ciNodeVersions = [
      ...new Set(
        [...ciWorkflow.matchAll(/node-version:\s*(\d+)/g)].map((match) =>
          Number(match[1]),
        ),
      ),
    ];
    // CI currently tests exactly one Node version. If that ever becomes a
    // range, this assertion (and the engines.node values below) should be
    // revisited deliberately rather than drifting apart silently.
    expect(ciNodeVersions).toEqual([24]);

    for (const packageDir of PACKAGE_DIRS) {
      const packageJson = JSON.parse(
        readFileSync(path.join(REPO_ROOT, packageDir, 'package.json'), 'utf8'),
      ) as { name?: string; engines?: { node?: string } };
      expect(packageJson.engines?.node, `${packageDir} engines.node`).toBe(
        '>=24',
      );
    }
  });
});
