#!/usr/bin/env node
/**
 * Clean-install smoke check: proves the packed `@agentmonitors/cli` tarball
 * installs and runs its native `better-sqlite3` addon on a machine with no
 * pre-existing C/C++ build toolchain (Refs #516/#509 review finding on PR
 * #517: bumping `better-sqlite3` to `^13.0.3` "can make the published CLI
 * fail to install for Windows users without a native build toolchain").
 *
 * better-sqlite3@13.0.3 has a current upstream reproduction where a clean
 * Windows 11 + Node 24 + npm 11 install still invokes an implicit node-gyp
 * rebuild and fails at "find Python", despite the bundled win32-x64
 * prebuild and `gypfile: false`. This script is the evidence-gathering the
 * finding asked for before any version/path decision: pack every
 * publishable package (same `pnpm pack` + `PACKAGE_DIRS` precedent as
 * `scripts/test-standalone-consumer.mjs` / `test-e2e-fresh-install-hooks.mjs`),
 * install `@agentmonitors/cli` globally into an isolated npm prefix exactly
 * the way the README instructs a real user to, and run `agentmonitors
 * --version` — proving the native addon actually loads, not just that
 * `npm install` exits 0.
 *
 * Deliberately does NOT install a Python/Visual Studio Build Tools
 * toolchain first, and deliberately does not set `npm_config_build_from_source`
 * or any other flag that would change what better-sqlite3 tries to do on
 * install: doing either would mask exactly the failure class this check
 * exists to catch. If a clean Windows Node 24 install reproduces the
 * upstream failure, the fix is a different better-sqlite3 version/path, not
 * a CI toolchain workaround — see the module comment on this being run from
 * `.github/workflows/ci.yml`'s `windows-install-check` job for how that
 * job's environment is kept toolchain-free.
 *
 * Unlike `test-e2e-fresh-install-hooks.mjs` (which this deliberately does
 * NOT extend), this script stays OS-agnostic and exercises nothing
 * daemon/socket-related — a `--version` invocation is enough to force the
 * native module to load and detect the node-gyp/"find Python" failure
 * class, without needing Unix sockets or signal handling that don't exist
 * on Windows.
 *
 * @see https://github.com/WiseLibs/better-sqlite3/issues/1516
 * @see https://github.com/mike-north/AgentMonitors/issues/516
 * @see https://github.com/mike-north/AgentMonitors/issues/509
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  packPackage,
  resolveInstalledPackageFile,
} from './lib/pack-helpers.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Run a command to completion, throwing with full stdout/stderr on failure
 * so a broken step is diagnosable from CI logs alone. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) {
    throw new Error(
      `Spawn error running ${command} ${args.join(' ')}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${command} ${args.join(' ')}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

export async function main() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'am-windows-install-'));
  const packDir = path.join(tmpRoot, 'packed');
  const npmPrefixDir = path.join(tmpRoot, 'npm-global');
  const npmCacheDir = path.join(tmpRoot, 'npm-cache');
  const fakeHome = path.join(tmpRoot, 'home');
  for (const dir of [packDir, npmPrefixDir, npmCacheDir, fakeHome]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`Isolated temp root (outside the repo tree): ${tmpRoot}`);

  // No `npm_config_devdir`/build-toolchain env overrides here — unlike
  // test-e2e-fresh-install-hooks.mjs, this run must reflect exactly what a
  // clean machine's default npm config does with better-sqlite3.
  // CI runners ship Python + build tools, so a silent node-gyp source
  // rebuild could succeed and mask the exact failure class this check
  // exists to catch (upstream WiseLibs/better-sqlite3#1516: implicit gyp
  // rebuild on a clean Windows machine). Pointing NODE_GYP_FORCE_PYTHON
  // (and npm_config_python) at a guaranteed-missing executable makes any
  // node-gyp invocation fail loudly instead — so a green install PROVES
  // the bundled prebuild was used, on any runner image.
  const missingPython = path.join(
    tmpRoot,
    'deliberately-missing-python-so-node-gyp-fails.exe',
  );
  const installEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    npm_config_cache: npmCacheDir,
    NODE_GYP_FORCE_PYTHON: missingPython,
    npm_config_python: missingPython,
  };

  console.log('Packing every publishable package (pnpm pack)...');
  const tarballs = PACKAGE_DIRS.map((dir) =>
    packPackage(path.join(REPO_ROOT, dir), packDir),
  );
  console.log(
    `Packed ${String(tarballs.length)} tarballs:\n${tarballs
      .map((tarball) => `  - ${path.basename(tarball)}`)
      .join('\n')}`,
  );

  console.log(
    'Installing @agentmonitors/cli globally from the packed tarballs ' +
      '(isolated prefix; no Python/node-gyp toolchain assumed)...',
  );
  run(
    NPM_BIN,
    [
      'install',
      '--global',
      '--prefix',
      npmPrefixDir,
      '--no-audit',
      '--no-fund',
      ...tarballs,
    ],
    { cwd: packDir, env: installEnv },
  );

  // Invoke @agentmonitors/cli's own installed entry point directly (`node
  // <path>`) rather than the npm-generated bin shim/symlink: this is what
  // actually forces the native better-sqlite3 addon to load, and sidesteps
  // needing `shell: true` to execute a win32 `.cmd` shim.
  const cliEntryPoint = resolveInstalledPackageFile(
    npmPrefixDir,
    '@agentmonitors/cli',
    'dist',
    'index.cjs',
  );

  console.log(`Running: node ${cliEntryPoint} --version`);
  const versionResult = run(process.execPath, [cliEntryPoint, '--version'], {
    env: installEnv,
  });
  const installedVersion = versionResult.stdout.trim();

  const localCliPackageJson = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps', 'cli', 'package.json'), 'utf8'),
  );
  if (installedVersion !== localCliPackageJson.version) {
    throw new Error(
      `agentmonitors --version reported "${installedVersion}", expected ` +
        `"${String(localCliPackageJson.version)}" (this repo's apps/cli version) ` +
        '— the global install did not resolve to this build.',
    );
  }

  console.log(
    `OK: agentmonitors --version reported ${installedVersion} — the ` +
      'installed entry point executes.',
  );

  // `--version` alone does NOT prove the native addon loads: better-sqlite3
  // only calls getBinding() inside the Database constructor, so requiring
  // its JS entrypoint is native-load-free (verified in review by breaking
  // Node's `.node` loader: --version still passed while `new Database()`
  // threw). Explicitly instantiate a Database resolved from the INSTALLED
  // tree so success requires loading the packed prebuilt binary.
  const nativeProbe = [
    "const { createRequire } = require('node:module');",
    `const req = createRequire(${JSON.stringify(cliEntryPoint)});`,
    "const Database = req('better-sqlite3');",
    "const db = new Database(':memory:');",
    "const row = db.prepare('select 1 as one').get();",
    'db.close();',
    "if (row.one !== 1) throw new Error('unexpected query result: ' + JSON.stringify(row));",
    "console.log('native-addon-ok');",
  ].join(' ');
  console.log(
    'Instantiating better-sqlite3 Database from the installed tree ' +
      '(forces the native addon to load)...',
  );
  const probeResult = run(process.execPath, ['-e', nativeProbe], {
    env: installEnv,
  });
  if (!probeResult.stdout.includes('native-addon-ok')) {
    throw new Error(
      'native better-sqlite3 probe did not report success; stdout: ' +
        probeResult.stdout,
    );
  }

  console.log(
    'OK: the packed native better-sqlite3 addon loaded and executed a query ' +
      'without a build toolchain (node-gyp was poisoned; a source rebuild ' +
      'would have failed loudly).',
  );
}

// Only run when invoked directly, matching the entrypoint-detection pattern
// already used across this scripts/ directory (e.g.
// check-dependency-audit.mjs, test-e2e-fresh-install-hooks.mjs).
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
