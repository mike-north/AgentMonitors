import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const PACKAGE_DIRS = [
  'libs/core',
  'plugins/source-api-poll',
  'plugins/source-file-fingerprint',
  'plugins/source-schedule',
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

function releaseCandidates() {
  let baseSha;
  try {
    baseSha = run('git', ['rev-parse', 'HEAD^']);
  } catch {
    return [];
  }

  return PACKAGE_DIRS.filter((packageDir) => {
    const diff = run('git', [
      'diff',
      baseSha,
      'HEAD',
      '--',
      `${packageDir}/package.json`,
    ]);
    return /^[+-]\s*"version":/m.test(diff);
  }).map(packageInfo);
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
    console.log('No version-bumped packages found on this commit.');
    return;
  }

  if (DRY_RUN) {
    for (const pkg of candidates) {
      console.log(`Would process ${pkg.name}@${pkg.version}`);
    }
    return;
  }

  for (const pkg of candidates) {
    if (alreadyPublished(pkg)) {
      console.log(
        `Skipping ${pkg.name}@${pkg.version}; version already exists.`,
      );
      continue;
    }

    publishPackage(pkg);
  }
}

main();
