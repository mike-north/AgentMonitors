/**
 * Tests for the release-work gate (scripts/release-gate.mjs) — the decision
 * factored out of the Release workflow's "Detect release work" step so it is
 * node-level testable and derived from the single authoritative
 * publishable-package inventory (`PACKAGE_DIRS`).
 *
 * These exercise the decision logic directly, with the registry lookup and
 * `.changeset` directory injected, so the suite is network-independent (it
 * never calls `npm view`) and git-independent (the gate has no git input at
 * all — that is precisely the property issue #284 requires).
 *
 * `release-gate.mjs` / `publish-release-packages.mjs` are plain JS (no
 * `.d.ts`), consistent with the rest of `scripts/` (see the
 * `scripts/**\/*.mjs` override in eslint.config.mjs); this file is not part of
 * any tsconfig project and relies on vitest's esbuild transform.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/284
 * @see .github/workflows/release.yml — the gate step this module drives
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeReleaseGate,
  decideReleaseWork,
  discoverPublishablePackageDirs,
  hasPendingChangesets,
  main,
} from './release-gate.mjs';
import {
  PACKAGE_DIRS,
  REPO_ROOT,
  alreadyPublished,
} from './publish-release-packages.mjs';

const COMMAND_POLL = '@agentmonitors/source-command-poll';
const SCHEDULE = '@agentmonitors/source-schedule';

interface Pkg {
  name: string;
  version: string;
  registry: string;
}

/**
 * A fake registry lookup: a package is "published" unless its name is in the
 * given unpublished set. Lets each scenario declare exactly which current
 * versions are missing from the registry without any network call.
 */
function publishedExcept(
  unpublished: readonly string[],
): (pkg: Pkg) => boolean {
  const missing = new Set(unpublished);
  return (pkg) => !missing.has(pkg.name);
}

/** Build a child-process-style npm error whose stderr carries `text`. */
function makeNpmError(text: string): Error {
  return Object.assign(new Error('Command failed'), { stderr: text });
}

/** Tracks temp dirs so afterEach can clean them all up. */
const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** An empty `.changeset` fixture (no pending changesets). */
function emptyChangesetDir(): string {
  return makeTmpDir('agentmonitors-changeset-empty-');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('hasPendingChangesets', () => {
  it('is false for a directory that does not exist', () => {
    expect(
      hasPendingChangesets(path.join(os.tmpdir(), 'definitely-not-here-284')),
    ).toBe(false);
  });

  it('is false for a directory with only config.json and README.md', () => {
    const dir = makeTmpDir('agentmonitors-changeset-');
    writeFileSync(path.join(dir, 'config.json'), '{}');
    writeFileSync(path.join(dir, 'README.md'), '# changesets\n');
    expect(hasPendingChangesets(dir)).toBe(false);
  });

  it('is true when a pending changeset .md is present', () => {
    const dir = makeTmpDir('agentmonitors-changeset-');
    writeFileSync(
      path.join(dir, 'brave-lions-jump.md'),
      '---\n"x": patch\n---\n',
    );
    expect(hasPendingChangesets(dir)).toBe(true);
  });
});

describe('decideReleaseWork', () => {
  it('runs when changesets are pending (regardless of publish state)', () => {
    expect(
      decideReleaseWork({ pendingChangesets: true, unpublishedNames: [] }),
    ).toEqual({ shouldRun: true, reason: 'pending changesets present' });
  });

  it('runs when a current version is unpublished, naming the packages', () => {
    const decision = decideReleaseWork({
      pendingChangesets: false,
      unpublishedNames: [COMMAND_POLL],
    });
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toContain(COMMAND_POLL);
  });

  it('does not run when nothing is pending and everything is published', () => {
    expect(
      decideReleaseWork({ pendingChangesets: false, unpublishedNames: [] }),
    ).toEqual({
      shouldRun: false,
      reason:
        'no pending changesets and all current versions already published',
    });
  });
});

describe('computeReleaseGate — required release scenarios', () => {
  // DoD scenario 1: a command-poll-only version bump. Before the fix the
  // workflow's hand-maintained manifest list omitted
  // plugins/source-command-poll/package.json, so a bump to *only* that package
  // left the gate false and it never published. Here every other package is
  // already published and only source-command-poll's current version is
  // missing — the gate must still run.
  it('runs for a command-poll-only version bump', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([COMMAND_POLL]),
      changesetDir: emptyChangesetDir(),
    });
    expect(decision.shouldRun).toBe(true);
    expect(decision.unpublishedNames).toEqual([COMMAND_POLL]);
    expect(decision.reason).toContain(COMMAND_POLL);
  });

  // DoD scenario 2: a partial publish followed by an unrelated main commit.
  // Some packages published, some not — and no changeset present. The gate has
  // no git input, so an unrelated later commit cannot hide the still-missing
  // packages the way the old `git diff HEAD^..HEAD` gate did.
  it('runs after a partial publish even with no changeset and an unrelated HEAD', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([COMMAND_POLL, SCHEDULE]),
      changesetDir: emptyChangesetDir(),
    });
    expect(decision.shouldRun).toBe(true);
    // Reconciles exactly the packages still missing from the registry.
    expect(new Set(decision.unpublishedNames)).toEqual(
      new Set([COMMAND_POLL, SCHEDULE]),
    );
  });

  // DoD scenario 4: all current versions already published, no changesets — a
  // clean no-op. Normal feature commits must not trigger release work.
  it('does not run when every current version is already published (clean no-op)', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([]),
      changesetDir: emptyChangesetDir(),
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.unpublishedNames).toEqual([]);
  });

  // Idempotency: an already-published version is never selected as work, so
  // reconciliation can run on every main CI push without ever republishing an
  // existing version.
  it('never lists an already-published version as release work', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([COMMAND_POLL]),
      changesetDir: emptyChangesetDir(),
    });
    for (const name of decision.unpublishedNames) {
      expect(name).toBe(COMMAND_POLL);
    }
  });

  // A pending changeset short-circuits the registry check entirely: the gate
  // runs to open/update the Version PR without any `npm view` call.
  it('runs on a pending changeset without consulting the registry', () => {
    const changesetDir = makeTmpDir('agentmonitors-changeset-');
    writeFileSync(
      path.join(changesetDir, 'happy-otters-run.md'),
      '---\n"@agentmonitors/core": patch\n---\n\nchange\n',
    );
    const isPublished = vi.fn(() => true);

    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished,
      changesetDir,
    });

    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe('pending changesets present');
    expect(isPublished).not.toHaveBeenCalled();
  });
});

describe('computeReleaseGate — registry outage stays default-closed (real gate check)', () => {
  // Wires the REAL gate-side check (alreadyPublished) into computeReleaseGate
  // with only the npm-view probe mocked, proving end-to-end that a transient
  // registry failure keeps the gate CLOSED (issue #284: an unreachable
  // registry must not flip should-run open on every unrelated push), while a
  // definitive E404 still opens it for a genuinely unpublished version.
  function viewFor(
    states: Record<string, 'published' | 'e404' | 'transient'>,
  ): (pkg: Pkg) => string {
    return (pkg) => {
      const state = states[pkg.name] ?? 'published';
      if (state === 'e404') {
        throw makeNpmError('npm error code E404\nnpm error 404 Not Found');
      }
      if (state === 'transient') {
        throw makeNpmError('npm error code E503 Service Unavailable');
      }
      return pkg.version;
    };
  }

  it('stays closed when the only unpublished-looking package fails transiently', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: (pkg) =>
        alreadyPublished(pkg, {
          view: viewFor({ [COMMAND_POLL]: 'transient' }),
          warn: () => undefined,
        }),
      changesetDir: emptyChangesetDir(),
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.unpublishedNames).toEqual([]);
  });

  it('opens for a definitive E404 (a genuinely unpublished version)', () => {
    const decision = computeReleaseGate({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: (pkg) =>
        alreadyPublished(pkg, {
          view: viewFor({ [COMMAND_POLL]: 'e404' }),
          warn: () => undefined,
        }),
      changesetDir: emptyChangesetDir(),
    });
    expect(decision.shouldRun).toBe(true);
    expect(decision.unpublishedNames).toEqual([COMMAND_POLL]);
  });
});

describe('discoverPublishablePackageDirs — inventory drift guard', () => {
  // DoD scenario 3: a newly added publishable package. The gate and publisher
  // share ONE inventory (PACKAGE_DIRS); this guard proves that inventory stays
  // complete, so a new publishable package can't be silently omitted from it
  // (which is how it would fail to publish). If someone adds a non-private
  // package under a workspace glob without updating PACKAGE_DIRS, this fails.
  it('matches PACKAGE_DIRS exactly for the real workspace', () => {
    expect(discoverPublishablePackageDirs(REPO_ROOT)).toEqual(
      [...PACKAGE_DIRS].sort(),
    );
  });

  // Proves the guard actually detects drift rather than tautologically passing:
  // a fixture workspace with a brand-new publishable package surfaces a dir the
  // (stale) inventory omits, and excludes private packages.
  it('detects a newly added publishable package missing from a stale inventory', () => {
    const repoRoot = makeTmpDir('agentmonitors-workspace-');
    writeFileSync(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      "packages:\n  - 'libs/*'\n  - 'apps/*'\n  - 'plugins/*'\nallowBuilds:\n  esbuild: true\n",
    );
    writePackageJson(repoRoot, 'libs/core', {
      name: '@fixture/core',
      version: '1.0.0',
    });
    writePackageJson(repoRoot, 'plugins/source-existing', {
      name: '@fixture/source-existing',
      version: '1.0.0',
    });
    // Newly added, publishable, but absent from the stale inventory below.
    writePackageJson(repoRoot, 'plugins/source-new', {
      name: '@fixture/source-new',
      version: '0.1.0',
    });
    // Private packages under a matched glob are correctly excluded, and the
    // `allowBuilds:` map entries above (not `- ` bullets) must not be treated
    // as globs.
    writePackageJson(repoRoot, 'apps/website', {
      name: '@fixture/website',
      version: '0.0.0',
      private: true,
    });

    const discovered = discoverPublishablePackageDirs(repoRoot);
    expect(discovered).toEqual([
      'libs/core',
      'plugins/source-existing',
      'plugins/source-new',
    ]);

    const staleInventory = ['libs/core', 'plugins/source-existing'];
    const missing = discovered.filter((dir) => !staleInventory.includes(dir));
    expect(missing).toEqual(['plugins/source-new']);
  });
});

describe('ci.yml release-collateral path filter — PACKAGE_DIRS drift guard', () => {
  // The release-collateral-changed job in ci.yml hard-codes a path-filter
  // regex; a workflow can't derive one at runtime, so it is a SECOND
  // hand-maintained inventory that can drift from PACKAGE_DIRS — exactly the
  // failure class issue #284 eliminates elsewhere. This cross-check parses the
  // regex out of ci.yml and asserts it matches every PACKAGE_DIRS entry,
  // naming any dir it misses (so adding a publishable package without updating
  // the filter fails CI loudly).
  function collateralPatternFromCi(): string {
    const ciYaml = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    // ci.yml has two `pattern='...'` filters (release-collateral and website);
    // select the release-collateral one by a publishable dir only it lists.
    const patterns = [...ciYaml.matchAll(/pattern='([^']+)'/g)].map(
      (match) => match[1],
    );
    const collateralPattern = patterns.find((pattern) =>
      pattern.includes('libs/core/'),
    );
    if (collateralPattern === undefined) {
      throw new Error(
        'could not find the release-collateral path filter in .github/workflows/ci.yml',
      );
    }
    return collateralPattern;
  }

  it('matches every PACKAGE_DIRS entry', () => {
    const regex = new RegExp(collateralPatternFromCi());
    const missing = PACKAGE_DIRS.filter(
      (dir) => !regex.test(`${dir}/package.json`),
    );
    expect(
      missing,
      `ci.yml release-collateral path filter does not match PACKAGE_DIRS entr${
        missing.length === 1 ? 'y' : 'ies'
      }: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  // Proves the guard actually detects drift rather than passing vacuously: a
  // stale filter that omits real publishable dirs surfaces exactly those dirs.
  it('names the dirs a stale filter would miss', () => {
    const staleRegex = new RegExp('^(libs/core/|apps/cli/)');
    const missing = PACKAGE_DIRS.filter(
      (dir) => !staleRegex.test(`${dir}/package.json`),
    );
    expect(missing).toContain('apps/agentmonitors');
    expect(missing).toContain('plugins/source-schedule');
    expect(missing).not.toContain('libs/core');
  });
});

describe('main — real GITHUB_OUTPUT append path (the branch CI runs)', () => {
  // Every other main() test injects writeOutput; this one exercises the actual
  // appendFileSync-to-$GITHUB_OUTPUT branch the workflow step runs, by pointing
  // GITHUB_OUTPUT at a temp file and asserting the file's exact contents.
  const originalGithubOutput = process.env.GITHUB_OUTPUT;

  afterEach(() => {
    if (originalGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGithubOutput;
    }
  });

  it('appends "should-run=true\\n" to $GITHUB_OUTPUT (append-only, no writeOutput)', () => {
    const outputFile = path.join(
      makeTmpDir('agentmonitors-ghoutput-'),
      'github_output',
    );
    // GITHUB_OUTPUT accumulates across steps; seed a prior line to prove append.
    writeFileSync(outputFile, 'prior-key=prior-value\n');
    process.env.GITHUB_OUTPUT = outputFile;

    const decision = main({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([COMMAND_POLL]),
      changesetDir: emptyChangesetDir(),
      log: () => undefined,
      // No writeOutput and no githubOutput override: resolve the real
      // process.env.GITHUB_OUTPUT default and hit appendFileSync.
    });

    expect(decision.shouldRun).toBe(true);
    expect(readFileSync(outputFile, 'utf8')).toBe(
      'prior-key=prior-value\nshould-run=true\n',
    );
  });

  it('appends "should-run=false\\n" for a clean no-op', () => {
    const outputFile = path.join(
      makeTmpDir('agentmonitors-ghoutput-'),
      'github_output',
    );
    process.env.GITHUB_OUTPUT = outputFile;

    main({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([]),
      changesetDir: emptyChangesetDir(),
      log: () => undefined,
    });

    expect(readFileSync(outputFile, 'utf8')).toBe('should-run=false\n');
  });
});

describe('main — GITHUB_OUTPUT emission', () => {
  it('writes should-run=true to the captured output for release work', () => {
    const lines: string[] = [];
    const decision = main({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([COMMAND_POLL]),
      changesetDir: emptyChangesetDir(),
      log: () => undefined,
      writeOutput: (line: string) => lines.push(line),
    });
    expect(decision.shouldRun).toBe(true);
    expect(lines).toEqual(['should-run=true\n']);
  });

  it('writes should-run=false for a clean no-op', () => {
    const lines: string[] = [];
    main({
      packageDirs: PACKAGE_DIRS,
      repoRoot: REPO_ROOT,
      isPublished: publishedExcept([]),
      changesetDir: emptyChangesetDir(),
      log: () => undefined,
      writeOutput: (line: string) => lines.push(line),
    });
    expect(lines).toEqual(['should-run=false\n']);
  });
});

/** Scaffolds a `package.json` under `repoRoot/packageDir` for discovery tests. */
function writePackageJson(
  repoRoot: string,
  packageDir: string,
  packageJson: Record<string, unknown>,
): void {
  const absDir = path.join(repoRoot, packageDir);
  mkdirSync(absDir, { recursive: true });
  writeFileSync(
    path.join(absDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
}
