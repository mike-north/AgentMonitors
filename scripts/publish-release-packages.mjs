import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const PACKAGE_DIRS = [
  'libs/core',
  'plugins/source-api-poll',
  'plugins/source-file-fingerprint',
  'plugins/source-incoming-changes',
  'plugins/source-schedule',
  'apps/cli',
];
const DRY_RUN = process.argv.includes('--dry-run');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function packageInfo(packageDir) {
  const packageJsonPath = path.join(REPO_ROOT, packageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return {
    packageDir,
    packageJsonPath,
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
function releaseCandidates() {
  return PACKAGE_DIRS.map(packageInfo).filter((pkg) => {
    if (alreadyPublished(pkg)) {
      console.log(
        `Skipping ${pkg.name}@${pkg.version}; version already exists.`,
      );
      return false;
    }
    return true;
  });
}

function alreadyPublished(pkg) {
  try {
    const publishedVersion = run(
      'npm',
      [
        'view',
        `${pkg.name}@${pkg.version}`,
        'version',
        '--registry',
        pkg.registry,
      ],
      {
        env: process.env,
      },
    );
    return publishedVersion === pkg.version;
  } catch {
    return false;
  }
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

function main() {
  const candidates = releaseCandidates();
  if (candidates.length === 0) {
    console.log('All package versions are already published.');
    return;
  }

  if (DRY_RUN) {
    for (const pkg of candidates) {
      console.log(`Would publish ${pkg.name}@${pkg.version}`);
    }
    return;
  }

  for (const pkg of candidates) {
    publishPackage(pkg);
  }
}

main();
